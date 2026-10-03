// Lift code out of server.js to run it in a script, exactly as the server runs
// it — the pattern scripts/count-load-closeout.js and the unit runners use, made
// automatic: given the functions and routes a script needs, closure() walks the
// identifiers they mention to the top-level declarations they depend on, so a
// script follows server.js as it changes instead of keeping a hand list.
//
// Pure: reads source text only.
//
// What "top-level declaration" means here: a line at column 0 that starts with
// `function NAME(`, `async function NAME(`, `const NAME =`, `let NAME =`, or
// `const { A, B: C } =` (each name it binds). A function runs to the first
// "\n}\n" after it (server.js's own shape); a const or let runs to the line
// before the next one that starts a new top-level statement at column 0 (a
// closer such as "];" or "});" belongs to the declaration). Every piece is
// checked by the JS parser before it is used. DECL_START_RE is every line that
// starts a top-level declaration of any form, so a runner can prove the index
// misses none of server.js's.

"use strict";

const DECL_RE = /^(?:(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(|(const|let)\s+([A-Za-z_$][\w$]*)\s*=|(const|let)\s+\{([^}]*)\}\s*=)/;
const DECL_START_RE = /^(?:async\s+function|function|const|let|var|class)\b/;
const IDENT_RE = /[A-Za-z_$][\w$]*/g;

// The identifiers a piece of code uses: comments, string contents and regex
// literals are skipped (their words are not references); a template literal's
// ${…} expressions are code. A property after "." is no reference either.
function codeIdentifiers(text) {
	const out = [];
	let i = 0;
	let prev = ""; // the last significant character, to tell a regex from a division
	const regexCanStart = () => prev === "" || /[(,=:[!&|?{};+\-*%<>~^]/.test(prev);
	const skipString = (q) => {
		i++;
		while (i < text.length && text[i] !== q) i += text[i] === "\\" ? 2 : 1;
		i++;
	};
	const skipTemplate = () => {
		i++;
		while (i < text.length && text[i] !== "`") {
			if (text[i] === "\\") { i += 2; continue; }
			if (text[i] === "$" && text[i + 1] === "{") {
				i += 2;
				let depth = 1;
				const s = i;
				while (i < text.length && depth) {
					if (text[i] === "{") depth++;
					else if (text[i] === "}") depth--;
					else if (text[i] === "`") { skipTemplate(); continue; }
					else if (text[i] === '"' || text[i] === "'") { skipString(text[i]); continue; }
					i++;
				}
				out.push(...codeIdentifiers(text.slice(s, i - 1)));
				continue;
			}
			i++;
		}
		i++;
	};
	while (i < text.length) {
		const ch = text[i];
		if (ch === "/" && text[i + 1] === "/") { const e = text.indexOf("\n", i); i = e === -1 ? text.length : e; continue; }
		if (ch === "/" && text[i + 1] === "*") { const e = text.indexOf("*/", i + 2); i = e === -1 ? text.length : e + 2; continue; }
		if (ch === '"' || ch === "'") { skipString(ch); prev = "a"; continue; }
		if (ch === "`") { skipTemplate(); prev = "a"; continue; }
		if (ch === "/" && regexCanStart()) {
			i++;
			let inClass = false;
			while (i < text.length && (inClass || text[i] !== "/") && text[i] !== "\n") {
				if (text[i] === "\\") { i += 2; continue; }
				if (text[i] === "[") inClass = true;
				else if (text[i] === "]") inClass = false;
				i++;
			}
			i++;
			while (/[a-z]/.test(text[i] || "")) i++;
			prev = "a";
			continue;
		}
		if (/[A-Za-z_$]/.test(ch)) {
			IDENT_RE.lastIndex = i;
			const m = IDENT_RE.exec(text);
			let k = i - 1;
			while (k >= 0 && /\s/.test(text[k])) k--;
			const isProperty = k >= 0 && text[k] === "." && text[k - 1] !== ".";
			if (!isProperty) out.push(m[0]);
			i += m[0].length;
			prev = /^(return|typeof|case|in|of|new|delete|void|throw|else|do)$/.test(m[0]) ? "=" : "a";
			continue;
		}
		if (!/\s/.test(ch)) prev = ch;
		i++;
	}
	return out;
}

function indexDeclarations(src) {
	const lines = src.split("\n");
	const offsets = [];
	let at = 0;
	for (const l of lines) { offsets.push(at); at += l.length + 1; }
	const decls = new Map();
	const dupes = new Set();
	for (let i = 0; i < lines.length; i++) {
		const m = DECL_RE.exec(lines[i]);
		if (!m) continue;
		// `{ a, b: c, d = 1 }` binds a, c and d.
		const names = m[6] !== undefined
			? m[6].split(",").map((b) => b.split(":").pop().split("=")[0].trim()).filter(Boolean)
			: [m[2] || m[4]];
		const name = names.join(", ");
		const kind = m[2] ? "function" : (m[3] || m[5]);
		const start = offsets[i];
		let end;
		if (kind === "function") {
			end = src.indexOf("\n}\n", start);
			if (end === -1) throw new Error(`function ${name}() never closes`);
			end += 2;
		} else {
			let j = i + 1;
			while (j < lines.length) {
				const l = lines[j];
				if (l === "" || /^\s/.test(l) || /^[\]})`]/.test(l)) { j++; continue; }
				break;
			}
			// Trailing blank lines belong to no one.
			while (j - 1 > i && lines[j - 1] === "") j--;
			end = offsets[j - 1] + lines[j - 1].length;
		}
		const decl = { name, kind, start, end, text: src.slice(start, end) };
		for (const n of names) {
			if (decls.has(n)) dupes.add(n);
			decls.set(n, decl);
		}
	}
	return { decls, dupes };
}

// The route registration `head` (its first line, as written), through its "});".
function liftRoute(src, head) {
	const needle = `\n${head}`;
	const hits = src.split(needle).length - 1;
	if (hits !== 1) throw new Error(`expected exactly 1 registration ${JSON.stringify(head)}, found ${hits}`);
	const a = src.indexOf(needle) + 1;
	return src.slice(a, src.indexOf("\n});\n", a) + "\n});".length);
}

// Every top-level declaration `roots` and `routes` depend on, in source order
// (so a const reads the consts above it, as in the server). `provided` names
// are supplied by the caller and never lifted; a `denied` name the closure
// reaches is an error, so a script can never pull in, say, the HTTP server.
function closure(src, { roots = [], routes = [], provided = [], denied = [] }) {
	const { decls, dupes } = indexDeclarations(src);
	const provide = new Set(provided);
	const deny = new Set(denied);
	const want = new Set();
	const queue = [];
	const routeTexts = routes.map((h) => liftRoute(src, h));
	const visit = (text) => {
		for (const id of codeIdentifiers(text)) {
			if (provide.has(id) || want.has(id) || !decls.has(id)) continue;
			if (deny.has(id)) throw new Error(`the closure reaches ${id}, which a script must never lift`);
			if (dupes.has(id)) throw new Error(`${id} is declared more than once at the top level of server.js`);
			want.add(id);
			queue.push(id);
		}
	};
	for (const r of roots) {
		if (!decls.has(r)) throw new Error(`no top-level declaration ${r} in server.js`);
		if (!want.has(r)) { want.add(r); queue.push(r); }
	}
	for (const t of routeTexts) visit(t);
	while (queue.length) visit(decls.get(queue.shift()).text);
	// A destructuring declaration binding several wanted names is one piece.
	const pieces = [...new Set([...want].map((n) => decls.get(n)))].sort((x, y) => x.start - y.start);
	for (const p of pieces) {
		try {
			// A syntax check of the piece on its own (compiled, never called).
			new Function(p.text);
		} catch (err) {
			throw new Error(`lifted ${p.kind} ${p.name} does not parse on its own: ${err.message}`);
		}
	}
	return { names: pieces.flatMap((p) => p.name.split(", ").filter((n) => want.has(n))), text: [...pieces.map((p) => p.text), ...routeTexts].join("\n") };
}

module.exports = { indexDeclarations, liftRoute, closure, codeIdentifiers, DECL_START_RE };
