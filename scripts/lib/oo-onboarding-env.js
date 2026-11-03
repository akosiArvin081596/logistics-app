// The owner-operator onboarding module (lib/owner-operator-onboarding.js) as
// server.js builds it, over a runner's own database, with the names server.js
// gives it. With no owner-operator profile every answer is a company driver's,
// so a runner whose subject is something else passes these into its lifted code
// as they are; scripts/test-owner-operator-onboarding.js is the module's own runner.
//
//   const { ooOnboardingEnv } = require("./lib/oo-onboarding-env");
//   const env = { ...ooOnboardingEnv(db), ... };
//
// Options: src (server.js text, for ONBOARDING_DOCS), driverDocs, onboarding (the
// flag, default off), and the recorders the module calls (each a no-op by default).

"use strict";

const path = require("path");

const ROOT = path.join(__dirname, "..", "..");

function driverDocsFrom(src) {
	const m = /\nconst ONBOARDING_DOCS = (\[[\s\S]*?\n\]);/.exec(src || "");
	if (!m) throw new Error("oo-onboarding-env: server.js has no ONBOARDING_DOCS");
	return new Function(`return ${m[1]};`)();
}

// A checkout from before the module (a red-on-base run) has no lib file: the env
// then carries nulls, which that checkout's server.js never reads.
function ooOnboardingEnv(db, opts = {}) {
	const ownerOperator = require(path.join(ROOT, "lib", "owner-operator.js"));
	let ooOnboardingLib = null;
	try { ooOnboardingLib = require(path.join(ROOT, "lib", "owner-operator-onboarding.js")); } catch (err) {
		if (err.code !== "MODULE_NOT_FOUND") throw err;
		return { OWNER_OPERATOR_ONBOARDING_ENABLED: opts.onboarding === true, ownerOperator, ooOnboardingLib: null, ooOnboarding: null };
	}
	const src = opts.src || require("./server-source").serverSource();
	const ooOnboarding = ooOnboardingLib.createOwnerOperatorOnboarding({
		db,
		driverDocs: opts.driverDocs || driverDocsFrom(src),
		assignDriverToTruck: opts.assignDriverToTruck || (() => {}),
		normalizeDriverName: opts.normalizeDriverName || ((s) => String(s == null ? "" : s).trim().toLowerCase().replace(/\s+/g, " ")),
		todayKey: opts.todayKey || (() => "2026-11-04"),
		logAudit: opts.logAudit || (() => {}),
		logAuditRefusal: opts.logAuditRefusal || (() => {}),
		notify: opts.notify || (() => {}),
		partnerRef: opts.partnerRef || "",
	});
	return { OWNER_OPERATOR_ONBOARDING_ENABLED: opts.onboarding === true, ownerOperator, ooOnboardingLib, ooOnboarding };
}

// The module's answers for a world with no owner-operator profile, for a runner
// whose stand-in database can't hold the module's tables. Every answer is a
// company driver's; scripts/test-owner-operator-onboarding.js pins each one equal
// to the real module's over a database with no profile.
function ooOnboardingNoProfile(driverDocs) {
	const docs = Object.freeze([...(driverDocs || [])]);
	const none = (what) => () => { throw new Error(`ooOnboarding.${what} is reached only by an owner-operator, and this world has none`); };
	return Object.freeze({
		docSet: (asOwnerOperator) => { if (asOwnerOperator) throw new Error("ooOnboarding.docSet(true) with no owner-operator"); return docs; },
		docsFor: () => docs,
		hasProfile: () => false,
		profileForUser: () => null,
		profileForDriverName: () => null,
		agreementSigned: () => false,
		loadRefusal: () => null,
		refuseLoad: () => false,
		rowDriverChange: () => "",
		directoryEditRefusal: () => null,
		setInServiceOnCompletion: () => "",
		notifyAgreementReady: () => false,
		sweepAgreementReadyNotices: () => 0,
		agreementState: () => null,
		acceptanceCheck: none("acceptanceCheck"),
		writeAcceptance: none("writeAcceptance"),
		insertApplicationSection: none("insertApplicationSection"),
		agreementRenderData: none("agreementRenderData"),
	});
}

module.exports = { ooOnboardingEnv, ooOnboardingNoProfile, driverDocsFrom };
