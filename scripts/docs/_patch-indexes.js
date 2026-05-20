// One-off: wrap every unguarded `db.exec(\`CREATE INDEX ...);` in server.js
// in a try/catch so a fresh app.db can bootstrap. The indexes get re-tried
// on the next boot once their target table/column exists.
//
// Safe to run multiple times — only matches lines NOT already wrapped.
//
// Usage: node scripts/docs/_patch-indexes.js

const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", "..", "server.js");
const src = fs.readFileSync(file, "utf8");

const re = /^db\.exec\(`CREATE INDEX [^\n]*`\);$/gm;
let count = 0;
const out = src.replace(re, (match) => {
	count++;
	return `try { ${match} } catch {}`;
});

fs.writeFileSync(file, out);
console.log(`Wrapped ${count} CREATE INDEX statements in try/catch.`);
