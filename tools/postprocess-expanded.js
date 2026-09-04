/* tools/postprocess-expanded.js — line-level finishing pass for the
 * primary source (mim.js), run after tools/make-expanded.js + prettier.
 *
 *  1. expands one-line `if (c) stmt;` (and `} else if (c) stmt;`) into full
 *     multi-line braced form — always a newline for if statements,
 *  2. inserts a separating blank line before if / for / while / try / return
 *     statements and around section-banner comments,
 *  3. collapses runs of blank lines.
 *
 * Run AFTER prettier has normalized the babel output.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'mim.js');
const lines = fs.readFileSync(file, 'utf8').split('\n');

/* ------------------------------------------------------------------ */
/* 1. one-line if expansion                                            */
/* ------------------------------------------------------------------ */

// find the index just past the closing paren of the if-condition
function condEnd(line, openIdx) {
  let depth = 0;
  let inStr = null;
  for (let i = openIdx; i < line.length; i++) {
    const ch = line[i];
    if (inStr) {
      if (ch === '\\') i++;
      else if (ch === inStr) inStr = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') inStr = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

const out = [];
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  let m = line.match(/^(\s*)if\s*\(/);
  let isElseIf = false;
  if (!m) {
    m = line.match(/^(\s*)\} else if\s*\(/);
    isElseIf = true;
  }
  if (!m) { out.push(line); continue; }
  const indent = m[1];
  const openIdx = line.indexOf('(', m[0].length - 1);
  const end = condEnd(line, openIdx);
  if (end < 0) { out.push(line); continue; } // multi-line condition: leave
  const stmt = line.slice(end).trim();
  if (!stmt || stmt === ';' || stmt.startsWith('{')) { out.push(line); continue; }
  if (stmt.includes('{')) { out.push(line); continue; } // object literal: leave
  const head = isElseIf ? `} else if (${line.slice(openIdx + 1, end - 1)}) {` : `if (${line.slice(openIdx + 1, end - 1)}) {`;
  out.push(indent + head);
  out.push(indent + '  ' + stmt);
  out.push(indent + '}');
}

/* ------------------------------------------------------------------ */
/* 1.5 section banners (inserted above well-known anchor lines)        */
/* ------------------------------------------------------------------ */

const BANNERS = [
  ['  const clamp = ', '// ---- shared math & color helpers ----'],
  ['  function fmtVal(', '// ---- value formatting ----'],
  ['  const Layers = ', '// ---- public constants ----'],
  ['  const ThemeDark = {', '// ---- built-in theme: dark ----'],
  ['  const ThemeLight = {', '// ---- built-in theme: light ----'],
  ['  const DefaultVars = {', '// ---- default style variables ----'],
  ['  class Style {', '// ---- style model ----'],
  ['  const EMPTY_FEATURES = ', '// ---- feature-detection sentinel ----'],
  ['  class RendererProxy {', '// ---- renderer proxy: clip / offset / layers / recording ----'],
  ['  class Window {', '// ---- window record ----'],
  ['  class GUI {', '// ---- GUI: the main class ----'],
  ['  function fpPad(', '// ---- misc helpers ----'],
  ['  const Mim = {', '// ---- public export object ----'],
];

const withBanners = [];
const used = new Set();
for (let i = 0; i < out.length; i++) {
  for (let b = 0; b < BANNERS.length; b++) {
    if (used.has(b)) continue;
    if (out[i].startsWith(BANNERS[b][0])) {
      withBanners.push(BANNERS[b][1]);
      used.add(b);
    }
  }
  withBanners.push(out[i]);
}

/* ------------------------------------------------------------------ */
/* 2. separating blank lines                                           */
/* ------------------------------------------------------------------ */

const isBlank = (l) => l.trim() === '';
const isBanner = (l) => /^\/\/ ----/.test(l);
const startsBlockStmt = (l) => /^\s{2,}(if |for |while |try )/.test(l) && !/^\s*\}/.test(l);
const isReturnStmt = (l) => /^\s{2,}return /.test(l) || /^\s{2,}return;/.test(l);
const endsOpenBrace = (l) => /{\s*$/.test(l) && !/^\s*\*/.test(l);
// a top-level declaration inside the IIFE (indent exactly 2) starts a new
// chunk: separate it from whatever came before
const isTopDecl = (l) => /^  (function |const |let |var |class )/.test(l);
const isCommentLine = (l) => /^\s*(\/\/|\/\*|\*)/.test(l);

const final = [];
for (let i = 0; i < withBanners.length; i++) {
  const line = withBanners[i];
  const prev = i > 0 ? withBanners[i - 1] : null;
  const next = i + 1 < withBanners.length ? withBanners[i + 1] : null;

  // banner spacing: blank before (unless already blank/comment) and after
  if (isBanner(line)) {
    if (prev != null && !isBlank(prev) && !/^\/\//.test(prev) && !prev.startsWith('/*') && prev.trim() !== '') {
      final.push('');
    }
    final.push(line);
    if (next != null && !isBlank(next)) final.push('');
    continue;
  }
  // separating newline before block statements
  if ((startsBlockStmt(line) || isReturnStmt(line)) && prev != null && !isBlank(prev) && !endsOpenBrace(prev) && !isBanner(prev)) {
    final.push('');
  }
  // separating newline before top-level chunks (unless a comment introduces them)
  if (isTopDecl(line) && prev != null && !isBlank(prev) && !isCommentLine(prev) && !isBanner(prev)) {
    final.push('');
  }
  final.push(line);
}

/* ------------------------------------------------------------------ */
/* 3. collapse blank runs, trim tail                                   */
/* ------------------------------------------------------------------ */

const result = [];
let blank = 0;
for (const line of final) {
  if (isBlank(line)) {
    blank++;
    if (blank > 1) continue;
  } else blank = 0;
  result.push(line);
}
while (result.length && result[result.length - 1].trim() === '') result.pop();
result.push('');

fs.writeFileSync(file, result.join('\n'), 'utf8');
console.log('postprocessed:', result.length, 'lines');
