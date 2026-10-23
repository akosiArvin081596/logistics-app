// Where the harness may take a REAL database from: SOURCE_DB, only under
// ~/LogisX-replica/ (where real data lives), never inside a checkout or worktree.
// setup-db.cjs and payout-parity.mjs both judge SOURCE_DB here.
//
//   sourceDb()  null when SOURCE_DB is unset or empty; otherwise its canonical path
//               (symlinks resolved first), or an Error saying why it is refused:
//               inside this checkout or the main checkout, inside any folder holding
//               .git (a repo or a worktree), or outside ~/LogisX-replica/.
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const paths = require("./paths.cjs");

const realOrSelf = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const isInside = (child, parent) => child === parent || child.startsWith(parent + path.sep);

// The checkout (a folder holding .git: a repo or a worktree) that p lies in, or null.
function enclosingCheckout(p) {
	let dir = path.dirname(p);
	for (;;) {
		if (fs.existsSync(path.join(dir, ".git"))) return dir;
		const up = path.dirname(dir);
		if (up === dir) return null;
		dir = up;
	}
}

function sourceDb({ unsetHint = "Unset SOURCE_DB to build the made-up database (the default)." } = {}) {
	const given = process.env.SOURCE_DB;
	if (!given) return null;
	let src;
	try { src = fs.realpathSync(given); } catch { throw new Error(`SOURCE_DB ${given} does not exist`); }
	const inside = (checkout) => new Error(`refusing SOURCE_DB ${src}: it is inside the checkout ${checkout}. ` +
		`Real data stays in ~/LogisX-replica/, never in a checkout or worktree. ${unsetHint}`);
	for (const checkout of [paths.REPO, paths.mainCheckout()].map(realOrSelf)) {
		if (isInside(src, checkout)) throw inside(checkout);
	}
	const inCheckout = enclosingCheckout(src);
	if (inCheckout) throw inside(inCheckout);
	const replica = realOrSelf(path.join(os.homedir(), "LogisX-replica"));
	if (!isInside(src, replica)) throw new Error(`refusing SOURCE_DB ${src}: a real database is copied only from under ${replica}/. ${unsetHint}`);
	return src;
}

module.exports = { sourceDb, enclosingCheckout };
