# Mim — a single-file, immediate-mode GUI library for JavaScript

Mim is a Dear-ImGui inspired immediate-mode GUI library written as one
self-contained JavaScript file: `mim.js`. It has:

- **Zero dependencies** - no imports, no exports, no build step, no external assets. Copy the file anywhere.
- **No platform APIs** - the core never touches `window`, `document`, the DOM, Node, or any browser/OS API. All rendering and input flow through a backend-agnostic interface you implement (p5, Canvas, WebGL, etc.).
- **Backend-agnostic by design** - the core only calls ~17 drawing primitives; it never draws itself.

```
mim.js                    the library (single file, no dependencies)

mim.beautified.js         the same library, Prettier-formatted (identical behavior —
                          all 7 test suites pass against it; use it for reading)

addons/                optional addon files (plain JS, register onto the GUI)

  mim_plots.js            2D plots: bezier (drag, rescale-proof), polar, heatmap,
                          bar chart, multi-series line chart — all scale with the window

  mim_3d.js               3D surface/point plots (drag to rotate, wheel zoom, auto-spin)

  mim_tables.js           advanced table: sort (null-safe), row selection by id, resize

  mim_color.js            color picker widget (swatch + HSV sliders + hex + presets)

  mim_notifications.js    toast notifications (top-right stack, fade in/out, ttl)

demo/                  HTML + canvas demo (zero external libraries, offline)

  index.html              canvas + mim.js + addons + backend + sketch (no CDN needed)

  canvas-backend.js       2D-context renderer + DOM input adapter (~330 lines)

  sketch.js               the same feature tour on a plain canvas

test/                  Tests for Mim + Addons

  headless.js             headless core test suite (275 tests)

  round2.js               docking/context-menu/hover-gating suite (201 tests)

  canvas-backend.js       canvas backend test suite with a fake ctx + DOM (37 tests)

  addons.js               addon test suite (58 tests)

  canvas-demo-smoke.js    full canvas demo sketch, driven headlessly (9 checks)
```

Run a demo:

serve the repo with any static server and open `demo/index.html` (e.g. `npx http-server .`)

Run the tests:

```sh
node test/headless.js          # core, 275 tests
node test/advanced.js          # docking + context menus + hover gating, 201 tests
node test/canvas-backend.js    # canvas backend, 37 tests
node test/addons.js            # addons, 58 tests
node test/canvas-demo-smoke.js # drives the real canvas demo headlessly (9 checks)
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
