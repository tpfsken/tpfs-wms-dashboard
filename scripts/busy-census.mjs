#!/usr/bin/env node
// =============================================================================
// Busy census — every async click handler must go through uiBusy.
//
//   Flags, across js/*.js and index.html:
//     1. addEventListener('click', async …)            not wrapped in uiBusyHandler(…)
//     2. addEventListener('click', NAME)               NAME is an async function, not wrapped
//     3. addEventListener('click', (…) => …NAME(…)…)   arrow that calls an async function
//                                                        or contains `await`, not wrapped
//     4. onclick="NAME(…)"                             NAME async, not wrapped in uiRun(this, …)
//     5. el.onclick = async …                          not wrapped
//
//   Rationale: a second click while the first request runs must never fire a
//   second request; uiBusy disables the control, shows "Working…", flashes on
//   success and puts the error next to the control.
//
//   Usage: node scripts/busy-census.mjs      (exit 1 on findings)
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const jsDir = path.join(root, 'js');
const files = fs.readdirSync(jsDir).filter(f => f.endsWith('.js')).map(f => path.join(jsDir, f));
const html = path.join(root, 'index.html');

const src = Object.fromEntries(files.map(f => [f, fs.readFileSync(f, 'utf8')]));
const asyncFns = new Set();
for (const s of Object.values(src)) {
  for (const m of s.matchAll(/\basync\s+function\s+([A-Za-z_$][\w$]*)/g)) asyncFns.add(m[1]);
  for (const m of s.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*async\b/g)) asyncFns.add(m[1]);
}
// wrappers that are themselves the guard
const GUARDS = new Set(['uiBusyHandler', 'uiRun', 'uiBusy']);

/** Span of the argument list of a call starting at `open` (index of '('), string/template aware. */
function matchParen(s, open) {
  let depth = 0, i = open, q = null;
  for (; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '\\') { i++; continue; } if (ch === q) q = null; continue; }
    if (ch === '\'' || ch === '"' || ch === '`') { q = ch; continue; }
    if (ch === '/' && s[i + 1] === '/') { i = s.indexOf('\n', i); if (i < 0) return -1; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
const callsAsync = (body) => /\bawait\b/.test(body) || [...asyncFns].some(n => new RegExp(`(^|[^.\\w$])${n.replace(/\$/g, '\\$')}\\s*\\(`).test(body));
const lineOf = (s, idx) => s.slice(0, idx).split('\n').length;

const findings = [];
for (const [f, s] of Object.entries(src)) {
  const rel = path.relative(root, f);
  const re = /\.addEventListener\(\s*['"]click['"]\s*,\s*/g;
  let m;
  while ((m = re.exec(s))) {
    const open = s.lastIndexOf('(', m.index + m[0].length - 1);
    const close = matchParen(s, s.indexOf('(', m.index));
    if (close < 0) continue;
    const arg = s.slice(m.index + m[0].length, close).trim();
    const head = arg.split('(')[0].trim();
    if (GUARDS.has(head)) continue;
    let why = null;
    if (/^async\b/.test(arg)) why = 'async handler';
    else if (/^[A-Za-z_$][\w$]*$/.test(arg) && asyncFns.has(arg)) why = `named async handler ${arg}`;
    else if (/^(\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/.test(arg) && callsAsync(arg)) why = 'arrow calls an async function';
    if (why) findings.push(`${rel}:${lineOf(s, m.index)}  ${why}: ${arg.slice(0, 70).replace(/\s+/g, ' ')}`);
  }
  for (const mm of s.matchAll(/\.onclick\s*=\s*(async\b[^\n]{0,60}|[A-Za-z_$][\w$]*\s*;)/g)) {
    const rhs = mm[1].trim().replace(/;$/, '');
    if (/^async\b/.test(rhs) || asyncFns.has(rhs)) findings.push(`${rel}:${lineOf(s, mm.index)}  .onclick = ${rhs.slice(0, 50)}`);
  }
  for (const mm of s.matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)) {
    if (asyncFns.has(mm[1])) findings.push(`${rel}:${lineOf(s, mm.index)}  inline onclick="${mm[1]}(…)" (use uiRun)`);
  }
}
{
  const s = fs.readFileSync(html, 'utf8');
  for (const mm of s.matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)) {
    if (asyncFns.has(mm[1])) findings.push(`index.html:${lineOf(s, mm.index)}  inline onclick="${mm[1]}(…)" (use uiRun)`);
  }
}

if (findings.length) {
  console.log(`BUSY CENSUS — ${findings.length} async click handler(s) not wrapped:\n` + findings.map(x => '  ' + x).join('\n'));
  process.exit(1);
}
console.log(`BUSY CENSUS CLEAN — ${asyncFns.size} async functions known, every async click handler is wrapped.`);
