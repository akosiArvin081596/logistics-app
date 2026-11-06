// Is there already an invoice in Gmail for this load? The read-only mailbox search
// and the classifier that judges each hit. Nothing here sends, writes or stores
// anything: a caller decides what an answer means.
//
// READ-ONLY: the session's only commands are LOGIN, CAPABILITY, EXAMINE, SEARCH,
// FETCH with BODY.PEEK, and LOGOUT. ratecon-reconcile.js's header says why that
// matters: n8n's trigger selects unread + starred mail, so a read that set a flag
// would stop ingestion.
//
// A FAILURE IS NEVER "NOTHING FOUND": a refused term, any NO, BAD, BYE or throttle
// answer (this mailbox also sends invoices), an answer that can't be read or a lost
// connection rejects with err.stage. err.message never carries server text.
//
// WHAT LEAVES: counts and a date. To, Cc, Bcc and Subject are read in memory and
// never returned, logged or stored.

"use strict";

const tls = require("tls");
const { createImapReader, parseFetchResponse, attachmentNamesFromBodyStructure, parseFromAddress } = require("./ratecon-reconcile");
const { decodeWords, parseHeaders, parseParams } = require("./mime-read");

const KIND = Object.freeze({ INVOICE: "invoice", MENTION: "mention", IGNORED: "ignored" });
// searchMailboxForLoad()'s verdict: KIND.INVOICE, KIND.MENTION or this.
const CLEAN = "clean";
const MAILBOXES = Object.freeze({ drafts: "[Gmail]/Drafts", sent: "[Gmail]/Sent Mail", trash: "[Gmail]/Trash" });

const MAX_HITS_FETCHED = 20;
const MAX_TERMS = 12;
const MAX_HEADER_CHARS = 64 * 1024;
const MAX_ADDRESS_CHARS = 1024;
const MAX_SUBJECT_CHARS = 1000;
const MAX_READER_BYTES = 4 * 1024 * 1024;

// BCC is here so a send addressed to the company with the broker on Bcc reads as outside.
const FETCH_ITEMS = "(BODY.PEEK[HEADER.FIELDS (SUBJECT DATE TO CC BCC)] BODYSTRUCTURE)";

// Letters, digits, `.`, `_`, `-`, with a digit and alphanumeric ends: nothing Gmail's
// search or IMAP could read as an operator, a second term or a second command.
const TERM_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,62}[A-Za-z0-9]$/;

const INVOICE_WORD_RE = /invoic|(?<![a-z])inv(?![a-z])/i;
const ORDER_END_RE = /\border\s{0,3}#\s{0,3}([A-Za-z0-9][A-Za-z0-9._-]{0,79})\s{0,3}$/i;
const REPLY_RE = /^(?:re|fw|fwd)\s{0,3}(?:\[\d{1,3}\])?\s{0,3}:/i;
const TOKEN_CHAR_RE = /[a-z0-9]/;

// The app's alerts to ADMIN_NOTIFY_EMAIL and AUTO_INVOICE_ALERT_TO, settings that may sit
// outside the company's domain: judged by shape whatever the To, or a re-issued load's own
// alert would read as doubt on the path a person takes to fix it. They carry no attachment.
// The last two are the automatic invoices' (lib/auto-invoice-send.js heldAlert(), stopAlert()).
const APP_ALERT_SUBJECTS = Object.freeze([
	/^Load .{1,60}: a re-issued rate con (?:was held|changed fields)$/,
	/^Load .{1,60}: a later rate con did not replace a corrected date$/,
	/^LogisX integrity check \(.{1,40}\): \d{1,6} issues?$/,
	/^Load .{1,60}: changed after sending, needs a check$/,
	/^Automatic invoice sending stopped$/,
]);

// The app's mail to the mailbox itself that says "invoice" and lists loads in its body
// or PDF. Its subjects say invoice, so they need their exact shape, sent to this
// mailbox alone: anything less is a person's mail, and doubt.
const APP_SELF_MAIL = Object.freeze([
	{ subject: /^Weekly Invoices\W{1,12}(?:ACTION NEEDED\W{1,12})?\d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}$/i, attachments: 0 },
	{ subject: /^New Invoice: .{1,80} - .{1,160}$/, attachments: 1 },
	{ subject: /^\W{0,12}\d{1,6} completed loads? no weekly invoice will bill$/, attachments: 0 },
]);

const GREETING_RE = /^\* (?:OK|NO|BAD|BYE|PREAUTH)\b/i;
const STATUS_LINE_RE = /^(?:\*|a\d{1,6}) (?:OK|NO|BAD|BYE)\b/i;
const REFUSAL_RE = /^\S+ (?:NO|BAD|BYE)\b/i;
const THROTTLE_RE = /\[(?:THROTTLED|ALERT|OVERQUOTA|LIMIT|UNAVAILABLE)\b|throttl|too many|exceeded/i;
const EXPUNGE_RE = /^\* \d{1,10} EXPUNGE\b/i;
const HEADER_LITERAL_RE = /BODY\[HEADER\.FIELDS[^\]]{0,80}\](?:<\d{1,10}>)?\s{0,4}\u0001LIT(\d{1,6})\u0001/i;
const HEADER_BLANK_RE = /BODY\[HEADER\.FIELDS[^\]]{0,80}\](?:<\d{1,10}>)?\s{0,4}(?:NIL|"")/i;
const BODYSTRUCTURE_RE = /\bBODYSTRUCTURE\s{1,4}\(/i;
const LITERAL_NAME_RE = /"((?:FILENAME|NAME)(?:\*\d{0,3}\*?)?)"\s{1,4}\u0001LIT(\d{1,6})\u0001/gi;
const EXTENDED_NAME_RE = /"(FILENAME|NAME)\*(\d{1,3})?(\*)?"\s{1,4}"((?:[^"\\]|\\.){0,2000})"/gi;

function searchError(stage, { answered = false, throttled = false } = {}) {
	const err = new Error(`mailbox search stopped at ${stage}`);
	err.stage = stage;
	if (answered) err.answered = true;
	if (throttled) err.throttled = true;
	return err;
}

function imapQuote(s) {
	return '"' + String(s).replace(/(["\\])/g, "\\$1") + '"';
}

// One search term, with a leading # dropped, or "" when it can't be searched for.
function searchTerm(raw) {
	const s = String(raw == null ? "" : raw).trim().replace(/^#/, "");
	return TERM_RE.test(s) && /\d/.test(s) ? s : "";
}

// The load number, and each row's invoice and order number where a row has one. A
// value given that fails the shape counts as unsearchable: the load can't be cleared.
function searchTermsFor({ loadNumber, invoiceNumbers = [], orderNumbers = [] } = {}) {
	const terms = [];
	let unsearchable = 0;
	const add = (raw, required) => {
		if (raw == null || String(raw).trim() === "") {
			if (required) unsearchable++;
			return;
		}
		const term = searchTerm(raw);
		if (!term) unsearchable++;
		else if (!terms.some((t) => t.toLowerCase() === term.toLowerCase())) terms.push(term);
	};
	add(loadNumber, true);
	for (const raw of [].concat(invoiceNumbers == null ? [] : invoiceNumbers)) add(raw, false);
	for (const raw of [].concat(orderNumbers == null ? [] : orderNumbers)) add(raw, false);
	if (terms.length > MAX_TERMS) unsearchable += terms.length - MAX_TERMS;
	return { terms: terms.slice(0, MAX_TERMS), unsearchable };
}

// Every address of an address header, lower case, and whether any part couldn't be
// read. mime-read.js's parseAddresses() won't do here: it drops what it can't read and
// takes the first angle-addr, so a display name could make an outside recipient look
// internal. Only commas and semicolons outside quotes, comments and <> split the list.
function parseAddressList(values) {
	const addresses = [];
	let unreadable = false;
	for (const value of [].concat(values == null ? [] : values)) {
		const s = String(value);
		if (s.length > MAX_HEADER_CHARS) {
			unreadable = true;
			continue;
		}
		let part = "";
		let quoted = false;
		let comment = 0;
		let angle = false;
		let angles = 0;
		const flush = () => {
			const piece = part.trim();
			const oneAddress = angles <= 1 && piece.length <= MAX_ADDRESS_CHARS;
			part = "";
			angles = 0;
			if (!piece) return;
			const address = oneAddress ? parseFromAddress(piece) : "";
			if (address) addresses.push(address);
			else unreadable = true;
		};
		for (let i = 0; i < s.length; i++) {
			const ch = s[i];
			if (quoted || comment) {
				part += ch;
				if (ch === "\\") part += s[++i] || "";
				else if (quoted && ch === '"') quoted = false;
				else if (comment && ch === "(") comment++;
				else if (comment && ch === ")") comment--;
			} else if (angle) {
				part += ch;
				if (ch === ">") angle = false;
			} else if (ch === "," || ch === ";") {
				flush();
			} else {
				part += ch;
				if (ch === '"') quoted = true;
				else if (ch === "(") comment = 1;
				else if (ch === "<") {
					angle = true;
					angles++;
				}
			}
		}
		if (quoted || comment || angle) unreadable = true;
		flush();
	}
	return { addresses, unreadable };
}

const domainOf = (address) => address.slice(address.lastIndexOf("@") + 1);

// Whole token: no letter or digit either side, so Invoice_900000019.pdf names the load
// and 9000000190 or CHR900000019 don't.
function hasToken(text, token) {
	const hay = String(text || "").toLowerCase();
	const needle = String(token || "").toLowerCase();
	if (!needle) return false;
	for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + 1)) {
		const before = at > 0 ? hay[at - 1] : "";
		const after = hay[at + needle.length] || "";
		if (!TOKEN_CHAR_RE.test(before) && !TOKEN_CHAR_RE.test(after)) return true;
	}
	return false;
}

// decodeWords() rather than ratecon-reconcile's decodeSubject(): that one leaves a
// space between two encoded words, which can split a load number in two.
const subjectText = (raw) => decodeWords(String(raw == null ? "" : raw)).replace(/\s+/g, " ").trim().slice(0, MAX_SUBJECT_CHARS);

// hit: { subject, to, cc, bcc, attachmentNames, unreadable? }, raw header values.
// ctx: { ownAddress, terms }, the mailbox's address and the load's known numbers.
// Answers { kind, namesIt, invoiceLook, invoiceFile, outside }: never an address or a
// subject.
//
// The direction that matters is a real invoice reading Ignored, because a load with
// nothing but Ignored hits can read as not billed. So Ignored has to be proven, and
// anything that can't be placed is a Mention, which is doubt.
function classifyHit(hit, ctx) {
	const h = hit || {};
	const own = parseFromAddress(ctx && ctx.ownAddress);
	const terms = (ctx && ctx.terms) || [];
	const subject = subjectText(h.subject);
	const names = [].concat(h.attachmentNames == null ? [] : h.attachmentNames).map(String);
	const to = parseAddressList(h.to);
	const cc = parseAddressList(h.cc);
	const bcc = parseAddressList(h.bcc);
	const everyone = [...to.addresses, ...cc.addresses, ...bcc.addresses];
	const outside = everyone.some((a) => domainOf(a) !== domainOf(own));
	const texts = [subject, ...names];
	const namesIt = texts.some((t) => terms.some((term) => hasToken(t, term)));
	const invoiceFile = names.some((t) => INVOICE_WORD_RE.test(t));
	const says = invoiceFile || INVOICE_WORD_RE.test(subject);
	const order = ORDER_END_RE.exec(subject);
	const invoiceLook = says || Boolean(order);
	const answer = (kind) => ({ kind, namesIt, invoiceLook, invoiceFile, outside });
	if (!own || h.unreadable) return answer(KIND.MENTION);

	const endsKnownOrder = Boolean(order) && terms.some((t) => String(t).toLowerCase() === order[1].toLowerCase());
	if (outside && namesIt && !REPLY_RE.test(subject) && (says || endsKnownOrder)) return answer(KIND.INVOICE);

	if (!names.length && APP_ALERT_SUBJECTS.some((re) => re.test(subject))) return answer(KIND.IGNORED);

	const readable = !to.unreadable && !cc.unreadable && !bcc.unreadable;
	const internal = readable && to.addresses.length > 0 && !outside;
	if (internal && !invoiceLook) return answer(KIND.IGNORED);

	const toThisMailboxAlone = readable && to.addresses.length === 1 && to.addresses[0] === own && !cc.addresses.length && !bcc.addresses.length;
	if (toThisMailboxAlone && APP_SELF_MAIL.some((m) => m.subject.test(subject) && names.length <= m.attachments)) return answer(KIND.IGNORED);

	return answer(KIND.MENTION);
}

// An answer's own lines. Each literal's bytes are skipped by count, so nothing inside a
// message can pose as a status line.
function protocolLines(buf) {
	const lines = [];
	let at = 0;
	while (at < buf.length) {
		const eol = buf.indexOf("\r\n", at);
		if (eol < 0) break;
		const line = buf.toString("latin1", at, eol);
		lines.push(line);
		at = eol + 2;
		const literal = /\{(\d{1,10})\}$/.exec(line);
		if (literal) at += Number(literal[1]);
	}
	return lines;
}

// Ends the run on a refusal or a throttle, in an untagged line or the tagged answer. An
// EXPUNGE moves the sequence numbers, so a later FETCH could judge the wrong message.
function checkAnswer(lines, stage) {
	for (const line of lines) {
		if (EXPUNGE_RE.test(line)) throw searchError(stage);
		if (!STATUS_LINE_RE.test(line)) continue;
		const throttled = THROTTLE_RE.test(line);
		if (throttled || REFUSAL_RE.test(line)) throw searchError(stage, { answered: true, throttled });
	}
}

// The hits of one SEARCH answer. A missing or garbled `* SEARCH` line is a failure.
function hitsIn(lines) {
	const found = lines.filter((line) => /^\* SEARCH(?: |$)/i.test(line));
	if (!found.length) throw searchError("search");
	const seqs = [];
	for (const line of found) {
		for (const word of line.slice(8).trim().split(/ +/).filter(Boolean)) {
			if (!/^[1-9]\d{0,9}$/.test(word)) throw searchError("search");
			seqs.push(Number(word));
		}
	}
	return seqs;
}

// Attachment names from one FETCH answer. A name sent as a literal or in RFC 2231 form
// (`FILENAME*`, `FILENAME*0*`) is invisible to attachmentNamesFromBodyStructure(), and an
// unseen "Invoice" would count against the invoice look.
function attachmentNamesOf(chunk, lits) {
	const text = chunk
		.replace(LITERAL_NAME_RE, (all, key, n) => (lits[+n] ? `"${key}" ${imapQuote(lits[+n].toString("utf8").slice(0, 2000).replace(/[\r\n]+/g, " "))}` : all))
		.replace(/\u0001LIT\d{1,6}\u0001/g, "");
	const names = attachmentNamesFromBodyStructure(text);
	const open = {};
	const extended = [];
	for (const m of text.matchAll(EXTENDED_NAME_RE)) {
		const base = m[1].toLowerCase();
		if (!Number(m[2] || 0) || !open[base]) extended.push([base, (open[base] = [])]);
		open[base].push(`${base}*${m[2] || ""}${m[3] || ""}="${m[4]}"`);
	}
	for (const [base, pieces] of extended) names.push(parseParams(`x; ${pieces.join("; ")}`).params[base] || "");
	return [...new Set(names.map((name) => decodeWords(name).trim()).filter(Boolean))];
}

// One hit, read from its FETCH answer. Items are found by name: Gmail answers them in its
// own order. A blank header block is still a hit; a missing item is a failure.
function readHit(chunk, lits) {
	if (!chunk || !BODYSTRUCTURE_RE.test(chunk)) throw searchError("fetch");
	const literal = HEADER_LITERAL_RE.exec(chunk);
	if (!literal && !HEADER_BLANK_RE.test(chunk)) throw searchError("fetch");
	if (literal && !lits[+literal[1]]) throw searchError("fetch");
	const attachmentNames = attachmentNamesOf(chunk, lits);
	const block = literal ? lits[+literal[1]].toString("utf8") : "";
	if (block.length > MAX_HEADER_CHARS) return { unreadable: true, attachmentNames, date: "" };
	const headers = parseHeaders(block);
	const all = (name) => headers.get(name) || [];
	return { subject: all("subject")[0] || "", date: all("date")[0] || "", to: all("to"), cc: all("cc"), bcc: all("bcc"), attachmentNames };
}

function readHits(buf, wanted) {
	const chunks = new Map();
	let lits = [];
	for (const part of parseFetchResponse(buf)) {
		lits = part.lits;
		const seq = Number(part.seq);
		if (wanted.includes(seq)) chunks.set(seq, (chunks.get(seq) || "") + part.chunk);
	}
	return wanted.map((seq) => readHit(chunks.get(seq), lits));
}

function tally(hits, totalHits, ctx) {
	const box = { hits: totalHits, invoice: 0, mention: 0, ignored: 0, ignoredNamed: 0, overCap: totalHits - hits.length, firstInvoiceDate: null };
	let first = null;
	for (const hit of hits) {
		const read = classifyHit(hit, ctx);
		box[read.kind]++;
		if (read.kind === KIND.IGNORED && (read.namesIt || read.invoiceFile)) box.ignoredNamed++;
		if (read.kind !== KIND.INVOICE) continue;
		const at = Date.parse(hit.date);
		if (Number.isFinite(at) && (first === null || at < first)) first = at;
	}
	if (first !== null) box.firstInvoiceDate = new Date(first).toISOString();
	return box;
}

// Searches Drafts and Sent Mail (Trash too with includeTrash, by `in:trash`, since the
// web search leaves Trash out) for the load's numbers, in one read-only session.
// lastCheck adds a plain SEARCH SUBJECT per term, for a just-sent message the web search
// hasn't indexed yet.
//
// opts: { user, pass, loadNumber, invoiceNumbers?, orderNumbers?, includeTrash?, lastCheck?,
//         host?, port?, timeoutMs?, maxReaderBytes? }
// Resolves { verdict: "invoice" | "mention" | "clean", mailboxes: { drafts, sent, trash? } },
// each mailbox { hits, invoice, mention, ignored, ignoredNamed, overCap, firstInvoiceDate }.
// ignoredNamed: Ignored hits that name the load or carry an invoice-named file. overCap:
// hits past the newest 20, which were never read, so they read as doubt.
// Rejects with err.stage: credentials, terms, greeting, login, capability, examine, search
// or fetch; err.answered when the server refused; err.throttled for a throttle. Pacing
// belongs to the caller; sessions wait their turn (searchMailboxForLoad()).
function oneSession(opts) {
	const {
		user, pass, loadNumber, invoiceNumbers, orderNumbers,
		includeTrash = false, lastCheck = false,
		host = "imap.gmail.com", port = 993, timeoutMs = 60000, maxReaderBytes = MAX_READER_BYTES,
	} = opts || {};
	const ownAddress = parseFromAddress(user);
	if (!ownAddress || !pass || /[\r\n\0]/.test(`${user}${pass}`)) return Promise.reject(searchError("credentials"));
	const { terms, unsearchable } = searchTermsFor({ loadNumber, invoiceNumbers, orderNumbers });
	if (unsearchable || !terms.length) return Promise.reject(searchError("terms"));
	const boxes = includeTrash ? ["drafts", "sent", "trash"] : ["drafts", "sent"];
	const ctx = { ownAddress, terms };

	return new Promise((resolve, reject) => {
		const reader = createImapReader({ maxBytes: maxReaderBytes });
		const sock = tls.connect(port, host, { servername: host });
		let stage = "greeting";
		let tag = 0;
		let done = false;
		const finish = (err, val) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			try {
				sock.write("aZ LOGOUT\r\n");
				sock.end();
			} catch {
				/* the socket is already gone */
			}
			setTimeout(() => sock.destroy(), 2000).unref();
			err ? reject(err) : resolve(val);
		};
		const timer = setTimeout(() => finish(searchError(stage)), timeoutMs);
		sock.on("data", (d) => reader.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
		sock.on("error", () => finish(searchError(stage)));
		sock.on("close", () => finish(searchError(stage)));

		const send = async (command) => {
			tag++;
			const answer = reader.expect(new RegExp(`^a${tag} (?:OK|NO|BAD)\\b`, "i"));
			sock.write(`a${tag} ${command}\r\n`);
			const buf = await answer;
			const lines = protocolLines(buf);
			checkAnswer(lines, stage);
			return { buf, lines };
		};

		(async () => {
			const hello = (await reader.expect(GREETING_RE)).toString("latin1");
			if (!/^\* OK\b/i.test(hello) || THROTTLE_RE.test(hello)) throw searchError(stage, { answered: true, throttled: THROTTLE_RE.test(hello) });
			stage = "login";
			await send(`LOGIN ${imapQuote(user)} ${imapQuote(pass)}`);
			stage = "capability";
			const { lines } = await send("CAPABILITY");
			if (!lines.some((line) => /^\* CAPABILITY\b/i.test(line) && /(?:^| )X-GM-EXT-1(?: |$)/i.test(line))) throw searchError(stage);

			const mailboxes = {};
			for (const name of boxes) {
				stage = "examine";
				await send(`EXAMINE ${imapQuote(MAILBOXES[name])}`);
				stage = "search";
				const seqs = new Set();
				for (const term of terms) {
					const query = `${name === "trash" ? "in:trash " : ""}"${term}"`;
					for (const seq of hitsIn((await send(`SEARCH X-GM-RAW ${imapQuote(query)}`)).lines)) seqs.add(seq);
					if (!lastCheck) continue;
					for (const seq of hitsIn((await send(`SEARCH SUBJECT ${imapQuote(term)}`)).lines)) seqs.add(seq);
				}
				const ordered = [...seqs].sort((a, b) => a - b);
				const newest = ordered.slice(-MAX_HITS_FETCHED);
				stage = "fetch";
				const hits = newest.length ? readHits((await send(`FETCH ${newest.join(",")} ${FETCH_ITEMS}`)).buf, newest) : [];
				mailboxes[name] = tally(hits, ordered.length, ctx);
			}
			const all = Object.values(mailboxes);
			const verdict = all.some((b) => b.invoice) ? KIND.INVOICE : all.some((b) => b.mention || b.overCap) ? KIND.MENTION : CLEAN;
			return { verdict, mailboxes };
		})().then((val) => finish(null, val), (e) => finish(e && e.stage ? e : searchError(stage)));
	});
}

// One session at a time, whoever asks: the mailbox also sends invoices, and a session's own
// timeout bounds each turn.
let sessionLine = Promise.resolve();
let answerListener = null;

// Told each answer but a `quiet` caller's, so what a live search found can be saved. The
// search itself stores nothing. null clears it. A listener's failure never reaches the caller.
function onAnswer(listener) {
	answerListener = typeof listener === "function" ? listener : null;
}

function searchMailboxForLoad(opts) {
	const turn = sessionLine.then(() => oneSession(opts));
	sessionLine = turn.then(() => {}, () => {});
	if (opts && opts.quiet === true) return turn;
	return turn.then((answer) => {
		try {
			if (answerListener) answerListener(opts && opts.loadNumber, answer);
		} catch {
			// the caller's answer stands
		}
		return answer;
	});
}

module.exports = { searchMailboxForLoad, onAnswer, classifyHit, searchTerm, searchTermsFor, parseAddressList, KIND, CLEAN, MAILBOXES };
