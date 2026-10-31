// The contractor agreement, substance policy and vehicle lease can each come from a server
// folder its own setting names, so the repo needn't hold them. Unset or blank: the repo, as
// before. Set: that folder only, or a refusal and one log line naming the setting, never the folder.
"use strict";

const fs = require("fs");
const path = require("path");

const FOLDER_DOCUMENTS = Object.freeze({
	contractor_agreement: Object.freeze({ env: "POLICY_TEMPLATE_DIR_CONTRACTOR_AGREEMENT", file: "contractor-agreement.html" }),
	substance_policy: Object.freeze({ env: "POLICY_TEMPLATE_DIR_SUBSTANCE_POLICY", file: "substance-policy.html" }),
	vehicle_lease: Object.freeze({ env: "POLICY_TEMPLATE_DIR_VEHICLE_LEASE", file: "vehicle-lease.html" }),
});

const SUBSTANCE_POLICY_PDF = "LogisX-Substance-Policy.pdf";
// The apply page's link as the static mount resolves it: relative, lower case.
const SUBSTANCE_POLICY_PDF_LINK = "policies/logisx-substance-policy.pdf";

const POLICY_TEMPLATE_UNAVAILABLE = "POLICY_TEMPLATE_UNAVAILABLE";

// A setting counts as set when it holds more than spaces.
function folderSetting(env, name) {
	const raw = env == null ? undefined : env[name];
	const value = raw == null ? "" : String(raw).trim();
	return value === "" ? null : value;
}

// A name with no folder part: what is read is always a file directly in the folder.
function isPlainFileName(name) {
	return typeof name === "string" && name !== "" && name !== "." && name !== ".." && !/[\\/\0]/.test(name);
}

function isInside(folder, file) {
	const rel = path.relative(folder, file);
	return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

// `fileName` in `folder`, as { file } (its real path) or { reason }. Links are
// followed on both, and the file must still be inside the folder after that,
// so a link can't reach anything else on the server.
function locateFolderFile(folder, fileName) {
	if (typeof folder !== "string" || !path.isAbsolute(folder)) return { reason: "the setting is not an absolute folder path" };
	if (!isPlainFileName(fileName)) return { reason: "the file name has a folder part" };
	let realFolder;
	try {
		realFolder = fs.realpathSync(folder);
		if (!fs.statSync(realFolder).isDirectory()) return { reason: "the setting does not name a folder" };
		fs.accessSync(realFolder, fs.constants.X_OK);
	} catch (err) {
		return { reason: err && err.code === "ENOENT" ? "the folder is missing" : "the folder can't be read" };
	}
	let realFile;
	try {
		realFile = fs.realpathSync(path.join(realFolder, fileName));
	} catch (err) {
		return { reason: err && err.code === "ENOENT" ? "the file is missing" : "the file can't be read" };
	}
	if (!isInside(realFolder, realFile)) return { reason: "the file resolves outside the folder" };
	try {
		if (!fs.statSync(realFile).isFile()) return { reason: "the file is not a regular file" };
	} catch {
		return { reason: "the file can't be read" };
	}
	return { file: realFile };
}

function refuse(setting, fileName, reason) {
	console.error(`[policy-templates] ${setting}: ${reason} (${fileName}); refused, and nothing is read in its place`);
	const err = new Error(`${fileName} can't be read from the folder ${setting} names: ${reason}.`);
	err.code = POLICY_TEMPLATE_UNAVAILABLE;
	throw err;
}

// The template text for `docKey` from its folder; null when the document has
// no folder setting or it is unset (the caller reads the repo, as before).
function readFolderTemplate(docKey, env = process.env) {
	if (!Object.prototype.hasOwnProperty.call(FOLDER_DOCUMENTS, docKey)) return null;
	const doc = FOLDER_DOCUMENTS[docKey];
	const folder = folderSetting(env, doc.env);
	if (folder === null) return null;
	const found = locateFolderFile(folder, doc.file);
	if (found.reason) return refuse(doc.env, doc.file, found.reason);
	try {
		return fs.readFileSync(found.file, "utf8");
	} catch {
		return refuse(doc.env, doc.file, "the file can't be read");
	}
}

// True for every spelling of the link that the static mount would resolve to
// the build's copy: decoded and normalized as it does, in any letter case (a
// case-insensitive disk serves those too).
function isSubstancePolicyPdfPath(requestPath) {
	let decoded;
	try {
		decoded = decodeURIComponent(String(requestPath));
	} catch {
		return false;
	}
	return path.posix.normalize(`./${decoded}`).toLowerCase() === SUBSTANCE_POLICY_PDF_LINK;
}

function substancePdfUnavailable(res, setting, reason) {
	console.error(`[policy-templates] ${setting}: ${reason} (${SUBSTANCE_POLICY_PDF}); answered 503, and the build's copy is not served`);
	res.status(503).set("Cache-Control", "no-store").type("text").send("The substance policy can't be shown right now. Please try again later.");
}

// Each document's folder state, for the start log: { docKey, setting, set, problems: [{ file, reason }] }.
function folderSettingsReport(env = process.env) {
	return Object.entries(FOLDER_DOCUMENTS).map(([docKey, doc]) => {
		const folder = folderSetting(env, doc.env);
		if (folder === null) return { docKey, setting: doc.env, set: false, problems: [] };
		const files = docKey === "substance_policy" ? [doc.file, SUBSTANCE_POLICY_PDF] : [doc.file];
		const problems = files.map((file) => ({ file, reason: locateFolderFile(folder, file).reason })).filter((p) => p.reason);
		return { docKey, setting: doc.env, set: true, problems };
	});
}

// Logs, while any setting is set, where each document is read from and what
// can't be read now; nothing at all while none is.
function logFolderSettings(env = process.env) {
	const report = folderSettingsReport(env);
	if (!report.some((r) => r.set)) return report;
	for (const r of report) {
		if (!r.set) console.log(`[policy-templates] ${r.docKey}: read from the repo (${r.setting} is unset)`);
		else if (!r.problems.length) console.log(`[policy-templates] ${r.docKey}: read from the folder ${r.setting} names`);
		else for (const p of r.problems) console.error(`[policy-templates] ${r.setting}: ${p.reason} (${p.file}); refused until that is fixed`);
	}
	return report;
}

// The apply page's substance PDF: while set, the link in any spelling gets that
// folder's PDF and nothing else (the request picks no file name), or a 503, never
// the build's copy; unset, everything passes on. Building it logs the settings once.
function substancePolicyPdf({ env = process.env } = {}) {
	logFolderSettings(env);
	const setting = FOLDER_DOCUMENTS.substance_policy.env;
	return function substancePolicyPdf(req, res, next) {
		const folder = folderSetting(env, setting);
		if (folder === null) return next();
		if ((req.method !== "GET" && req.method !== "HEAD") || !isSubstancePolicyPdfPath(req.path)) return next();
		const found = locateFolderFile(folder, SUBSTANCE_POLICY_PDF);
		if (found.reason) return substancePdfUnavailable(res, setting, found.reason);
		res.sendFile(found.file, { dotfiles: "allow" }, (err) => {
			if (!err || res.headersSent || err.code === "ECONNABORTED") return;
			substancePdfUnavailable(res, setting, err.code === "ENOENT" ? "the file is missing" : "the file can't be read");
		});
	};
}

module.exports = {
	FOLDER_DOCUMENTS,
	SUBSTANCE_POLICY_PDF,
	POLICY_TEMPLATE_UNAVAILABLE,
	readFolderTemplate,
	locateFolderFile,
	isSubstancePolicyPdfPath,
	substancePolicyPdf,
	folderSettingsReport,
	logFolderSettings,
};
