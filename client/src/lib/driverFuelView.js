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
const STOP_FOR_FUEL = 'Stop for fuel as soon as you can.';

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
      kind: 'now', headline: 'Refuel now', sub: STOP_FOR_FUEL,
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
  // Only what to pump: a "uses about" figure beside it reads against the gauge and
  // can talk a driver out of the top-up the planning rate says he needs.
  if (leg.status === 'add' && add !== null) return row('bad', `Add about ${gal(add)}.`);
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
    // Before pickup with no position the row has no number, so it needs its reason,
    // with no truck linked too; after pickup the old line is enough.
    if (b.approachUncounted === true) footers.push("The truck's location isn't known, so the run to the pickup can't be counted.");
    else if (b.position === 'none' && b.fuelState !== 'no_truck') footers.push("Your truck hasn't sent its location recently.");
    if (b.routeEstimated === true) footers.push('Distance is estimated.');
    if (b.extraStops === true) footers.push("This load has extra stops that aren't counted. You may need more fuel.");
    if (b.afterAnotherLoad === true) {
      footers.push('You have another load before this one. These numbers start from where your truck is now.');
    }
    if (b.pickupUnmapped === true) footers.push("The pickup isn't on the map, so the run to it isn't counted.");
  }
  return { top, rows, rowsNote: rows.length ? '' : planProblemText(planProblem), footers };
}

// The header's thresholds, on the block's miles left: one figure decides the colour.
function milesTone(miles) {
  return miles < 50 ? 'bad' : miles < 150 ? 'warn' : 'ok';
}

// A row the block can't count is amber, unless the miles left are already in the
// chip's red band: then the section top and the badge are red like the chip.
function uncountedTone(b) {
  const miles = toNum(b && b.milesLeft);
  return miles !== null && milesTone(miles) === 'bad' ? 'bad' : 'warn';
}

function liveLegs(b) {
  return b && Array.isArray(b.legs) && b.loadDone !== true ? b.legs.filter(Boolean) : [];
}

/**
 * The colour of the section's top, from the block alone: 'bad' (refuel now, or a
 * row says add or refill), 'warn' (a row it can't count; 'bad' under 50 mi left),
 * 'ok', or 'unknown'.
 */
export function driverFuelTone(b) {
  const top = fuelTop(b);
  if (top.kind === 'now') return 'bad';
  if (top.kind !== 'miles') return 'unknown';
  const legs = liveLegs(b);
  if (legs.some((l) => l.status === 'add' || l.status === 'refill_on_way')) return 'bad';
  if (legs.some((l) => l.status === 'check_gauge')) return uncountedTone(b);
  return legs.length ? 'ok' : milesTone(toNum(b.milesLeft));
}

/**
 * The stops section's urgency and lead, from the block alone: a stop is needed
 * when it says refuel now, add or refill, or can't count a row while it knows the
 * miles left; the lead is that figure, the one the section headlines.
 */
export function driverFuelStops(b) {
  const top = fuelTop(b);
  const miles = toNum(b && b.milesLeft);
  const legs = liveLegs(b);
  const required = top.kind === 'now'
    || legs.some((l) => l.status === 'add' || l.status === 'refill_on_way')
    || (miles !== null && legs.some((l) => l.status === 'check_gauge'));
  if (!required) return { required: false, lead: '' };
  if (top.kind === 'now') return { required: true, lead: 'Fuel up now — before you start this run.' };
  return { required: true, lead: miles !== null ? `Fuel up within ${milesText(miles)} mi.` : 'Fuel up before you finish this run.' };
}

export const FUEL_RANGE_NOT_AVAILABLE = 'Fuel range: not available';

const milesWord = (miles) => (String(miles) === '1' ? 'mile' : 'miles');

/**
 * The header chip's sentence, on both its paths. `miles` arrives already formatted
 * from the server's figure, so this only picks the words.
 */
export function fuelRangeText(miles) {
  return `Fuel range: ${miles} ${milesWord(miles)} left until empty`;
}

// The chip's tooltip, which a tap with no load shows as a toast. One figure and no
// working, on both flag paths: the driver reads it beside the chip's own sentence.
const sensorNote = (estimate) => (estimate ? ` ${SENSOR_ESTIMATE}` : '');

export function fuelRangeTitle(miles, estimate = false) {
  return `About ${miles} ${milesWord(miles)} before you run out.${sensorNote(estimate)}`;
}

export function refuelNowTitle(estimate = false) {
  return `Refuel now. ${STOP_FOR_FUEL}${sensorNote(estimate)}`;
}

/**
 * Which load a tap on the chip opens: the load page on screen, else the load under
 * way, else the next in the queue, else none. `queued` is the store's queuedLoads,
 * in queue order. Not workingLoads[0]: that list runs newest added first, so it can
 * be a load still waiting behind the one on the road.
 */
export function fuelTapLoad({ onScreen, inProgress, queued }) {
  return onScreen || inProgress || (queued && queued[0]) || null;
}

/**
 * The header chip: the miles in a sentence, "Refuel now" or "not available", its
 * tooltip, and its colour, all from the block. `kind` as in fuelTop().
 */
export function driverFuelChip(b) {
  const top = fuelTop(b);
  const estimate = top.notes.length > 0;
  if (top.kind === 'now') return { kind: 'now', tone: 'bad', text: 'Refuel now', title: refuelNowTitle(estimate) };
  if (top.kind === 'miles') {
    return { kind: 'miles', tone: milesTone(toNum(b.milesLeft)), text: fuelRangeText(top.headline), title: fuelRangeTitle(top.headline, estimate) };
  }
  return { kind: 'unknown', tone: 'warn', text: FUEL_RANGE_NOT_AVAILABLE, title: `${top.headline}. ${top.sub}` };
}

/**
 * The badge on the load's collapsed Fuel header, from the block alone. Null with
 * no block (the caller keeps today's rule) or a load that is over (no badge).
 */
export function driverFuelBadge(plan) {
  const b = driverFuelOf(plan);
  if (!b || b.loadDone === true) return null;
  const finish = liveLegs(b).filter((l) => l.key === 'finish' || l.key === 'whole_load').pop();
  const add = finish && finish.status === 'add' ? toNum(finish.addGallons) : null;
  if (add !== null && add > 0) return { tone: 'bad', text: `Add ${milesText(add)} gal` };
  const top = fuelTop(b);
  if (top.kind === 'now') return { tone: 'bad', text: 'Refuel now' };
  if (finish && finish.status === 'refill_on_way') return { tone: 'bad', text: 'Fuel stop needed' };
  if (WITHHELD.has(b.fuelState) || top.kind === 'unknown') return { tone: 'warn', text: 'Fuel unknown' };
  if (finish && finish.status === 'check_gauge') return { tone: uncountedTone(b), text: 'Check gauge' };
  // The same figure the section headlines, so the badge and the section agree.
  return { tone: 'plain', text: `${top.headline} mi range` };
}
