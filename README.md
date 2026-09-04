# Mim — a single-file, immediate-mode GUI library for JavaScript

Mim is a Dear-ImGui-style immediate-mode GUI library written as **one
self-contained JavaScript file**. It has:

- **Zero dependencies** — Copy the file anywhere.
- **No platform APIs** — the core never touches `window`, `document`, the DOM,
  Node, or any browser/OS API. All rendering and input flow through a
  backend-agnostic interface you implement (Canvas, WebGL, Three.js, etc.).
- **Backend-agnostic by design** — the core only calls ~17 drawing
  primitives; it never draws itself.

```
mim.js                    the library (single file, no dependencies) — the primary
                          source, expanded for readability: section banners, chunk
                          separators, braced if statements, detailed variable names

mim.compressed.js         the same library in the compact one-line style (regenerated
                          from mim.js; all suites pass against both forms)

tools/

  rename-tables.js        the shared guarded-rename tables used by the two builders

  make-compressed.js      mim.js -> mim.compressed.js (reverse renames, one-line ifs)

  make-expanded.js        mim.compressed.js -> mim.js (guarded scope-aware renames)

  postprocess-expanded.js line pass: one-line-if expansion + separating blank lines

  make-docs.js            generates the docs/ API site from the JSDoc in the source

docs/                     generated doxygen-style API reference (open index.html)

BACKEND.md                humanized guide to writing a rendering backend (ASCII only)

ADDONS.md                 humanized guide to writing an addon (ASCII only)

.jsdoc-dump.json          config for the JSDoc doclet dump used by tools/make-docs.js

addons/                   optional addon files (plain JS, register onto the GUI)

  mim_plots.js            2D plots: bezier (drag, rescale-proof), polar, heatmap,
                          bar chart, multi-series line chart — grid toggle, axis
                          labels, marker control; all scale with the window

  mim_3d.js               3D surface/point plots (drag to rotate, wheel zoom, auto-spin)

  mim_tables.js           advanced table: sort (null-safe), row selection by id, column
                          resize, row filter

  mim_color.js            color picker: swatch, 2D saturation/value pad, hue bar,
                          optional alpha slider, checkerboard, hex + presets

  mim_notifications.js    toast notifications (top-right stack, fade in/out, ttl)

  mim_widgets.js          imgui-style extras: grabber (drag bar), spinner, bullet

  mim_markdown.js         lightweight markdown text (**bold**, *italic*, `code`, wrap)

demo/              the demo: HTML + canvas, zero external libraries, offline

  index.html              canvas + mim.js + addons + backend + sketch (no CDN needed)

  canvas-backend.js       2D-context renderer + DOM input adapter (~330 lines)

  sketch.js               the demo app (menu bar, docks, addons, widgets, layers,
                          style editor, toasts)

test/headless.js          headless core test suite (279 tests)

test/advanced.js          docking/context-menu/hover-gating suite (201 tests)

test/canvas-backend.js    canvas backend test suite with a fake ctx + DOM (37 tests)

test/addons.js            addon test suite (113 tests)

test/canvas-demo-smoke.js full canvas demo sketch, driven headlessly (14 checks)

run-tests.sh              runs every test suite and reports a summary
```

The two source forms are kept in sync by the `tools/` builders (dev-only;
the library itself has no build step):

```sh
npm run make:compressed    # mim.js -> mim.compressed.js (one-line ifs, cryptic names)
npm run make:expanded      # mim.compressed.js -> mim.js (rebuild the primary)
```

Edit `mim.js` (the expanded primary), regenerate the compressed copy, and
run `./run-tests.sh` — both forms must stay green.

Run the demo: serve the repo root with any static server and open
`demo/index.html` — e.g. `npx http-server .`
Run the tests:

```sh
node test/headless.js          # core, 279 tests
node test/advanced.js          # docking + context menus + hover gating, 201 tests
node test/canvas-backend.js    # canvas backend, 37 tests
node test/addons.js            # addons, 113 tests
node test/canvas-demo-smoke.js # drives the real canvas demo headlessly (14 checks)

# or run everything with a summary:
./run-tests.sh
```

## Quick start (headless core)

```js
// Mim is the single global the file installs (or require it in Node).
const gui = new Mim.GUI(myRenderer, {
  flags: { tooltips: true, animations: false },   // every behavior is toggleable
});

function draw() {
  gui.beginFrame({                              // normalized input, see below
    width: 800, height: 600,
    mouse: { x: 12, y: 34, buttons: [true, false, false, false, false],
             wheelX: 0, wheelY: 1 },
    keys: new Set(['shift']),                   // tokens: 'tab','enter','left',...
    text: 'ab',                                  // characters typed this frame
  });
  if (gui.beginWindow('Hello', { size: [300, 200] })) {
    if (gui.button('Click me')) console.log('clicked');
    gui.sliderFloat('x', 0.5, 0, 1);
    gui.endWindow();
  }
  gui.endFrame();
}
```