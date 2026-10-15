#!/usr/bin/env node
// The dashboard's three load tabs search through one matcher (B19).
//
// Job Board, Active Loads and Completed each carried their own inline copy of the
// search rule, `(j[loadIdCol] || '').toString().toLowerCase().includes(q)`: Load
// ID only, no "#" folding. They now call searchLoads() from
// client/src/lib/loadSearch.js (its own runner: scripts/test-load-search-client.mjs),
// which also matches the reference numbers GET /api/dashboard attaches as `_refs`,
// and a row found through one shows a chip naming it under the Load ID.
//
// Source-text checks, per tab:
//   - imports searchLoads and refChipText from the shared module, and the
//     placeholders;
//   - the old inline rule is gone and filteredJobs reads searchLoads();
//   - the chip is in the Load ID table cell (Completed stays a table on phones)
//     and in the Job Board and Active Loads phone cards;
//   - the placeholder is the shared one, the short one on phones.
//
// No network, no build.
//   node scripts/test-load-search-tabs.js      # exits 1 on any failure

"use strict";

const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..", "client", "src", "components", "dashboard");
const TABS = {
	"JobBoardTab.vue": { card: "mobile-job-card", cardId: "mobile-job-id" },
	"ActiveLoadsTab.vue": { card: "mobile-load-card", cardId: "mobile-load-id" },
	"CompletedLoadsTab.vue": { card: null, cardId: null },
};

let pass = 0, fail = 0;
function check(name, cond) {
	if (cond) { pass++; return; }
	fail++;
	console.log(`  FAIL  ${name}`);
}

// The markup of the element whose opening tag carries `cls`, to its matching
// close tag (div / template / span nesting counted).
function elementWithClass(src, cls) {
	const at = src.search(new RegExp(`<(div|span)[^>]*class="[^"]*\\b${cls}\\b`));
	if (at < 0) return "";
	const tag = src.slice(at + 1, src.indexOf(" ", at)).trim();
	const re = new RegExp(`<${tag}\\b|</${tag}>`, "g");
	re.lastIndex = at;
	let depth = 0, m;
	while ((m = re.exec(src))) {
		depth += m[0].startsWith("</") ? -1 : 1;
		if (depth === 0) return src.slice(at, m.index + m[0].length);
	}
	return "";
}
// The `<template v-else-if="col === loadIdCol">` cell of the desktop table.
function loadIdCell(src) {
	const open = '<template v-else-if="col === loadIdCol">';
	const at = src.indexOf(open);
	if (at < 0) return "";
	return src.slice(at, src.indexOf("</template>", at));
}

const CHIP = /<span v-if="refVia\(job\)" class="ref-chip">\{\{ refChipText\(refVia\(job\)\) \}\}<\/span>/;
const OLD_RULE = /\.toString\(\)\.toLowerCase\(\)\.includes\(q\)/;
for (const [file, t] of Object.entries(TABS)) {
	const src = fs.readFileSync(path.join(DIR, file), "utf8");
	const script = src.slice(src.indexOf("<script setup>"));
	check(`${file}: imports searchLoads, refChipText and the placeholders from lib/loadSearch`,
		/import \{ searchLoads, refChipText, SEARCH_PLACEHOLDER, SEARCH_PLACEHOLDER_PHONE \} from '\.\.\/\.\.\/lib\/loadSearch'/.test(script));
	check(`${file}: the old inline Load-ID-only rule is gone`, !OLD_RULE.test(src));
	check(`${file}: the search runs through searchLoads() on the tab's pool`,
		/const searchResult = computed\(\(\) => \{[\s\S]{0,600}?return searchLoads\(pool, searchQuery\.value, loadIdCol\.value\)\n\}\)/.test(script));
	check(`${file}: filteredJobs is the search result's rows`,
		script.includes("const filteredJobs = computed(() => searchResult.value.rows)"));
	check(`${file}: refVia() reads the chip from the search result`,
		script.includes("function refVia(job) { return searchResult.value.via.get(job) || null }"));
	check(`${file}: the chip is under the Load ID in the table cell`, CHIP.test(loadIdCell(src)));
	if (t.card) {
		const card = elementWithClass(src, t.card);
		check(`${file}: the phone card exists`, card.length > 0);
		check(`${file}: the chip is under the Load ID in the phone card`, CHIP.test(elementWithClass(card, t.cardId)));
	}
	check(`${file}: the placeholder is the shared one, short on phones`,
		src.includes(':placeholder="isMobile ? SEARCH_PLACEHOLDER_PHONE : SEARCH_PLACEHOLDER"') && !src.includes('placeholder="Search load number..."'));
	check(`${file}: the chip has its style`, /\.ref-chip \{/.test(src));
}

// The browser e2e finds the Completed tab's search box by its placeholder.
{
	const lib = fs.readFileSync(path.join(__dirname, "..", "client", "src", "lib", "loadSearch.js"), "utf8");
	const placeholder = (lib.match(/^export const SEARCH_PLACEHOLDER = '([^']+)'$/m) || [])[1];
	const e2e = fs.readFileSync(path.join(__dirname, "e2e", "e2e.mjs"), "utf8");
	check("scripts/e2e/e2e.mjs looks the search box up by the shared placeholder",
		!!placeholder && e2e.includes(`panel.getByPlaceholder('${placeholder}')`) && !e2e.includes("'Search load number...'"));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
