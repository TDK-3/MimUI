/* tools/make-expanded.js — rebuild the PRIMARY source (mim.js) from
 * mim.compressed.js in the expanded, readable form.
 *
 * What it does (all AST-based, nothing text-hacky except the final
 * blank-line/one-liner-if post pass):
 *   1. renames cryptic scope-local variables to detailed names
 *      (guarded: a rename only happens when the initializer proves the
 *      meaning, and it is skipped on any scope collision),
 *   2. renames function parameters on the renderer interface and the
 *      main public methods to detailed names,
 *   3. regenerates the file (unformatted).
 *
 * Section banners and the one-line-if expansion are added afterwards by
 * tools/postprocess-expanded.js (babel's generator glues synthetic line
 * comments onto the previous brace, so banners must be added as plain
 * text after generation).
 *
 * Run:  node tools/make-expanded.js
 *       npx prettier --single-quote --print-width 100 --write mim.js
 *       node tools/postprocess-expanded.js
 *       node --check mim.js
 * Then validate with the test suites (./run-tests.sh).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const babel = require("@babel/core");
const { isMember, LOCAL_RENAMES, PARAM_RENAMES } = require("./rename-tables");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "mim.compressed.js");
const OUT = path.join(ROOT, "mim.js");

/* ------------------------------------------------------------------ */
/* transformation                                                      */
/* ------------------------------------------------------------------ */

const source = fs.readFileSync(SRC, "utf8");
const { parse: babelParse } = require("@babel/parser");
const ast = babelParse(source, { sourceType: "script", attachComment: true });

const renames = []; // { node, name, to, scopeNode }

// NOTE: section banners are inserted by tools/postprocess-expanded.js
// (babel's generator glues synthetic line comments onto the previous
// brace, so they must be added as plain text after generation).

// --- pass 2: collect renames ---
(function collect() {
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    // guarded local declarators
    if (
      n.type === "VariableDeclarator" &&
      n.id &&
      n.id.type === "Identifier" &&
      LOCAL_RENAMES[n.id.name] &&
      n.init
    ) {
      const spec = LOCAL_RENAMES[n.id.name];
      if (spec.ok(n.init))
        renames.push({ node: n.id, name: n.id.name, to: spec.to });
    }
    for (const k in n) {
      if (
        k === "leadingComments" ||
        k === "trailingComments" ||
        k === "innerComments"
      )
        continue;
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === "string") walk(v);
    }
  })(ast);
})();

// --- pass 3: apply renames via babel scopes ---
function applyRenames() {
  const t = require("@babel/types");
  let applied = 0;
  const traverse = require("@babel/traverse").default;
  // only visit identifiers that are the declarator id
  const declaratorIds = new Set(renames.map((r) => r.node));
  traverse(ast, {
    VariableDeclarator(path) {
      const id = path.node.id;
      if (!declaratorIds.has(id)) return;
      const rec = renames.find((r) => r.node === id);
      if (!rec) return;
      try {
        const binding = path.scope.getBinding(rec.name);
        if (!binding) return;
        let s = binding.scope;
        while (s) {
          if (s.hasBinding(rec.to)) return;
          s = s.parent;
        }
        binding.scope.rename(rec.name, rec.to);
        applied++;
      } catch (e) {
        /* skip */
      }
    },
  });
  let paramApplied = 0;
  const specFor = (path) => {
    const n = path.node;
    const name = n.id ? n.id.name : n.key && (n.key.name || n.key.value);
    return name && PARAM_RENAMES[name] ? PARAM_RENAMES[name] : null;
  };
  traverse(ast, {
    "FunctionDeclaration|ClassMethod"(path) {
      const spec = specFor(path);
      if (!spec) return;
      try {
        path.scope.crawl();
        for (const p of path.node.params) {
          if (p.type !== "Identifier" || !spec[p.name]) continue;
          const to = spec[p.name];
          if (to === p.name) continue;
          const binding = path.scope.getBinding(p.name);
          if (!binding) continue;
          let s = binding.scope;
          let free = true;
          while (s) {
            if (s.hasBinding(to)) {
              free = false;
              break;
            }
            s = s.parent;
          }
          if (!free) continue;
          path.scope.rename(p.name, to);
          paramApplied++;
        }
      } catch (e) {
        /* skip */
      }
    },
  });
  console.log("local renames applied:", applied + "/" + renames.length);
  console.log("param renames applied:", paramApplied);
}
applyRenames();

// --- generate ---
const generated = babel.transformFromAst(ast, source, {
  sourceType: "script",
  generatorOpts: { retainLines: false, concise: false, compact: false },
}).code;

fs.writeFileSync(OUT, generated, "utf8");
console.log("wrote", OUT, generated.length, "chars");
