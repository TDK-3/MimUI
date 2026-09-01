# Mim — a single-file, immediate-mode GUI library for JavaScript

Mim is a Dear-ImGui-style immediate-mode GUI library written as **one
self-contained JavaScript file** (`mim.js`, ~5,000 lines). It has:

- **Zero dependencies** — no imports, no exports, no build step, no external
  assets. Copy the file anywhere.
- **No platform APIs** — the core never touches `window`, `document`, the DOM,
  Node, or any browser/OS API. All rendering and input flow through a
  backend-agnostic interface you implement (p5, Canvas, WebGL, Three.js,
  Scratch-like, or anything else).
- **Backend-agnostic by design** — the core only calls ~17 drawing
  primitives; it never draws itself.

```
mim.js                    the library (single file, no dependencies)
mim.beautified.js         the same library, Prettier-formatted (identical behavior —
                          all 7 test suites pass against it; use it for reading)
addons/                   optional addon files (plain JS, register onto the GUI)
  mim_plots.js            2D plots: bezier (drag, rescale-proof), polar, heatmap,
                          bar chart, multi-series line chart — all scale with the window
  mim_3d.js               3D surface/point plots (drag to rotate, wheel zoom, auto-spin)
  mim_tables.js           advanced table: sort (null-safe), row selection by id, resize
  mim_color.js            color picker widget (swatch + HSV sliders + hex + presets)
  mim_notifications.js    toast notifications (top-right stack, fade in/out, ttl)
demo/                     HTML + p5.js demo (p5 is the only external library)
  index.html              loads p5 (vendored in lib/) + mim.js + addons + backend + sketch
  lib/p5.min.js           p5.js v1.9.4, vendored so the demo needs no CDN
  p5-backend.js           p5 renderer + input adapter (~270 lines)
  sketch.js               the demo app (menu bar, docks, addons, widgets, layers,
                          style editor, toasts)
demo-canvas/              HTML + canvas demo (zero external libraries, offline)
  index.html              canvas + mim.js + addons + backend + sketch (no CDN needed)
  canvas-backend.js       2D-context renderer + DOM input adapter (~330 lines)
  sketch.js               the same feature tour on a plain canvas
test/headless.js          headless core test suite (275 tests)
test/round2.js            docking/context-menu/hover-gating suite (201 tests)
test/p5-backend.js        p5 backend test suite with a fake p5 (27 tests)
test/canvas-backend.js    canvas backend test suite with a fake ctx + DOM (37 tests)
test/addons.js            addon test suite (58 tests)
test/p5-demo-smoke.js     full p5 demo sketch, driven headlessly (15 checks)
test/canvas-demo-smoke.js full canvas demo sketch, driven headlessly (9 checks)
```

Run a demo: serve the repo root with any static server and open
`demo/index.html` (p5) or `demo-canvas/index.html` (canvas) — e.g.
`npx http-server .`. Both work offline: the p5 demo uses the vendored
`demo/lib/p5.min.js` (no CDN), and the canvas demo has no external
dependencies at all. If the p5 demo ever fails to start, it shows the exact
missing piece on-screen instead of a blank canvas.

Run the tests:

```sh
node test/headless.js          # core, 275 tests
node test/round2.js            # docking + context menus + hover gating, 201 tests
node test/p5-backend.js        # p5 backend, 27 tests
node test/canvas-backend.js    # canvas backend, 37 tests
node test/addons.js            # addons, 58 tests
node test/p5-demo-smoke.js     # drives the real p5 demo headlessly (15 checks)
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

The input object is the **only** thing the core accepts from the outside; your
backend's job is to translate your platform's events into it, and to implement
the renderer primitives.

## Architecture

```
┌────────────┐   input snapshot   ┌───────────────────────────────┐
│  your      │ ─────────────────► │  Mim.GUI (stateless-looking,  │
│  events    │                    │  actually persistent, keyed   │
│  (p5, DOM, │   draw calls       │  by ids — the "immediate"     │
│  gamepad…) │ ◄───────────────── │  part)                        │
└────────────   via renderer     └──────────────┬────────────────┘
                                                 │ ~17 primitives
                                 ┌───────────────▼────────────────┐
                                 │ RendererProxy (culling, clip   │
                                 │ intersect, offsets, layers)    │
                                 └───────────────┬────────────────┘
                                                 │
                                 ┌───────────────▼────────────────┐
                                 │ your backend (P5Renderer,      │
                                 │ CanvasRenderer, WebGL, …)      │
                                 └────────────────────────────────┘
```

- **Frame lifecycle**: `beginFrame(input)` → `beginWindow`/widgets/
  `endWindow` (repeat) → `endFrame()`. `beginFrame` runs wheel-scroll routing,
  focus/keyboard bookkeeping and key-edge detection; `endFrame` draws popups,
  tooltips and the debug overlay, then compacts per-frame state.
- **IDs, not labels**: every widget builds an id from an id-stack seed
  (window/child/group/popup context) + a hashed label + a duplicate counter.
  Two visible widgets with the same label are independent — state is stored in
  maps keyed by those ids, which is what makes duplicate labels safe.
- **Three layers**: `gui.layer(Layers.Background | Layers.Foreground, fn)`
  runs your drawing on a layer around the GUI pass; windows can set
  `zIndex`; `AlwaysOnTop` windows render last; an open `Modal` window blocks
  mouse input to the windows it covers (windows drawn above it — e.g.
  `AlwaysOnTop` — stay interactive: topmost input priority). A window or
  dock is raised to the front of the draw order only when it is actually
  MOVED; clicks never reorder the stack — they just mark the clicked window
  as the focused one (bright title bar) — so input always follows the
  visible order: the topmost window under the cursor owns every mouse
  event, and a focused window beneath can never steal it.
- **Style**: a global `Style` with named colors + vars (`gui.style`), themes
  (`gui.setTheme('dark'|'light')`), per-window `style` option, and
  `pushStyleVar`/`popStyleVar` + `pushStyleColor`/`popStyleColor` stacks.
- **Flags** (all live-toggleable at runtime): `tooltips`, `animations`,
  `keyboardShortcuts`, `clipboard`, `undoRedo`, `rightClickNumeric`,
  `mouseBackForward`, `keyboardNavigation`, `windowMove`, `windowResize`,
  `windowDoubleReset`, `wheelScroll`, `doubleClick`, `docking` (live drop
  hints while dragging a window), `dockJoinHitGenerous` (join grid over a
  target window: true = the whole window body selects a side, default
  false = only directly over the drawn 72×72 triangle square),
  `dockScreenHitGenerous` (screen-center grid selection extends ~24px
  beyond its drawn 72×72 square; default true), `windowContextMenu` (right-click menus on
  title bars, dock titles and member headers), plus `dragThreshold`,
  `scrollSpeed`, `tooltipDelay`, `animationDuration`, `resizeBarProximity`
  (px near a window's outline where the resize bars appear and the edge
  bands grab, and near an edge stack's inner edge where its resize bar
  appears; integer, default 8, 0 = off).
- **Performance posture**: single pass per frame, no layout objects created
  per widget (one reused layout struct), FNV-1a ids, renderer-side culling
  against the active clip, and frame-stamped state that gets compacted in
  `endFrame`.

## Public API (abridged — full JSDoc is in `mim.js`)

**Lifecycle & query** — `beginFrame(input)`, `endFrame()`, `isMouseDown(i)`,
`isMouseClicked(i)`, `isMouseReleased(i)`, `isMouseDoubleClicked(i)`,
`mousePos()`, `mouseDelta()`, `isKeyDown(k)`, `isKeyPressed(k)`,
`isKeyReleased(k)`, `changed()`, `lastItem*()` helpers.

**Windows** — `beginWindow(title, opts)` / `endWindow()`, `openPopup`,
`closePopup`, `beginPopup`/`endPopup`, `beginPopupContextWindow`,
`beginPopupContextItem`, `setWindowOpen`, `isWindowOpen`, `getWindow`,
`setNextWindowPos/Size`. Window options: `pos`, `size`, `minSize`, `maxSize`,
`zIndex`, `flags` (`Mim.WindowFlags`: Closable, ScrollX, AlwaysOnTop, Modal,
NoTitleBar, NoClip, NoScrollbar, AutoResize, FixedSize, NoMove, NoResize,
NoCollapse, **NoDock**), `style`, `onClose`, `persist` (id-based window state
storage). A **collapsed** window (title-bar chevron, or the per-member chevron
inside a dock) renders **its header only** — no background, no shadow — and
occupies just that header row for hover/click purposes, so the space behind
it behaves as if it were empty.

**Layout** — `beginGroup`/`endGroup`, `sameLine(spacing, offsetX)`,
`spacing`, `indent`/
`unindent`, `dummy`, `setCursorPos`/`setCursorScreenPos`, `getCursorPos`,
`setNextItemWidth`, `getRegionAvail`, `beginChild`/`endChild` (scrollable),
`beginTable`/`tableHeader`/`tableRow`/`tableCell`/`tableEndRow`/`endTable`,
`beginTabBar`/`beginTabItem`/`endTabItem`/`endTabBar`, `beginMenuBar`/
`beginMenu`/`menuItem`, `treeNode`/`treePop`/`treePopToLevel`,
`collapsingHeader`. `sameLine` puts the next element on the previous
element's line — its y stays put while its x moves to the right of the
previous element's right edge plus the horizontal item spacing (automatic
padding/margin; pass `spacing` to override, or `sameLine(null, offsetX)`
to anchor at an absolute offset from the line start); it is a no-op when
nothing precedes it ("if applicable").

**Widgets** — `text`, `textColored`, `textWrapped`, `button`, `smallButton`,
`checkbox`, `radioButton`, `sliderFloat`/`sliderInt`, `dragFloat`/`dragInt`,
`inputInt`/`inputFloat`/`inputText` (full editing: caret, selection,
copy/paste, select-all, undo/redo, arrow keys, Home/End, word delete),
`combo`, `listBox`, `selectable`, `progressBar`, `separator`,
`separatorText`, `plotLines`, `image`, `beginDisabled`/`endDisabled`.
`plotLines(label, values, { h, share, min, max, overlay, color })` is a
mini line chart: with no `h` it **fills the remaining region** of the
window/child (ImGui-style), and `share: n` splits it evenly with n-1
sibling plots so the whole set rescales live with the window (see
`gui.plotHeight`).
`listBox(label, value, items, { w, h, rows, rowH, label })` is a
single-select, scrollable list (wheel + scrollbar; selection is kept in
view; `value == null` for a library-kept state).
Right-clicking any slider/drag/input opens an exact numeric entry field
(toggle: `rightClickNumeric`). Sliders are click-to-set: clicking the
track (without dragging) jumps the value to that position; drags stay
relative from the grabbed point.

**Styling & id scopes** — `pushId`/`popId`, `pushStyleVar`/`popStyleVar`,
`pushStyleColor`/`popStyleColor`, `setTheme(name)`.

**Tooltips & overlay** — `setTooltip(str)`, `beginTooltip`/`endTooltip`
(draw a rich tooltip with widgets), `gui.debugOverlay = true`. A plain
tooltip pops up after `tooltipDelay` (default 0.5s) of continuous hover,
is drawn on the foreground layer above every window, and is positioned
just above the cursor (flipping below when there's no room). Only the
topmost hovered element may own a tooltip, so overlapping windows never
show two at once.

**User drawing** — `gui.renderer` is the live `RendererProxy`: inside any
window you can call `gui.renderer.rect(...)`, `.line(...)`, `.drawText(...)`,
`.fillCircle(...)` etc.; the calls are clipped to the window, offset with the
window's scroll, and culled automatically. `gui.layer(l, fn)` for
background/foreground passes.

### Window resizing (bars, grip, scrollbars)

Free windows are resizable from any side (toggle with
`gui.flags.windowResize`, `flags: { resizable: false }` /
`WindowFlags.FixedSize` per window):

- **Resize bars.** When the cursor comes within
  `gui.flags.resizeBarProximity` px (integer, default **8**, `0` disables
  the bars and the edge bands) of a side of the window's outline, a small
  bar fades in over that side; pressing and dragging it scales the window
  in that direction (left/right bars move width, top/bottom bars move
  height, the opposite edge stays put). Near a corner two bars appear and
  the whole corner claims **both directions at once**.
- **Corner grip.** The bottom-right corner draws a resize triangle (grip).
  Its zone resizes width *and* height together and **takes click priority
  over the window's scrollbars** (the scrollbar stops short of the grip
  zone, so a corner click always resizes). The grip highlights while
  hovered.
- Dock members and edge-docked windows resize with their dock/stack
  instead (see below); `minW`/`minH` clamp every resize.

### Docking (window groups)

Two windows can be joined into a single **dock** — one frame, two
side-by-side (or stacked) panes, a draggable split divider, and a shared
title bar.

```js
// join two windows horizontally (default); 'v' stacks them vertically
gui.dock('Inspector', 'Console', {
  dir: 'h',          // 'h' = side by side (default) | 'v' = stacked
  ratio: 0.55,       // fraction of the dock taken by the first member (0.12..0.88)
  pos: [384, 500],   // dock position (else derived from the members)
  size: [420, 200],  // dock size (else derived from the members)
  title: 'Debug',    // optional dock title (else "A + B")
});
gui.undock('Inspector', 'Console'); // split them back into independent windows
gui.isDocked('Inspector', 'Console'); // -> boolean
gui.getDocks();         // -> [{ id, a, b, dir, ratio, x, y, w, h, collapsed }] (a/b = titles)
gui.setDockRatio('Inspector', 'Console', 0.7);
```

Behavior:

- **Docks are lazy.** `gui.dock(a, b, ...)` *registers the intent*; the dock
  is actually created the first frame both windows are open (so you can call
  it in `setup` before the windows exist). `gui.undock(...)` is immediate.
- The dock behaves like one window: **move** it by its title bar, **resize**
  it from any of its four edges (right/left/bottom, and top — top/bottom
  scaling matters for `dir: 'v'` docks, which grow/shrink their stack
  vertically), **close** both members at once with the title-bar ×, and it
  participates in `AlwaysOnTop` / focus like any window.
- The **divider** (6px, hover-highlights) is draggable to resplit; double-click
  it to return to 50/50. Dragging updates `dock.ratio` live.
- Each member keeps a **slim header** (chevron + undock button) instead of a
  full title bar. Clicking the header (left of the buttons) **collapses that
  member** — the other member takes its space; the header becomes a strip.
  The ⧉ button **undocks just that member** (it becomes an independent window
  at its current sub-rect). **Dragging the slim header** out of the dock also
  undocks the member: after a few pixels of movement the drag switches from
  "maybe a click" to "detach this member", and releasing anywhere drops the
  window as a free window under the cursor (releasing over another window
  shows the join grid first, as with a normal window drag).
- The dock title bar carries a **collapse chevron** (left end): it collapses
  the whole dock to just the title bar (hiding both members — the header-only
  rule means nothing else is drawn) and expands it again. `gui.setDockCollapsed(a, b, bool)` /
  `gui.isDockCollapsed(a, b)` do the same programmatically.
- After undocking, members are independent again (`movable`, `resizable`
  restored) and keep the sub-rect they occupied in the dock.
- A dock is stored in `gui.state.docks` keyed by an id like
  `"A|B"`; members are tagged `win._dock` / `win._dockKey` while joined.

**Interactive docking (drag hints).** With `gui.flags.docking` on (default),
dragging a window shows live drop hints:

- **Window join grid** — over the topmost other window under the cursor, a
  grid pops up in its center: a **square of four direction triangles**, one
  per side (left / right / top / bottom), whose apexes meet at the center.
  Hover a triangle and release to join the two (the triangle sets the split
  direction and which side each window takes). There is no center square:
  the center apex has nothing to dock to, so releasing there is a plain
  drop. The grid works over **any** window that can be docked — including
  members of existing docks (dropping splits the group) and edge-docked
  windows (dropping joins their edge stack) — and it re-appears on every
  drag; it is not consumed by a plain drop.
- **Screen-center dock grid** — while dragging, the same square of four
  direction triangles is drawn at the screen center, one per screen edge.
  The hovered triangle highlights; releasing over it docks the window to
  that screen edge (joining any windows already docked there — see below).
  The center apex (where the triangles' peaks meet) has no direction, so
  releasing there is a plain drop — the window stays where it was released
  as a free window — and releasing anywhere else just leaves the window
  there. The screen edges also highlight as the cursor nears them; releasing
  on a highlighted edge docks to it too. The global docking UI (the
  screen-center grid and the edge bands) is treated as **always-on-top**:
  while the cursor is over it, it claims the highlight and the drop even
  when a window sits underneath, so it always gets input priority over the
  window join grid.

A window with `WindowFlags.NoDock` takes part in no docking at all: it can't
be dragged into a dock, can't be a join-grid target, and while one of its
windows is being dragged the library draws **no docking UI at all** (no
screen-center grid, no join grid, no edge highlights). Both
`gui.dock(...)` and `gui.dockToEdge(...)` also refuse it.

**Combined size.** When two windows are joined — by a drop, or by
`gui.dock(a, b)` without an explicit `size` — the combined window's size
is the **sum of both windows' sizes in the dock direction**: a horizontal
join gets `width = A.w + B.w`, a vertical join gets `height = A.h + B.h`.
The other dimension takes the **larger window's size** (anchored on it, so
that window keeps its position). Resizing the combined window afterwards
scales both members relatively, preserving their split ratio.

**Combining into a globally docked window.** When one of the two windows is
a screen-edge stack unit (a globally docked window), the combination is
formed **inside the edge stack**: the combined window stays globally
docked as one unit of that stack, and its dimension **along the screen edge
is the docked window's — NOT the sum of both windows** (a pair combined on
the left edge is both the column's width; on the top edge both the row's
height). The other dimension still adds both windows so each keeps its full
size, and the split direction is forced so both members span the full
docked width/height (vertical in columns, horizontal in rows). Dropping a
window onto a globally docked one with the drag join grid does exactly
this; if the target is itself a docked *combined* window, the stack keeps
its unit member and the dragged window combines with that one (the other
member is freed as a free window).

**Screen-edge docks.** A window docked to a screen edge joins that edge's
stack: left/right edges are a **vertical column**, top/bottom edges a
horizontal row (so multiple windows docked to the same edge are joined
vertically by default). A stack unit is either a plain window or a
**combined window (dock)** — combined windows are dockable too. The stack
is laid out by the library:

```js
gui.dockToEdge('Addons', 'left');  // join the left-edge column
gui.undockEdge('Addons');          // take it back (also: double-click its title bar)
```

- The stack's width/height comes from the first window joined
  (`clamp(w, 180, 420)` for columns, `clamp(h, 110, 300)` for rows) and the
  **inner edge of the stack is draggable** to resize it; every unit is
  scaled to fit.
- **Combined windows are edge-dockable.** Drag a dock onto a screen edge
  (or the screen-center grid) and it joins that stack as one unit — or call
  `gui.dockToEdge(memberTitle, edge)` on any of the dock's members to dock
  the whole combined window. The dock keeps its title bar, divider and
  member headers; the divider still resplits the members inside the unit.
- `gui.undockEdge(memberTitle)` on a docked dock frees the **whole combined
  window as a free dock** at its current slot rect (the combination
  survives); double-clicking the dock's title bar does the same. Edge
  units are not movable/resizable — the stack owns their geometry (the
  inner bar and the gap splitters resize them).
- The **gap between two edge units is draggable** to resplit the space
  between them.
- Edge units keep their normal title bar (close ×, collapse chevron — a
  collapsed edge window renders its header only), are not individually
  movable/resizable, and leaving the stack (double-click title, close, or
  `undockEdge`) frees them at their current rect.
- **Dropping a window onto a globally docked unit combines them in place**
  (the combined window becomes the stack unit, keeping the docked
  width/height — see "Combining into a globally docked window" above).
- Edge stacks inset themselves around the app menu bar when it shares an
  edge (a top-docked row sits below a top bar, etc.).

**Context menus (right-click).** With `gui.flags.windowContextMenu` on
(default), right-clicking opens a small context menu at the cursor with only
the rows the window's flags and state allow:

- **window title bar** — `Collapse`/`Expand` (if the window is collapsible),
  `Undock from screen edge` (edge-docked windows only), `Reset position`
  (free windows, when `windowDoubleReset` is on), `Close` (only if the
  window was created `Closable`).
- **dock title bar** — `Collapse`/`Expand` for the whole dock, `Undock: A`
  and `Undock: B` (one row per open member), and `Close` (closes both
  members and removes the dock).
- **member slim header** — `Collapse`/`Expand` for that member and `Undock`.

Right-clicking again while a menu is open dismisses it; a row click fires the
action and closes the menu. Menus are ordinary popups (positioned at the
cursor and kept on-screen), so they stack, cover windows and take input like
any other popup — and everything under an open menu is hover- and
input-gated (see below).

**Hover/input gating.** An element only gets hover highlighting (and input)
when it is actually reachable by the cursor: if another window, a dock, or an
open popup is painted over it, the covered element draws its normal resting
style and ignores clicks — the topmost element under the cursor owns the
interaction. This applies to title-bar buttons (chevron/×), dock chrome
(title bar, divider, edges), screen-edge stack bands (the gap splitter and
the inner-edge resize bar), resize edge bands, menu-bar rows and every
widget, so user input can never travel through a window or overlapping
element to the one underneath. An open `Modal` window blocks input to the
windows it covers, but topmost priority still applies: a window painted
above the modal (e.g. `AlwaysOnTop`) keeps its own input, and points the
modal doesn't cover are unaffected — the focused/modal window never beats
the last-drawn element. And a click anywhere on a window — empty body
included, not just its title bar or a widget — is handled by that window:
it becomes the focused window, but the draw order does not change — the
topmost window owns every mouse event on its surface and nothing can pass
through it to the window underneath.

The "topmost" test follows the **visible (draw) order**: out of everything
the cursor is over, only the last-drawn element (highest z-index) receives
hover, clicks and drags. Draw order tracks MOVEMENT, not clicks — when a
window or dock is actually moved (a title-bar grab, or a dock grab — title,
divider, edges — that travels past the drag threshold) it is raised to the
front of the draw order, so dragging a window or a combined window over
others always ends up ON TOP of them, and its title bar can never become
undraggable (softlocked) underneath. A click (widget, title bar, or body)
never reorders the stack: it only marks that window as the focused one (its
title bar is drawn brighter). Two extra details keep the rule airtight: a dock's combined
title bar is hit-tested as part of the dock even though it is not inside
either member's rect, and a window's resize edge band only claims the
cursor when no other window is painted over the band point.

### App menu bar (application menu / navbar)

A persistent menu bar pinned to an edge of the **screen** (not a window),
built from a plain config object, editable at runtime. Use it to toggle
windows or run app-level commands.

```js
gui.setAppMenuBar([
  { label: 'File', items: [
    { label: 'Save layout', shortcut: 'ctrl+s', key: 's', keyMod: ['ctrl'], onActivated: saveLayout },
    { sep: true },
    { label: 'Open all windows', onActivated: () => openAll() },
  ]},
  { label: 'Windows', items: ['Playground', 'Settings', 'Console'].map(t => ({
    label: t,
    selected: () => gui.isWindowOpen(t),   // checked when truthy (re-evaluated every frame)
    onActivated: () => toggleWindow(t),
  })) },
  { label: 'Tools', items: [
    { label: 'Transform', items: [          // nested submenu
      { label: 'Rotate', onActivated: rotate },
      { label: 'Scale',  onActivated: scale },
    ]},
    { label: 'Quit', disabled: true },
  ]},
], { pos: 'top' });   // 'top' | 'left' | 'right' | 'bottom'
gui.clearAppMenuBar();
```

Placement options: `pos` (edge to pin — `'top'` default), `size` (bar height
for `top`/`bottom`, default 30; `thickness` is an alias), `width` (bar width
for `left`/`right`, default 180).

Behavior:

- **Blocks clicks** through the whole bar region *and its open dropdowns* —
  a click on a bar label or menu row never falls through to the windows
  underneath (no accidental collapse toggles, drags, etc.), so it doubles as
  a navbar that occupies its edge. An outside click (or Escape) dismisses an
  open menu.
- Click a top-level label to open its menu; hover across the open bar to
  switch menus (standard menubar behavior). Submenus open on hover.
- `onActivated(item)` fires on item click (skipped if `disabled`).
- `selected: (fn or bool)` re-evaluates every frame to drive the checkmark.
- `shortcut` (`'ctrl+s'`-style, shown in the menu) and `key` + `keyMod`
  (the actual key binding — e.g. `key: 's', keyMod: ['ctrl']`) fire the item
  when the combination is pressed anywhere in the app (one shot per press).
- `activateMenu('File', 'Save')` triggers an item programmatically (returns
  `false` if the path doesn't resolve).
- Escape closes an open menu; clicking outside dismisses it.

### Addons (extension system)

Addons register new widgets/plots/tables onto the GUI under
`gui.addons.<name>`. The five bundled addons are self-contained files that
each call `Mim.registerAddon(...)` — load them with a `<script>` tag (or
`require` in Node) *after* `mim.js`.

```js
// bundled addons (each auto-registers on load):
//   gui.addons.plots   -> plotBezier, plotPolar, plotHeatmap, plotBars, plotSeries
//   gui.addons.t3d     -> plot3D, plot3DPoints
//   gui.addons.tables  -> advancedTable
//   gui.addons.color   -> colorButton  (+ norm/toHex/fromHex helpers)
//   gui.addons.notifs  -> toast, draw, count

gui.addons.plots.plotBezier('drag the control points', null, { share: 2 });
gui.addons.plots.plotPolar('rose', (t) => 0.5 + 0.45 * Math.sin(4 * t), { share: 2 });
gui.addons.plots.plotHeatmap('field', numberMatrix, { share: 1, c1: [...], c2: [...] });
gui.addons.plots.plotBars('bars', [12, 8, -3, 21], { share: 1 });        // or [[label, value], ...]
gui.addons.plots.plotSeries('two series', [                                // hover = nearest sample
  { name: 'cpu', values: [0.2, 0.7, 0.4] },
  { name: 'mem', values: [0.8, 0.3, 0.6, 0.9] },                          // different lengths OK
], { share: 1 });

gui.addons.t3d.plot3D('surface', (x, y) => Math.sin(2*x) * Math.cos(2*y), { share: 1, spin: 0.3 });
gui.addons.t3d.plot3DPoints('scatter', [[x, y, z], ...], { h: 220, pointRadius: 2.5 });
// points also accept {x, y, z} objects; non-finite/missing coords are dropped

const t = gui.addons.tables.advancedTable('rows',
  [{ id: 'name', label: 'Name', width: 120 }, { id: 'load', label: 'Load %', width: 80, align: 'right' }],
  rows, { share: 1, selectable: true, sortable: true, zebra: true });
// t -> { box, sorted, selected, sortCol, sortDir }
// sorting is null-safe (missing values sort last), missing cells render as '—',
// and row selection is keyed by row.id so it survives re-sorting

let col = [88, 138, 240, 255];
col = gui.addons.color.colorButton('accent', col, { presets: true, w: 150 });
// click the swatch -> inline picker: H/S/V sliders, hex field (validates before
// it applies, so invalid text never corrupts the color), preset palette.
// gui.addons.color.norm / .toHex / .fromHex are exported for your own use.

const N = gui.addons.notifs;
N.toast('Saved 3 nodes', { type: 'success', ttl: 2.5 });   // info | success | error
// once per frame, above everything (incl. popups):
gui.layer(Mim.Layers.Foreground, () => N.draw());
```

**Scaling with window resizes.** Every plot/table/3D frame accepts
`{ h, share }`:

- `h: px` — explicit height (legacy behavior).
- `share: n` — the widget takes 1/n of the region's remaining height, split
  evenly among n sibling widgets in the same window (tracked per frame, so
  all members get exactly their share).
- neither — the widget **fills** the remaining height.

Widths always follow the window. Bezier control points are stored
*normalized* (0..1 inside the plot rect), so dragging, resizing and redrawing
all stay consistent: resize the demo's Addons window and every graph
rescales with it.

Roll your own:

```js
Mim.registerAddon('charts', (gui, Mim) => ({
  plotMyChart(label, fn, { h = 120 } = {}) {
    // use only the public gui API + gui.renderer for custom drawing
    // (the addon receives the live gui instance, so it inherits
    //  current window/child clipping, scroll, styling and id scope)
    ...
  },
}));
// then: gui.addons.charts.plotMyChart(...)
Mim.addonNames();            // -> ['plots', 't3d', 'tables', 'color', 'notifs', 'charts']
Mim.unregisterAddon('charts');
```

Controlling which addons load:

- `new Mim.GUI(renderer, { addons: false })` disables addon registration
  entirely; `{ addons: ['plots'] }` loads only the named ones (by default all
  registered addons are attached). `gui.reloadAddons(list?)` re-attaches them.
- Addons are **pure immediate-mode widgets**: they hold no DOM, no global
  state beyond the id-keyed widget state in `gui.state`, and use only the
  public API + `gui.renderer`, so they work on any backend.

## Implementing a backend (the renderer contract)

A renderer is any object with these methods (colors are `[r,g,b,a]` with
`a` in 0..255; missing methods are simply skipped):

```js
beginFrame(width, height)
endFrame()
setLayer('background' | 'gui' | 'foreground')
pushClip(x, y, w, h) / popClip()          // paired; core keeps it balanced
fillRect(x, y, w, h, color)
fillRoundedRect(x, y, w, h, r, color)
strokeRect(x, y, w, h, color, thickness)
strokeRoundedRect(x, y, w, h, r, color, thickness)
line(x1, y1, x2, y2, color, thickness)
polyline([x0,y0, x1,y1, ...], color, thickness)
fillPolygon([x0,y0, x1,y1, ...], color)
fillCircle(cx, cy, r, color)
fillEllipse(cx, cy, rx, ry, color)
drawImage(imageId, x, y, w, h, tintOrNull)
drawText(x, y, str, color, { fontSize, fontId })   // (x,y) = top-left
textSize(str, { fontSize, fontId }) -> { w, h }    // h = line height
// Optional, feature-gated (see "Capability flags" below):
setCursor(style)                                    // 'default','pointer',...
features: { cursor: true, clip: true, tint: true }  // capability flags
```

Practical notes:

- **Text anchoring matters**: the core's layout assumes `drawText` places the
  string's **top-left** at (x, y), and `textSize().h` equals the line height
  used for vertical centering. The p5 backend achieves this with
  `textBaseline(TOP)`; on a 2D canvas use `textBaseline = 'top'`.
- **Clipping**: implement `pushClip`/`popClip` as save/clip/restore (the p5
  backend uses `p5.drawingContext`); if your API can't clip (some Scratch-like
  runtimes), implement them as no-ops — the GUI still works, content just may
  overflow scroll regions.
- **Layer**: store `setLayer` and let it affect your draw order (e.g. draw
  background commands first, foreground last) or split into separate
  passes/targets.
- **Images**: the core passes an *id* (string or object). Keep a map from id
  to your native image handle.
- **Culling**: the proxy already culls draws outside the active clip and
  translates coordinates for window scroll, so your backend can assume most
  primitives are worth drawing.
- **Capability flags**: advertise what you can do via a `features` object
  (e.g. `{ cursor: true, clip: true, tint: true }`). The core only uses an
  optional feature when the flag is truthy — most importantly, it calls
  `setCursor` *only* if `features.cursor === true`, so a backend without
  cursor support (e.g. a game or WebGL canvas with no OS cursor) never gets
  cursor requests and the GUI degrades to a fixed "default" cursor. Omit
  `features` (or a single flag) to opt out of that feature.
- **Cursor**: `setCursor(style)` receives one of `'default'`, `'pointer'`,
  `'text'`, `'move'`, `'grab'`, `'grabbing'`, `'ew-resize'`, `'ns-resize'`,
  `'nwse-resize'`, `'nesw-resize'`. CSS canvas/p5 backends map these 1:1 to
  `element.style.cursor`. The core sets `pointer` over clickable widgets,
  `text` in an active text field, `move`/`grabbing` over/while moving a
  title bar, and the resize variants over/while dragging a window edge.
- **The input contract** is the inverse: each frame produce
  `{ width, height, mouse: {x, y, buttons:[5], wheelX, wheelY}, keys: Set,
  text: string }` (key tokens: `' '` `'enter'` `'tab'` `'escape'`
  `'backspace'` `'delete'` `'insert'` `'home'` `'end'` `'pageup'` `'pagedown'`
  `'left'` `'right'` `'up'` `'down'` `'shift'` `'ctrl'` `'alt'` `'meta'`
  `'f1'..'f12'` and single lowercase letters; `wheelY > 0` means **scroll
  down** — same sign as DOM `deltaY` and p5 `e.delta`, so no sign flip is
  needed; `text` = characters typed since last frame, including space).
- **Mouse buttons** are ordered `[left, right, middle, back, forward]` — DOM
  button codes must be mapped 0→0, 2→1, 1→2, 3→3, 4→4.

Reference implementations: `demo/p5-backend.js` (~270 lines) and
`demo-canvas/canvas-backend.js` (~330 lines, includes the key-token table,
wheel normalization, DPR scaling and self-attaching DOM listeners).
