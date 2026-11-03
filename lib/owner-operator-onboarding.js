"use strict";
// Owner-operators, onboarding (plan C PR 3): the application's truck section and
// source, acceptance as an owner-operator (his profile, and his truck created,
// linked and assigned inside the acceptance's own transaction), his document set
// and agreement, and the loads and directory edits the app refuses him.
//
// New owner-operators exist only while OWNER_OPERATOR_ONBOARDING_ENABLED is on (the
// caller checks it). Everything else here is reached through an owner_operators row
// and answers for every existing profile whatever the flag, so a switch-off strands
// no one; with no profile each answer is a company driver's. Parameterized SQL only.

const ownerOperator = require("./owner-operator");
const { OWNER_OPERATOR_AGREEMENT_TEXT } = require("./owner-operator-agreement-text");
const POLICY_FIELD_MAPS = require("./policy-field-maps");

const OO_AGREEMENT_DOC_KEY = "owner_operator_agreement";
const OO_AGREEMENT_DOC = Object.freeze({ key: OO_AGREEMENT_DOC_KEY, name: "Owner-Operator Agreement", confidential: 1 });
// The welcome email's document line for him, in the drivers' line's own words.
const OO_WELCOME_DOC_NAMES = Object.freeze(["Owner-Operator Agreement", "Equipment Policy", "W-9", "Mobile Policy", "Substance Policy"]);
const OO_READY_NOTICE_TYPE = "oo_agreement_ready";
const OO_SYSTEM_ACTOR = Object.freeze({ session: Object.freeze({ user: Object.freeze({ id: 0, username: "owner-operator-onboarding", role: "system" }) }) });
const NOT_READY_MESSAGE = "LogisX is still setting up your agreement. We'll let you know here when it's ready to sign.";

// His document set: the drivers' set with the owner-operator agreement in place of
// the contractor agreement, whose $300/day pay would contradict it.
function ooOnboardingDocs(driverDocs) {
	const list = Array.isArray(driverDocs) ? driverDocs : [];
	if (!list.some((d) => d && d.key === "contractor_agreement")) {
		throw new Error("owner-operator documents: the drivers' set has no contractor agreement to replace");
	}
	return Object.freeze(list.map((d) => (d.key === "contractor_agreement" ? OO_AGREEMENT_DOC : Object.freeze({ ...d }))));
}

function ooWelcomeDocsText(docs) {
	return `Sign ${docs.length} onboarding documents (${OO_WELCOME_DOC_NAMES.join(", ")})`;
}

const refused = (status, code, error, extra) => ({ status, body: { error, code, ...(extra || {}) } });

// The acceptance's `as`: absent is today's acceptance. With the flag off only
// "owner_operator" changes anything (404, nothing written); any other value is
// ignored as it is today.
function ooAcceptAs(body, status, onboardingOn) {
	const raw = body && typeof body === "object" ? body.as : undefined;
	if (raw === undefined || raw === null || raw === "") return { ownerOperator: false };
	if (!onboardingOn) {
		return raw === "owner_operator" ? { refusal: refused(404, "FEATURE_OFF", "Not found") } : { ownerOperator: false };
	}
	if (raw === "company_driver") return { ownerOperator: false };
	if (raw !== "owner_operator" || status !== "Accepted") {
		return { refusal: refused(400, "INVALID_ACCEPT_AS", "Accept as \"company_driver\" or \"owner_operator\", with status \"Accepted\".") };
	}
	return { ownerOperator: true };
}

// The application's category, as the Applications screen shows it.
function ooApplicationCategory(position) {
	return ownerOperator.ooIsOwnerOperatorPosition(position) ? "owner_operator" : "driver";
}

// The Driver cell a row save puts on a load, when it names a new driver; "" when
// the save leaves the driver as it was. The column is the books' (/^driver$/i).
function ooRowDriverChange(headers, before, after, normalize) {
	const i = Array.isArray(headers) ? headers.findIndex((h) => /^driver$/i.test(String(h))) : -1;
	if (i < 0 || !Array.isArray(after)) return "";
	const next = String(after[i] == null ? "" : after[i]).trim();
	const prev = Array.isArray(before) ? String(before[i] == null ? "" : before[i]).trim() : "";
	return next && normalize(next) !== normalize(prev) ? next : "";
}

// The company signer the driver policies print (COMPANY in lib/policy-field-maps.js),
// read through the mobile policy's map so the name lives in one place.
function companySigner() {
	const text = POLICY_FIELD_MAPS.mobile_policy({}).text || {};
	return { name: String(text["Received by signature"] || ""), title: String(text["Received by title"] || "") };
}

// deps: db; driverDocs (ONBOARDING_DOCS); assignDriverToTruck(truckId, name);
// normalizeDriverName; todayKey() (the business day); logAudit; logAuditRefusal;
// notify(driverNameLower, type, title, body, metadataJson); partnerRef (the
// partner's referral code setting); agreementText (tests only; default the module's).
function createOwnerOperatorOnboarding(deps) {
	const { db, assignDriverToTruck, normalizeDriverName, todayKey, logAudit, logAuditRefusal, notify } = deps;
	const partnerRef = typeof deps.partnerRef === "string" ? deps.partnerRef : "";
	const agreementText = deps.agreementText || OWNER_OPERATOR_AGREEMENT_TEXT;
	const driverDocs = Object.freeze([...deps.driverDocs]);
	const ooDocs = ooOnboardingDocs(driverDocs);
	// The tables are created at boot whatever the flags; repeated here (idempotent) so
	// no reader below can meet a database without them.
	db.exec(ownerOperator.OO_SCHEMA_SQL);

	const profileForUser = (userId) => db.prepare("SELECT * FROM owner_operators WHERE user_id = ?").get(Number(userId)) || null;
	const hasProfile = (userId) => !!db.prepare("SELECT 1 FROM owner_operators WHERE user_id = ?").get(Number(userId));
	const docsFor = (userId) => (hasProfile(userId) ? ooDocs : driverDocs);
	const docSet = (asOwnerOperator) => (asOwnerOperator ? ooDocs : driverDocs);

	// His profile by the driver name a load or directory row carries, compared as
	// every ownership check compares names.
	function profileForDriverName(name) {
		const needle = normalizeDriverName(String(name == null ? "" : name));
		if (!needle || !db.prepare("SELECT 1 FROM owner_operators LIMIT 1").get()) return null;
		const rows = db.prepare("SELECT oo.*, u.driver_name AS account_driver_name FROM owner_operators oo JOIN users u ON u.id = oo.user_id").all();
		return rows.find((r) => normalizeDriverName(String(r.account_driver_name || "")) === needle) || null;
	}
	const agreementSigned = (userId) => !!db.prepare("SELECT 1 FROM onboarding_documents WHERE user_id = ? AND doc_key = ? AND signed = 1")
		.get(Number(userId), OO_AGREEMENT_DOC_KEY);
	const openLink = (ooId) => db.prepare("SELECT * FROM owner_operator_trucks WHERE oo_id = ? AND end_week_start = '' ORDER BY id DESC LIMIT 1").get(ooId) || null;
	const applicationSection = (appId) => db.prepare("SELECT * FROM owner_operator_applications WHERE application_id = ?").get(Number(appId)) || null;

	// ── the application ──────────────────────────────────────────────────────
	// One row beside the job_applications insert, in its transaction. The source is
	// "partner" only for the partner's own code; nothing tells the applicant which.
	function insertApplicationSection(appId, section) {
		const source = ownerOperator.ooSourceFromReferral(section.referralCode, partnerRef);
		db.prepare(`INSERT INTO owner_operator_applications (application_id, truck_year, truck_make, truck_model, truck_vin, truck_plate,
			truck_plate_state, truck_unit, truck_ownership, registered_owner, business_name, source, created_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
			.run(Number(appId), section.truckYear, section.truckMake, section.truckModel, section.truckVin, section.truckPlate,
				section.truckPlateState, section.truckUnit, section.truckOwnership, section.registeredOwner, section.businessName,
				source, new Date().toISOString());
		return source;
	}

	// The list's category, whether the truck section is on file, its source, and
	// whether the application was accepted as an owner-operator.
	function annotateApplications(apps) {
		const sections = new Map(db.prepare("SELECT application_id, source FROM owner_operator_applications").all().map((r) => [r.application_id, r.source]));
		const profiles = new Set(db.prepare("SELECT user_id FROM owner_operators").all().map((r) => r.user_id));
		return apps.map((a) => ({
			...a,
			category: ooApplicationCategory(a.position),
			oo_truck: sections.has(a.id),
			oo_source: sections.get(a.id) || "",
			oo_accepted: a.onboarding_user_id != null && profiles.has(a.onboarding_user_id),
		}));
	}

	function applicationDetail(row) {
		const s = applicationSection(row.id);
		return {
			category: ooApplicationCategory(row.position),
			owner_operator: s ? {
				truck_year: s.truck_year, truck_make: s.truck_make, truck_model: s.truck_model, truck_vin: s.truck_vin,
				truck_plate: s.truck_plate, truck_plate_state: s.truck_plate_state, truck_unit: s.truck_unit,
				truck_ownership: s.truck_ownership, registered_owner: s.registered_owner, business_name: s.business_name, source: s.source,
			} : null,
			oo_accepted: row.onboarding_user_id != null && hasProfile(row.onboarding_user_id),
		};
	}

	// ── acceptance ───────────────────────────────────────────────────────────
	// Everything acceptance as an owner-operator needs, checked before anything is
	// written. It never reuses or moves a truck: a full 17-character VIN already on
	// any truck, company-owned included, is a person's decision.
	function acceptanceCheck({ appId, body }) {
		const section = applicationSection(appId);
		if (!section) {
			return { ok: false, ...refused(409, "OO_TRUCK_REQUIRED", "Not accepted as an owner-operator: this application has no truck details. Accept as a company driver, or ask the applicant to apply again. Nothing was changed."),
				audit: `Accepting application ${appId} as an owner-operator refused: no truck section; nothing was written [OO_TRUCK_REQUIRED]` };
		}
		const vin = ownerOperator.ooMatchableVin(section.truck_vin);
		const held = vin ? db.prepare("SELECT id FROM trucks WHERE UPPER(TRIM(COALESCE(vin, ''))) = ? ORDER BY id LIMIT 1").get(vin) : null;
		if (held) {
			return { ok: false, ...refused(409, "OO_TRUCK_VIN_HELD", "A truck with this VIN is already on file. Decide which truck he drives before accepting him. Nothing was changed."),
				audit: `Accepting application ${appId} as an owner-operator refused: its VIN is on truck ${held.id}; nothing was written [OO_TRUCK_VIN_HELD]` };
		}
		const unit = `OO-${Number(appId)}-A`;
		if (db.prepare("SELECT 1 FROM trucks WHERE unit_number = ? COLLATE NOCASE").get(unit)) {
			return { ok: false, ...refused(409, "OO_TRUCK_UNIT_TAKEN", `A truck numbered ${unit} is already on file. Nothing was changed.`),
				audit: `Accepting application ${appId} as an owner-operator refused: unit ${unit} is taken; nothing was written [OO_TRUCK_UNIT_TAKEN]` };
		}
		// The Super Admin's acceptance confirms the source; it is sent only to correct it.
		const sent = body && typeof body === "object" ? body.source : undefined;
		if (sent !== undefined && sent !== null && sent !== "" && sent !== "direct" && sent !== "partner") {
			return { ok: false, ...refused(400, "OO_SOURCE_INVALID", "The source is \"direct\" or \"partner\"."), audit: "" };
		}
		const source = sent === "direct" || sent === "partner" ? sent : section.source;
		return { ok: true, section, source, unit };
	}

	// Inside the acceptance's transaction: his profile with the default terms, his truck
	// (company-operated, owner 0, Inactive until staff set it Active), the link from
	// this week, and the assignment to drive it (owner 0 writes no carrier pairing).
	function writeAcceptance({ appId, userId, fullName, accept, actor }) {
		const now = new Date().toISOString();
		const s = accept.section;
		const truck = db.prepare(`INSERT INTO trucks (unit_number, make, model, year, vin, license_plate, status, owner_id, notes)
			VALUES (?, ?, ?, ?, ?, ?, 'Inactive', 0, '')`).run(accept.unit, s.truck_make, s.truck_model, s.truck_year, s.truck_vin, s.truck_plate);
		const truckId = Number(truck.lastInsertRowid);
		const profile = db.prepare(`INSERT INTO owner_operators (user_id, application_id, status, source, business_name, fee_bps,
			escrow_target_cents, escrow_weekly_cents, installment_cents, created_at, created_by)
			VALUES (?, ?, 'onboarding', ?, ?, ?, ?, ?, 0, ?, ?)`).run(Number(userId), Number(appId), accept.source, s.business_name,
			ownerOperator.OO_FEE_DEFAULT_BPS, ownerOperator.OO_ESCROW_TARGET_DEFAULT_CENTS, ownerOperator.OO_ESCROW_WEEKLY_DEFAULT_CENTS,
			now, String(actor || ""));
		const ooId = Number(profile.lastInsertRowid);
		db.prepare(`INSERT INTO owner_operator_trucks (oo_id, truck_id, start_week_start, created_at, created_by, reason)
			VALUES (?, ?, ?, ?, ?, ?)`).run(ooId, truckId, ownerOperator.ooWeekStart(todayKey()), now, String(actor || ""), "Created from the application at acceptance");
		assignDriverToTruck(truckId, fullName);
		return { ooId, truckId, unit: accept.unit, source: accept.source };
	}

	// ── the agreement ────────────────────────────────────────────────────────
	// Ready to sign: his profile not ended, his truck linked with the details the
	// agreement prints, readable terms and truck costs, and counsel's final text (no
	// draft marker: no one signs the draft).
	function agreementState(userId) {
		const profile = profileForUser(userId);
		if (!profile) return null;
		const missing = [];
		if (profile.status === "ended") missing.push("ended");
		const link = openLink(profile.id);
		const truck = link ? db.prepare("SELECT * FROM trucks WHERE id = ?").get(link.truck_id) || null : null;
		if (!truck) missing.push("truck");
		if (ownerOperator.ooValidateFeeBps(profile.fee_bps) ||
			ownerOperator.ooValidateEscrowTerms({ targetCents: profile.escrow_target_cents, weeklyCents: profile.escrow_weekly_cents })) missing.push("terms");
		const section = profile.application_id ? applicationSection(profile.application_id) : null;
		const blank = (v) => String(v == null ? "" : v).trim() === "";
		if (truck && (!(Number(truck.year) > 0) || blank(truck.make) || blank(truck.model) || blank(truck.vin) || blank(truck.license_plate) ||
			!section || blank(section.truck_plate_state) || blank(section.truck_ownership) || blank(section.registered_owner))) missing.push("truck_details");
		const readable = (v) => v === null || v === undefined || v === "" || ownerOperator.ooToCents(v) !== null;
		if (truck && (!readable(truck.insurance_monthly) || !readable(truck.eld_monthly))) missing.push("truck_costs");
		if (String(agreementText.DRAFT_MARKER || "") !== "") missing.push("draft");
		return { profile, truck, section, ready: missing.length === 0, missing };
	}

	// The sign route's refusal, before anything is written; null when he may sign.
	function agreementSignRefusal(userId) {
		const state = agreementState(userId);
		if (state && state.ready) return null;
		return { error: NOT_READY_MESSAGE, code: "OO_AGREEMENT_NOT_READY", missing: state ? state.missing : ["profile"] };
	}

	// What the agreement prints, every figure from his profile, his truck row and his
	// live onboarding charges.
	function agreementRenderData(userId, { effectiveDate = "", fullName = "", address = "", signatureText = "", signatureImage = null, paymentMethod = "" } = {}) {
		const state = agreementState(userId);
		if (!state) {
			const e = new Error("\"owner_operator_agreement\" has no owner-operator profile behind it. Nothing was produced.");
			e.code = "OO_AGREEMENT_NOT_READY";
			throw e;
		}
		const { profile, truck, section } = state;
		const t = truck || {};
		const costs = db.prepare(`SELECT label, cents FROM owner_operator_charges WHERE oo_id = ? AND kind = 'onboarding' AND voided_at = ''
			ORDER BY charge_date, id`).all(profile.id).map((c) => ({ label: c.label, cents: c.cents }));
		const weekly = truck ? ownerOperator.ooTruckWeeklyCents(truck) : null;
		const signer = companySigner();
		const methods = agreementText.PAYMENT_METHOD || {};
		return {
			effectiveDate, fullName, address, startDate: effectiveDate,
			businessName: profile.business_name || "",
			feeBps: profile.fee_bps,
			escrowWeeklyCents: profile.escrow_weekly_cents,
			escrowTargetCents: profile.escrow_target_cents,
			truckYear: Number(t.year) > 0 ? String(t.year) : "",
			truckMake: t.make || "", truckModel: t.model || "", truckVin: t.vin || "",
			truckPlate: t.license_plate || "", truckPlateState: section ? section.truck_plate_state : "",
			truckUnit: t.unit_number || "",
			registeredOwner: section ? section.registered_owner : "",
			truckOwnership: section && section.truck_ownership ? section.truck_ownership : undefined,
			weeklyInsuranceCents: weekly ? weekly.insuranceCents : undefined,
			weeklyEldCents: weekly ? weekly.eldCents : undefined,
			onboardingCosts: costs,
			onboardingTotalCents: costs.reduce((sum, c) => sum + c.cents, 0),
			installmentCents: profile.installment_cents,
			paymentMethod: Object.prototype.hasOwnProperty.call(methods, paymentMethod) ? paymentMethod : undefined,
			carrierSignerName: signer.name, carrierSignerTitle: signer.title, carrierSignedOn: effectiveDate,
			signatureText, signatureImage, signedOn: effectiveDate,
		};
	}

	// The in-app notice that his agreement is ready, once, the first time it is.
	function notifyAgreementReady(userId) {
		const state = agreementState(userId);
		if (!state || !state.ready || agreementSigned(userId)) return false;
		const user = db.prepare("SELECT driver_name FROM users WHERE id = ?").get(Number(userId));
		const recipient = String((user && user.driver_name) || "").trim().toLowerCase();
		if (!recipient) return false;
		if (db.prepare("SELECT 1 FROM notifications WHERE driver_name = ? AND type = ? LIMIT 1").get(recipient, OO_READY_NOTICE_TYPE)) return false;
		notify(recipient, OO_READY_NOTICE_TYPE, "Your agreement is ready to sign",
			"Your owner-operator agreement is ready. Open your onboarding documents to read and sign it.",
			JSON.stringify({ userId: Number(userId), docKey: OO_AGREEMENT_DOC_KEY }));
		return true;
	}

	// At start-up: a deploy can make an agreement ready (counsel's text) with no other change.
	function sweepAgreementReadyNotices() {
		let sent = 0;
		for (const p of db.prepare("SELECT user_id FROM owner_operators WHERE status != 'ended'").all()) {
			if (notifyAgreementReady(p.user_id)) sent++;
		}
		return sent;
	}

	// When his onboarding completes, his truck's in-service date is his completion day
	// on the business clock, unless one is already set; his weekly charges follow it.
	function setInServiceOnCompletion(userId, completedAt) {
		const profile = profileForUser(userId);
		if (!profile) return "";
		const link = openLink(profile.id);
		const truck = link ? db.prepare("SELECT id, unit_number, in_service_date FROM trucks WHERE id = ?").get(link.truck_id) : null;
		if (!truck) return "";
		const day = ownerOperator.ooInServiceDateOnCompletion({ onboardedAt: completedAt, currentInServiceDate: truck.in_service_date });
		if (!day) return "";
		db.prepare("UPDATE trucks SET in_service_date = ? WHERE id = ?").run(day, truck.id);
		logAudit(OO_SYSTEM_ACTOR, "oo_truck_in_service_set", "truck", truck.id,
			`In-service date ${day} set on ${truck.unit_number} as owner-operator user ${profile.user_id} completed onboarding [system change]`);
		return day;
	}

	// ── loads and the directory ──────────────────────────────────────────────
	// No load for him before his agreement is signed or after his end week.
	function loadRefusal(driverName) {
		const profile = profileForDriverName(driverName);
		if (!profile) return null;
		const name = String(driverName).trim();
		const thisWeek = ownerOperator.ooWeekStart(todayKey());
		if (profile.status === "ended" || (profile.end_week_start && thisWeek && thisWeek > profile.end_week_start)) {
			return { body: { error: `${name}'s owner-operator agreement has ended, so no load can be given to this driver. Nothing was changed.`, code: "OWNER_OPERATOR_ENDED", driver: name },
				audit: `${name} is an owner-operator whose end week ${profile.end_week_start || "(ended)"} has passed` };
		}
		if (!agreementSigned(profile.user_id)) {
			return { body: { error: `${name} hasn't signed the owner-operator agreement yet, so no load can be given to this driver until it is signed. Nothing was changed.`, code: "OWNER_OPERATOR_UNSIGNED", driver: name },
				audit: `${name} is an owner-operator whose agreement isn't signed` };
		}
		return null;
	}

	// The route's refusal, audited and answered; false when the load may go to him.
	function refuseLoad(req, res, { driver, loadId = "", via, action = "dispatch_blocked" }) {
		const r = loadRefusal(driver);
		if (!r) return false;
		logAuditRefusal(req, action, "load", String(loadId || ""), `${via}: ${r.audit}; nothing was written [${r.body.code}]`, r.body.code);
		res.status(409).json(r.body);
		return true;
	}

	// His pay is his agreement and his carrier name decides whose ledger he is on, so
	// neither changes on his directory row; a resend of the stored values is no change.
	function directoryEditRefusal(current, next) {
		if (!current) return null;
		const profile = profileForDriverName(current.driver_name);
		if (!profile) return null;
		const changed = [];
		if (String(next.pay_type || "fixed").toLowerCase() !== String(current.pay_type || "fixed").toLowerCase()) changed.push("pay_type");
		if (Number(next.pay_percentage || 0) !== Number(current.pay_percentage || 0)) changed.push("pay_percentage");
		if (Number(next.pay_daily || 0) !== Number(current.pay_daily || 0)) changed.push("pay_daily");
		if (String(next.carrier_name || "").trim() !== String(current.carrier_name || "").trim()) changed.push("carrier_name");
		if (!changed.length) return null;
		return {
			body: { error: `${current.driver_name} is an owner-operator: pay is set by the owner-operator agreement, and the carrier name can't be changed here. Nothing was changed.`, code: "OWNER_OPERATOR_DIRECTORY", fields: changed },
			audit: `${current.driver_name}: ${changed.join(", ")} refused for an owner-operator; nothing was written [OWNER_OPERATOR_DIRECTORY]`,
		};
	}

	return {
		docSet, docsFor, hasProfile, profileForUser, profileForDriverName, agreementSigned,
		insertApplicationSection, applicationSection, annotateApplications, applicationDetail,
		acceptanceCheck, writeAcceptance, welcomeDocsText: () => ooWelcomeDocsText(ooDocs),
		agreementState, agreementSignRefusal, agreementRenderData, notifyAgreementReady, sweepAgreementReadyNotices,
		setInServiceOnCompletion,
		loadRefusal, refuseLoad, rowDriverChange: (headers, before, after) => ooRowDriverChange(headers, before, after, normalizeDriverName),
		directoryEditRefusal,
	};
}

module.exports = {
	OO_AGREEMENT_DOC_KEY,
	OO_AGREEMENT_DOC,
	OO_READY_NOTICE_TYPE,
	OO_WELCOME_DOC_NAMES,
	ooOnboardingDocs,
	ooWelcomeDocsText,
	ooAcceptAs,
	ooApplicationCategory,
	ooRowDriverChange,
	companySigner,
	createOwnerOperatorOnboarding,
};
