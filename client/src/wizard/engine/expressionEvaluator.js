const BINARY_OPS = {
  '==': (a, b) => a == b,
  '!=': (a, b) => a != b,
  '===': (a, b) => a === b,
  '!==': (a, b) => a !== b,
  '>': (a, b) => a > b,
  '<': (a, b) => a < b,
  '>=': (a, b) => a >= b,
  '<=': (a, b) => a <= b,
  '&&': (a, b) => a && b,
  '||': (a, b) => a || b,
};

function tokenize(expr) {
  const tokens = [];
  let i = 0;
  const s = String(expr);
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '(' || ch === ')') { tokens.push({ type: 'paren', value: ch }); i++; continue; }
    if (ch === '!' && s[i + 1] !== '=') { tokens.push({ type: 'not', value: '!' }); i++; continue; }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      let j = i + 1;
      let str = '';
      while (j < s.length && s[j] !== quote) {
        if (s[j] === '\\' && j + 1 < s.length) { str += s[j + 1]; j += 2; } else { str += s[j]; j++; }
      }
      tokens.push({ type: 'string', value: str });
      i = j + 1;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < s.length && /[0-9.]/.test(s[j])) j++;
      tokens.push({ type: 'number', value: Number(s.slice(i, j)) });
      i = j;
      continue;
    }
    const twoChar = s.slice(i, i + 2);
    const threeChar = s.slice(i, i + 3);
    if (BINARY_OPS[threeChar]) { tokens.push({ type: 'op', value: threeChar }); i += 3; continue; }
    if (BINARY_OPS[twoChar]) { tokens.push({ type: 'op', value: twoChar }); i += 2; continue; }
    if ('><'.includes(ch)) { tokens.push({ type: 'op', value: ch }); i++; continue; }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < s.length && /[A-Za-z0-9_$.\[\]]/.test(s[j])) j++;
      const ident = s.slice(i, j);
      if (ident === 'true') tokens.push({ type: 'bool', value: true });
      else if (ident === 'false') tokens.push({ type: 'bool', value: false });
      else if (ident === 'null') tokens.push({ type: 'null', value: null });
      else tokens.push({ type: 'ident', value: ident });
      i = j;
      continue;
    }
    i++;
  }
  return tokens;
}

function readPath(ctx, path) {
  const parts = path.match(/[^.\[\]]+/g) || [];
  let cur = ctx;
  for (const part of parts) {
    if (cur == null) return undefined;
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') return undefined;
    cur = cur[part];
  }
  return cur;
}

function parsePrimary(tokens, ctx) {
  const tok = tokens.shift();
  if (!tok) return undefined;
  if (tok.type === 'paren' && tok.value === '(') {
    const value = parseExpression(tokens, ctx);
    tokens.shift();
    return value;
  }
  if (tok.type === 'not') {
    return !parsePrimary(tokens, ctx);
  }
  if (tok.type === 'string') return tok.value;
  if (tok.type === 'number') return tok.value;
  if (tok.type === 'bool') return tok.value;
  if (tok.type === 'null') return null;
  if (tok.type === 'ident') return readPath(ctx, tok.value);
  return undefined;
}

function parseBinary(tokens, ctx, minPrec) {
  const precedence = {
    '||': 1, '&&': 2,
    '==': 3, '!=': 3, '===': 3, '!==': 3,
    '<': 4, '>': 4, '<=': 4, '>=': 4,
  };
  let left = parsePrimary(tokens, ctx);
  while (tokens.length) {
    const tok = tokens[0];
    if (tok.type !== 'op') break;
    const prec = precedence[tok.value];
    if (prec == null || prec < minPrec) break;
    tokens.shift();
    const right = parseBinary(tokens, ctx, prec + 1);
    left = BINARY_OPS[tok.value](left, right);
  }
  return left;
}

function parseExpression(tokens, ctx) {
  return parseBinary(tokens, ctx, 1);
}

export function evalExpression(expr, ctx = {}) {
  try {
    const tokens = tokenize(expr);
    return parseExpression(tokens, ctx);
  } catch {
    return false;
  }
}
