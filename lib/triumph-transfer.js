// Factored loads sent to Triumph: the SFTP connection, a thin wrapper over ssh2 (pinned)
// with three ways in and nothing else.
//   read    list, stat and get, in the two folders the settings name: the status reports
//           and the connection check. It has no way to write.
//   live    put() only, and only with the lock point's token (lib/triumph-ledger.js
//           lockForUpload()) for the exact file that lock covers, while the submit mode
//           reads live. So no path can send a real load's files without the lock.
//   sample  putSample() only: the made-up batch that shows Triumph the format, before go-live
//           (scripts/triumph-batch-sample.js is its one caller).
// There is no delete, rename, mkdir or setstat anywhere: the app never moves or removes
// anything on Triumph's side. A replica gets no connection at all.
//
// The connection: key authentication only (no password, keyboard-interactive, agent or
// "none" is ever offered), the host's key pinned by its SHA-256 fingerprint with only its
// own type offered, never trusted on first use; a 20 s handshake and 60 s for each
// operation; one session per use, closed after. Settings: lib/triumph-rules.js
// transportSettings(), with no default for any of them.
// An error carries a code and never a host, user, folder or key: a log line holds the code.

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const rules = require("./triumph-rules");
const ledger = require("./triumph-ledger");
const triumphBatch = require("./triumph-batch");

const READY_TIMEOUT_MS = 20 * 1000;
const OP_TIMEOUT_MS = 60 * 1000;
const CHUNK = 32 * 1024;
// A file the app sends or reads is named by it, never given a path.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

const coded = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
// The two SFTP answers to an open that prove no file was made: the folder isn't there, or
// creating in it isn't allowed. A plain failure may mean the file is there already.
const NO_SUCH_FILE = 2;
const PERMISSION_DENIED = 3;

// ssh-keygen -l's form of a host key: the SHA-256 of its blob in base64, padding dropped.
function fingerprintOf(blob) {
	return crypto.createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
}

// A fingerprint compared in constant time: both sides are the same length when they match.
function fingerprintMatches(blob, expected) {
	const got = Buffer.from(fingerprintOf(blob));
	const want = Buffer.from(String(expected || ""));
	return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function withTimeout(promise, ms, code = "OP_TIMEOUT") {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(coded(code)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

// `db` is the app's database (the live mode checks the lock on it); `Client` is ssh2's
// (a runner can hand in its own); `readKeyFile(path)` reads the private key at connect.
function create(deps = {}) {
	const d = {
		env: {},
		replica: false,
		readKeyFile: (p) => fs.readFileSync(p),
		now: () => new Date(),
		readyTimeoutMs: READY_TIMEOUT_MS,
		opTimeoutMs: OP_TIMEOUT_MS,
		...deps,
	};
	const conf = rules.transportSettings(d.env, { replica: d.replica });
	const s = conf.settings;
	const folders = s ? { submit: s.submitDir, reports: s.reportsDir } : {};
	const Client = () => d.Client || require("ssh2").Client;
	const remote = (folder, name) => path.posix.join(folders[folder], name);

	// One session: { sftp, end() }. The key is read here and goes only to ssh2.
	function connect() {
		if (d.replica) return Promise.reject(coded("TRANSPORT_REPLICA"));
		if (!s) return Promise.reject(coded("TRANSPORT_UNCONFIGURED"));
		let key;
		try {
			key = d.readKeyFile(s.keyFile);
		} catch {
			return Promise.reject(coded("KEY_UNREADABLE"));
		}
		return new Promise((resolve, reject) => {
			const C = Client();
			const client = new C();
			let hostKeyRefused = false;
			let offered = false;
			let settled = false;
			const fail = (code) => {
				if (settled) return;
				settled = true;
				try {
					client.end();
				} catch {
					// already closed
				}
				reject(coded(code));
			};
			client.on("ready", () => {
				client.sftp((err, sftp) => {
					if (err) return fail("SFTP_FAILED");
					if (settled) return undefined;
					settled = true;
					return resolve({ sftp, end: () => { try { client.end(); } catch { /* closed */ } } });
				});
			});
			client.on("error", (e) => {
				const level = e && e.level;
				if (hostKeyRefused) return fail("HOST_KEY_MISMATCH");
				if (level === "client-authentication") return fail("LOGIN_REFUSED");
				if (level === "client-timeout") return fail("CONNECT_TIMEOUT");
				return fail("CONNECT_FAILED");
			});
			client.on("close", () => fail(hostKeyRefused ? "HOST_KEY_MISMATCH" : "CONNECT_FAILED"));
			try {
				client.connect({
					host: s.host,
					port: s.port,
					username: s.user,
					readyTimeout: d.readyTimeoutMs,
					keepaliveInterval: 0,
					tryKeyboard: false,
					algorithms: { serverHostKey: [...s.hostKeyAlgorithms] },
					hostVerifier: (blob) => {
						const ok = fingerprintMatches(blob, s.fingerprint);
						if (!ok) hostKeyRefused = true;
						return ok;
					},
					// The one method, once: the key. Nothing else is ever offered.
					authHandler: () => {
						if (offered) return false;
						offered = true;
						return { type: "publickey", username: s.user, key };
					},
				});
			} catch {
				fail("CONNECT_FAILED");
			}
		});
	}

	const op = (fn) => withTimeout(new Promise((resolve, reject) => fn((err, v) => (err ? reject(err) : resolve(v)))), d.opTimeoutMs);

	// Writes `bytes` to `full` and checks the size Triumph's side reports. On a failure,
	// `nothingSent` is true only when the server refused the open in a way that proves no file
	// was made there. Any other failure may have left the file there, whole or in part.
	async function writeFile(sftp, full, bytes, { exclusive }) {
		let opened = false;
		try {
			const handle = await op((cb) => sftp.open(full, exclusive ? "wx" : "w", 0o600, cb));
			opened = true;
			for (let at = 0; at < bytes.length; at += CHUNK) {
				const len = Math.min(CHUNK, bytes.length - at);
				await op((cb) => sftp.write(handle, bytes, at, len, at, cb));
			}
			await op((cb) => sftp.close(handle, cb));
			const st = await op((cb) => sftp.stat(full, cb));
			if (!st || Number(st.size) !== bytes.length) throw coded("SIZE_MISMATCH");
			return { ok: true, bytes: bytes.length };
		} catch (e) {
			const status = e && typeof e.code === "number" ? e.code : null;
			const code = e && e.code === "SIZE_MISMATCH" ? "SIZE_MISMATCH" : e && e.code === "OP_TIMEOUT" ? "OP_TIMEOUT" : "PUT_FAILED";
			throw coded(code, { nothingSent: !opened && (status === NO_SUCH_FILE || status === PERMISSION_DENIED) });
		}
	}

	// ── read ────────────────────────────────────────────────────────────────

	async function openRead() {
		const session = await connect();
		const folderOf = (folder) => {
			if (!Object.hasOwn(folders, folder) || !folders[folder]) throw coded("FOLDER_UNSET");
			return folders[folder];
		};
		return Object.freeze({
			// The names, sizes and times in a folder; a folder that isn't there reads as none.
			async list(folder) {
				const dir = folderOf(folder);
				try {
					const entries = await op((cb) => session.sftp.readdir(dir, cb));
					return (entries || []).map((e) => ({ name: e.filename, size: Number(e.attrs && e.attrs.size) || 0, mtime: Number(e.attrs && e.attrs.mtime) || 0 }));
				} catch (e) {
					if (e && e.code === 2) return [];
					throw coded(e && e.code === "OP_TIMEOUT" ? "OP_TIMEOUT" : "LIST_FAILED");
				}
			},
			async stat(folder, name) {
				if (!NAME_RE.test(String(name || ""))) throw coded("NAME_UNSAFE");
				const st = await op((cb) => session.sftp.stat(path.posix.join(folderOf(folder), name), cb));
				return { size: Number(st && st.size) || 0, mtime: Number(st && st.mtime) || 0 };
			},
			async get(folder, name) {
				if (!NAME_RE.test(String(name || ""))) throw coded("NAME_UNSAFE");
				return op((cb) => session.sftp.readFile(path.posix.join(folderOf(folder), name), cb));
			},
			close: () => session.end(),
		});
	}

	// ── live ────────────────────────────────────────────────────────────────

	// Refused before any connection unless the submit mode reads live.
	async function openLive() {
		if (rules.submitMode(d.env, { replica: d.replica }) !== "live") throw coded("NOT_LIVE");
		if (!d.db) throw coded("TRANSPORT_UNCONFIGURED");
		const session = await connect();
		return Object.freeze({
			// One file of a locked batch: the PDF while the claim is at pdf_uploading, the CSV at
			// csv_uploading, each only as the bytes its build hashed. Anything else is refused
			// with no write operation at all.
			async put(token, { name, bytes } = {}) {
				if (rules.submitMode(d.env, { replica: d.replica }) !== "live") throw coded("NOT_LIVE");
				const buf = Buffer.isBuffer(bytes) ? bytes : null;
				const checked = buf && NAME_RE.test(String(name || ""))
					? ledger.tokenCheck(d.db, token, { nowIso: d.now().toISOString(), name, sha256: sha256(buf) })
					: { ok: false, code: "UNLOCKED_PUT" };
				if (!checked.ok) throw coded(checked.code);
				return writeFile(session.sftp, remote("submit", name), buf, { exclusive: checked.part === "csv" });
			},
			close: () => session.end(),
		});
	}

	// ── sample ──────────────────────────────────────────────────────────────

	// The made-up batch only, before go-live. Its content is checked against the sample's
	// constants (lib/triumph-batch.js sampleRefusal()), never where it came from. The PDF goes
	// first; a PDF that fails sends no CSV.
	async function openSample() {
		const shut = rules.sampleShut(d.env, { replica: d.replica });
		if (shut) throw coded(shut);
		const session = await connect();
		return Object.freeze({
			async putSample({ pdfName, pdf, csvName, csv } = {}) {
				const again = rules.sampleShut(d.env, { replica: d.replica });
				if (again) throw coded(again);
				const refused = triumphBatch.sampleRefusal({ pdfName, pdf, csvName, csv });
				if (refused) throw coded("SAMPLE_REFUSED", { why: refused });
				const sent = { pdf: null, csv: null };
				try {
					sent.pdf = await writeFile(session.sftp, remote("submit", pdfName), pdf, { exclusive: false });
				} catch (e) {
					throw Object.assign(e, { part: "pdf" });
				}
				try {
					sent.csv = await writeFile(session.sftp, remote("submit", csvName), csv, { exclusive: true });
				} catch (e) {
					throw Object.assign(e, { part: "csv", pdfSent: true });
				}
				return { ok: true, pdfBytes: sent.pdf.bytes, csvBytes: sent.csv.bytes };
			},
			close: () => session.end(),
		});
	}

	return Object.freeze({
		configured: Boolean(s),
		missing: conf.missing,
		invalid: conf.invalid,
		openRead,
		openLive,
		openSample,
	});
}

module.exports = { create, fingerprintOf, fingerprintMatches, READY_TIMEOUT_MS, OP_TIMEOUT_MS, NAME_RE };
