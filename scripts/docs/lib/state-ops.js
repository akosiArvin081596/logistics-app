// scripts/docs/lib/state-ops.js — putting the LOCAL environment into the state a
// clip needs to film, and putting it back afterwards.
//
// WHY THIS IS NOT OPTIONAL. A refreshed environment is a copy of PRODUCTION, and
// production has no live freight sitting mid-ladder — every row is Delivered,
// Completed or Cancelled. Measured on this copy 2026-09-03: the whole Job
// Tracking sheet held ONE non-terminal load, and both storyboard demo loads
// (566293352, 566076070) were `Delivered` with PODs already attached. So the
// accept flow and the status ladder cannot be filmed as found. Staging is the
// entry cost of recording, not an optimisation.
//
// Everything here goes through the app's OWN endpoints rather than touching
// app.db, so the staging obeys the same guards the video is teaching.

"use strict";

const JT = encodeURIComponent("Job Tracking");

/**
 * ⚠️ Sheets allows plenty of writes but `driverWriteLimiter` is 60/min per IP and
 * covers /api/driver/respond, /api/driver/status, /api/messages, /api/expenses
 * and /api/documents/upload. One reset costs <= 8 writes, so a full run is fine
 * — the hazard is a tight `--only` re-record loop. Sleep at 40 in a rolling
 * 60 s window, i.e. a 1/3 margin.
 */
function makeWriteGate() {
	const stamps = [];
	return async function gate() {
		const now = Date.now();
		while (stamps.length && now - stamps[0] > 60_000) stamps.shift();
		if (stamps.length >= 40) {
			const waitMs = 60_000 - (now - stamps[0]) + 250;
			console.log(`   [gate] ${stamps.length} writes in the last minute — waiting ${Math.ceil(waitMs / 1000)}s`);
			await new Promise((r) => setTimeout(r, waitMs));
		}
		stamps.push(Date.now());
	};
}

function makeStateOps({ api, adminApi, driverName }) {
	const gate = makeWriteGate();

	async function findLoad(loadId) {
		const { body } = await api(`/api/driver/${encodeURIComponent(driverName)}`);
		const norm = (v) => String(v || "").replace(/^#/, "");
		const hit = (body?.loads || []).find((l) => norm(l["Load ID"]) === norm(loadId));
		if (!hit) throw new Error(`load ${loadId} not in ${driverName}'s payload`);
		return { rowIndex: hit._rowIndex, status: (hit["Job Status"] || "").trim(), load: hit };
	}

	/** Job Tracking headers, needed to splice a single column into a full row write. */
	let headersCache = null;
	async function jtHeaders() {
		if (headersCache) return headersCache;
		const { body } = await adminApi(`/api/data?sheet=${JT}&limit=1&page=1`);
		headersCache = body.headers;
		return headersCache;
	}

	/**
	 * Write one Job Tracking column via the ADMIN sheet route.
	 *
	 * Deliberately not PUT /api/driver/status: that route enforces the ladder and
	 * the POD gate, which is exactly the behaviour the video is demonstrating and
	 * therefore must not be weakened just to stage a shot.
	 */
	async function setSheetField(loadId, column, value) {
		const { rowIndex, load } = await findLoad(loadId);
		const hdrs = await jtHeaders();
		const idx = hdrs.indexOf(column);
		if (idx === -1) throw new Error(`no "${column}" column in Job Tracking`);
		const vals = hdrs.map((h) => load[h] ?? "");
		vals[idx] = value;
		await gate();
		const r = await adminApi(`/api/data/${rowIndex}?sheet=${JT}`, { method: "PUT", body: JSON.stringify({ values: vals }) });
		if (!r.ok) throw new Error(`sheet write failed (${column}=${value}): ${r.status} ${JSON.stringify(r.body)}`);
		return `${loadId} ${column} -> ${value}`;
	}

	const setSheetStatus = (loadId, status) => setSheetField(loadId, "Job Status", status);

	/**
	 * Drop every POD on a load so the Delivered gate re-arms.
	 *
	 * ⚠️ ORDER IS LOAD-BEARING: walk the STATUS DOWN FIRST. DELETE
	 * /api/documents/:id answers 409 LAST_POD_ON_DELIVERED_LOAD while the load is
	 * still Delivered/Completed and this is its only POD. Both demo loads carry
	 * PODs today, so deleting before the status move fails on the last one.
	 */
	async function clearPods(loadId) {
		const { body } = await adminApi(`/api/documents/${encodeURIComponent(loadId)}`);
		const pods = (Array.isArray(body) ? body : body?.documents || [])
			.filter((d) => /^pod$/i.test(d.type || d.doc_type || ""));
		let removed = 0;
		for (const d of pods) {
			await gate();
			const r = await adminApi(`/api/documents/${d.id}`, { method: "DELETE" });
			if (r.ok) removed++;
			else if (r.status === 409) {
				throw new Error(
					`cannot clear POD ${d.id} on ${loadId}: ${JSON.stringify(r.body)} — ` +
					`move the load OFF Delivered/Completed before clearing PODs`);
			}
		}
		return `${loadId}: ${removed} POD(s) cleared`;
	}

	/**
	 * Put a load back on offer so Accept/Decline render again. POST /api/dispatch
	 * clears load_responses for the driver and re-stamps the row Dispatched.
	 *
	 * ⚠️ It runs the period guard. If the load's month is finalized it refuses
	 * with PERIOD_FINALIZED — refuse loudly rather than filming the wrong screen.
	 */
	async function redispatch(loadId) {
		const { rowIndex, load } = await findLoad(loadId);
		await gate();
		const r = await adminApi("/api/dispatch", {
			method: "POST",
			body: JSON.stringify({
				rowIndex, loadId, driver: driverName,
				origin: load["Origin"] || load["Pickup Location"] || "",
				destination: load["Destination"] || load["Delivery Location"] || "",
			}),
		});
		if (!r.ok) {
			const code = r.body && (r.body.code || r.body.error);
			if (String(code).includes("PERIOD_FINALIZED")) {
				throw new Error(
					`${loadId} is in a FINALIZED period, so it cannot be re-dispatched.\n` +
					`   Reopen the period, re-run staging, then re-finalize — or pick a load in an open month.`);
			}
			throw new Error(`redispatch ${loadId} failed: ${r.status} ${JSON.stringify(r.body)}`);
		}
		return `${loadId} -> Dispatched (offer restored)`;
	}

	/**
	 * A driver may hold only ONE active job — PUT /api/driver/status answers 409
	 * ACTIVE_JOB_CONFLICT otherwise. Park anything else that is mid-ladder.
	 */
	async function freeActiveSlot(exceptLoadId) {
		const { body } = await api(`/api/driver/${encodeURIComponent(driverName)}`);
		const norm = (v) => String(v || "").replace(/^#/, "");
		const busy = (body?.loads || []).filter(
			(l) => /^(assigned|heading to shipper|at shipper|loading|in transit|at receiver)$/i
				.test((l["Job Status"] || "").trim()) && norm(l["Load ID"]) !== norm(exceptLoadId));
		for (const l of busy) await setSheetStatus(norm(l["Load ID"]), "Completed");
		return busy.length ? `parked ${busy.length} other active load(s)` : "no other active load";
	}

	return { findLoad, jtHeaders, setSheetField, setSheetStatus, clearPods, redispatch, freeActiveSlot, gate };
}

module.exports = { makeStateOps, makeWriteGate };
