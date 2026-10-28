// The draft route's code, for the runners that read or run it as text. Since
// the engine extraction it lives in two files: the registration in server.js,
// and the steps it calls (prepare, render, record) in lib/broker-invoice-draft.js.
//
//   const draftLift = require("./lib/broker-invoice-draft-lift");
//   const SRC = draftLift.withEngine(serverText, ROOT);  // server.js + the engine, one text
//   draftLift.engineOf(SRC);                             // the engine's part of such a text
//   draftLift.inlineSteps(routeText, engineText);        // the route as it runs (below)
//   draftLift.loadEngine(engineText, deps);              // create(deps) from the engine's text
//
// inlineSteps() puts each step's code right after the route line that calls it,
// then the rest of the engine, so a check on the route's text (what it reads,
// what it never writes, what comes before the invoice number) sees the code
// that runs, in the order it runs.
//
// Pure: reads source text only.
"use strict";

const fs = require("fs");
const path = require("path");

const ENGINE_FILE = "lib/broker-invoice-draft.js";
const MARK = "\n// ==== lib/broker-invoice-draft.js, the draft route's steps ====\n";
const STEPS = ["prepare", "render", "record"];

function readEngine(root) {
	return fs.readFileSync(path.join(root, ENGINE_FILE), "utf8");
}

function withEngine(serverText, root) {
	return serverText + MARK + readEngine(root);
}

function engineOf(src) {
	const at = src.indexOf(MARK);
	if (at < 0 || src.indexOf(MARK, at + 1) >= 0) throw new Error(`expected exactly one ${ENGINE_FILE} part in the source text`);
	return src.slice(at + MARK.length);
}

// One step's lines in the engine: from `\t\t[async ]<name>(` to the `\t\t},` that
// closes it.
function stepRange(lines, name) {
	const re = new RegExp(`^\\t\\t(async )?${name}\\(`);
	const s = lines.findIndex((l) => re.test(l));
	if (s < 0 || lines.findIndex((l, i) => i > s && re.test(l)) >= 0) throw new Error(`expected exactly one ${name}() in ${ENGINE_FILE}`);
	const e = lines.findIndex((l, i) => i > s && l === "\t\t},");
	if (e < 0) throw new Error(`unterminated ${name}() in ${ENGINE_FILE}`);
	return [s, e];
}

function inlineSteps(routeText, engineText) {
	const engine = engineText.split("\n");
	const ranges = STEPS.map((name) => [name, stepRange(engine, name)]);
	const route = routeText.split("\n");
	const at = ranges.map(([name, range]) => {
		const hits = route.filter((l) => l.includes(`brokerInvoiceDraft.${name}(`)).length;
		if (hits !== 1) throw new Error(`expected the route to call brokerInvoiceDraft.${name}() once, found ${hits}`);
		return [route.findIndex((l) => l.includes(`brokerInvoiceDraft.${name}(`)), range];
	}).sort((a, b) => b[0] - a[0]);
	for (const [line, [s, e]] of at) route.splice(line + 1, 0, ...engine.slice(s, e + 1));
	const inSteps = (i) => ranges.some(([, [s, e]]) => i >= s && i <= e);
	return route.concat(engine.filter((l, i) => !inSteps(i))).join("\n");
}

function loadEngine(engineText, deps) {
	const mod = { exports: {} };
	new Function("module", "exports", "require", engineText)(mod, mod.exports, require);
	return mod.exports.create(deps);
}

module.exports = { ENGINE_FILE, readEngine, withEngine, engineOf, inlineSteps, loadEngine };
