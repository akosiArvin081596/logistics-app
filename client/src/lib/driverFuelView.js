// The `driverFuel` block (lib/fuel-model.js planDriverFuel(), DRIVER_FUEL_GALLONS_ENABLED)
// in plain words for the driver: the server works out every number, this only picks the
// sentence, and no working (reserve, MPG, fuel %) reaches the screen. The Fuel section,
// the load's Fuel badge and the header chip all read it here, so they cannot disagree.
// Pinned by scripts/test-fuel-reserve-line.mjs §7-§9.

// '.js' on the import so bare Node (the runners) can load this file.
import { toNum, milesText } from './fuelReview.js';

// States in which the server withholds the miles: say why, never guess.
const WITHHELD = new Set(['none', 'stale', 'no_tank_size', 'no_truck']);

const SENSOR_ESTIMATE = "Your fuel sensor isn't reporting. This is an estimate.";
const CHECK_GAUGE = 'Check your gauge.';

export const FUEL_REQUEST_FAILED = "Couldn't load your fuel numbers. Tap Refresh.";

const ROW_LABELS = {
  pickup: 'To reach pickup',
  finish: 'To finish this load',
  whole_load: 'Whole load, pickup to delivery',
};
const NEED_FOR = {
  pickup: 'to reach pickup',
  finish: 'to finish',
  whole_load: 'for the whole load',
};

/**
 * The block from a fuel answer, or null. Null means the flag is off (or an
 * answer this client doesn't know), and the screens stay exactly as before.
 */
export function driverFuelOf(answer) {
  const b = answer && typeof answer === 'object' ? answer.driverFuel : null;
  return b && typeof b === 'object' && b.v === 1 ? b : null;
}

/** "12 min", "1 hr", "18 hrs", "3 days"; '' under a minute or with no age. */
export function ageWords(minutes) {
  const m = toNum(minutes);
  if (m === null || m < 1) return '';
  if (m < 60) return `${Math.round(m)} min`;
  const hrs = Math.round(m / 60);
  if (hrs < 48) return `${hrs} hr${hrs === 1 ? '' : 's'}`;
  return `${Math.round(hrs / 24)} days`;
}

function gal(n) {
  return `${milesText(n)} gal`;
}

function readAgoOf(b) {
  const m = toNum(b.fuelReadAgeMinutes);
  if (m === null || m < 0) return '';
  const words = ageWords(m);
  return words ? `Fuel level read ${words} ago` : 'Fuel level read just now';
}

/**
 * The top of the section: the miles until the tank runs out, "Refuel now", or
 * why there is no figure. `kind` is 'miles', 'now' or 'unknown'.
 */
export function fuelTop(b) {
  const state = b && b.fuelState;
  const miles = toNum(b && b.milesLeft);
  const sensor = state === 'estimated' ? [SENSOR_ESTIMATE] : [];
  if (miles !== null && b.refuelNow === true) {
    return {
      kind: 'now', headline: 'Refuel now', sub: 'Stop for fuel as soon as you can.',
      notes: sensor, readAgo: state === 'live' || state === 'estimated' ? readAgoOf(b) : '',
    };
  }
  if (miles !== null && (state === 'live' || state === 'estimated')) {
    return { kind: 'miles', headline: milesText(miles), sub: 'miles until you run out', notes: sensor, readAgo: readAgoOf(b) };
  }
  const unknown = (headline, sub) => ({ kind: 'unknown', headline, sub, notes: [], readAgo: '' });
  if (state === 'stale') {
    const age = ageWords(b.fuelReadAgeMinutes);
    return unknown('Fuel level unknown', age ? `No fuel reading for ${age}. ${CHECK_GAUGE}` : `No recent fuel reading. ${CHECK_GAUGE}`);
  }
  if (state === 'no_tank_size') {
    return unknown('Miles left unknown', "This truck's tank size isn't on file. Check your gauge and ask dispatch to add it.");
  }
  if (state === 'no_truck') return unknown('Fuel level unknown', 'No truck is linked to your account. Ask dispatch.');
  if (state === 'none') return unknown('Fuel level unknown', `Your truck isn't sending a fuel level. ${CHECK_GAUGE}`);
  return unknown('Fuel level unknown', CHECK_GAUGE);
}

function rowOf(leg, b) {
  const key = leg && leg.key;
  if (!Object.prototype.hasOwnProperty.call(ROW_LABELS, key)) return null;
  const label = key === 'pickup' && b.extraStops === true ? 'To reach first pickup' : ROW_LABELS[key];
  const miles = toNum(leg.miles);
  const uses = toNum(leg.usesGallons);
  const add = toNum(leg.addGallons);
  const need = toNum(leg.needInTankGallons);
  const row = (tone, line) => ({ key, label, miles: miles === null ? '' : `${milesText(miles)} mi`, tone, line });
  if (leg.status === 'enough' && uses !== null) return row('ok', `Uses about ${gal(uses)}. You have enough.`);
  if (leg.status === 'add' && uses !== null && add !== null) return row('bad', `Uses about ${gal(uses)}. Add about ${gal(add)}.`);
  if (leg.status === 'refill_on_way' && uses !== null) {
    return row('bad', `Uses about ${gal(uses)}. Fill up full, and plan another fuel stop on the way.`);
  }
  if (need !== null) return row('unknown', `You need about ${gal(need)} in the tank ${NEED_FOR[key]}. ${CHECK_GAUGE}`);
  return row('unknown', CHECK_GAUGE);
}

// The trip-plan 400 codes the server sends only with the flag on.
const FLAG_ON_CODES = new Set(['NO_ROUTE', 'NO_POSITION']);

/** True when a failed trip-plan request ({ status, code }) shows the flag is on. */
export function flagOnProblem(problem) {
  return !!problem && typeof problem === 'object' && FLAG_ON_CODES.has(problem.code);
}

/**
 * Why there are no rows, from the trip-plan request that failed (its status and
 * the 400's `code`). '' when there is nothing to say.
 */
export function planProblemText(problem) {
  if (!problem || typeof problem !== 'object') return '';
  if (problem.code === 'NO_ROUTE') return "This load isn't on the map yet, so we can't work out the fuel for it.";
  if (problem.code === 'NO_POSITION') return "Your truck hasn't sent its location recently, so we can't work out the fuel for this load yet.";
  if (problem.status === 404) return '';
  if (problem.status === 400) return "We can't work out the fuel for this load yet.";
  if (problem.status === 429) return 'Checked too many times just now. Try again in a few minutes.';
  return FUEL_REQUEST_FAILED;
}

/**
 * The whole section: { top, rows, rowsNote, footers }. `planProblem` is the
 * failed trip-plan request when the block came from /api/fuel/range instead.
 */
export function driverFuelView(b, { planProblem = null } = {}) {
  const top = fuelTop(b);
  const legs = b && Array.isArray(b.legs) && b.loadDone !== true ? b.legs : [];
  const rows = legs.map((l) => rowOf(l, b)).filter(Boolean);
  const footers = [];
  if (rows.length) {
    if (b.position === 'old') {
      const age = ageWords(b.positionAgeMinutes);
      if (age) footers.push(`Worked out from where your truck was ${age} ago.`);
    }
    if (b.position === 'none' && b.fuelState !== 'no_truck') footers.push("Your truck hasn't sent its location recently.");
    if (b.routeEstimated === true) footers.push('Distance is estimated.');
    if (b.extraStops === true) footers.push("This load has extra stops that aren't counted. You may need more fuel.");
    if (b.afterAnotherLoad === true) {
      footers.push('You have another load before this one. These numbers start from where your truck is now.');
    }
  }
  return { top, rows, rowsNote: rows.length ? '' : planProblemText(planProblem), footers };
}

/**
 * The header chip: "225 mi", "Refuel now" or "Fuel ?", and its tooltip. `kind`
 * as in fuelTop(); the header picks the colour.
 */
export function driverFuelChip(b) {
  const top = fuelTop(b);
  const sensor = top.notes.length ? ` ${top.notes.join(' ')}` : '';
  if (top.kind === 'now') return { kind: 'now', text: 'Refuel now', title: `Refuel now. ${top.sub}${sensor}` };
  if (top.kind === 'miles') return { kind: 'miles', text: `${top.headline} mi`, title: `About ${top.headline} miles before you run out.${sensor}` };
  return { kind: 'unknown', text: 'Fuel ?', title: `${top.headline}. ${top.sub}` };
}

/**
 * The badge on the load's collapsed Fuel header, from the trip-plan answer.
 * Null when the block doesn't decide it: the caller keeps its own rule.
 */
export function driverFuelBadge(plan) {
  const b = driverFuelOf(plan);
  if (!b || b.loadDone === true) return null;
  const legs = Array.isArray(b.legs) ? b.legs : [];
  const finish = legs.filter((l) => l && (l.key === 'finish' || l.key === 'whole_load')).pop();
  const add = finish && finish.status === 'add' ? toNum(finish.addGallons) : null;
  if (add !== null && add > 0) return { tone: 'bad', text: `Add ${milesText(add)} gal` };
  const top = fuelTop(b);
  if (top.kind === 'now') return { tone: 'bad', text: 'Refuel now' };
  if (WITHHELD.has(b.fuelState) || top.kind === 'unknown') return { tone: 'warn', text: 'Fuel unknown' };
  // The same figure the section headlines, so the badge and the section agree.
  if (plan.verdict === 'clears') return { tone: 'plain', text: `${top.headline} mi range` };
  return null;
}
