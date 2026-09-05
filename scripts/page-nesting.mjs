#!/usr/bin/env node
// PAGE NESTING GATE — every <div class="page"> in index.html must sit directly
// inside <div class="main"> (which sits inside .shell). A stray </div> closes
// .main early and every page after it lands OUTSIDE the 100vh shell: it gets
// .active, renders, and is invisible below the fold (body is overflow:hidden).
// That is exactly how the Users page shipped blank on 2026-09-05.
//
//   node scripts/page-nesting.mjs      exit 1 with the offending page ids
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

const stack = [];      // open <div> descriptors
const problems = [];
let pages = 0, line = 1;
const re = /<(\/?)div\b([^>]*)>|\n/g;
let m;
while ((m = re.exec(html))) {
  if (m[0] === '\n') { line++; continue; }
  if (m[1] === '/') { stack.pop(); continue; }
  if (m[2].endsWith('/')) continue;
  const attrs = m[2];
  const cls = (attrs.match(/class="([^"]*)"/) || [, ''])[1].split(/\s+/);
  const id = (attrs.match(/id="([^"]*)"/) || [, ''])[1];
  const desc = { cls, id, line };
  if (cls.includes('page')) {
    pages++;
    const parent = stack[stack.length - 1];
    const grand = stack[stack.length - 2];
    if (!parent || !parent.cls.includes('main') || !grand || !grand.cls.includes('shell')) {
      problems.push(`#${id || '(no id)'} at line ${line}: parent is ${parent ? (parent.id ? '#' + parent.id : '.' + parent.cls.join('.')) : 'document'} (depth ${stack.length}), expected .shell > .main`);
    }
  }
  stack.push(desc);
}
if (stack.length) problems.push(`${stack.length} <div> left open at end of file (first: line ${stack[0].line})`);

if (problems.length) {
  console.log(`PAGE NESTING: ${problems.length} problem(s) across ${pages} pages`);
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log(`PAGE NESTING CLEAN — ${pages} pages, every one a child of .shell > .main`);
