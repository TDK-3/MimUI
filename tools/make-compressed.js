/* tools/make-compressed.js — regenerate mim.compressed.js from the primary
 * source (mim.js, the expanded readable form).
 *
 * It is the exact inverse of tools/make-expanded.js + postprocess-expanded.js:
 *   1. renames detailed scope-local variables back to their cryptic names
 *      (same structural guards as the forward pass — the guards inspect the
 *      initializer, never the name — and the same scope-collision safety),
 *   2. renames the detailed parameter names back to cryptic ones,
 *   3. collapses single-statement `if` bodies back to one line
 *      (`if (c) stmt;`), matching the compact house style,
 *   4. regenerates, runs Prettier (single quotes, 100 columns), and removes
 *      the section-banner comment lines that only the expanded form keeps.
 *
 * Run:  node tools/make-compressed.js
 *       node --check mim.compressed.js
 * Then validate both forms against the test suites (./run-tests.sh).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const prettier = require("prettier");
const babel = require("@babel/core");
const { LOCAL_RENAMES, PARAM_RENAMES } = require("./rename-tables");

const ROOT = path.join(__dirname, "..");
const SRC = path.join(ROOT, "mim.js");
const OUT = path.join(ROOT, "mim.compressed.js");

/* section banners added by tools/postprocess-expanded.js (removed here) */
const BANNERS = new Set([
  "// ---- shared math & color helpers ----",
  "// ---- value formatting ----",
  "// ---- public constants ----",
  "// ---- built-in theme: dark ----",
  "// ---- built-in theme: light ----",
  "// ---- default style variables ----",
  "// ---- style model ----",
  "// ---- feature-detection sentinel ----",
  "// ---- renderer proxy: clip / offset / layers / recording ----",
  "// ---- window record ----",
  "// ---- GUI: the main class ----",
  "// ---- misc helpers ----",
  "// ---- public export object ----",
]);

/* ------------------------------------------------------------------ */
/* transformation                                                      */
/* ------------------------------------------------------------------ */

const source = fs.readFileSync(SRC, "utf8");
const { parse: babelParse } = require("@babel/parser");
const traverse = require("@babel/traverse").default;
const ast = babelParse(source, { sourceType: "script", attachComment: true });

// reverse tables: detailed -> cryptic (the guards are name-independent,
// so the SAME ok(init) function proves the meaning in both directions)
const LOCAL_REV = {};
for (const [from, spec] of Object.entries(LOCAL_RENAMES))
  LOCAL_REV[spec.to] = { to: from, ok: spec.ok };
const PARAM_REV = {};
for (const [fn, map] of Object.entries(PARAM_RENAMES)) {
  PARAM_REV[fn] = {};
  for (const [from, to] of Object.entries(map)) PARAM_REV[fn][to] = from;
}

// --- pass 1: collect guarded local declarators (detailed name -> cryptic) ---
const renames = [];
(function collect() {
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    if (
      n.type === "VariableDeclarator" &&
      n.id &&
      n.id.type === "Identifier" &&
      LOCAL_REV[n.id.name] &&
      n.init
    ) {
      const spec = LOCAL_REV[n.id.name];
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

// --- pass 2: apply renames via babel scopes ---
let applied = 0;
{
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
          if (s.hasBinding(rec.to)) return; // cryptic name already used here
          s = s.parent;
        }
        binding.scope.rename(rec.name, rec.to);
        applied++;
      } catch (e) {
        /* skip */
      }
    },
  });
}
console.log("local renames reverted:", applied + "/" + renames.length);

let paramApplied = 0;
{
  const specFor = (path) => {
    const n = path.node;
    const name = n.id ? n.id.name : n.key && (n.key.name || n.key.value);
    return name && PARAM_REV[name] ? PARAM_REV[name] : null;
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
}
console.log("param renames reverted:", paramApplied);

// --- pass 3: collapse single-statement if bodies back to one line -------
// (inverse of postprocess-expanded.js step 1; covers else-if chains too,
//  since an else-if is just another IfStatement node)
let collapsed = 0;
traverse(ast, {
  IfStatement(path) {
    const consequent = path.node.consequent;
    if (consequent.type !== "BlockStatement") return;
    if (consequent.body.length !== 1) return;
    const only = consequent.body[0];
    if (only.type === "Directive") return;
    path.node.consequent = only;
    collapsed++;
  },
});
console.log("if bodies collapsed to one line:", collapsed);

// --- generate + prettier + banner removal ------------------------------
(async () => {
  const generated = babel.transformFromAst(ast, source, {
    sourceType: "script",
    generatorOpts: { retainLines: false, concise: false, compact: false },
  }).code;
  const formatted = await prettier.format(generated, {
    parser: "babel",
    singleQuote: true,
    printWidth: 100,
  });
  const cleaned = formatted
    .split("\n")
    .filter((l) => !BANNERS.has(l.trim()))
    .join("\n");
  fs.writeFileSync(OUT, cleaned, "utf8");
  console.log("wrote", OUT, cleaned.length, "chars");
})();
