# Building a rendering backend for Mim

This is the short, human version of how you teach Mim to draw on your
surface of choice. If you can draw rectangles and text on it, you can
render Mim on it. The core never touches your canvas, your WebGL context,
your DOM, or any other platform object. It just hands you a list of
commands every frame and asks you for a list of inputs. You do the
translation. That is the whole job.


## The shape of a backend

A backend is two things, both plain objects or small classes:

1. A **renderer** -- an object with drawing methods (the "renderer
   interface", described below).
2. An **input snapshot** -- a function that reads your host's state (mouse,
   keys, text) and returns one normalized object per frame.

You wire them together in two lines:

    const gui = new Mim.GUI(renderer, { flags: { animations: false } });
    // ...every frame...
    gui.beginFrame(readMyInput());
    // ...draw windows/widgets...
    gui.endFrame();

The constructor options are optional: `{ style, flags, clipboard, addons,
debugOverlay }`. `flags` turns behaviors on/off (every key of
`gui.flags`), and you can also change them live at runtime
(`gui.flags.tooltips = false;`).

Note that `beginFrame` takes the input snapshot; it calls
`renderer.beginFrame(width, height)` for you. You do not call it yourself.


## The renderer interface

These are the methods the core may call on your renderer. Coordinates are
pixels, origin at the top-left, y grows downward. Colors are always
4-element arrays `[r, g, b, a]` with values 0..255. If you pass a
3-component color back into anything, the core will ignore the call (it
validates alpha), so always supply 4 components when you draw your own
extra pixels.

Required -- the core will not degrade nicely without these:

    beginFrame(width, height)      // new frame; set transforms, clear if you like
    endFrame()                     // flush / present
    textSize(text, options)        // -> { w, h }  where h is the line height
    fillRect(x, y, w, h, color)
    fillRoundedRect(x, y, w, h, radius, color)
    strokeRect(x, y, w, h, color, thickness)
    strokeRoundedRect(x, y, w, h, radius, color, thickness)
    line(x1, y1, x2, y2, color, thickness)
    pushClip(x, y, w, h)           // intersect with current clip (scissor)
    popClip()

Optional -- the core checks for each with `typeof renderer.m === 'function'`
and quietly skips the feature if it is missing:

    fillCircle(cx, cy, radius, color)
    fillEllipse(cx, cy, rx, ry, color)
    polyline(points, color, thickness)   // points = [x0, y0, x1, y1, ...]
    fillPolygon(points, color)
    drawImage(imageId, x, y, w, h, tint) // tint is a color or null
    setLayer('background' | 'gui' | 'foreground')
    setCursor(name)                    // 'default','pointer','text','grab',...
    drawText(x, y, text, color, options)

Two notes on the optional ones:

- `drawText` is optional in the sense that the core only calls it when it
  exists, but a GUI without text is not a GUI, so in practice you must
  implement it. `options` carries `{ fontSize, fontId }`. `fontId` is a
  string key you can map to any font you like (see "Fonts" below). The x, y
  is the top-left of the text, and the text grows right and down.
- `pushClip`/`popClip` are about scissoring. The core always passes
  absolute rectangles. Your job is to intersect each new clip with the one
  currently active and restore on `popClip`. A clip stack of two or three
  levels is enough; the core keeps them balanced for you.

`textSize` must return the same width your `drawText` will actually use for
the same string and options, or the layout (wrapping, centering,
truncation) will be wrong. If your font metrics are expensive, cache them;
the core already caches the results, but not your computation.


## The input snapshot

Once per frame, your function returns:

    {
      width: 1280,          // display size in pixels (what you drew on)
      height: 720,
      mouse: {
        x: 400, y: 250,     // pixel coords, same space as the renderer
        buttons: [true, false, false, false, false],
                                // [left, right, middle, back, forward]
        wheelX: 0, wheelY: 0.1,  // deltas since last frame, then reset
      },
      keys: new Set(['shift']),  // tokens, see below; current frame only
      text: 'ab',                // characters typed since last frame
    }

Key tokens are lowercase strings: `shift`, `ctrl`, `meta` (cmd on mac),
`alt`, `enter`, `tab`, `escape`, `backspace`, `delete`, `home`, `end`,
`left`, `right`, `up`, `down`, `pageup`, `pagedown`, plus plain letters and
digits by name. The core tracks edge events (pressed/released) itself by
comparing frames, so you only report the current set.

`text` is the free-form input: everything the user typed that is not a key
token. The core routes it to the focused text field and clears it after
each frame, so buffer it between frames on your side.

If you are on a canvas behind a CSS-scaled element, convert mouse
coordinates into the same pixel space you draw in before returning them.
The core does no scaling.


## A minimal Canvas2D backend

This is genuinely almost everything. It renders the full demo.

    class Canvas2DRenderer {
      constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.clipStack = [];
        this.layer = 'gui';
        this.images = {};    // id -> CanvasImageSource
        this.fonts = {};     // fontId -> font family string
      }
      beginFrame(w, h) { this.ctx.setTransform(1, 0, 0, 1, 0, 0); }
      endFrame() {}
      _c(c) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (c[3] / 255) + ')'; }
      _font(o) { o = o || {}; return (o.fontSize || 13) + 'px ' + (this.fonts[o.fontId] || 'sans-serif'); }
      drawText(x, y, str, c, o) {
        const g = this.ctx;
        g.font = this._font(o);
        g.fillStyle = this._c(c);
        g.textAlign = 'left';
        g.textBaseline = 'top';
        g.fillText(String(str), x, y);
      }
      textSize(str, o) {
        const g = this.ctx;
        g.font = this._font(o);
        const w = g.measureText(String(str)).width;
        return { w: w, h: (o && o.fontSize || 13) * 1.25 };
      }
      fillRect(x, y, w, h, c) { this.ctx.fillStyle = this._c(c); this.ctx.fillRect(x, y, w, h); }
      strokeRect(x, y, w, h, c, t) {
        const g = this.ctx;
        g.strokeStyle = this._c(c); g.lineWidth = t || 1;
        g.strokeRect(x + (t || 1) / 2, y + (t || 1) / 2, w - (t || 1), h - (t || 1));
      }
      line(x1, y1, x2, y2, c, t) {
        const g = this.ctx;
        g.strokeStyle = this._c(c); g.lineWidth = t || 1;
        g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      }
      fillCircle(cx, cy, r, c) {
        const g = this.ctx;
        g.fillStyle = this._c(c);
        g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.fill();
      }
      fillRoundedRect(x, y, w, h, r, c) { this._rounded(x, y, w, h, r, c, true); }
      strokeRoundedRect(x, y, w, h, r, c, t) { this._rounded(x, y, w, h, r, c, false, t); }
      _rounded(x, y, w, h, r, c, fill, t) {
        const g = this.ctx;
        r = Math.min(r, w / 2, h / 2);
        g.beginPath();
        g.moveTo(x + r, y);
        g.arcTo(x + w, y, x + w, y + h, r);
        g.arcTo(x + w, y + h, x, y + h, r);
        g.arcTo(x, y + h, x, y, r);
        g.arcTo(x, y, x + w, y, r);
        g.closePath();
        if (fill) { g.fillStyle = this._c(c); g.fill(); }
        else { g.strokeStyle = this._c(c); g.lineWidth = t || 1; g.stroke(); }
      }
      pushClip(x, y, w, h) {
        const g = this.ctx;
        this.clipStack.push(g.getTransform());
        g.save(); g.beginPath(); g.rect(x, y, w, h); g.clip();
      }
      popClip() { const g = this.ctx; g.restore(); this.clipStack.pop(); }
    }

If you want layers, add `setLayer(name)` and store `name`; in `endFrame`
draw the three passes if your surface requires it. Most canvas setups can
ignore layers entirely: the core draws in the right order, and a single
canvas pass is just the `gui` layer.

`demo/canvas-backend.js` is this idea plus device-pixel-ratio
scaling, image support, cursor styling, and capability flags. Read it if
you want a fuller reference; it is one file and heavily commented.


## Fonts

You decide what a `fontId` means. The core only sends the id and a size.
A good pattern: keep a map from id to font family (or a texture atlas),
default to your UI font for unknown ids, and optionally
register a `bold` and a `mono` id so addons like `mim_markdown` can use
them when available (they fall back to a double-draw fake bold and plain
text when you do not register anything).

Keep `textSize` and `drawText` in lockstep: same font, same size, same
string, same width.


## Images

If you implement `drawImage`, register your sources with the renderer
before frames start (any registry you like; the core only passes the id):

    renderer.images['logo'] = myCanvasElement;   // your bookkeeping
    // in the sketch:
    gui.image('logo', 120, 60, {});

`tint` is a 4-color array or null. Applying it is your problem (canvas:
draw to an offscreen and `globalCompositeOperation = 'source-in'`, or just
ignore tint and draw the image plain).


## How the core uses the calls (so you can debug)

- The core wraps your renderer in a small proxy. That proxy does clip
  culling (it will not send you a fillRoundedRect that is fully outside the
  active clip), applies scroll offsets, and counts calls. If a call you
  expect never arrives, first check whether it was clipped.
- Every window body is drawn inside a `pushClip`/`popClip` pair, so your
  clip stack depth reaches 2 or 3 inside scroll areas.
- `setLayer` may be called a handful of times per frame (background, gui,
  foreground). If you do not implement it, all drawing is one pass.
- `setCursor` is only called when you advertise it (see "Capabilities").


## Capabilities

You can advertise what you support with a plain object:

    renderer.features = { cursor: true, clip: true };

The core only calls `setCursor` when `features.cursor` is true. There is no
capability list you must satisfy; missing methods are the capability
system, and `features` is a small convenience on top.


## Testing your backend without a browser

The whole test suite in `test/` runs in Node with a mock renderer that just
records calls. Copy the pattern from `test/headless.js`:

    class Mock {
      constructor() { this.calls = []; }
      record(m, a) { this.calls.push([m, ...a]); }
      beginFrame() {} endFrame() {}
      fillRect(...a) { this.record('fillRect', a); }
      // ...one line per method you implement...
      drawText(...a) { this.record('drawText', a); }
      pushClip() {} popClip() {}
      textSize(s, o) { return { w: String(s).length * 7, h: 16 }; }
    }

Then drive frames with a fake input object (see the `Env` class in
`test/addons.js`) and assert on the recorded calls: did the window's
background arrive? did the text land at the expected coordinates? This is
how a backend can be verified headlessly, and it is how the canvas
backend is verified here. The mock does not need to draw anything; it
only needs to have the right method names and to return a plausible
`textSize`.


## Common pitfalls

- **3-component colors.** The renderer interface wants `[r, g, b, a]`. If
  you build your own colors for custom drawing and forget alpha, the core
  proxy drops the call. Use `[r, g, b, 255]`.
- **Text metrics drift.** If `textSize` and `drawText` disagree (different
  font, different baseline math), wrapped text and centered labels will be
  off by a pixel or a word. Measure with the exact font you draw with.
- **Forgetting to clear your input deltas.** `wheelX`, `wheelY`, and
  `text` are "since last frame". If you keep returning the same value, the
  UI will scroll and re-type forever.
- **CSS scaling.** If your canvas is scaled with CSS (or is a
  device-pixel-ratio-scaled surface), mouse coordinates arrive in CSS
  pixels while you draw in device pixels. Multiply by the scale before you
  return the input snapshot.
- **Clip leaks.** If you implement `pushClip` with `save()` you must
  `restore()` in `popClip`, or your transforms and clips drift frame over
  frame. The core always balances the calls; your state must balance too.
- **Measuring before the font is set.** Canvas `measureText` uses the
  current `ctx.font`. Set it before you measure.


## Checklist

1. Object with the required methods (and `drawText`/`textSize`).
2. Input snapshot function returning the normalized shape.
3. Colors as 4 arrays, both in and out.
4. `textSize` and `drawText` agree on widths.
5. Clip stack balanced.
6. A Node test that records calls and asserts on a frame or two.

Do those six things and Mim will render on your surface, with all the
windows, docking, widgets, and addons included.


## Where to look

- `demo/canvas-backend.js` -- the full Canvas2D backend (with DPR,
  images, cursors, layers).
- `test/headless.js`, `test/advanced.js`, `test/addons.js` -- the mock
  renderer + input harness used to test everything in this repository
  without a browser.
