// The WITHHELD LOAD KEYS helpers of server.js (beside shownLoadId()), for a
// runner that lifts a route reading a load ID through them. Each is the shipped
// source, compiled as production runs it by default: WITHHELD_LOAD_REFS_ENABLED
// off, and no key on the request (such a runner's requests name none). So a
// route reads and answers its load ID exactly as sent, and serves no key.
// scripts/test-withheld-load-key-routes.js runs them with the flag on and keys.
//
//   const { withheldLoadKeyHelpers } = require("./lib/withheld-load-key-lift");
//   const keyHelpers = withheldLoadKeyHelpers(SRC); // { loadIdFor, loadIdShownFor, ... }
//
// `deps` may hand in the runner's own currentShownLoadIdIndex() (the default
// index three helpers read, unused with the flag off). Whatever the helpers
// reach only with the flag on or a key named throws, so a runner can never pass
// through it unseen.
//
// Pure: reads source text only.
"use strict";

const HELPER_NAMES = Object.freeze([
	"loadKeysFor", "loadKeyFor", "withLoadKeys", "withNoticeLoadKey",
	"loadIdFor", "loadIdShownFor", "loadIdBindingOpts", "messageLoadIdFor",
]);

// A top-level `function name(`, to the first line that is exactly "}".
function liftTopFunction(src, name) {
	const needle = `\nfunction ${name}(`;
	const hits = src.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 definition of ${name}() in server.js, found ${hits}`);
	const start = src.indexOf(needle) + 1;
	const end = src.indexOf("\n}\n", start);
	if (end < 0) throw new Error(`no column-0 "}" after ${name}()`);
	return src.slice(start, end + 2);
}

const unreachable = (name) => () => {
	throw new Error(`${name} is reached only with WITHHELD_LOAD_REFS_ENABLED on or a key named`);
};

function withheldLoadKeyHelpers(src, deps = {}) {
	const scope = {
		WITHHELD_LOAD_REFS_ENABLED: false,
		WITHHELD_LOAD_KEYS: { keyFor: unreachable("WITHHELD_LOAD_KEYS.keyFor()") },
		brokerContact: { loadIdKey: unreachable("brokerContact.loadIdKey()") },
		loadIdWithheldFor: unreachable("loadIdWithheldFor()"),
		currentShownLoadIdIndex: () => null,
		normLoadKey: unreachable("normLoadKey()"),
		normalizeDriverName: unreachable("normalizeDriverName()"),
		...deps,
	};
	const names = Object.keys(scope);
	const body = `"use strict";\n${HELPER_NAMES.map((n) => liftTopFunction(src, n)).join("\n")}\nreturn { ${HELPER_NAMES.join(", ")} };`;
	return new Function(...names, body)(...names.map((n) => scope[n]));
}

module.exports = { withheldLoadKeyHelpers, HELPER_NAMES };
