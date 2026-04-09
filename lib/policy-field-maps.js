// Per-doc mappings from the data object the old generators used to receive
// into { text, checkboxes, signatureImage, days } descriptors the renderer
// understands. All text fields are keyed by the `aria-label` attribute of the
// corresponding <input> in the HTML template. Checkboxes are keyed by either
// `aria-label` (for service invoice) or `id` (for contractor agreement).
//
// Adding a new field = add a line here + add a corresponding <input> in the HTML.

const COMPANY = {
	recipientName: "Arvin Edubas",
	recipientTitle: "CEO, LogisX Inc.",
	// Investor contracts use LogisX as the Manager / Lessor entity
	managerName: "Arvin Edubas",
	managerTitle: "Chief Executive Officer",
	lessorName: "LogisX Inc.",
	lessorAddress: "4576 Research Forest Dr, Suite 200, The Woodlands, TX 77381",
	lessorContact: "(346) 406-6209",
	lessorPrintedName: "Arvin Edubas",
	lessorTitle: "Chief Executive Officer",
};

const POLICY_FIELD_MAPS = {
	// --- Equipment Policy (simplest doc) ---
	equipment_policy(data) {
		return {
			text: {
				"Full name": data.fullName || "",
				"Provider signature": data.signatureText || "",
				Date: data.effectiveDate || "",
			},
			signatureImage: data.signatureImage || null,
		};
	},

	// --- Mobile Policy ---
	mobile_policy(data) {
		return {
			text: {
				"Full name": data.fullName || "",
				"Driver signature": data.signatureText || "",
				"Driver date": data.effectiveDate || "",
				"Received by signature": COMPANY.recipientName,
				"Received by title": COMPANY.recipientTitle,
			},
			signatureImage: data.signatureImage || null,
		};
	},

	// --- Substance Policy ---
	substance_policy(data) {
		return {
			text: {
				"Driver/Associate name": data.fullName || "",
				Name: data.fullName || "",
				// Substance policy combines signature + date into one field
				"Driver signature and date": data.signatureText
					? `${data.signatureText} — ${data.effectiveDate || ""}`
					: "",
				"Approved by": COMPANY.recipientName,
				"Received by signature": COMPANY.recipientName,
			},
			signatureImage: data.signatureImage || null,
		};
	},

	// --- Contractor Agreement (heaviest doc: banking + checkboxes) ---
	contractor_agreement(data) {
		return {
			text: {
				"Effective date": data.effectiveDate || "",
				"Contractor name": data.fullName || "",
				"Contractor address": data.address || "",
				"Recipient signature": COMPANY.recipientName,
				"Recipient date": data.effectiveDate || "",
				"Contractor signature": data.signatureText || "",
				"Contractor date": data.effectiveDate || "",
				"Contractor printed name": data.fullName || "",
				"Exhibit A agreement date": data.effectiveDate || "",
				"Check: Name on account": data.checkName || "",
				"ACH: Name of bank": data.bankName || "",
				"Bank address": data.bankAddress || "",
				"Bank phone number": data.bankPhone || "",
				"Bank routing number": data.bankRouting || "",
				"Bank account number": data.bankAccount || "",
				"Names on account": data.bankAcctName || "",
				"Type of account": data.accountType || "",
				Date: data.effectiveDate || "",
			},
			checkboxesById: {
				"pay-check": data.paymentMethod === "check",
				"pay-ach": data.paymentMethod === "ach",
			},
			signatureImage: data.signatureImage || null,
		};
	},

	// --- Weekly Service Invoice (dynamic day rows) ---
	// The HTML template's own <script> generates 7 day rows (Saturday–Friday) on load.
	// The renderer lets that script run first, then fills the aria-labels via page.evaluate.
	// data.days is expected to be a map: { Saturday: {loadBol, total}, Sunday: {...}, ... }
	service_invoice(data) {
		const days = data.days || {};
		const dayText = {};
		for (const dayName of [
			"Saturday",
			"Sunday",
			"Monday",
			"Tuesday",
			"Wednesday",
			"Thursday",
			"Friday",
		]) {
			const row = days[dayName] || {};
			dayText[`${dayName} Load/BOL number`] = row.loadBol || "";
			dayText[`${dayName} total`] = row.total != null ? Number(row.total).toFixed(2) : "";
		}
		const totalDueNum =
			typeof data.totalDue === "number" ? data.totalDue : parseFloat(data.totalDue || 0);
		return {
			text: {
				"Business name": data.businessName || data.driverName || "",
				"Provider name": data.driverName || "",
				"Provider address": data.providerAddress || "",
				"Provider phone": data.providerPhone || "",
				"Invoice number suffix": data.invoiceNumberSuffix || "",
				"Submission date": data.submissionDate || "",
				"Provider signature": data.driverName || "",
				"Signature date": data.signatureDate || data.submissionDate || "",
				"Total due": totalDueNum ? totalDueNum.toFixed(2) : "",
				"Bank on file": data.bankOnFile || "",
				...dayText,
			},
			checkboxesByLabel: {
				Checking: data.accountType === "checking",
				Savings: data.accountType === "savings",
				"Verified ELD Data": !!data.hasEldData,
				"Signed Bills of Lading": !!data.hasBol,
				"Daily Vehicle Inspection Reports": !!data.hasDvir,
				"Fuel Receipts": !!data.hasFuelReceipts,
			},
			// Per-day "Completed" checkboxes — rendered by the template script.
			// Renderer sets these via DOM after the script runs.
			dayCompletedByIndex: (() => {
				const order = [
					"Saturday",
					"Sunday",
					"Monday",
					"Tuesday",
					"Wednesday",
					"Thursday",
					"Friday",
				];
				return order.map((name) => {
					const row = days[name] || {};
					return { completed: !!row.completed, na: !!row.na };
				});
			})(),
			signatureImage: data.signatureImage || null,
		};
	},

	// --- Investor: Master Participation & Management Agreement ---
	// Data comes from appData (investor_applications + vehiclesArr[0]) + investor_payment_info.
	// The "Participant" is the investor/owner, the "Manager" is LogisX.
	master_agreement(data) {
		const v0 = (data.vehicles && data.vehicles[0]) || {};
		return {
			text: {
				// Company / legal
				"Legal name": data.legalName || "",
				"Tax ID SSN": data.einSsn || "",
				Email: data.email || "",

				// Participant (the investor)
				"Participant name": data.legalName || data.contactPerson || "",
				"Participant signature": data.signatureText || "",
				"Participant date": data.signedAt || data.effectiveDate || "",
				"Participant title": data.contactTitle || "",
				"Participant address": data.address || "",

				// Manager (LogisX — hardcoded)
				"Manager name": COMPANY.managerName,
				"Manager signature": COMPANY.managerName,
				"Manager date": data.effectiveDate || "",
				"Manager title": COMPANY.managerTitle,

				// Vehicle (first vehicle in the application)
				Year: v0.year || data.vehicleYear || "",
				Make: v0.make || data.vehicleMake || "",
				Model: v0.model || data.vehicleModel || "",
				VIN: v0.vin || data.vehicleVin || "",
				"Current mileage": v0.mileage || data.vehicleMileage || "",
				"Title state": v0.titleState || data.vehicleTitleState || "",
				"Existing liens": v0.liens || data.vehicleLiens || "",
				"Registered owner": v0.registeredOwner || data.vehicleRegisteredOwner || "",

				// Equipment details — no data source yet, left blank for hand-fill
				"ELD make model": data.eldMakeModel || "",
				"Telematics details": data.telematicsDetails || "",
				"Dashcam details": data.dashcamDetails || "",
				"Sleeper details": data.sleeperDetails || "",
				"APU details": data.apuDetails || "",

				// Banking
				"Bank name": data.bankName || "",
				"Routing number": data.bankRouting || "",
				"Account number": data.bankAccount || "",

				Date: data.effectiveDate || "",
			},
			checkboxesByLabel: {
				// Equipment — default all unchecked (manual fill-in until the application form captures them)
				"ELD Hardware": !!data.hasEld,
				"Telematics/GPS": !!data.hasTelematics,
				Dashcam: !!data.hasDashcam,
				"Sleeper Berthing": !!data.hasSleeper,
				APU: !!data.hasApu,
				// Account type — mutually exclusive, driven by investor_payment_info.account_type
				"Business Checking": /business/i.test(data.accountType || ""),
				"Personal Checking": /personal/i.test(data.accountType || "") || /^checking$/i.test(data.accountType || ""),
				Savings: /savings/i.test(data.accountType || ""),
			},
			signatureImage: data.signatureImage || null,
		};
	},

	// --- Investor: Commercial Vehicle Lease Agreement ---
	// 10 inspection checkboxes default to CHECKED — lessee attests the vehicle is
	// in good condition at lease start. Lessor fields are hardcoded LogisX constants.
	vehicle_lease(data) {
		const v0 = (data.vehicles && data.vehicles[0]) || {};
		const vinLast6 = (v0.vin || data.vehicleVin || "").slice(-6);
		const nowStr =
			data.signedAt ||
			new Date().toLocaleString("en-US", {
				month: "long",
				day: "numeric",
				year: "numeric",
				hour: "numeric",
				minute: "2-digit",
				timeZone: "America/Chicago",
			});

		return {
			text: {
				// Lessee business
				"Legal name": data.legalName || "",
				DBA: data.dba || "",
				"Other entity type": /other/i.test(data.entityType || "") ? data.entityType : "",
				"EIN SSN": data.einSsn || "",
				"Years in operation": data.yearsInOperation || "",
				"Fleet size": data.fleetSize || "",
				"Principal address": data.address || "",
				Phone: data.phone || "",
				Email: data.email || "",
				"Contact person": data.contactPerson || "",
				"Contact title": data.contactTitle || "",

				// Lessor (LogisX — hardcoded)
				"Lessor name": COMPANY.lessorName,
				"Lessor address": COMPANY.lessorAddress,
				"Lessor contact": COMPANY.lessorContact,
				"Lessor signature": COMPANY.lessorPrintedName,
				"Lessor printed name": COMPANY.lessorPrintedName,
				"Lessor title": COMPANY.lessorTitle,

				// Vehicle
				"Unit number": v0.unitNumber || v0.unit || `${v0.year || ""} ${v0.make || ""} ${v0.model || ""}`.trim() || "",
				"VIN last 6": vinLast6,
				"Current mileage": v0.mileage || data.vehicleMileage || "",
				"Location of delivery": data.address || "",
				"Date and time": nowStr,
				"Tread percentage": data.treadPercentage || "",

				// Lessee signature
				"Lessee signature": data.signatureText || "",
			},
			checkboxesByLabel: {
				// Inspection checklist — default to "good / present" so a clean lease starts checked.
				// Lessee is attesting the unit is in inspection-pass condition when signing.
				"Front Bumper/Grille": data.inspectionFront != null ? !!data.inspectionFront : true,
				"Windshield/Glass": data.inspectionWindshield != null ? !!data.inspectionWindshield : true,
				"Left/Driver Side": data.inspectionLeft != null ? !!data.inspectionLeft : true,
				"Right/Passenger Side": data.inspectionRight != null ? !!data.inspectionRight : true,
				Tires: data.inspectionTires != null ? !!data.inspectionTires : true,
				"Lights/Signals": data.inspectionLights != null ? !!data.inspectionLights : true,
				"ELD Hardware": data.inspectionEld != null ? !!data.inspectionEld : true,
				"Registration Cab Card": data.inspectionRegistration != null ? !!data.inspectionRegistration : true,
				"Fire Extinguisher": data.inspectionFireExt != null ? !!data.inspectionFireExt : true,
				"Cabin Cleanliness": data.inspectionCabin != null ? !!data.inspectionCabin : true,
			},
			signatureImage: data.signatureImage || null,
		};
	},
};

module.exports = POLICY_FIELD_MAPS;
