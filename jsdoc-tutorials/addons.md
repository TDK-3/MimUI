# Building an addon for Mim

An addon is a plain JavaScript file that teaches the GUI a new widget,
plot, or table. It has no build step, no dependencies, no DOM. It calls
`Mim.registerAddon(name, factory)` once, and every GUI instance grows a
namespace `gui.addons.<name>` with your methods in it. That is the whole
contract.

If BACKEND.md is "how do I make Mim draw on my surface", this is "how do I
make Mim draw things it does not know yet".


## The shape of an addon

    // my_addon.js
    (function (Mim) {
      Mim.registerAddon('myname', function (gui, M) {
        // `gui` is the live GUI instance that will call your methods.
        // `M` is the Mim namespace (M.Color, M.WindowFlags, ...).
        // Return a plain object: its methods become your API.
        return {
          myWidget(label, value) {
            // ...one frame of immediate-mode work...
            return value;
          },
        };
      });
    })(typeof globalThis !== 'undefined' ? globalThis.Mim : require('../mim.js'));

Three properties follow from that shape:

- Your methods run inside the caller's window: the current clip, scroll
  offset, style and id scope are already in place when you start. You do
  not manage any of that.
- You hold no state of your own. Everything persistent goes into the
  id-keyed widget state (`gui._state(...)`), so two windows that draw the
  same label get two independent widgets.
- You work on any backend, because you only use the public API and
  `gui.renderer`.

Load the file with a `<script>` tag (or `require` in Node) after `mim.js`.
Existing instances pick the addon up with `gui.reloadAddons()`; new
instances get it automatically, unless they were built with
`{ addons: false }` or `{ addons: ['plots'] }`.


## The public API is the default

For most addons you never need to touch an underscore method. A bar chart
is layout (`gui._nextPos()`-free): measure, draw rectangles through
`gui.renderer`, advance the layout with `gui._advance()`. The demos and
the bundled addons show the pattern:

    gui.renderer.fillRect(x, y, w, h, [88, 138, 240, 255]);
    gui.renderer.line(x, y, x2, y2, [255, 255, 255, 40], 1);

The calls are clipped to the current window, translated for scroll, and
culled before they reach the backend. Draw in absolute screen coordinates
(you get them from layout calls, not from `gui.renderer`).

Two public helpers matter for any plot-shaped addon:

- `gui.getRegionAvail()` -- the space left below/right of the cursor. Your
  width should follow it, so the widget rescales with the window.
- `gui.plotHeight(opts, minH, extra)` -- resolves the shared sizing
  contract below.


## The h / share sizing contract

Every plot in this repository accepts the same two options:

- `h: px` -- explicit height (the legacy behavior).
- `share: n` -- take 1/n of the region's remaining height, split evenly
  among the n siblings in the same window (tracked per frame, so if a
  sibling disappears the rest grow).
- neither -- fill the remaining height.

The implementation is ~10 lines (see `shareHeight` in `addons/mim_plots.js`
or `frame3D` in `addons/mim_3d.js`); copy it and your plot joins the
family. Widths always follow the window either way.


## The documented internal surface

When you build a real widget (frame, label, hit testing, value), you reach
for the documented underscore surface. These are stable by agreement --
they are listed in the `Mim.registerAddon` docs, and the bundled addons
rely on all of them:

    gui._id(label)
        -> { stateKey, itemId, instance }
        Build the ids for a widget from a label. `stateKey` is scoped by
        the id stack (window / child / group / popup context plus any
        pushId), so identical labels in different contexts are different
        widgets. `instance` is the duplicate counter within the current
        scope: two visible widgets with the same label both work.

    gui._state(stateKey)
        -> a persistent object (plain, yours to fill)
        The per-widget store, kept across frames. Its `lastFrame` is
        updated for you, which is how the core garbage-collects state that
        stopped being drawn.

    gui._nextPos()
        -> { x, y } (absolute screen coords)
        Where the next item would go, honoring sameLine/indent/cursor.

    gui._advance(x, y, w, h)
        Move the layout cursor past your widget. Call it exactly once per
        widget with the rect you actually drew (or reserved).

    gui._item(x, y, w, h, itemId, opts)
        -> the item for this frame, or a recycled one
        Registers your rect so hover/click/scroll/gating work. `it.visible`
        tells you whether the core will draw for you (clip + scroll).

    gui._clickable(it)
        -> { active, pressed, released, clicked }
        The whole press/drag/release lifecycle against the input, with
        hover gating (a covered item is never clicked) and the pointer
        cursor set for you. `clicked` is true on the press frame.

    gui._col(name, alphaMul)
        -> [r, g, b, a]
        A palette color ('text', 'frameBg', 'border', ...), respecting the
        active push/pop style stack and window style. `alphaMul` (0..1)
        fades it.

    gui._var(name)   a style var ('fontSize', 'framePadding', ...)
    gui._fo()        -> { fontSize, fontId } for the current text font
    gui._lineH()     the current line height (px)
    gui._measure(str, fo) -> { w, h }   cached text metrics
    gui._drawText(x, y, str, color, fo) draw text with the standard font
    gui.beginChild(label, opts) / gui.endChild()   nested scrollable area
    gui.renderer        the live RendererProxy for your own drawing


## A worked widget, start to finish

A grabber: a horizontal drag bar that returns its value. This is, almost
verbatim, the `grabber` in `addons/mim_widgets.js` -- the same pattern as
every slider and drag in the core.

    grabber(label, value, opts) {
      opts = opts || {};
      const min = opts.min != null ? opts.min : 0;
      const max = opts.max != null ? opts.max : 1;
      if (max <= min) max = min + 1;
      const fo = gui._fo();
      const pos = gui._nextPos();                  // where do I go?
      const avail = gui.getRegionAvail();
      const w = opts.w > 0 ? opts.w : Math.max(80, avail.w);
      const h = opts.h > 0 ? opts.h : 18;
      const s = gui.state;

      const st = gui._state('##grab' + label);     // persistent per label
      const v = clamp(value, min, max);            // the caller's suggestion
      const t = (v - min) / (max - min);           // 0..1 along the track

      const it = gui._item(pos.x, pos.y, w, h,
        gui._id('##gr' + label).itemId, { focusable: false });
      if (it.visible) {
        r.fillRoundedRect(pos.x, pos.y + h / 2 - 3, w, 6, 3, col('childBg')); // track
        if (t > 0.004)
          r.fillRoundedRect(pos.x, pos.y + h / 2 - 3, w * t, 6, 3, col('sliderGrab'));
        r.fillRoundedRect(pos.x + w * t - 5, pos.y + 1, 10, h - 2, 3,
          col(it.hovered ? 'headerActive' : 'sliderGrab'));                   // knob
        // ...label on the right, measured first...
      }

      // Input. A fresh left click that nobody else owns:
      const clicked = gui.isMouseClicked(0) && s.activeId === 0 && !s.drag
        && s.disabledCount === 0;
      if (s.drag && s.drag.type === 'grab' && s.drag.st === st && gui.isMouseDown(0)) {
        // dragging: the mouse owns the value (px/pw = the press point and
        // track width, st = this state object, so other grabbers ignore us)
        st.v = min + clamp((s.mouse.x - s.drag.px) / s.drag.pw, 0, 1) * (max - min);
        st._dragging = true;
        gui._setCursor('ew-resize', 2);
      } else if (clicked && it.hovered) {
        // press on the track: jump to the click position, then keep dragging
        st.v = min + clamp((s.mouse.x - pos.x) / w, 0, 1) * (max - min);
        st._dragging = true;
        s.drag = { type: 'grab', st, px: pos.x, pw: w };
        s.activeId = -1;                    // "I own the press now"
      } else if (st._dragging) {
        // release frame: the core already cleared s.drag at frame start,
        // so this branch IS the release. Keep the dragged value.
        st._dragging = false;
      } else {
        // idle: follow the value the caller passed in
        st.v = v;
      }
      gui._advance(pos.x, pos.y, w, h);      // take the space
      return st.v;
    }

Notes on what is going on:

- The value lives in `st`, not in your closure. Immediate mode: the
  argument `value` is a suggestion, `st.v` is the truth, and you return
  the truth. The first frame seeds `st.v` from the argument; after that
  the user owns it.
- `gui.state.drag = { type: 'grab', ... }` is the convention for "I am
  dragging now": the window-move logic steps aside while you drag, and the
  core clears `s.drag` on the release frame (before your widget runs).
  That is why the release is detected from your own `st._dragging` flag,
  not from the core: by the time your code runs on that frame, the core
  has already forgotten the drag.
- Tagging your state object onto `s.drag` (`s.drag.st === st`) is how
  several instances of the same widget coexist: each only follows the drag
  it started.
- `gui._clickable(it)` (see the list above) does this press/drag/release
  dance for you against a single item; widgets that need multi-instance
  or custom geometry (like the grabber) do it by hand with the pattern
  shown. For pure hover/draw work you do not need either -- just `it.visible`
  and `it.hovered`.


## State, and its one trap

`gui._state(stateKey)` hands you an object that survives frames and is
garbage-collected when you stop drawing the widget. Fill it with anything
plain (numbers, arrays, small objects). The one trap is feedback loops:
if your widget's output feeds back into its input (a text field editing a
string, a slider driving a quantized value), only re-derive internal
formatting when the user actually changed something. Check
`res.clicked` / `res.pressed` or compare against the last stored value --
do not re-parse your own output every frame, or rounding and formatting
will fight each other and the value will jitter.


## IDs and labels

The label you pass to `gui._id` becomes the widget's identity together
with the current id scope:

- Use a visible label for widgets that show one: `gui._id('Volume')`.
- Use a `##` suffix for the invisible part when a label is also a display
  string: `gui._id('##grabVolume')`.
- Wrap repeated regions in `gui.pushId(i)` / `gui.popId()` (lists,
  tables) so row 3 of panel A and row 3 of panel B are different widgets.
- `instance` in the `_id` result is the duplicate counter: if the same
  label legitimately appears twice in the same scope (two columns in a
  row), each gets its own ids automatically. You never have to fix it.

Two state-key styles are both in use here:

- `gui._state(gui._id(label).stateKey)` -- scope-aware: the same label in
  different windows/children/ids is a different widget. Use this for
  widgets that may legitimately appear in more than one window.
- `gui._state('##grab' + label)` -- a plain string, global to the app.
  Shorter, and fine when the label is unique per app (all the bundled
  addons do this). The `##` prefix is a convention that keeps these keys
  away from visible labels.

Pick one per widget and stay consistent; the danger is only mixing a
scope-aware key and a string key for the same visual thing.


## Colors

Always 4-component arrays `[r, g, b, a]`, 0..255. The renderer proxy
silently drops a draw call whose color has no alpha, so a missing fourth
component is a "nothing appears" bug, not an error.

- Theme colors: `gui._col('frameBg')`, `gui._col('text')`, ... (these
  follow themes, per-window style and push/pop stacks).
- Your own colors: `[88, 138, 240, 255]`, or `M.Color.hex('#588af0')`, or
  `M.Color.mix(c1, c2, t)` for ramps (heatmaps, progress bars).
- Faded versions of a theme color: `gui._col('border', 0.4)`.


## Testing your addon headlessly

Everything in `test/addons.js` runs in Node, no browser. The harness:

- a `Mock` renderer that records every draw call
  (`this.calls.push([method, ...args])`),
- an `Env` class that builds a GUI on the mock and lets you synthesize
  frames: hover, press, release, click, dragTo, and typed text,
- assertions on (a) the recorded draw calls and (b) the widget state in
  `gui.state.widgetStates`.

The shape of a test:

    const e = new Env({ addons: true });
    e.frame(() => {
      if (e.gui.beginWindow('T')) {
        value = e.gui.addons.widgets.grabber('volume', value, { min: 0, max: 1 });
        e.gui.endWindow();
      }
    });
    // frame 1: find where the track was drawn (a fillRect in the log),
    // press inside it, frame, drag, frame, release, frame.
    // assert on `value` and on st._dragging in gui.state.widgetStates.

Two conventions the tests rely on, so keep them: draw your chrome with
distinct colors (the tests find your widget by its rectangles), and keep
your state keys stable (the tests read them out of
`gui.state.widgetStates`). The mock records calls across frames, so clear
the log between the frames you assert on if you need to.

Run `node test/addons.js` after a change; 88 checks in about a second.


## Checklist

1. Self-contained file, no imports, no globals but the `Mim` hook.
2. `Mim.registerAddon(name, factory)` returning a plain object.
3. Identity through `gui._id` + `gui._state` (never the raw label).
4. One `gui._item` + `gui._clickable` + `gui._advance` per widget.
5. Colors always 4-component; theme colors through `gui._col`.
6. Value in state, suggestion in the argument, truth in the return.
7. A headless test that presses it and asserts the state changed.

Do those seven things and your addon behaves like one of the bundled ones
on every backend, in every window, at any size.


## Where to look

- `addons/mim_color.js` -- the richest example: pad + hue + alpha drags,
  hex editing, a checkerboard, all on the internal surface.
- `addons/mim_plots.js` -- the h/share sizing, normalized-point persistence
  (bezier), and the hover-to-nearest-sample pattern (series).
- `addons/mim_tables.js` -- sorting, selection-by-id, filtering, and the
  "state outlives re-sorting" pattern.
- `test/addons.js` -- the `Env`/`Mock` harness, ready to copy.
- BACKEND.md -- the other side of the fence: what your drawing calls land
  on.
