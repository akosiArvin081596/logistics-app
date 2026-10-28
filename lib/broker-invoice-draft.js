// ============================================================
// Broker invoice drafts: the steps of POST /api/loads/:loadId/draft-invoice
// ============================================================
// One engine for the Super Admin's Draft Invoice button and the automatic
// drafts, so the two cannot drift.
//   prepare()  reads the load, its PODs and rate cons, and settles every field
//              and every refusal that must come before an invoice number
//              (the route's steps 1 to 6a-2, and the printed fields of 6b).
//   render()   the invoice PDF, the email and the attachments (steps 7, 7b).
//   record()   the draft row and its audit rows.
// The route keeps the override parsing, the number (minted, or peeked on a
// dry run), the dry-run answer and the Gmail / n8n send, in that order around
// these steps.
//
// mode "manual" is the button exactly. mode "auto" takes no edits, links no
// rate con, runs no by-content Drive scan and reads extra rate-con files with
// the free text scan only; anything a reviewer would have had to fix is a
// refusal carrying one of AUTO_REFUSAL_CODES.
//
// Every dependency is passed to create() by server.js (or a runner's stub).

"use strict";

// The refusals only mode "auto" makes. Its other refusals are the button's own
// (the delivered gate, the POD gates, TRAILER_MISMATCH, INVOICE_TOTAL_UNKNOWN,
// INVOICE_REFS_REQUIRED, the advance-line codes, INVOICE_RECIPIENT_UNCONFIGURED).
const AUTO_REFUSAL_CODES = Object.freeze([
	"POD_PAGE_UNREADABLE",
	"RATECON_MISSING",
	"RATECON_BY_CONTENT",
	"RATECON_TOTAL_UNREAD",
	"RECIPIENT_UNCONFIGURED",
	"NO_BILLING_EMAIL",
	"RECIPIENT_DOMAIN_MISMATCH",
	"TOTAL_MISMATCH",
	"ADVANCE_LINES",
	"NO_DELIVERY_DATE",
	"NO_BROKER_EMAIL",
	"BROKER_EMAIL_FREEMAIL",
]);

// Free and personal mail: anyone can hold an address there, so a broker Email
// on one proves nothing about who bills. Whole domains, and providers by name
// under any country suffix (yahoo.co.uk, hotmail.fr, gmx.de).
const FREE_MAIL_DOMAINS = new Set([
	"gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
	"rocketmail.com", "aol.com", "icloud.com", "me.com", "mac.com", "proton.me", "pm.me", "protonmail.com",
	"protonmail.ch", "gmx.com", "gmx.net", "mail.com", "zoho.com", "zohomail.com", "yandex.com", "yandex.ru",
	"comcast.net", "att.net", "sbcglobal.net", "bellsouth.net", "verizon.net", "cox.net", "charter.net", "earthlink.net",
]);
const FREE_MAIL_PROVIDERS = new Set([
	"gmail", "googlemail", "outlook", "hotmail", "live", "msn", "yahoo", "ymail", "aol", "icloud", "protonmail", "gmx", "zoho", "yandex",
]);
// The domain's own name, its public suffix dropped (the rule humanizeDomain()
// in lib/broker-invoice.js uses): "mail.yahoo.co.uk" -> "yahoo".
function isFreeMailDomain(domain) {
	const d = String(domain || "").toLowerCase();
	if (!d) return false;
	let labels = d.split(".").filter(Boolean);
	if (FREE_MAIL_DOMAINS.has(labels.slice(-2).join(".")) || FREE_MAIL_DOMAINS.has(labels.slice(-3).join("."))) return true;
	if (labels.length >= 3 && labels[labels.length - 1].length === 2 && /^(co|com|net|org)$/.test(labels[labels.length - 2])) labels = labels.slice(0, -2);
	else labels = labels.slice(0, -1);
	return FREE_MAIL_PROVIDERS.has(labels[labels.length - 1] || "");
}

// "Billing@Example-Broker.test" -> "example-broker.test": the part after the @,
// lowercased. "" when the value is not an email address.
function emailDomainOf(email, normalizeEmail) {
	const addr = normalizeEmail(email);
	return addr ? addr.slice(addr.lastIndexOf("@") + 1).toLowerCase() : "";
}

// The automatic path's recipient rule. Bison: its configured AP inbox only.
// Any other broker: the rate con's documents email only, and only when its
// domain is exactly the sheet's broker Email domain; a subdomain or a sister
// domain is a person's call. Rate-con text never picks a recipient on its own.
// null, or { code, error }; the message names no address.
function autoRecipientRefusal({ isBison, recipientEmail, documentsEmail, brokerEmail }, normalizeEmail) {
	if (isBison) {
		return recipientEmail ? null : { code: "RECIPIENT_UNCONFIGURED", error: "No Bison invoice address is configured (BISON_INVOICE_EMAIL)." };
	}
	if (!normalizeEmail(documentsEmail)) {
		return { code: "NO_BILLING_EMAIL", error: "The rate con names no documents email, so the invoice would go to the default inbox." };
	}
	const brokerDomain = emailDomainOf(brokerEmail, normalizeEmail);
	if (!brokerDomain || emailDomainOf(recipientEmail, normalizeEmail) !== brokerDomain) {
		return { code: "RECIPIENT_DOMAIN_MISMATCH", error: "The rate con's documents email is not on the broker's own email domain." };
	}
	return null;
}

// Whole cents, so two money figures compare without float noise.
const cents = (n) => Math.round(Number(n || 0) * 100);

function create(deps) {
	const {
		db,
		brokerInvoice,
		getSheets,
		SPREADSHEET_ID,
		parseSheet,
		deduplicateLoads,
		findCol,
		parseInvoiceOverrides,
		fetchDocumentBytes,
		buildRateConLoadCtx,
		getRateConBytes,
		GEMINI_API_KEY,
		runRateConGemini,
		latestDraftNotes,
		renderHtmlToPdf,
		safeAttachmentName,
		logAudit,
		sanitizeEvidenceText,
		// The flag reads (BROKER_INVOICE_LINES_ENABLED) see the server's own env.
		env = process.env,
		// Injectable so a runner can read what a draft logs.
		console = globalThis.console,
	} = deps;

	// The automatic job knows a busy renderer as RENDERER_BUSY (a retry, not an
	// attempt); the route's 503 keys on the renderer's own PDF_RENDERER_BUSY.
	const rendererFor = (mode) => (mode !== "auto" ? renderHtmlToPdf : async (html) => {
		try {
			return await renderHtmlToPdf(html);
		} catch (e) {
			if (e && e.code === "PDF_RENDERER_BUSY") e.code = "RENDERER_BUSY";
			throw e;
		}
	});

	// The automatic path's POD lookup: either spelling of the load ID ("#id" or
	// "id", any case), normLoadKey()'s rule, so a spelling difference between
	// the sheet and the upload is not a missing POD. Page order as the button's.
	const podDocsByKey = (loadId) => {
		const key = String(loadId || "").trim().toLowerCase().replace(/^#/, "");
		return db
			.prepare(
				"SELECT * FROM documents WHERE LOWER(TRIM(load_id)) IN (?, ?) AND UPPER(type) = 'POD' AND deleted_at IS NULL ORDER BY uploaded_at ASC, id ASC",
			)
			.all(key, `#${key}`);
	};

	// Active advance lines on a load, whatever the lines flag: the table stays
	// once the flag has been on, and an automatic draft must never bill a load
	// that carries one. 0 when the table was never made.
	const activeAdvanceLines = (loadId) => {
		const invoiceLines = brokerInvoice.invoiceLines;
		if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(invoiceLines.TABLE)) return 0;
		return invoiceLines.listLines(db, loadId).filter((line) => !line.voided).length;
	};

	// A rate con an earlier by-content match linked to the load
	// (rememberRateConMatch(): a RATECON row with a Drive id and no local file,
	// a shape no other writer leaves) is served back as "documents", fully
	// trusted. The automatic path treats it as found by content. Same two keys
	// as getRateConBytes() step 2.
	const storedContentMatch = (loadId) => {
		const raw = String(loadId || "").trim();
		const keys = [...new Set([raw, raw.replace(/^#/, "").trim()].filter(Boolean))];
		return !!db
			.prepare(
				`SELECT 1 FROM documents WHERE load_id IN (${keys.map(() => "?").join(",")}) AND UPPER(type) = 'RATECON'
				 AND COALESCE(drive_url, '') = '' AND COALESCE(drive_file_id, '') != '' AND deleted_at IS NULL LIMIT 1`,
			)
			.get(...keys);
	};

	return {
		// { ok: true, ctx } or { ok: false, http, json, code, geminiUnavailable }.
		// `ov` and `lineSel` are the route's parsed overrides and advance-line
		// selection; mode "auto" ignores them and the body.
		async prepare({ loadId, body, dryRun, mode = "manual", ov, lineSel = null, req = null }) {
			if (mode !== "manual" && mode !== "auto") throw new Error(`broker-invoice-draft: unknown mode "${mode}"`);
			const auto = mode === "auto";
			// A dry run skips the refusals an approve makes, so an automatic
			// preview would show drafts the job itself refuses.
			if (auto && dryRun) throw new Error("broker-invoice-draft: mode \"auto\" never dry-runs");
			if (auto) {
				ov = parseInvoiceOverrides({});
				lineSel = null;
				body = null;
			} else if (!ov || !ov.ok) {
				throw new Error("broker-invoice-draft: the route validates the overrides before prepare()");
			}
			const invoiceLines = brokerInvoice.invoiceLines;
			const linesOn = invoiceLines.linesEnabled(env);
			// Set by onGeminiError (step 4); declared first so every refusal says
			// whether Gemini was down when it was reached.
			let geminiUnavailable = null;
			// The code of a refusal whose answer has none (load, delivered, POD):
			// set just before it, so the job can tell waiting from refused while
			// the route's JSON stays as it was.
			let refusalCode = "";
			const refused = (http, json) => ({ ok: false, http, json, code: json.code || refusalCode, geminiUnavailable: !!geminiUnavailable });
			// The route's own res.status(code).json(body), so the steps below read
			// as they did in the route: a refusal is handed back, never sent.
			const res = { status: (http) => ({ json: (json) => refused(http, json) }) };
			const autoRefused = (code, error) => refused(422, { error, code });

			// 1) Look up the load in the Job Tracking sheet by loadId.
			const sheets = await getSheets();
			const resp = await sheets.spreadsheets.values.get({
				spreadsheetId: SPREADSHEET_ID,
				range: "Job Tracking",
			});
			const parsed = parseSheet({ values: resp.data.values });
			const rows = deduplicateLoads(parsed.data, parsed.headers);
			const headers = parsed.headers;
			const loadIdCol = findCol(headers, /load.?id|job.?id/i);
			if (!loadIdCol) return res.status(500).json({ error: "Sheet misconfigured" });
			const target = loadId.toLowerCase().replace(/^#/, "");
			const load = rows.find(
				(r) => (r[loadIdCol] || "").toString().trim().toLowerCase().replace(/^#/, "") === target,
			);
			if (!load) {
				refusalCode = "LOAD_NOT_FOUND";
				return res.status(404).json({ error: "Load not found" });
			}

			// Resolve the columns we need from the sheet.
			const emailCol = findCol(headers, /^email$/i) || findCol(headers, /broker.*email|email/i);
			const statusCol = findCol(headers, /^status$/i) || findCol(headers, /status/i);
			const trailerCol = findCol(headers, /trailer/i);
			const deliveryDateCol =
				headers.find((h) => /status.*update.*date|completion.*date/i.test(h)) ||
				headers.find((h) => /drop.?off.*date|drop.?off.*appoint|deliv.*date|deliv.*appoint/i.test(h));
			const driverCol = findCol(headers, /^driver$/i) || findCol(headers, /driver/i);
			const brokerNameCol = findCol(headers, /broker.*(contact|name)/i);
			// The money column is literally "  Payment  " (real surrounding
			// spaces) — matched on the trimmed header inside the helper.
			const paymentCol = brokerInvoice.findPaymentColumn(headers);

			const brokerEmail = emailCol ? (load[emailCol] || "").toString().trim() : "";
			const brokerContactName = brokerNameCol ? (load[brokerNameCol] || "").toString().trim() : "";
			const status = statusCol ? (load[statusCol] || "").toString().trim() : "";
			const sheetTrailer = trailerCol ? (load[trailerCol] || "").toString().trim() : "";

			// 2) Broker identity. Every broker can be invoiced now — the Bison
			//    check is a BRANCH (it picks the AP inbox), no longer a gate.
			//    The sheet has no brokerage-company column, so the name is
			//    resolved from the email domain; see lib/broker-invoice.js.
			const brokerCtx = { brokerEmail, brokerContactName };
			const isBison = brokerInvoice.isBisonLoad({ email: brokerEmail });
			const brokerName = brokerInvoice.resolveBrokerName(brokerCtx);
			let invoiceTo = brokerInvoice.resolveInvoiceTo(brokerCtx);

			//    The delivered/completed gate is unchanged.
			if (!/delivered|completed|pod received/i.test(status)) {
				refusalCode = "NOT_COMPLETED";
				return res.status(400).json({
					error: `Load must be delivered/completed to draft an invoice (current status: "${status || "unknown"}").`,
				});
			}
			// An automatic draft needs the broker's own mail domain on the sheet:
			// no readable one, or a free-mail one, is a person's call.
			if (auto) {
				const brokerDomain = emailDomainOf(brokerEmail, brokerInvoice.normalizeEmail);
				if (!brokerDomain) return autoRefused("NO_BROKER_EMAIL", `Load ${loadId} has no broker email address in Job Tracking.`);
				if (isFreeMailDomain(brokerDomain)) return autoRefused("BROKER_EMAIL_FREEMAIL", `Load ${loadId}'s broker email is on a free-mail domain.`);
			}

			// 3) Get the POD + rate-con bytes (server-side).
			//
			// EVERY POD, not just the newest. A proof packet routinely arrives as
			// several files (driver photographs the signed BOL page by page), and
			// this used to be `ORDER BY uploaded_at DESC LIMIT 1` — which silently
			// billed brokers with a one-page fragment of a three-page proof and got
			// invoices rejected. 14 of 85 loads with a POD have more than one.
			//
			// ASC = upload order = page order (id breaks ties: uploaded_at only has
			// second granularity and a burst of page uploads can share a second).
			const podDocs = auto
				? podDocsByKey(loadId)
				: db
					.prepare(
						"SELECT * FROM documents WHERE load_id = ? AND UPPER(type) = 'POD' AND deleted_at IS NULL ORDER BY uploaded_at ASC, id ASC",
					)
					.all(loadId);
			if (!podDocs.length) {
				refusalCode = "POD_NOT_FOUND";
				return res.status(400).json({ error: "POD not found for this load" });
			}

			// Fetch sequentially — these are local /uploads reads in the common case,
			// and the Drive fallback is rate-limited enough that a parallel fan-out
			// buys nothing. A row whose bytes are unreadable is dropped rather than
			// failing the whole draft, but it IS surfaced to the caller (below), so a
			// missing page is never silently omitted a second time.
			const podFiles = [];
			const podMissing = [];
			for (const d of podDocs) {
				const buf = await fetchDocumentBytes(d);
				if (buf && buf.length) podFiles.push({ doc: d, buffer: buf });
				else podMissing.push(d.file_name || String(d.id));
			}
			if (!podFiles.length) {
				refusalCode = "POD_NOT_FOUND";
				return res.status(400).json({ error: "POD not found for this load" });
			}
			if (podMissing.length) {
				console.warn(
					`Draft invoice ${loadId}: ${podMissing.length} of ${podDocs.length} POD file(s) unreadable, attaching ${podFiles.length} — ${podMissing.join(", ")}`,
				);
			}
			// An automatic draft never goes out with a page of the proof missing.
			if (auto && podMissing.length) {
				return autoRefused("POD_PAGE_UNREADABLE", `${podMissing.length} of ${podDocs.length} POD file(s) on load ${loadId} could not be read.`);
			}

			// Attachment names. A single POD keeps its EXACT historical name — the
			// overwhelming majority of loads, and "1 of 1" would be noise a broker
			// has to parse. Multi-POD gets "POD_2_of_3_<loadId>.pdf" so an AP clerk
			// can see at a glance whether the packet is complete.
			const podSafeLoadId = String(loadId).replace(/[^A-Za-z0-9._-]/g, "_");
			const podAttachments = podFiles.map((f, i) => ({
				filename:
					podFiles.length === 1
						? f.doc.file_name || `${podSafeLoadId}_POD.pdf`
						: `POD_${i + 1}_of_${podFiles.length}_${podSafeLoadId}.pdf`,
				content: f.buffer,
				contentType: "application/pdf",
			}));
			// Back-compat aliases for the single-POD consumers further down.
			const podDoc = podFiles[0].doc;
			const podBuffer = podFiles[0].buffer;

			// Facts about this load from a source OTHER than the rate-con, so the
			// by-content fallback has something independent to check a match
			// against. Built by the shared helper so this route and the bulk
			// backfill cannot disagree about which facts the matcher gets.
			const rateconLoadCtx = buildRateConLoadCtx(load, headers, loadId);
			// ⚠️ persist:false ON A PREVIEW. This route is documented as previewing
			// "without burning an invoice number or creating a draft", and a preview
			// that permanently links a guessed document to a load breaks that
			// promise: a dispatcher who opens the modal, sees the wrong rate-con and
			// CANCELS has already written the link, and every later draft is then
			// served from `documents` with no rescan and no second look.
			// The automatic path reads no request body, passes no load facts (so no
			// by-content scan runs) and links nothing.
			const { buffer: rateconBuffer, candidates: rateconCandidates } = auto
				? await getRateConBytes(loadId, null, null, { persist: false })
				: await getRateConBytes(loadId, body, rateconLoadCtx, { persist: !dryRun, req });
			// What a rate con may supply is rateconSourceTrust()'s call: no source
			// that may supply fields is no rate con; one that may not pick the
			// recipient was found by reading Drive files, which a person checks.
			if (auto) {
				const primaryTrust = brokerInvoice.rateconSourceTrust(((rateconCandidates || [])[0] || {}).source);
				if (!rateconBuffer || !rateconBuffer.length || !primaryTrust.fields) {
					return autoRefused("RATECON_MISSING", `No rate con on file for load ${loadId}.`);
				}
				if (!primaryTrust.recipient || storedContentMatch(loadId)) {
					return autoRefused("RATECON_BY_CONTENT", `Load ${loadId}'s rate con was found only by reading Drive files.`);
				}
			}
			// Say so plainly. The invoice still drafts without one (POD + the
			// sheet's Payment column carry it), but brokers generally require the
			// rate-con alongside the invoice, so an unattached one is the reason a
			// payment later stalls. The preview modal warns the reviewer too.
			if (!rateconBuffer || !rateconBuffer.length) {
				console.warn(
					`Draft invoice ${loadId}: no rate-con found (Drive folder by name, documents table, request body and Drive folder by content all empty) — drafting without it.`,
				);
			}

			// 4) Extract the rate-con fields (deterministic text scan → Gemini fallback).
			//    The Gemini fallback reuses the shared runRateConGemini() helper.
			//    NOTE: only the Bison rate-con has the "Billing Information" block
			//    the deterministic scan understands — every OTHER broker takes the
			//    Gemini path, so it is the primary path now, not an edge case
			//    (verified against real C.H. Robinson / Navisphere rate-cons).
			const geminiExtract = GEMINI_API_KEY
				? async (buf) => {
						// Defensive: extractRateConFields already skips the call when
						// there are no bytes, but this wrapper is the seam a future
						// caller reaches for, and Buffer.from(null) throws.
						if (!buf || !buf.length) return null;
						const b64 = Buffer.from(buf).toString("base64");
						if (!/^JVBERi/.test(b64)) return null;
						return runRateConGemini(b64);
				  }
				: null;
			// This route already degrades correctly on a Gemini failure —
			// extractRateConFields returns empty fields, the total falls back to the
			// sheet's Payment column and the order number to the load ID — so there is
			// no status to change here. Two things are free, and only those:
			// (a) NAME the failure in the log. "Gemini fallback failed" on a dead key
			//     reads as a parsing problem, which is what sent 2026-08-05's outage to
			//     the wrong diagnosis for a day.
			// (b) latch it (geminiUnavailable, declared at the top), so the
			//     alternate-rate-con loop below stops re-calling a scanner that is
			//     refusing everything.
			const onGeminiError = (e) => {
				if (e && e.kind === "unavailable") {
					geminiUnavailable = e;
					console.error(`Draft invoice: Gemini fallback unavailable (Gemini ${e.status}${e.reason ? " " + e.reason : ""}):`, e.message);
					return;
				}
				console.error("Draft invoice: Gemini fallback failed:", e.message);
			};
			// ⚠️ WHAT A CANDIDATE MAY SUPPLY IS DECIDED BY ITS SOURCE, IN ONE PLACE.
			// brokerInvoice.readRateConCandidates() applies rateconSourceTrust() to the
			// primary AND to the alternate-recipient loop below it, so the two cannot
			// drift. Do not call extractRateConFields() on a candidate directly here.
			//
			// A load can have MULTIPLE rate-con files (the original + a "Re:" reply, or
			// a signed scan). getRateConBytes returns the newest as the primary, but the
			// billing / "send documents to" email may live on ANOTHER file — so if the
			// primary yielded none, the reader checks the other candidates and takes the
			// first that does. Prevents defaulting the invoice to the wrong inbox (client
			// 2026-07-30: Steam Logistics load 2214407 — carrierdocs@steamlogistics.com
			// was only on the original file, not the newer "Re:" scan).
			//
			// ⚠️ A DOCUMENT WE FOUND BY INFERENCE MAY NOT CHOOSE WHERE MONEY IS SENT.
			// For every non-Bison broker `documentsEmail` becomes the Gmail To:, so a
			// content-matched file that turned out to belong to someone else would
			// mail this invoice — and that customer's rate — to an address lifted off
			// THEIR paperwork. 'drive-content' may therefore fill in fields but never
			// the recipient. Bison is pinned regardless, so this only ever affects the
			// brokers where it matters.
			//
			// ⚠️ ONLY RATE-CON ROWS in `documents` are trusted, and the trust is in who
			// writes them: POST /api/loads/from-ratecon (a Super Admin or Dispatcher
			// creating the load FROM that PDF), rememberRateConMatch() (a Super
			// Admin's non-preview request on this route found the file by content —
			// normally the approve after the review modal showed it — or a Super
			// Admin applied the backfill), and an upload typed as a rate-con,
			// which POST /api/documents/upload's type list keeps to Super Admin
			// (uploadDocTypeFor()). A BOL row is
			// not a rate-con: getRateConBytes() tags it 'documents-bol', and nothing —
			// no total, no order/PO/move #, no trailer, no recipient — is read from
			// it. It is only attached, as a supporting document, when no rate-con
			// exists at all.
			const rcRead = await brokerInvoice.readRateConCandidates(
				rateconCandidates,
				(buf, { alternate } = {}) =>
					brokerInvoice.extractRateConFields(buf, {
						brokerEmail, // exclude the booking agent's own email from documents-email detection
						// On an ALTERNATE read, drop only the GEMINI half once the key is
						// refusing — the documents email that loop hunts for comes from the
						// deterministic text scan, so skipping the read would throw away a
						// recovery that never needed Gemini. null keeps the free scan. The
						// automatic path reads every alternate with the free scan only.
						geminiExtract: alternate && (auto || geminiUnavailable) ? null : geminiExtract,
						onGeminiError,
					}),
				{ onAlternateError: (e) => console.error("Draft invoice: alternate rate-con extract failed:", e.message) },
			);
			const rcFields = rcRead.fields;
			if (rcRead.primarySource && !rcRead.primaryRead) {
				console.warn(
					`Draft invoice ${loadId}: no rate-con on file, only a ${rcRead.primarySource} document — attaching it as supporting paperwork and reading nothing from it.`,
				);
			}
			if (rcRead.recipientIgnored) {
				console.warn(
					`Draft invoice ${loadId}: ignoring the documents email on a ${rcRead.primarySource} rate-con — recipient falls back to the broker default.`,
				);
			}
			if (rcRead.recipientFrom > 0) {
				console.log(`Draft invoice ${loadId}: documents email recovered from an alternate rate-con file (of ${rateconCandidates.length} candidates).`);
			}

			// Recipient: the rate-con's "email documents to" address wins over the
			// configured default (drives both the Gmail To: and the printed
			// "Invoice To" block); falls back to BISON_INVOICE_EMAIL /
			// DEFAULT_INVOICE_EMAIL when absent, and to "" when that setting is
			// missing (refused below, step 6a-2, before anything is minted).
			invoiceTo = brokerInvoice.resolveInvoiceTo({ ...brokerCtx, documentsEmail: rcFields.documentsEmail });
			if (auto) {
				const recipientRefusal = autoRecipientRefusal(
					{ isBison, recipientEmail: invoiceTo.email, documentsEmail: rcFields.documentsEmail, brokerEmail },
					brokerInvoice.normalizeEmail,
				);
				if (recipientRefusal) return autoRefused(recipientRefusal.code, recipientRefusal.error);
			}

			// The review-before-approve preview sends the recipient the dispatcher SAW
			// back on approve, pinning it — so a nondeterministic Gemini re-run on the
			// commit can't silently re-route the draft to a different address than the
			// one that was reviewed. Classify "manual" only when the override actually
			// DIFFERS from what extraction resolved (an unchanged confirm keeps the
			// ratecon/default badge). An invalid/empty override is ignored.
			const resolvedEmail = invoiceTo.email;
			const resolvedInvoiceToName = invoiceTo.name;
			const recipientOverride = ov.has.recipientEmail ? ov.values.recipientEmail : "";
			let recipientSource = rcFields.documentsEmail ? "ratecon" : "default";
			if (recipientOverride) {
				if (recipientOverride.toLowerCase() !== String(resolvedEmail).toLowerCase()) recipientSource = "manual";
				invoiceTo = { name: invoiceTo.name, email: recipientOverride };
			}
			// The "Invoice To" NAME is separately overridable now. It is a different
			// fact from the address — resolveInvoiceTo() labels the block from the
			// RECIPIENT's domain, so the two legitimately diverge — which is exactly
			// why recipient_source above is left alone and keeps meaning "provenance
			// of the email address" and nothing else.
			if (ov.has.billToName) invoiceTo = { name: ov.values.billToName, email: invoiceTo.email };

			// 4b) Invoice reference number. Per client (2026-07-30): ONLY Bison
			//     invoices carry the broker's rate-con Order # (Bison AP matches on
			//     it). EVERY other broker is invoiced by our Load Number, so a
			//     non-Bison rate-con Order # is deliberately ignored here. Bison
			//     still falls back to the load ID when its rate-con had no Order #.
			const loadRef = loadId.replace(/^#/, "").trim();
			const derivedOrderNumber = isBison ? (rcFields.orderNumber || loadRef) : loadRef;
			// The dispatcher's correction wins — this is the field Gemini most often
			// gets one digit wrong on, and it is what broker AP matches against.
			const orderNumber = ov.has.orderNumber ? ov.values.orderNumber : derivedOrderNumber;
			// ⚠️ REPORTED, not just logged. A console.log was the ONLY signal that
			// the Order # had silently become our load id, so the review modal
			// rendered a populated, entirely normal-looking field and the wrong
			// number shipped. The reviewer cannot catch what nothing tells them.
			// 'load-number' is NOT a failure — it is the designed behaviour for every
			// non-Bison broker (PR #132), which is invoiced by OUR load number. It
			// gets its own value because reporting it as 'ratecon' was simply untrue:
			// the number never came from the document, and this field is the one
			// thing a reviewer is meant to be able to trust about provenance.
			const orderNumberSource = ov.has.orderNumber
				? "override"
				: !isBison
					? "load-number"
					: (rcFields.orderNumber ? "ratecon" : "load-id-fallback");
			if (isBison && !rcFields.orderNumber) {
				console.log(
					`Draft invoice ${loadId}: no order # from the Bison rate-con (gemini=${GEMINI_API_KEY ? "on" : "off"}) — falling back to the load ID.`,
				);
			}

			// 5) Validation: rate-con trailer must match the load's stored trailer.
			//    On mismatch, do NOT call n8n — return 409 so the frontend can alert.
			//    Only compare when the extracted trailer actually looks like a
			//    trailer id (contains a digit): a guard that blocks on garbage is
			//    worse than no guard, and prose like "Trailer Required" has been
			//    seen leaking out of loosely-labelled rate-cons.
			const normTrailer = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
			const rcTrailerUsable = /\d/.test(String(rcFields.trailerNumber || ""));
			if (sheetTrailer && rcTrailerUsable && normTrailer(sheetTrailer) !== normTrailer(rcFields.trailerNumber)) {
				return res.status(409).json({
					error: `Trailer mismatch: rate-con says ${rcFields.trailerNumber} but the load is on trailer ${sheetTrailer}. Invoice not drafted.`,
					code: "TRAILER_MISMATCH",
					details: { rateconTrailer: rcFields.trailerNumber, loadTrailer: sheetTrailer },
				});
			}

			// 6) Invoice total: the rate-con's Total Rate, else the load's
			//    "  Payment  " cell from the sheet. HARD STOP when neither
			//    yields a positive number — this endpoint moves money, and a
			//    $0.00 invoice mailed to a broker is worse than an error.
			const rcTotal = brokerInvoice.parseMoney(rcFields.totalRate);
			const sheetTotal = paymentCol ? brokerInvoice.parseMoney(load[paymentCol]) : 0;
			const derivedTotal = rcTotal > 0 ? rcTotal : sheetTotal;
			// A SUPPLIED total satisfying this guard IS the feature: extraction
			// fails, the dispatcher types 2100.00, the invoice drafts. But the
			// guarantee shifts from "the server proved a number exists" to "a human
			// typed a number", so the number is RE-DERIVED through the same format
			// gate / >= $0.01 floor / $1,000,000 ceiling in parseInvoiceOverrides()
			// rather than trusted. It is never skipped.
			//
			// ⚠️ An overridden total is INVOICE-ONLY. Nothing here writes back to the
			// Job Tracking "  Payment  " column, so revenue, driver pay, investor
			// payouts and the P&L keep reading the sheet exactly as they do today and
			// no closed month can be restated by an invoice correction. The
			// divergence is RECORDED instead (total_source / sheet_total /
			// ratecon_total below). Owner decision — do not "helpfully" sync it.
			const totalAmount = ov.has.total ? ov.values.total : derivedTotal;
			const totalSource = ov.has.total ? "manual" : (rcTotal > 0 ? "ratecon" : (derivedTotal > 0 ? "sheet" : "unknown"));
			const needsTotal = !(totalAmount > 0);
			// ⚠️ RELAXED FOR dryRun ONLY, and that relaxation is the blocker fix.
			// The review modal opens exclusively via ?dryRun=1, so while this 422
			// fired ahead of the preview response the dispatcher never saw a form to
			// type the missing total INTO — precisely in the case this feature exists
			// for. The preview instead returns 200 with needsTotal:true and skips the
			// render entirely, so no $0.00 LogisX PDF is ever produced. The real
			// approve keeps the hard 422 unchanged, and the delivered gate, both POD
			// gates and the trailer 409 above are all untouched.
			if (needsTotal && !dryRun) {
				return res.status(422).json({
					error:
						`Invoice total is unknown for load ${loadId} — the rate-con had no readable Total Rate` +
						(paymentCol ? ` and the sheet's ${paymentCol.trim()} column is empty` : " and the sheet has no payment column") +
						". Refusing to draft a $0.00 invoice. Add the rate to the load, then retry." +
						(GEMINI_API_KEY ? "" : " (Rate-con AI extraction is not configured on this server.)"),
					code: "INVOICE_TOTAL_UNKNOWN",
				});
			}
			// The button bills the rate con's total, else the sheet's; an automatic
			// draft bills only a total read off the rate con (not after a Gemini
			// error, a Gemini answer without one, or no Gemini key) that agrees
			// with the sheet.
			if (auto && !(rcTotal > 0)) {
				return autoRefused("RATECON_TOTAL_UNREAD", `No total could be read off load ${loadId}'s rate con.`);
			}
			if (auto && cents(rcTotal) !== cents(sheetTotal)) {
				return autoRefused("TOTAL_MISMATCH", `The rate con's total and Job Tracking's Payment differ on load ${loadId}.`);
			}

			// 6a) REFERENCE NUMBERS ON A BISON INVOICE — the same shape as the
			//     total guard above, for the same reason, and it must live HERE:
			//     the route calls nextInvoiceNumber() as soon as prepare() returns,
			//     so a refusal placed after it would burn an invoice number on
			//     every attempt.
			//
			//     ⚠️ WHY THIS IS A HARD STOP AND NOT A WARNING. Bison AP matches
			//     payment to their Order #. When the rate-con cannot be read, the
			//     order number silently becomes OUR load id — a number that looks
			//     entirely valid to the clerk reading it and matches nothing on
			//     their side, while the "…& PO #…" sentence vanishes from the body
			//     because buildInvoiceEmailHtml() omits refs it does not have.
			//     That is exactly what shipped on load 30080873 on 2026-08-18, and
			//     a modal warning did not stop it. Owner's call: require a human to
			//     type both rather than mail a plausible wrong number.
			//
			//     Bison ONLY. Every other broker is invoiced by our load number by
			//     design (PR #132) and its cover note carries no PO language at all
			//     (PR #133), so there is nothing to be wrong about.
			//
			//     An explicitly-sent EMPTY poNumber satisfies this — clearing a
			//     field is a decision, omitting it is not. Same OMITTED-vs-EMPTY
			//     rule parseInvoiceOverrides() already enforces.
			//     ⚠️ THE SEED IS HALF THE GUARD, and without it the guard is
			//     decorative. `buildOverrideBody()` sends `orderNumber` on EVERY
			//     request ("always sent"), seeded from this route's own dryRun
			//     echo — so if that echo carries the load-id fallback, the modal
			//     hands it straight back, `ov.has.orderNumber` is true, and the
			//     422 below can never fire on the one path every dispatcher uses.
			//     Blanking the echo (the route's dryRun answer, beside `totalAmount`) is what
			//     makes the block real: an empty Order # fails the modal's own
			//     required-field validation AND parseInvoiceOverrides' non-empty
			//     rule, so nothing reaches the 422 by accident. This mirrors
			//     `needsTotal`, which has always blanked `totalAmount` for exactly
			//     this reason — the refs guard originally copied the flag and not
			//     the seed, which is the whole difference between the two.
			const refsUnreadable = isBison && !rcFields.orderNumber;
			const needsOrderNumber = refsUnreadable && !ov.has.orderNumber;
			const needsPoNumber = refsUnreadable && !ov.has.poNumber;
			if ((needsOrderNumber || needsPoNumber) && !dryRun) {
				return res.status(422).json({
					error:
						`Could not read the Order # from the rate-con for load ${loadId}, so this Bison invoice ` +
						`would go out referencing our load id instead — Bison AP matches on their Order #, not ours. ` +
						`Enter the Order # and PO # from the rate-con, then approve.` +
						(GEMINI_API_KEY ? "" : " (Rate-con AI extraction is not configured on this server.)"),
					code: "INVOICE_REFS_REQUIRED",
					details: { needsOrderNumber, needsPoNumber, rateconFound: !!(rateconBuffer && rateconBuffer.length) },
				});
			}

			// An automatic draft never prints advance lines: a load that carries one
			// is drafted by hand.
			if (auto && activeAdvanceLines(loadId) > 0) {
				return autoRefused("ADVANCE_LINES", `Load ${loadId} has an advance line.`);
			}
			// 6a-1) ADVANCE LINES (B20). Below the refs guard and above
			//     nextInvoiceNumber(), for the guards' own reason: a refusal after
			//     the mint would burn an invoice number. The line haul is this route's
			//     own base (the rate con's Total Rate, else the sheet's Payment); a
			//     typed total that differs from it is refused beside a line, since it
			//     would take the advance off twice. On ?dryRun=1 a refusal is reported
			//     in the answer's invoiceLines.error and nothing is rendered, so the
			//     editor still opens and the lines can be unticked. INVOICE-ONLY: the
			//     balance due is billed; Job Tracking's Payment and every settlement
			//     figure keep the line haul.
			let lineResolved = null;
			if (linesOn) {
				lineResolved = invoiceLines.resolveInvoiceLines(db, {
					loadId,
					selection: lineSel,
					derivedLineHaul: derivedTotal,
					lineHaulSource: rcTotal > 0 ? "ratecon" : "sheet",
					typedTotal: ov.has.total ? ov.values.total : null,
				});
				if (!lineResolved.ok && !dryRun) {
					return res.status(lineResolved.status).json({
						error: lineResolved.error, code: lineResolved.code, ...(lineResolved.lineId ? { lineId: lineResolved.lineId } : {}),
					});
				}
			}
			const lineSummary = lineResolved && lineResolved.ok ? lineResolved.summary : null;
			const lineRefused = !!(lineResolved && !lineResolved.ok);

			// 6a-2) A RECIPIENT. The default AP inboxes are settings with no default
			//     in code (BISON_INVOICE_EMAIL, DEFAULT_INVOICE_EMAIL), so on a server
			//     without the one this load needs, and with no rate-con address or
			//     reviewer-typed recipient, To is empty. No draft is created with an
			//     empty To: refused HERE, before the route's nextInvoiceNumber(), so nothing
			//     is minted, rendered, drafted or recorded. The dryRun still answers
			//     (with an empty recipient) so the review can collect one, exactly as
			//     it collects a missing total.
			if (!invoiceTo.email && !dryRun) {
				const setting = isBison ? "BISON_INVOICE_EMAIL" : "DEFAULT_INVOICE_EMAIL";
				return res.status(503).json({
					error:
						`No recipient for the invoice on load ${loadId}: this server has no ${isBison ? "Bison" : "default"} ` +
						`invoice address configured (${setting}). Enter the recipient's email in the review, then approve.`,
					code: "INVOICE_RECIPIENT_UNCONFIGURED",
				});
			}

			// 6b) The printed fields. deliveryDate is the load's ACTUAL
			//    delivery/completion date from the sheet — never today, never the
			//    rate-con scheduled date. (The invoice # and date are the caller's.)
			const rawDeliveryDate = deliveryDateCol ? (load[deliveryDateCol] || "").toString().trim() : "";
			const derivedDeliveryDate = brokerInvoice.formatDate(rawDeliveryDate);
			const deliveryDate = ov.has.deliveryDate ? ov.values.deliveryDate : derivedDeliveryDate;
			if (auto && !derivedDeliveryDate) {
				return autoRefused("NO_DELIVERY_DATE", `Load ${loadId} has no delivery date in Job Tracking.`);
			}
			// ⚠️ isBison is NOT recomputed from an edited broker name. It derives from
			// the broker EMAIL above and drives the AP inbox, the Bison-vs-generic
			// cover letter and the Bison filename — editing a display name must never
			// flip the email template or the routing.
			const effBrokerName = ov.has.brokerName ? ov.values.brokerName : brokerName;
			const derivedPoNumber = rcFields.poNumber || "";
			const poNumber = ov.has.poNumber ? ov.values.poNumber : derivedPoNumber;
			const derivedMoveNumber = rcFields.moveNumber || "";
			const moveNumber = ov.has.moveNumber ? ov.values.moveNumber : derivedMoveNumber;
			// Notes: omitted → the last APPROVED note for this load; "" → cleared.
			// The same omitted-vs-empty rule as every field above. PDF only — the
			// cover email is untouched, and nothing here reaches Job Tracking.
			const derivedNotes = latestDraftNotes(loadId);
			const notes = ov.has.notes ? ov.values.notes : derivedNotes;
			// "" on the needsTotal dryRun — never "$0.00", which reads as a real
			// figure the reviewer might approve.
			const total = needsTotal ? "" : brokerInvoice.formatMoney(totalAmount);
			// What the draft bills: the balance due when advance lines print (B20),
			// else the total. `total` above stays the line haul.
			const billedTotal = lineSummary ? invoiceLines.formatCents(lineSummary.balanceCents) : total;

			return {
				ok: true,
				ctx: {
					mode, loadId, loadRef, ov, geminiUnavailable: !!geminiUnavailable,
					brokerEmail, isBison, brokerName, effBrokerName,
					invoiceTo, resolvedEmail, resolvedInvoiceToName, recipientSource,
					podAttachments, podMissing, podBuffer,
					rateconBuffer, rateconCandidates, rcFields, sheetTrailer, rcTrailerUsable, normTrailer,
					orderNumber, derivedOrderNumber, orderNumberSource, needsOrderNumber, needsPoNumber,
					rcTotal, sheetTotal, derivedTotal, totalAmount, totalSource, needsTotal, total, billedTotal,
					lineResolved, lineSummary, lineRefused,
					deliveryDate, derivedDeliveryDate, poNumber, derivedPoNumber, moveNumber, derivedMoveNumber,
					notes, derivedNotes,
				},
			};
		},

		// The invoice PDF and the email for a prepared draft. `emailBody` is the
		// reviewer's edited message, or null for the generated one. The answer
		// also carries the Gmail draft's own fields: { to, subject, html, attachments,
		// total } (total: the billed figure as printed).
		async render(ctx, { invoiceId, invoiceDate, emailBody: editedEmailBody = null }) {
			const {
				effBrokerName, invoiceTo, orderNumber, poNumber, deliveryDate, lineSummary, total, billedTotal, notes,
				needsTotal, lineRefused, isBison, loadRef, needsOrderNumber, moveNumber, podAttachments, rateconBuffer,
			} = ctx;
			const invoiceLines = brokerInvoice.invoiceLines;
			const renderHtmlToPdf = rendererFor(ctx.mode);

			// 7) Render the invoice PDF. Skipped entirely when no total could be
			//    derived AND none was supplied (dryRun only — see prepare()'s guard):
			//    there is nothing honest to print, and a rendered $0.00 invoice is
			//    the one artifact this route has always refused to create. Skipped
			//    too on a dryRun whose advance lines were refused (6a-1).
			let invoicePdf = null;
			let invoicePdfBase64 = "";
			if (!needsTotal && !lineRefused) {
				const invoiceHtml = brokerInvoice.buildInvoiceHtml({
					invoiceId,
					invoiceDate,
					brokerName: effBrokerName,
					invoiceTo,
					orderNumber,
					poNumber,
					deliveryDate,
					invoiceLines: lineSummary,
					total,
					notes,
				});
				invoicePdf = await renderHtmlToPdf(invoiceHtml);
				invoicePdfBase64 = Buffer.from(invoicePdf).toString("base64");
			}

			// 7b) Build the standard invoice email (body + signature) — the same
			//     content the draft carries. For a Bison load brokerName is
			//     "Bison Transport", so the subject renders exactly as before.
			//     One builder for this route and the preview — see
			//     buildInvoiceSubject() for why it is plain text, never esc()'d.
			//     The message is the dispatcher's edit when one was sent, else the
			//     generated one; emailBodyDefault is that generated one, which the
			//     editor shows until somebody types and the audit judges an edit
			//     against. The signature is never editable.
			//     ⚠️ Its Order # is BLANKED exactly as the dryRun's `orderNumber` seed
			//     is (step 6a), for the same reason: with the refs unreadable,
			//     orderNumber is our load id, and the message the editor starts from
			//     must not offer it as Bison's Order #. Only a dryRun reaches here
			//     with needsOrderNumber set — prepare() refused the approve.
			const draftSubject = brokerInvoice.buildInvoiceSubject({ brokerName: effBrokerName, orderNumber });
			const emailFields = {
				brokerName: effBrokerName,
				isBison,
				loadNumber: loadRef,
				orderNumber: needsOrderNumber ? "" : orderNumber,
				moveNumber,
				poNumber,
			};
			// B20: the balance in its own paragraph when advance lines print.
			if (lineSummary) emailFields.balanceLine = invoiceLines.emailBalanceLine(lineSummary);
			const emailBodyDefault = brokerInvoice.buildInvoiceEmailBodyText(emailFields);
			const emailBody = editedEmailBody != null ? editedEmailBody : emailBodyDefault;
			const draftHtml = brokerInvoice.buildInvoiceEmailHtml({ ...emailFields, bodyText: emailBody });
			// Bison's attachment name is left byte-identical; other brokers get
			// their own name (a broker filing "Bison Invoice ..." would be odd).
			//
			// Both halves now go through safeAttachmentName(): orderNumber is
			// dispatcher-supplied and was never sanitized at all. The broker half
			// passes fallback "" on purpose — an empty broker name legitimately
			// yields the bare "Invoice Order #…" form.
			//
			// 80, matching INVOICE_ORDER_RE, so the file name carries the Order #
			// at its full length (up to 80) rather than a silently shorter one. It
			// is not a verbatim copy: the Windows-reserved characters
			// \ / : * ? " < > | are still turned into spaces (and runs of spaces
			// collapsed) by safeAttachmentName().
			const safeName = safeAttachmentName(effBrokerName, 40, "");
			const safeOrderNumber = safeAttachmentName(orderNumber, 80);
			const invoiceFileName = isBison
				? `Bison Invoice Order #${safeOrderNumber}.pdf`
				: `${safeName ? safeName + " " : ""}Invoice Order #${safeOrderNumber}.pdf`;
			// invoicePdf is null only on the needsTotal dryRun, whose answer never
			// reads this array.
			const draftAttachments = invoicePdf
				? [
						{ filename: invoiceFileName, content: invoicePdf, contentType: "application/pdf" },
						// ALL PODs, in page order — see step 3.
						...podAttachments,
				  ]
				: [];
			if (invoicePdf && rateconBuffer && rateconBuffer.length) {
				draftAttachments.push({ filename: `${safeOrderNumber}.pdf`, content: rateconBuffer, contentType: "application/pdf" });
			}

			return {
				invoicePdf, invoicePdfBase64, draftSubject, emailBodyDefault, emailBody, draftHtml,
				safeOrderNumber, invoiceFileName, draftAttachments,
				to: invoiceTo.email, subject: draftSubject, html: draftHtml, attachments: draftAttachments, total: billedTotal,
			};
		},

		// The draft row and its audit rows, after the Gmail draft exists. `actor`
		// is whoever the audit names: the request ({ session: { user } }), or the
		// user itself ({ id, username, role }). `editDiffs` are the route's
		// [field, derived, sent] triples that differ; `emailApplied: false` and
		// `lineAuditNotes` carry what the n8n fallback left out. Warnings are pushed
		// onto `draftWarnings`. Never throws; answers { recorded, draftRowId }.
		// `rendered` is the draft as sent; the row records what prepare() resolved.
		record(ctx, rendered, { via, actor, invoiceId, mintedInvoiceId, editDiffs = [], emailApplied = true, lineAuditNotes = [], draftWarnings = [] }) {
			const { loadId, invoiceTo, recipientSource, billedTotal, effBrokerName, orderNumber, ov, totalSource, sheetTotal, rcTotal, notes, lineSummary } = ctx;
			const req = actor && actor.session ? actor : { session: { user: actor || {} } };
			const invoiceLines = brokerInvoice.invoiceLines;
			const fmtMoney = (n) => brokerInvoice.formatMoney(n || 0);
			const editedFields = editDiffs.map(([f]) => f);
			const editEmailApplied = emailApplied;
			// Names the divergence explicitly, and names the RULE with it — an
			// auditor reading this row months later must not have to go and check
			// whether the sheet moved too. It did not, and that is owner decision #2.
			// The email message is the one field logged WITHOUT its text: only that
			// it was edited, its length, and — when the n8n fallback wrote the draft
			// with the generated message instead — that the edit was not applied.
			// An applied edit's words are in the Gmail draft itself.
			const describeEdits = (emailApplied) => `${invoiceId} load ${loadId} — ` + editDiffs.map(([f, from, to]) =>
				f === "total"
					? `total: sheet ${fmtMoney(sheetTotal)} / ratecon ${fmtMoney(rcTotal)} → invoiced ${fmtMoney(to)} (INVOICE ONLY — Job Tracking Payment unchanged)`
					: f === "emailBody"
						? `emailBody: edited (${Array.from(to).length} chars)` + (emailApplied ? "" : ", NOT APPLIED (the fallback service used the generated message)")
						: f === "lines"
							// Rebuilt here so the notes sit right after the figures, where
							// the 1000-character cap below cannot reach them.
							? invoiceLines.auditDraftDetail(lineSummary, lineAuditNotes)
							: `${f}: "${from}" → "${to}"`,
			).join("; ");

			// Persist that an official draft was created for this load so the load
			// modal can show "approved draft → recipient / invoice #". Best-effort —
			// never fails the draft. Only called on a real (non-dryRun) success.
			const recordDraft = (via) => {
				let draftRecorded = false;
				let draftRowId = null;
				try {
					// The draft row and, with B20 advance lines, its printed lines are ONE
					// write: a line record that fails takes the row with it, so no draft
					// row ever stands without the audit rows that follow.
					const lineRecord = db.transaction(() => {
						const draftRow = db.prepare(
							"INSERT INTO load_invoice_drafts (load_id, invoice_id, recipient, recipient_source, total, broker_name, order_number, via, created_by, edited, edited_fields, overrides_json, total_source, sheet_total, ratecon_total, invoice_id_minted, notes) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
						).run(
							loadId, invoiceId, invoiceTo.email, recipientSource, billedTotal, effBrokerName, orderNumber, via,
							(req.session.user && req.session.user.username) || "",
							editedFields.length ? 1 : 0,
							editedFields.join(","),
							// Without the email message, by the audit line's rule: edited_fields
							// records that it changed, and the text is not kept here.
							editedFields.length ? JSON.stringify({ ...ov.values, emailBody: undefined }) : "",
							totalSource,
							sheetTotal > 0 ? fmtMoney(sheetTotal) : "",
							rcTotal > 0 ? fmtMoney(rcTotal) : "",
							invoiceId === mintedInvoiceId ? "" : mintedInvoiceId,
							notes,
						);
						draftRowId = draftRow.lastInsertRowid;
						// B20: the printed lines and the line haul on this row, and each
						// line still active stamped with the first invoice # that printed it.
						return lineSummary ? invoiceLines.recordDraftLines(db, { draftId: draftRow.lastInsertRowid, summary: lineSummary, invoiceId }) : null;
					})();
					draftRecorded = true;
					// A line voided after this draft resolved its lines is in the Gmail
					// draft but carries no invoice #: the answer and the audit line say so.
					if (lineRecord && lineRecord.voidedIds.length) {
						for (const id of lineRecord.voidedIds) {
							draftWarnings.push(`Advance line #${id} was voided while this draft was made; check the Gmail draft.`);
							lineAuditNotes.push(`line #${id} was voided while this draft was made; check the Gmail draft`);
						}
					}
					// ⚠️ BYTE-IDENTICAL for the unedited case, deliberately — historical
					// queries over invoice_draft_created must not change shape. The edit
					// is a SEPARATE action, per the naming discipline beside logAudit():
					// "which invoices did somebody hand-correct, and to what?" is then a
					// one-line query instead of a string scan.
					logAudit(req, "invoice_draft_created", "load", loadId, `${invoiceId} → ${invoiceTo.email} (${via})`);
					if (editedFields.length) {
						// Built here, inside the try, with every note the send left: the
						// n8n fallback's, and any line voided above.
						const editDetail = describeEdits(editEmailApplied);
						logAudit(req, "invoice_draft_edited", "load", loadId, sanitizeEvidenceText(editDetail, 1000));
					}
				} catch (e) {
					console.error("Draft invoice: draft record persist failed:", e.message);
					// The Gmail draft exists but this app has no record of it (no row, no
					// stamp, no created/edited audit): the answer says so FIRST, so the
					// warning stands whatever the audit write below does, then a *_failed
					// row records the attempt.
					if (!draftRecorded) {
						draftWarnings.push(`The Gmail draft was created as invoice #${invoiceId} but LogisX could not record it; check before sending.`);
						try {
							logAudit(req, "invoice_draft_record_failed", "load", loadId, `${invoiceId} (${via}): ${sanitizeEvidenceText(e && e.message, 200)}`);
						} catch (auditErr) {
							console.error("Draft invoice: the record-failed audit row could not be written:", auditErr.message);
						}
					}
				}
				return { recorded: draftRecorded, draftRowId: draftRecorded ? draftRowId : null };
			};
			return recordDraft(via);
		},
	};
}

module.exports = { create, AUTO_REFUSAL_CODES, autoRecipientRefusal, isFreeMailDomain };
