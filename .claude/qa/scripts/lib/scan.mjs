// Shared, dependency-free source scanning helpers used by stack drivers.

/** Split on `sep` at nesting depth 0, respecting quotes and (), {}, []. */
export function splitTop(s, sep = ',') {
  const parts = [];
  let depth = 0, quote = null, cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) { cur += c; if (c === '\\') { cur += s[++i] ?? ''; } else if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; cur += c; continue; }
    if ('({['.includes(c)) depth++;
    if (')}]'.includes(c)) depth--;
    if (c === sep && depth === 0) { parts.push(cur); cur = ''; } else cur += c;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}

/**
 * From index i (src[i] is an opening bracket), return the index just past its matching close bracket.
 * Skips string literals ('', "", ``) and // and /* comments. Works for Java, C#, JS/TS.
 */
export function matchBracket(src, i) {
  const open = src[i];
  const close = { '(': ')', '{': '}', '[': ']' }[open];
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '"' || c === "'" || c === '`') { j = skipString(src, j) - 1; continue; }
    if (c === '/' && src[j + 1] === '/') { const n = src.indexOf('\n', j); j = n < 0 ? src.length : n; continue; }
    if (c === '/' && src[j + 1] === '*') { const n = src.indexOf('*/', j + 2); j = n < 0 ? src.length : n + 1; continue; }
    if (c === open) depth++;
    else if (c === close && --depth === 0) return j + 1;
  }
  return src.length;
}

/** From index i at a quote char, return the index just past the closing quote. Handles escapes and Java/C# text blocks. */
export function skipString(src, i) {
  const q = src[i];
  if (q === '"' && src.startsWith('"""', i)) { const n = src.indexOf('"""', i + 3); return n < 0 ? src.length : n + 3; }
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === q) return j + 1;
    if (src[j] === '\n' && q !== '`') return j + 1; // unterminated single-line string: recover
  }
  return src.length;
}

/** Read a string literal at index i (after optional whitespace). Returns { value, end } or null. */
export function readStringAt(src, i) {
  while (/\s/.test(src[i] || '')) i++;
  const q = src[i];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  const end = skipString(src, i);
  return { value: src.slice(i + 1, end - 1).replace(/\\(.)/g, '$1'), end };
}

/** Blank out comments while preserving offsets and newlines (for C-like languages). */
export function stripComments(src) {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { const e = skipString(src, i); out += src.slice(i, e); i = e - 1; continue; }
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); const e = n < 0 ? src.length : n; out += ' '.repeat(e - i); i = e - 1; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); const e = n < 0 ? src.length : n + 2; out += src.slice(i, e).replace(/[^\n]/g, ' '); i = e - 1; continue; }
    out += c;
  }
  return out;
}

export const lineAt = (src, idx) => src.slice(0, idx).split('\n').length;

export const humanize = (name) => String(name).replace(/^test_?/i, '').replace(/_/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2')
  .replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase());

export const uniq = (a) => [...new Set(a.filter((x) => x !== undefined && x !== null && x !== ''))];

/** ADO/TC ids embedded in names, titles or tags: TC-1234, ADO_1234, TC1234. */
export const adoIdsIn = (...texts) => uniq(texts.flatMap((t) => [...String(t || '').matchAll(/\b(?:TC|ADO|TestCase)[-_:]?(\d{3,})\b/gi)].map((m) => m[1])));

/** Dedupe ids within one file by suffixing #2, #3... */
export function dedupeIds(entries) {
  const seen = new Map();
  for (const e of entries) {
    const n = (seen.get(e.id) || 0) + 1;
    seen.set(e.id, n);
    if (n > 1) e.id = `${e.id}#${n}`;
  }
  return entries;
}

/** Shell-quote for POSIX shells (Git Bash on Windows included). */
export const shq = (s) => (/^[\w./:@%+=,-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

/**
 * Split items into chunks whose joined size stays under maxChars (keeps generated command lines under
 * OS limits, e.g. ~8K on Windows). sizeFn defaults to the item's string length plus a separator.
 */
export function chunkBy(items, maxChars, _sep = ' ', sizeFn = (x) => String(x).length + 1) {
  const chunks = [];
  let cur = [], size = 0;
  for (const it of items) {
    const s = sizeFn(it);
    if (cur.length && size + s > maxChars) { chunks.push(cur); cur = []; size = 0; }
    cur.push(it); size += s;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** Escape a string for use inside a regular expression. */
export const reEsc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
