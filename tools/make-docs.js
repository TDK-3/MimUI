#!/usr/bin/env node
/*
 * tools/make-docs.js -- generate the doxygen-style API site in docs/
 *
 * Pipeline:
 *   npx jsdoc -c .jsdoc-dump.json -X > .jsdoc-doclets.json   (doclet dump)
 *   node tools/make-docs.js                                  (HTML generator)
 *
 * Reads the doclet JSON plus BACKEND.md / ADDONS.md (tutorials) and writes
 * self-contained HTML pages (inline CSS, no external assets) so the site
 * works offline and inside sandboxed previews.
 */
"use strict";
const fs = require("fs");

const doclets = JSON.parse(fs.readFileSync(".jsdoc-doclets.json", "utf8"));
const VERSION = "1.0.0";

/* ------------------------------------------------------------------ */
/* doclet helpers                                                      */
/* ------------------------------------------------------------------ */

const byLong = (ln) => doclets.find((x) => x.longname === ln);
const esc = (s) =>
  String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

function cleanDesc(d) {
  return String(d || "")
    .replace(/\n\s*\*\s*/g, " ") // leftover JSDoc continuation markers
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function briefOf(d) {
  const t = cleanDesc(d);
  const m = t.match(/^[^.]*\./);
  if (m && m[0].length >= 25) return m[0];
  if (t.length > 120) return t.slice(0, 117).replace(/\s+\S*$/, "") + "...";
  return t || "&nbsp;";
}

/* ------------------------------------------------------------------ */
/* symbol registry + cross links                                       */
/* ------------------------------------------------------------------ */

const slug = (ln) => "a_" + String(ln).replace(/[^a-zA-Z0-9]/g, "_");

// longname -> file
const FILE = {
  GUI: "GUI.html",
  Style: "Style.html",
  Mim: "Mim.html",
  "Mim.Color": "Mim_Color.html",
  Layers: "Layers.html",
  Key: "Key.html",
  MouseButton: "MouseButton.html",
  WindowFlags: "WindowFlags.html",
};
for (const ns of [
  "plots",
  "t3d",
  "tables",
  "color",
  "notifs",
  "widgets",
  "markdown",
])
  FILE["gui.addons." + ns] = "gui_addons_" + ns + ".html";

const target = (ln) => {
  if (FILE[ln]) return FILE[ln];
  if (ln.startsWith("GUI#")) return "GUI.html#" + slug(ln);
  if (ln.startsWith("Style#")) return "Style.html#" + slug(ln);
  if (ln.startsWith("Mim.Color.")) return "Mim_Color.html#" + slug(ln);
  if (ln.startsWith("Mim.")) return "Mim.html#" + slug(ln);
  const i = ln.lastIndexOf(".");
  const parent = ln.slice(0, i);
  if (FILE[parent]) return FILE[parent] + "#" + slug(ln);
  return null;
};

// qualified names to linkify (longest first)
const qualified = [];
const pushQ = (ln) => {
  const t = target(ln);
  if (t) qualified.push({ name: ln, link: t });
};
for (const x of doclets) {
  if (
    x.memberof &&
    x.memberof.startsWith("gui.addons.") &&
    x.kind === "function"
  )
    pushQ(x.longname);
  if (/^Mim\.Color\./.test(x.longname)) pushQ(x.longname);
}
for (const ln of Object.keys(FILE)) pushQ(ln);
qualified.sort((a, b) => b.name.length - a.name.length);

// bare GUI method names, linked only when followed by (
const bareNames = new Set();
for (const x of doclets)
  if (
    x.memberof === "GUI" &&
    x.kind === "function" &&
    !x.name.startsWith("_") &&
    x.name.length >= 5 &&
    x.name !== "constructor"
  )
    bareNames.add(x.name);

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const qLink = (ln) =>
  '<a class="xref" href="' + target(ln) + '">' + esc(ln) + "</a>";

function linkify(html) {
  const parts = String(html).split(/(<[^>]*>)/);
  for (let i = 0; i < parts.length; i += 2) {
    let t = parts[i];
    for (const q of qualified) {
      if (!t.includes(q.name)) continue;
      t = t.replace(
        new RegExp(
          "(?<![\\w$])" + reEsc(q.name) + "(?!\\w)(?!\\.(?=\\w))",
          "g",
        ),
        qLink(q.name),
      );
    }
    for (const n of bareNames) {
      if (!t.includes(n)) continue;
      t = t.replace(
        new RegExp("(?<![\\w$#.])" + reEsc(n) + "(?=\\s*\\()", "g"),
        '<a class="xref" href="GUI.html#' +
          slug("GUI#" + n) +
          '">' +
          n +
          "</a>",
      );
    }
    parts[i] = t;
  }
  return parts.join("");
}

/* ------------------------------------------------------------------ */
/* markdown -> HTML (the subset used by BACKEND.md / ADDONS.md)        */
/* ------------------------------------------------------------------ */

function inlineMd(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<i>$2</i>");
  return linkify(s);
}

function mdToHtml(md, title) {
  const lines = md.split("\n");
  let out = [];
  let para = [];
  let list = null; // 'ul' | 'ol'
  let pre = null; // buffer
  let listBuf = [];
  const closePara = () => {
    if (para.length) {
      out.push("<p>" + para.map(inlineMd).join(" ") + "</p>");
      para = [];
    }
  };
  const closeList = () => {
    if (listBuf.length) {
      out.push("<" + list + ">" + listBuf.join("") + "</" + list + ">");
      listBuf = [];
      list = null;
    }
  };
  const closePre = () => {
    if (pre != null) {
      out.push("<pre>" + esc(pre.join("\n")) + "</pre>");
      pre = null;
    }
  };
  for (const raw of lines) {
    if (pre != null) {
      if (/^ {4,}\S/.test(raw) || raw.trim() === "") {
        pre.push(raw.replace(/^ {4}/, ""));
        if (raw.trim() === "" && pre[pre.length - 1] === "") continue;
        continue;
      }
      closePre();
    }
    if (/^ {4,}\S/.test(raw)) {
      closePara();
      closeList();
      pre = [raw.replace(/^ {4}/, "")];
      continue;
    }
    const h = raw.match(/^(#{1,4}) (.*)$/);
    if (h) {
      closePara();
      closeList();
      const lvl = h[1].length;
      const id =
        "h_" +
        h[2]
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "");
      out.push(
        "<h" +
          (lvl + 1) +
          ' id="' +
          id +
          '">' +
          inlineMd(h[2]) +
          "</h" +
          (lvl + 1) +
          ">",
      );
      continue;
    }
    const ul = raw.match(/^ {0,3}- (.*)$/);
    const ol = raw.match(/^ {0,3}\d+\. (.*)$/);
    if (ul || ol) {
      closePara();
      const kind = ul ? "ul" : "ol";
      if (list !== kind) {
        closeList();
        list = kind;
      }
      listBuf.push("<li>" + inlineMd((ul || ol)[1]) + "</li>");
      continue;
    }
    if (raw.trim() === "") {
      closePara();
      closeList();
      continue;
    }
    para.push(raw.trim());
  }
  closePara();
  closeList();
  closePre();
  return out.join("\n");
}

/* ------------------------------------------------------------------ */
/* page frame + doxygen-style css                                      */
/* ------------------------------------------------------------------ */

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin:0; font: 14px/1.55 "Segoe UI", "Helvetica Neue", Helvetica, Arial, sans-serif; color:#222; background:#e6e6e6; }
a { color:#1a4a7c; text-decoration:none; }
a:hover { text-decoration:underline; }
code, pre { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace; }
.nav { background:#2f4368; color:#fff; padding:0 18px; display:flex; flex-wrap:wrap; align-items:baseline; gap:2px 14px; }
.nav .brand { font-weight:600; font-size:15px; padding:10px 0 2px; margin-right:10px; }
.nav a { color:#cfd9ea; padding:10px 0 2px; font-size:13px; }
.nav a:hover { color:#fff; text-decoration:underline; }
.nav .sep { color:#8fa3c4; font-size:12px; }
.wrap { max-width:1100px; margin:0 auto; padding:18px 14px 60px; }
.card { background:#fff; border:1px solid #c8c8c8; border-radius:3px; padding:22px 28px 30px; box-shadow:0 1px 3px rgba(0,0,0,.08); }
h1 { font-size:22px; color:#1a3a5c; margin:.2em 0 .6em; border-bottom:2px solid #1a4a7c; padding-bottom:6px; }
h2 { font-size:17px; color:#1a4a7c; margin:1.4em 0 .5em; border-bottom:1px solid #d5dde8; padding-bottom:3px; }
h3 { font-size:15px; color:#2f4368; margin:1.2em 0 .4em; }
p { margin:.55em 0; }
table { border-collapse:collapse; width:100%; margin:.7em 0 1em; }
th, td { border:1px solid #c9d2de; padding:5px 9px; text-align:left; vertical-align:top; font-size:13px; }
th { background:#eef1f5; }
tr:nth-child(even) td { background:#f7f9fc; }
.crumbs { font-size:12px; color:#555; margin-bottom:8px; }
.crumbs b { color:#222; }
.membrief { border:1px solid #c9d2de; margin:.8em 0 1.2em; }
.membrief td { font-size:13px; }
.membrief .sig { white-space:nowrap; }
.membrief .sig b { font-family:Consolas,monospace; font-size:13px; }
.memitem { border:1px solid #c9d2de; border-left:4px solid #1a4a7c; margin:0 0 1em; }
.memname { background:#eef1f5; padding:6px 10px; font-family:Consolas,monospace; font-size:13px; border-bottom:1px solid #c9d2de; }
.memname b { font-size:14px; }
.memname .p { color:#555; }
.memdoc { padding:8px 12px 10px; }
.memdoc .ptype { color:#0b60b0; font-family:Consolas,monospace; font-size:12px; }
table.params { width:auto; min-width:60%; }
table.params .pt { color:#0b60b0; font-family:Consolas,monospace; font-size:12px; white-space:nowrap; }
table.params .pn { font-family:Consolas,monospace; font-size:12px; white-space:nowrap; font-weight:600; }
table.params .pd { }
dl { margin:.4em 0; }
dt { font-weight:600; color:#1a4a7c; font-size:13px; }
dd { margin:0 0 .4em 1.4em; }
pre { background:#f4f6f8; border:1px solid #d5dde8; padding:10px 12px; overflow-x:auto; font-size:12.5px; line-height:1.45; border-radius:2px; }
.note { background:#fff8e6; border:1px solid #e3cf8b; border-radius:2px; padding:8px 12px; margin:.8em 0; font-size:13px; }
.footer { max-width:1100px; margin:0 auto; padding:0 14px 30px; font-size:12px; color:#667; }
.xref { color:#1a4a7c; }
`;

const NAV = (active) => {
  const A = (href, label) =>
    '<a href="' +
    href +
    '"' +
    (active === href ? ' style="color:#fff;font-weight:600"' : "") +
    ">" +
    label +
    "</a>";
  return (
    '<div class="nav"><span class="brand">mim ' +
    VERSION +
    "</span>" +
    A("index.html", "Index") +
    '<span class="sep">Classes:</span>' +
    A("GUI.html", "GUI") +
    A("Style.html", "Style") +
    '<span class="sep">Namespaces:</span>' +
    A("Mim.html", "Mim") +
    A("Mim_Color.html", "Color") +
    A("gui_addons_plots.html", "plots") +
    A("gui_addons_t3d.html", "t3d") +
    A("gui_addons_tables.html", "tables") +
    A("gui_addons_color.html", "color") +
    A("gui_addons_notifs.html", "notifs") +
    A("gui_addons_widgets.html", "widgets") +
    A("gui_addons_markdown.html", "markdown") +
    '<span class="sep">Constants:</span>' +
    A("Layers.html", "Layers") +
    A("Key.html", "Key") +
    A("MouseButton.html", "MouseButton") +
    A("WindowFlags.html", "WindowFlags") +
    '<span class="sep">Tutorials:</span>' +
    A("tutorial_backend.html", "Writing a backend") +
    A("tutorial_addons.html", "Writing an addon") +
    "</div>"
  );
};

const page = (title, active, body) =>
  '<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
  "<title>" +
  title +
  "</title>\n<style>" +
  CSS +
  "</style>\n</head>\n<body>\n" +
  NAV(active) +
  '<div class="wrap"><div class="card">\n' +
  body +
  '\n</div></div>\n<div class="footer">mim ' +
  VERSION +
  " -- API reference generated from the JSDoc in " +
  "mim.js and addons/*.js (jsdoc 4 + tools/make-docs.js). Tutorials: BACKEND.md, ADDONS.md.</div>\n" +
  "</body>\n</html>\n";

/* ------------------------------------------------------------------ */
/* member rendering                                                    */
/* ------------------------------------------------------------------ */

const typeName = (p) => (p.type && p.type.names && p.type.names[0]) || "";

function sigHtml(d) {
  let s = "<b>" + esc(d.name) + '</b> <span class="p">(</span>';
  if (d.params && d.params.length) {
    s += d.params
      .map((p) => {
        const t = typeName(p);
        const opt = p.optional
          ? "[" +
            p.name +
            (p.defaultvalue != null ? " = " + p.defaultvalue : "") +
            "]"
          : p.name;
        return (
          (t ? '<span class="ptype">' + esc(t) + "</span> " : "") +
          "<code>" +
          esc(opt) +
          "</code>"
        );
      })
      .join(", ");
  }
  s += '<span class="p">)</span>';
  return s;
}

function detailHtml(d) {
  let h =
    '<div class="memitem" id="' +
    slug(d.longname || d.name) +
    '">\n' +
    '<div class="memname">' +
    sigHtml(d) +
    (d.kind === "member" ? "" : "") +
    "</div>\n" +
    '<div class="memdoc">';
  if (d.description)
    h += "<p>" + linkify(esc(cleanDesc(d.description))) + "</p>";
  if (d.params && d.params.length) {
    h += '<table class="params"><tr><th colspan="3">Parameters:</th></tr>';
    for (const p of d.params) {
      h +=
        '<tr><td class="pt">' +
        esc(typeName(p)) +
        '</td><td class="pn">' +
        esc(p.name) +
        (p.optional
          ? " <i>(optional" +
            (p.defaultvalue != null ? ", default " + esc(p.defaultvalue) : "") +
            ")</i>"
          : "") +
        '</td><td class="pd">' +
        linkify(esc(p.description || "")) +
        "</td></tr>";
    }
    h += "</table>";
  }
  if (d.returns && d.returns.length) {
    const r = d.returns[0];
    h +=
      '<dl><dt>Returns</dt><dd><span class="ptype">' +
      esc((r.type && r.type.names && r.type.names[0]) || "") +
      "</span> " +
      linkify(esc(r.description || "")) +
      "</dd></dl>";
  }
  if (d.properties && d.properties.length) {
    h += '<table class="params"><tr><th colspan="2">Properties:</th></tr>';
    for (const p of d.properties)
      h +=
        '<tr><td class="pn">' +
        esc(p.name) +
        '</td><td class="pd">' +
        linkify(esc(p.description || "")) +
        "</td></tr>";
    h += "</table>";
  }
  h += "</div>\n</div>\n";
  return h;
}

function briefTable(items) {
  // items: [{name, sig, brief, anchor}]
  let h = '<table class="membrief">';
  for (const it of items)
    h +=
      '<tr><td class="sig"><a href="#' +
      it.anchor +
      '"><b>' +
      esc(it.sig) +
      "</b></a></td><td>" +
      linkify(esc(it.brief)) +
      "</td></tr>";
  return h + "</table>";
}

/* ------------------------------------------------------------------ */
/* pages                                                               */
/* ------------------------------------------------------------------ */

function guiPage() {
  const cls = byLong("GUI");
  let body =
    '<div class="crumbs"><a href="index.html">mim ' +
    VERSION +
    "</a> &raquo; <b>GUI</b></div>";
  body += "<h1>Class GUI</h1>";
  body +=
    "<p>The immediate-mode GUI. One instance per app; it owns the window/widget state, the style, the flags, the renderer proxy and the addons.</p>";
  body +=
    "<p>A frame is: <code>beginFrame(input)</code> &rarr; <code>beginWindow</code> / widgets / <code>endWindow</code> (repeat) &rarr; <code>endFrame()</code>. See the README &ldquo;Quick start&rdquo; section for a full example.</p>";

  // constructor
  const ctor = {
    longname: "GUI#constructor",
    name: "GUI",
    kind: "function",
    description: "Creates a GUI instance.",
    params: [
      {
        type: { names: ["Object"] },
        name: "renderer",
        description:
          "the backend renderer object -- see the &ldquo;Implementing a backend&rdquo; README section and the backend tutorial for the full contract",
      },
      {
        type: { names: ["Object"] },
        name: "options",
        optional: true,
        description: "construction options (see below)",
      },
      {
        type: { names: ["Object"] },
        name: "options.style",
        optional: true,
        description: "partial style ({ theme, colors, vars, font })",
      },
      {
        type: { names: ["Object"] },
        name: "options.flags",
        optional: true,
        description:
          "behavior flags -- every key of gui.flags is toggleable, at construction time or later at runtime",
      },
      {
        type: { names: ["Object"] },
        name: "options.clipboard",
        optional: true,
        description: "{ read: () => string, write: (text) => void }",
      },
      {
        type: { names: ["boolean", "Array"] },
        name: "options.addons",
        optional: true,
        description:
          "which addons to attach: all registered addons (default), false for none, or a list of names",
      },
      {
        type: { names: ["boolean"] },
        name: "options.debugOverlay",
        optional: true,
        description: "draw the debug overlay in endFrame",
      },
    ],
  };
  body += "<h2>Constructor</h2>\n" + detailHtml(ctor);

  // public methods
  const methods = doclets
    .filter(
      (x) =>
        x.memberof === "GUI" &&
        x.kind === "function" &&
        !x.name.startsWith("_") &&
        x.name !== "constructor",
    )
    .sort((a, b) => a.name.localeCompare(b.name));
  body +=
    "<h2>Public Member Functions</h2>\n" +
    briefTable(
      methods.map((m) => ({
        sig:
          m.name + "(" + (m.params || []).map((p) => p.name).join(", ") + ")",
        brief: briefOf(m.description),
        anchor: slug("GUI#" + m.name),
      })),
    );
  for (const m of methods) body += detailHtml(m);

  // public attributes
  const attrs = [
    "state",
    "flags",
    "style",
    "addons",
    "renderer",
    "debugOverlay",
    "clipboard",
  ]
    .map((n) => byLong("GUI." + n))
    .filter(Boolean);
  body +=
    "<h2>Public Attributes</h2>\n" +
    briefTable(
      attrs.map((a) => ({
        sig: a.name,
        brief: briefOf(a.description),
        anchor: slug("GUI." + a.name),
      })),
    );
  for (const a of attrs) body += detailHtml({ ...a, kind: "member" });

  body +=
    '<div class="note">The documented <b>internal</b> surface used by addons (<code>gui._id</code>, <code>gui._state</code>, <code>gui._item</code>, <code>gui._clickable</code>, <code>gui._col</code>, ...) is described in the <a href="tutorial_addons.html">addon tutorial</a>. It is an agreement, not a guarantee: use it only from addon code.</div>';
  return page("mim " + VERSION + ": GUI Class Reference", "GUI.html", body);
}

function stylePage() {
  let body =
    '<div class="crumbs"><a href="index.html">mim ' +
    VERSION +
    "</a> &raquo; <b>Style</b></div>";
  body += "<h1>Class Style</h1>";
  body +=
    "<p>The visual style: named colors (<code>style.colors</code>), numeric metrics (<code>style.vars</code>) and the font (<code>style.font</code>). Construct one with a partial override object, or read it from an existing GUI via <code>gui.style</code>.</p>";
  const ctor = {
    longname: "Style#constructor",
    name: "Style",
    kind: "function",
    description: "Creates a style from a partial override object.",
    params: [
      {
        type: { names: ["Object"] },
        name: "partial",
        optional: true,
        description: "override object",
      },
      {
        type: { names: ["string"] },
        name: "partial.theme",
        optional: true,
        description: "'dark' (default) or 'light'",
      },
      {
        type: { names: ["Object"] },
        name: "partial.colors",
        optional: true,
        description: "color name -&gt; [r,g,b,a] | '#hex' | {r,g,b,a}",
      },
      {
        type: { names: ["Object"] },
        name: "partial.vars",
        optional: true,
        description: "var name -&gt; number (or [x, y] for vector vars)",
      },
      {
        type: { names: ["Object"] },
        name: "partial.font",
        optional: true,
        description: "{ size, id }",
      },
    ],
  };
  body += "<h2>Constructor</h2>\n" + detailHtml(ctor);
  const mems = [
    {
      longname: "Style.colors",
      name: "colors",
      kind: "member",
      description:
        "Color name -&gt; [r, g, b, a]. The current theme palette (see Mim.themes), possibly overridden by the constructor or per-window style.",
    },
    {
      longname: "Style.vars",
      name: "vars",
      kind: "member",
      description:
        "Numeric metrics: fontSize, framePadding, itemSpacing, indentSpacing, titleBarHeight, scrollbarSize, shadow, ...",
    },
    {
      longname: "Style.font",
      name: "font",
      kind: "member",
      description:
        "The default text font: { size (px), id (a backend font key; see the backend tutorial) }.",
    },
    {
      longname: "Style.themes",
      name: "themes",
      kind: "member",
      description: "Static: the built-in 'dark' and 'light' color palettes.",
    },
  ];
  body +=
    "<h2>Public Attributes</h2>\n" +
    briefTable(
      mems.map((m) => ({
        sig: m.name,
        brief: briefOf(m.description),
        anchor: slug(m.longname),
      })),
    );
  for (const m of mems) body += detailHtml(m);
  return page("mim " + VERSION + ": Style Class Reference", "Style.html", body);
}

function mimPage() {
  const ns = doclets.find((x) => x.kind === "namespace");
  let body =
    '<div class="crumbs"><a href="index.html">mim ' +
    VERSION +
    "</a> &raquo; <b>Mim</b></div>";
  body += "<h1>Namespace Mim</h1>";
  body +=
    "<p>" +
    linkify(
      esc(
        cleanDesc(ns && ns.description) ||
          "The single global the library installs.",
      ),
    ) +
    "</p>";
  const mems = [
    [
      "GUI",
      "class",
      'the <a href="GUI.html">GUI</a> class (the main entry point)',
    ],
    [
      "Style",
      "class",
      'the <a href="Style.html">Style</a> class (colors, vars, font)',
    ],
    [
      "Layers",
      "constant",
      "layer names for <code>gui.layer()</code> / <code>renderer.setLayer()</code>",
    ],
    ["Key", "constant", "key tokens for the isKey*() queries and input.keys"],
    [
      "MouseButton",
      "constant",
      "mouse button indices (0 left, 1 right, 2 middle, 3 back, 4 forward)",
    ],
    [
      "WindowFlags",
      "constant",
      "window option flags (bitmask for beginWindow)",
    ],
    ["Color", "object", "color helpers: rgba, hex, mix, withAlpha"],
    ["version", "string", "the library version (" + VERSION + ")"],
  ];
  body +=
    "<h2>Members</h2>\n" +
    briefTable(
      mems.map((m) => ({
        sig: m[0],
        brief: m[2],
        anchor: m[0] === "GUI" ? "Mim__GUI" : "Mim__" + m[0],
      })),
    );
  for (const m of mems)
    body += detailHtml({
      longname: "Mim." + m[0],
      name: m[0],
      kind: "member",
      description: m[2],
    });
  const fns = [
    {
      name: "registerAddon",
      kind: "function",
      description:
        "Registers an addon: the factory is stored and installed onto every GUI instance as gui.addons.&lt;name&gt; (existing instances pick it up on their next reloadAddons() call).",
      params: [
        {
          type: { names: ["string"] },
          name: "name",
          description: "the addon namespace (gui.addons.<name>)",
        },
        {
          type: { names: ["function"] },
          name: "factory",
          description:
            "(gui, Mim) =&gt; ({ methodName: fn, ... }) -- the returned object's methods become the addon's API. Use the public GUI API plus gui.renderer for custom drawing; keep the file self-contained and dependency-free.",
        },
      ],
      returns: [
        {
          type: { names: ["Mim"] },
          description: "the Mim namespace (chainable)",
        },
      ],
    },
    {
      name: "unregisterAddon",
      kind: "function",
      description:
        "Removes a registered addon (new GUI instances no longer get it; existing instances can drop it with reloadAddons()).",
      params: [{ type: { names: ["string"] }, name: "name" }],
      returns: [
        {
          type: { names: ["Mim"] },
          description: "the Mim namespace (chainable)",
        },
      ],
    },
    {
      name: "addonNames",
      kind: "function",
      description: "The names of all registered addons.",
      params: [],
      returns: [
        {
          type: { names: ["Array.&lt;string&gt;"] },
          description: "the registered addon names",
        },
      ],
    },
  ];
  body +=
    "<h2>Functions</h2>\n" +
    briefTable(
      fns.map((f) => ({
        sig: f.name + "(...)",
        brief: briefOf(f.description),
        anchor: slug("Mim." + f.name),
      })),
    );
  for (const f of fns) {
    f.longname = "Mim." + f.name;
    body += detailHtml(f);
  }
  body +=
    "<h2>Related</h2><p>Addon namespaces: " +
    ["plots", "t3d", "tables", "color", "notifs", "widgets", "markdown"]
      .map(
        (n) => '<a href="gui_addons_' + n + '.html">gui.addons.' + n + "</a>",
      )
      .join(", ") +
    ' -- each registered by its addon file (see the <a href="tutorial_addons.html">addon tutorial</a>).</p>';
  return page("mim " + VERSION + ": Mim Namespace Reference", "Mim.html", body);
}

function colorPage() {
  const fns = ["rgba", "hex", "mix", "withAlpha"]
    .map((n) => byLong("Mim.Color." + n))
    .filter(Boolean);
  let body =
    '<div class="crumbs"><a href="index.html">mim ' +
    VERSION +
    '</a> &raquo; <a href="Mim.html">Mim</a> &raquo; <b>Color</b></div>';
  body += "<h1>Mim.Color</h1>";
  body +=
    "<p>Color helpers. Colors are plain [r, g, b, a] arrays (0..255). Never mutate a color you obtained from the style; mix/withAlpha return new arrays.</p>";
  body +=
    "<h2>Functions</h2>\n" +
    briefTable(
      fns.map((f) => ({
        sig: "Mim.Color." + f.name + "(...)",
        brief: briefOf(f.description),
        anchor: slug(f.longname),
      })),
    );
  for (const f of fns) body += detailHtml(f);
  return page(
    "mim " + VERSION + ": Mim.Color Reference",
    "Mim_Color.html",
    body,
  );
}

const KEY_TOKENS = [
  ["Space", "' '"],
  ["Enter", "'enter'"],
  ["Tab", "'tab'"],
  ["Escape", "'escape'"],
  ["Backspace", "'backspace'"],
  ["Delete", "'delete'"],
  ["Insert", "'insert'"],
  ["Home", "'home'"],
  ["End", "'end'"],
  ["PageUp", "'pageup'"],
  ["PageDown", "'pagedown'"],
  ["Left / Right / Up / Down", "'left' / 'right' / 'up' / 'down'"],
  ["Shift / Ctrl / Alt / Meta", "'shift' / 'ctrl' / 'alt' / 'meta'"],
  ["F1..F12", "'f1' .. 'f12'"],
  ["Letters and digits", "by name: 'a'..'z', '0'..'9'"],
];

function constPage(longname, extraHtml) {
  const d = byLong(longname);
  let body =
    '<div class="crumbs"><a href="index.html">mim ' +
    VERSION +
    "</a> &raquo; <b>" +
    longname +
    "</b></div>";
  body += "<h1>Constant " + longname + "</h1>";
  if (d && d.description)
    body += "<p>" + linkify(esc(cleanDesc(d.description))) + "</p>";
  if (d && d.properties && d.properties.length) {
    body += '<table class="params"><tr><th colspan="2">Properties:</th></tr>';
    for (const p of d.properties)
      body +=
        '<tr><td class="pn">' +
        esc(p.name) +
        '</td><td class="pd">' +
        linkify(esc(p.description || "")) +
        "</td></tr>";
    body += "</table>";
  }
  body += extraHtml || "";
  return page(
    "mim " + VERSION + ": " + longname + " Reference",
    longname + ".html",
    body,
  );
}

function addonPage(ns) {
  const nsD = byLong("gui.addons." + ns);
  const fns = doclets
    .filter((x) => x.memberof === "gui.addons." + ns && x.kind === "function")
    .sort((a, b) => a.name.localeCompare(b.name));
  let body =
    '<div class="crumbs"><a href="index.html">mim ' +
    VERSION +
    "</a> &raquo; <b>gui.addons." +
    ns +
    "</b></div>";
  body += "<h1>Namespace gui.addons." + ns + "</h1>";
  if (nsD && nsD.description)
    body += "<p>" + linkify(esc(cleanDesc(nsD.description))) + "</p>";
  body +=
    "<h2>Functions</h2>\n" +
    briefTable(
      fns.map((f) => ({
        sig:
          f.name + "(" + (f.params || []).map((p) => p.name).join(", ") + ")",
        brief: briefOf(f.description),
        anchor: slug("gui.addons." + ns + "." + f.name),
      })),
    );
  for (const f of fns) body += detailHtml(f);
  body +=
    '<div class="note">Provided by <code>addons/mim_' +
    (ns === "color"
      ? "color"
      : ns === "t3d"
        ? "3d"
        : ns === "notifs"
          ? "notifications"
          : ns === "markdown"
            ? "markdown"
            : ns === "plots"
              ? "plots"
              : ns === "tables"
                ? "tables"
                : "widgets") +
    '.js</code> -- load it after mim.js. See the <a href="tutorial_addons.html">addon tutorial</a> for how these are built.</div>';
  return page(
    "mim " + VERSION + ": gui.addons." + ns + " Reference",
    "gui_addons_" + ns + ".html",
    body,
  );
}

function indexPage() {
  const nsBrief = (ln) => {
    const d = byLong(ln);
    return d && d.description ? briefOf(d.description) : "&nbsp;";
  };
  let body = "<h1>mim " + VERSION + " -- Documentation Index</h1>";
  body +=
    "<p>A single-file, immediate-mode GUI library for JavaScript (Dear-ImGui style, zero dependencies, backend-agnostic). This reference is generated from the JSDoc in <code>mim.js</code> and <code>addons/*.js</code>.</p>";
  body +=
    "<h2>Related Pages (tutorials)</h2>\n" +
    briefTable([
      {
        sig: "Writing a rendering backend",
        brief:
          "The humanized guide to implementing the renderer interface and the input snapshot (BACKEND.md).",
        anchor: "tutorial_backend.html",
      },
      {
        sig: "Writing an addon",
        brief:
          "The humanized guide to building custom widgets/plots/tables on the documented addon surface (ADDONS.md).",
        anchor: "tutorial_addons.html",
      },
    ])
      .replace('href="#tutorial_backend', 'href="tutorial_backend')
      .replace('href="#tutorial_addons', 'href="tutorial_addons');
  body +=
    "<h2>Classes</h2>\n" +
    briefTable([
      {
        sig: "GUI",
        brief:
          "The immediate-mode GUI: windows, widgets, plots, docking, popups, menus, tables, layers, style, addons.",
        anchor: "GUI.html",
      },
      {
        sig: "Style",
        brief: "The visual style: named colors, numeric metrics, font, themes.",
        anchor: "Style.html",
      },
    ])
      .replace('href="#GUI.html', 'href="GUI.html')
      .replace('href="#Style.html', 'href="Style.html');
  body +=
    "<h2>Namespaces</h2>\n" +
    briefTable([
      {
        sig: "Mim",
        brief: nsBrief(
          "The single global the library installs (or what require",
        ),
        anchor: "Mim.html",
      },
      {
        sig: "Mim.Color",
        brief: "Color helpers: rgba, hex, mix, withAlpha.",
        anchor: "Mim_Color.html",
      },
      {
        sig: "gui.addons.plots",
        brief: nsBrief("gui.addons.plots"),
        anchor: "gui_addons_plots.html",
      },
      {
        sig: "gui.addons.t3d",
        brief: nsBrief("gui.addons.t3d"),
        anchor: "gui_addons_t3d.html",
      },
      {
        sig: "gui.addons.tables",
        brief: nsBrief("gui.addons.tables"),
        anchor: "gui_addons_tables.html",
      },
      {
        sig: "gui.addons.color",
        brief: nsBrief("gui.addons.color"),
        anchor: "gui_addons_color.html",
      },
      {
        sig: "gui.addons.notifs",
        brief: nsBrief("gui.addons.notifs"),
        anchor: "gui_addons_notifs.html",
      },
      {
        sig: "gui.addons.widgets",
        brief: nsBrief("gui.addons.widgets"),
        anchor: "gui_addons_widgets.html",
      },
      {
        sig: "gui.addons.markdown",
        brief: nsBrief("gui.addons.markdown"),
        anchor: "gui_addons_markdown.html",
      },
    ])
      .replace('href="#Mim.html', 'href="Mim.html')
      .replace('href="#Mim_Color.html', 'href="Mim_Color.html')
      .replace(/href="#gui_addons_([a-z]+)\.html/g, 'href="gui_addons_$1.html');
  body +=
    "<h2>Constants</h2>\n" +
    briefTable([
      {
        sig: "Layers",
        brief:
          "Layer names for gui.layer() and renderer.setLayer(): 'background', 'gui', 'foreground'.",
        anchor: "Layers.html",
      },
      {
        sig: "Key",
        brief: "Key tokens used in input.keys and the isKey*() queries.",
        anchor: "Key.html",
      },
      {
        sig: "MouseButton",
        brief:
          "Indices into input.mouse.buttons: [left, right, middle, back, forward].",
        anchor: "MouseButton.html",
      },
      {
        sig: "WindowFlags",
        brief:
          "Window option flags (bitmask, pass via beginWindow): Closable, ScrollX, AlwaysOnTop, Modal, No*, ...",
        anchor: "WindowFlags.html",
      },
    ])
      .replace('href="#Layers.html', 'href="Layers.html')
      .replace('href="#Key.html', 'href="Key.html')
      .replace('href="#MouseButton.html', 'href="MouseButton.html')
      .replace('href="#WindowFlags.html', 'href="WindowFlags.html');
  body += "<h2>Repository layout</h2>";
  body +=
    "<pre>" +
    [
      "mim.js                    the library (single file, no dependencies) — primary source, expanded for readability",
      "mim.compressed.js         the same library in the compact one-line style",
      "addons/                   the seven bundled addons (this site documents them)",
      "demo/              the canvas demo (zero external libraries)",
      "test/  run-tests.sh       five headless test suites, 644 checks",
      "BACKEND.md  ADDONS.md     the two tutorials (linked above)",
      "tools/make-docs.js        this site generator",
    ].join("\n") +
    "</pre>";
  return page("mim " + VERSION + ": Documentation Index", "index.html", body);
}

/* ------------------------------------------------------------------ */
/* write everything                                                    */
/* ------------------------------------------------------------------ */

fs.mkdirSync("docs", { recursive: true });
const W = (f, html) => {
  fs.writeFileSync("docs/" + f, html);
  console.log("docs/" + f, html.length + " bytes");
};

W("index.html", indexPage());
W("GUI.html", guiPage());
W("Style.html", stylePage());
W("Mim.html", mimPage());
W("Mim_Color.html", colorPage());
W("Layers.html", constPage("Layers"));
W(
  "Key.html",
  constPage(
    "Key",
    '<h2>Token table</h2>\n<table class="params"><tr><th>Mim.Key constant</th><th>token</th></tr>' +
      KEY_TOKENS.map(
        (r) =>
          '<tr><td class="pn">' +
          r[0] +
          '</td><td class="pd">' +
          r[1] +
          "</td></tr>",
      ).join("") +
      "</table>",
  ),
);
W("MouseButton.html", constPage("MouseButton"));
W("WindowFlags.html", constPage("WindowFlags"));
for (const ns of [
  "plots",
  "t3d",
  "tables",
  "color",
  "notifs",
  "widgets",
  "markdown",
])
  W("gui_addons_" + ns + ".html", addonPage(ns));

const backendMd = fs.readFileSync("BACKEND.md", "utf8");
W(
  "tutorial_backend.html",
  page(
    "mim " + VERSION + ": Writing a rendering backend",
    "tutorial_backend.html",
    '<div class="crumbs"><a href="index.html">mim ' +
      VERSION +
      "</a> &raquo; <b>Tutorials</b> &raquo; Backend</div>" +
      "<h1>Building a rendering backend for Mim</h1>\n" +
      mdToHtml(backendMd, "backend"),
  ),
);
const addonsMd = fs.readFileSync("ADDONS.md", "utf8");
W(
  "tutorial_addons.html",
  page(
    "mim " + VERSION + ": Writing an addon",
    "tutorial_addons.html",
    '<div class="crumbs"><a href="index.html">mim ' +
      VERSION +
      "</a> &raquo; <b>Tutorials</b> &raquo; Addons</div>" +
      "<h1>Building an addon for Mim</h1>\n" +
      mdToHtml(addonsMd, "addons"),
  ),
);

console.log("done.");
