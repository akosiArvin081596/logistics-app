"use strict";
// Restoring a soft-deleted load (the restore plan of 2026-10-22, Revision 2): what
// the payout ledger would change. The server computes the ledger twice, with
// today's soft-deleted set ("before") and with the load's rows taken out of it
// ("after"), from one Job Tracking snapshot and one rules object
// (restoreLedgerSnapshot() / restoreLedgerChanges() in server.js, which only
// read), and passes both here with its own closed-month answer.
//
// ledgerChanges({ before, after, isClosed }) compares, for every scope (each
// settlable investor, and the company as owner 0) and every month either side
// has, these figures to the cent:
//   revenue    the month's load revenue
//   driverPay  the month's driver pay
//   raw        the month's result before any split (netProfit)
//   payable    an investor's payable after loss carry-forward; null for a scope
//              with no payable (the company)
// and the fleet's months, each figure the sum over the scopes (the fleet is the
// sum of its scopes; computeFleetLedger()). It returns:
//   scopes        [{ ownerId, name, month, closed, revenue, driverPay, raw,
//                  payable }], each figure { before, after, change } in dollars;
//                 only the scope-months where some figure changes, in the order
//                 the scopes come (before's, then any new one), oldest month first
//   fleet         [{ month, closed, revenue, driverPay, raw }], the same way
//   closedMonths  the sorted months a changed row falls in that `isClosed` says
//                 are closed: a restore that would change one is refused
//   dayOnce       { added, removed }: the ledger day-once rule's dropped
//                 driver-days ({ ownerId, driver, day, month, keptMonth, loadId,
//                 keptLoadId }) that appear, or go, with the restore: the days that
//                 move between months, later open months included
//
// Pure: no database, sheet or network.

// [the name in a change row, the field on a ledger month]
const FIGURES = [["revenue", "revenue"], ["driverPay", "driverPay"], ["raw", "netProfit"]];

const cents = (v) => Math.round((Number(v) || 0) * 100);
const figure = (b, a) => ({ before: b / 100, after: a / 100, change: (a - b) / 100 });

function isSnapshot(s) {
	return !!s && typeof s === "object" && Array.isArray(s.scopes);
}

// A snapshot's payable map for one owner, or null when it has none.
function payableOf(snapshot, ownerId) {
	const all = snapshot.payable;
	if (!all || typeof all !== "object") return null;
	const own = Object.prototype.hasOwnProperty.call(all, String(ownerId)) ? all[String(ownerId)] : null;
	return own && typeof own === "object" ? own : null;
}

const dropKey = (ownerId, d) => [ownerId, d.driver, d.day, d.month, d.keptMonth].join("\t");
function dropsOf(snapshot) {
	const out = new Map();
	for (const s of snapshot.scopes) {
		for (const d of s.dayOnceDrops || []) {
			out.set(dropKey(s.ownerId, d), {
				ownerId: s.ownerId, driver: d.driver, day: d.day, month: d.month, keptMonth: d.keptMonth,
				loadId: d.loadId || "", keptLoadId: d.keptLoadId || "",
			});
		}
	}
	return out;
}
const dropOrder = (x, y) => x.ownerId - y.ownerId || (x.day < y.day ? -1 : x.day > y.day ? 1 : 0) || (x.month < y.month ? -1 : x.month > y.month ? 1 : 0);

function ledgerChanges({ before, after, isClosed = () => false } = {}) {
	if (!isSnapshot(before) || !isSnapshot(after)) throw new TypeError("ledgerChanges: before and after must be ledger snapshots ({ scopes: [...] })");
	const closedCache = new Map();
	const closed = (mk) => {
		if (!closedCache.has(mk)) closedCache.set(mk, isClosed(mk) === true);
		return closedCache.get(mk);
	};
	const scopeOf = (snapshot) => new Map(snapshot.scopes.map((s) => [s.ownerId, s]));
	const was = scopeOf(before);
	const will = scopeOf(after);
	const owners = [];
	for (const s of [...before.scopes, ...after.scopes]) if (!owners.some((o) => o.ownerId === s.ownerId)) owners.push({ ownerId: s.ownerId, name: s.name || "" });

	const scopes = [];
	const fleet = new Map();
	for (const { ownerId, name } of owners) {
		const monthsOf = (scope) => new Map(((scope && scope.months) || []).map((m) => [m.month, m]));
		const b = monthsOf(was.get(ownerId));
		const a = monthsOf(will.get(ownerId));
		const bPay = payableOf(before, ownerId);
		const aPay = payableOf(after, ownerId);
		const hasPayable = !!(bPay || aPay);
		for (const mk of [...new Set([...b.keys(), ...a.keys()])].sort()) {
			const row = { ownerId, name, month: mk, closed: closed(mk) };
			let moved = false;
			const sums = fleet.get(mk) || { revenue: [0, 0], driverPay: [0, 0], raw: [0, 0] };
			for (const [key, field] of FIGURES) {
				const x = cents((b.get(mk) || {})[field]);
				const y = cents((a.get(mk) || {})[field]);
				row[key] = figure(x, y);
				if (x !== y) moved = true;
				sums[key][0] += x;
				sums[key][1] += y;
			}
			fleet.set(mk, sums);
			if (hasPayable) {
				const x = cents(bPay && bPay[mk]);
				const y = cents(aPay && aPay[mk]);
				row.payable = figure(x, y);
				if (x !== y) moved = true;
			} else {
				row.payable = null;
			}
			if (moved) scopes.push(row);
		}
	}

	const fleetRows = [];
	for (const mk of [...fleet.keys()].sort()) {
		const sums = fleet.get(mk);
		if (FIGURES.every(([key]) => sums[key][0] === sums[key][1])) continue;
		const row = { month: mk, closed: closed(mk) };
		for (const [key] of FIGURES) row[key] = figure(sums[key][0], sums[key][1]);
		fleetRows.push(row);
	}

	const closedMonths = [...new Set([...scopes, ...fleetRows].filter((r) => r.closed).map((r) => r.month))].sort();
	const b = dropsOf(before);
	const a = dropsOf(after);
	return {
		scopes,
		fleet: fleetRows,
		closedMonths,
		dayOnce: {
			added: [...a].filter(([k]) => !b.has(k)).map(([, d]) => d).sort(dropOrder),
			removed: [...b].filter(([k]) => !a.has(k)).map(([, d]) => d).sort(dropOrder),
		},
	};
}

module.exports = { ledgerChanges };
