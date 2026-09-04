/* ============================================================================
 * Mim — a single-file immediate-mode GUI library for JavaScript
 * ----------------------------------------------------------------------------
 * Mim is a Dear-ImGui-style immediate mode GUI whose core is completely
 * backend agnostic. The core never draws anything itself and never touches
 * platform APIs: it issues drawing commands through a renderer interface
 * and receives normalized input from the host application every frame.
 *
 *   const gui = new Mim.GUI(renderer, options);
 *
 *   function frame(input) {            // input is normalized (see below)
 *     gui.beginFrame(input);
 *     if (gui.beginWindow("Example")) {
 *       gui.text("Hello!");
 *       if (gui.button("Click me")) doThing();
 *       value = gui.sliderFloat("Value", value, 0, 100);
 *       gui.endWindow();
 *     }
 *     gui.endFrame();
 *   }
 *
 * RENDERER INTERFACE (implemented by the host, e.g. demo/canvas-backend.js)
 * ----------------------------------------------------------------------
 * Required:
 *   beginFrame(w, h)                       start of frame (clear / setup)
 *   endFrame()                             end of frame (flush)
 *   textSize(str, {fontSize, fontId})     -> { w, h }  (h = line height)
 *   fillRect(x, y, w, h, color)
 *   fillRoundedRect(x, y, w, h, r, color)
 *   strokeRect(x, y, w, h, color, thickness)
 *   strokeRoundedRect(x, y, w, h, r, color, thickness)
 *   line(x1, y1, x2, y2, color, thickness)
 *   fillCircle(cx, cy, r, color)
 *   pushClip(x, y, w, h) / popClip()      scissor management (core passes
 *                                         absolute rects, backends intersect)
 * Optional (the core degrades gracefully if absent):
 *   setLayer('background'|'gui'|'foreground')
 *   polyline(points, color, thickness)    points: [x0,y0,x1,y1,...]
 *   fillPolygon(points, color)
 *   fillEllipse(cx, cy, rx, ry, color)
 *   drawImage(imageId, x, y, w, h, tint)
 *   drawText(x, y, str, color, {fontSize, fontId, align, valign})
 *   setCursor(style)                      'default' | 'pointer' | 'text' | 'move'
 *                                         | 'grab' | 'grabbing' | 'ew-resize' |
 *                                         'ns-resize' | 'nwse-resize' | ...
 *   features: { cursor: true, ... }       capability flags; the core only uses
 *                                         a feature when advertised (e.g. it
 *                                         never calls setCursor unless
 *                                         features.cursor is true)
 *
 * Colors are arrays [r, g, b, a] with 0..255 components. Coordinates are in
 * display pixels with the origin at the top-left corner, +y down.
 *
 * INPUT FORMAT (passed to beginFrame every frame)
 * ------------------------------------------------
 *   {
 *     width, height,                       display size in px
 *     mouse: {
 *       x, y,                              mouse position
 *       buttons: [left, right, middle, back, forward]  // booleans
 *       wheelX, wheelY                     wheel delta accumulated since the
 *                                         last frame (positive wheelY = the
 *                                         user rolled "down", content scrolls
 *                                         toward the bottom)
 *     },
 *     keys: Set|Array,                      pressed key tokens (see Mim.Key)
 *     text: "ab",                           characters typed this frame
 *   }
 *
 * Key tokens: 'a'..'z', '0'..'9', ' ', 'enter', 'tab', 'escape',
 * 'backspace', 'delete', 'insert', 'home', 'end', 'pageup', 'pagedown',
 * 'left', 'right', 'up', 'down', 'shift', 'ctrl', 'alt', 'meta', 'f1'..'f12'.
 *
 * The core uses no browser, Node, or DOM APIs whatsoever. It exports a single
 * global symbol `Mim` (on globalThis) when none is present.
 * ==========================================================================*/
(function (global) {
  "use strict";

  const VERSION = "1.5.1";

  /* ------------------------------------------------------------------------
   * Small utilities
   * -------------------------------------------------------------------- */

  // ---- shared math & color helpers ----

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  const lerp = (a, b, t) => a + (b - a) * t;

  const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

  function nowMs() {
    if (typeof performance !== "undefined" && performance.now) {
      return performance.now();
    }

    return Date.now();
  }

  /* FNV-1a 32-bit hashing (fast, allocation free). */
  function fnv1a(str) {
    let h = 0x811c9dc5;

    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }

    return h >>> 0;
  }

  function hashPair(a, b) {
    return (
      (Math.imul(a >>> 0, 0x9e3779b1) ^ Math.imul(b >>> 0, 0x85ebca6b)) >>> 0
    );
  }

  function hash3(a, b, c) {
    return (hashPair(a, b) ^ Math.imul(c >>> 0, 0xcc9e2d51)) >>> 0;
  }

  function pointInRect(x, y, r) {
    return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
  }

  function rectsOverlap(a, b) {
    return (
      a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
    );
  }

  /* Colors are plain arrays [r, g, b, a] (0..255). Never mutate a color you
   * obtained from the style; use mix/withAlpha which return new arrays. */

  /**
   * Builds an [r, g, b, a] color array (ints, alpha defaults to 255).
   * @function Mim.Color.rgba
   * @param {number} r 0..255
   * @param {number} g 0..255
   * @param {number} b 0..255
   * @param {number} [a=255] 0..255
   * @returns {number[]} [r, g, b, a]
   */
  const rgba = (r, g, b, a) => [r | 0, g | 0, b | 0, a == null ? 255 : a | 0];

  /**
   * Converts a hex string to [r, g, b, a]: '#rgb', '#rrggbb', '#rgba',
   * '#rrggbbaa' (with or without the leading '#'). Invalid input yields
   * magenta [255, 0, 255, 255] so errors are visible.
   * @function Mim.Color.hex
   * @param {string} str
   * @returns {number[]} [r, g, b, a]
   */
  function hexToColor(str) {
    let m = /^#?([0-9a-f]{3,8})$/i.exec(String(str).trim());

    if (!m) {
      return rgba(255, 0, 255, 255);
    }
    let h = m[1];

    if (h.length === 3 || h.length === 4)
      h = h
        .split("")
        .map((c) => c + c)
        .join("");

    if (h.length === 6) {
      h = "ff" + h; // #rrggbb -> alpha first? we store [r,g,b,a]; append alpha
    }
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255;

    return [r, g, b, a];
  }

  function normColor(c) {
    if (c == null) {
      return null;
    }

    if (typeof c === "string") {
      return hexToColor(c);
    }

    if (Array.isArray(c)) {
      return [c[0] | 0, c[1] | 0, c[2] | 0, c[3] == null ? 255 : c[3] | 0];
    }

    if (typeof c.r === "number")
      return [
        c.r | 0,
        c.g | 0,
        c.b | 0,
        c.a == null ? 255 : (c.a * (c.a > 1 ? 1 : 255)) | 0,
      ];

    return rgba(200, 200, 200, 255);
  }
  /**
   * Linear blend of two colors: mix = c1 + (c2 - c1) * t.
   * @function Mim.Color.mix
   * @param {number[]} c1 [r, g, b, a]
   * @param {number[]} c2 [r, g, b, a]
   * @param {number} t 0..1
   * @returns {number[]} the blended color
   */
  function mixColor(c1, c2, t) {
    return [
      lerp(c1[0], c2[0], t) | 0,
      lerp(c1[1], c2[1], t) | 0,
      lerp(c1[2], c2[2], t) | 0,
      lerp(c1[3], c2[3], t) | 0,
    ];
  }
  /**
   * Returns a copy of the color with its alpha replaced.
   * @function Mim.Color.withAlpha
   * @param {number[]} c [r, g, b, a]
   * @param {number} a 0..255
   * @returns {number[]} a new color
   */
  function withAlpha(c, a) {
    return [c[0], c[1], c[2], a | 0];
  }

  /* Word-wrap `str` to maxW pixels using measure(line) -> width. */
  function wrapText(str, maxW, measure) {
    const out = [];
    let line = "";

    for (const rawPart of String(str).split(" ")) {
      if (rawPart === "") {
        out.push(line);
        line = "";
        continue;
      }
      const candidate = line ? line + " " + rawPart : rawPart;

      if (measure(candidate).w <= maxW || line === "") {
        // hard-break words that are longer than maxW on their own

        if (line === "" && measure(rawPart).w > maxW) {
          let chunk = "";

          for (const ch of rawPart) {
            if (chunk && measure(chunk + ch).w > maxW) {
              out.push(chunk);
              chunk = ch;
            } else chunk += ch;
          }
          line = chunk;
        } else if (line === "") {
          line = rawPart;
        } else line = candidate;
      } else {
        out.push(line);
        line = rawPart;
      }
    }

    if (line || out.length === 0) {
      out.push(line);
    }

    return out;
  }

  // ---- value formatting ----

  function fmtVal(v, fmt) {
    if (v == null || !isFinite(v)) {
      return "∞";
    }

    if (fmt === "%d") {
      return String(Math.round(v));
    }
    const m = /^%\.(\d+)f$/.exec(fmt || "");

    if (m) {
      return v.toFixed(+m[1]);
    }

    if (Math.abs(v) >= 10000) {
      return v.toFixed(0);
    }

    return String(Math.round(v * 1000) / 1000);
  }

  /* ------------------------------------------------------------------------
   * Public constants
   * -------------------------------------------------------------------- */

  /**
   * Layer names for gui.layer() and renderer.setLayer().
   * @constant {Object} Layers
   * @property {string} Background 'background' — behind all windows
   * @property {string} GUI 'gui' — the normal GUI pass
   * @property {string} Foreground 'foreground' — above everything (tooltips,
   *   notifications, ...)
   */

  // ---- public constants ----

  const Layers = Object.freeze({
    Background: "background",
    GUI: "gui",
    Foreground: "foreground",
  });

  /**
   * Key tokens used in input.keys and the isKey*() queries. A Set of these
   * tokens is the `keys` field of the per-frame input snapshot.
   * @constant {Object} Key
   */
  const Key = Object.freeze({
    Space: " ",
    Enter: "enter",
    Tab: "tab",
    Escape: "escape",
    Backspace: "backspace",
    Delete: "delete",
    Insert: "insert",
    Home: "home",
    End: "end",
    PageUp: "pageup",
    PageDown: "pagedown",
    Left: "left",
    Right: "right",
    Up: "up",
    Down: "down",
    Shift: "shift",
    Ctrl: "ctrl",
    Alt: "alt",
    Meta: "meta",
    F1: "f1",
    F2: "f2",
    F3: "f3",
    F4: "f4",
    F5: "f5",
    F6: "f6",
    F7: "f7",
    F8: "f8",
    F9: "f9",
    F10: "f10",
    F11: "f11",
    F12: "f12",
  });

  /**
   * Indices into input.mouse.buttons: [left, right, middle, back, forward].
   * @constant {Object} MouseButton
   */
  const MouseButton = Object.freeze({
    Left: 0,
    Right: 1,
    Middle: 2,
    Back: 3,
    Forward: 4,
  });

  /* Addon registry. Addons (separate self-contained files) register a
   * factory here; every GUI instance installs them into `gui.addons.<name>`.
   * See Mim.registerAddon / the "Addons" README section. */
  const MIM_ADDONS = Object.create(null);

  /* Window option flags (bitmask). Windows are movable, resizable and
   * collapsible by default; use the No* flags to disable those behaviors.
   * Modal: while open, the window blocks mouse input to the windows it
   * covers; windows drawn above it (e.g. AlwaysOnTop) stay interactive —
   * input always follows the visible (last-drawn) order. */
  /**
   * Window option flags (bitmask, pass via beginWindow's `flags` option).
   * Windows are movable, resizable and collapsible by default; the No* flags
   * disable those behaviors.
   * @constant {Object} WindowFlags
   * @property {number} Closable shows the close (x) button in the title bar
   * @property {number} ScrollX allows horizontal scrolling
   * @property {number} AlwaysOnTop renders above all normal windows
   * @property {number} Modal blocks mouse input to the windows it covers
   *   (windows drawn above it, e.g. AlwaysOnTop, stay interactive)
   * @property {number} NoTitleBar hides the title bar
   * @property {number} NoClip disables the window's clip region
   * @property {number} NoScrollbar hides the scrollbars (scrolling still works)
   * @property {number} AutoResize sizes the window to its content
   * @property {number} FixedSize disables resizing
   * @property {number} NoMove disables moving
   * @property {number} NoResize disables resizing
   * @property {number} NoCollapse disables the collapse chevron
   * @property {number} NoDock opts the window out of all docking
   */
  const WindowFlags = Object.freeze({
    Closable: 1 << 0,
    ScrollX: 1 << 1,
    AlwaysOnTop: 1 << 2,
    Modal: 1 << 3,
    NoTitleBar: 1 << 4,
    NoClip: 1 << 5,
    NoScrollbar: 1 << 6,
    AutoResize: 1 << 7,
    FixedSize: 1 << 8,
    NoMove: 1 << 9,
    NoResize: 1 << 10,
    NoCollapse: 1 << 11,
    NoDock: 1 << 12,
  });

  /* ------------------------------------------------------------------------
   * Style
   * --------------------------------------------------------------------
   * The style holds every tunable visual property. Colors live in
   * style.colors, metrics in style.vars, the font in style.font.
   *
   *   gui.style.colors.frameBg = '#3a3b44';      // hex strings are accepted
   *   gui.style.vars.windowRounding = 12;
   *   gui.setTheme('light');
   *
   * Temporary overrides: gui.pushStyleColor / gui.pushStyleVar (+ pop).
   * Per-window overrides: beginWindow(title, { style: { bg, border,
   * rounding, titleBg, padding, ... } }).
   * -------------------------------------------------------------------- */

  // ---- built-in theme: dark ----

  const ThemeDark = {
    windowBg: [30, 31, 36, 246],
    childBg: [40, 41, 48, 235],
    popupBg: [40, 41, 48, 252],
    titleBg: [42, 43, 49, 255],
    titleBgActive: [53, 54, 64, 255],
    titleBgCollapsed: [36, 37, 42, 255],
    menubarBg: [36, 37, 43, 255],
    border: [64, 65, 74, 255],
    frameBg: [50, 51, 60, 255],
    frameBgHovered: [61, 62, 74, 255],
    frameBgActive: [69, 70, 84, 255],
    sliderGrab: [88, 138, 240, 255],
    sliderGrabHovered: [110, 156, 246, 255],
    sliderGrabActive: [132, 174, 250, 255],
    checkMark: [88, 138, 240, 255],
    text: [230, 231, 234, 255],
    textDisabled: [128, 130, 138, 255],
    header: [61, 62, 74, 255],
    headerHovered: [70, 71, 86, 255],
    headerActive: [82, 83, 100, 255],
    separator: [64, 65, 74, 255],
    resizeGrip: [72, 73, 86, 255],
    resizeGripHovered: [96, 97, 114, 255],
    resizeGripActive: [118, 119, 140, 255],
    scrollbarBg: [0, 0, 0, 24],
    scrollbarGrab: [84, 85, 100, 255],
    scrollbarGrabHovered: [104, 105, 124, 255],
    scrollbarGrabActive: [126, 127, 150, 255],
    tab: [46, 47, 54, 255],
    tabHovered: [61, 62, 74, 255],
    tabActive: [58, 59, 72, 255],
    textSelectedBg: [64, 100, 190, 130],
    tooltipBg: [50, 51, 62, 252],
    error: [224, 82, 82, 255],
    focusRing: [88, 138, 240, 200],
    plotLine: [88, 138, 240, 255],
    tableBgAlt: [255, 255, 255, 7],
    tableHeader: [46, 47, 54, 255],
  };

  // ---- built-in theme: light ----

  const ThemeLight = {
    windowBg: [245, 246, 248, 248],
    childBg: [252, 252, 254, 255],
    popupBg: [255, 255, 255, 252],
    titleBg: [231, 233, 238, 255],
    titleBgActive: [219, 221, 228, 255],
    titleBgCollapsed: [238, 239, 242, 255],
    menubarBg: [235, 236, 240, 255],
    border: [198, 200, 210, 255],
    frameBg: [226, 228, 234, 255],
    frameBgHovered: [215, 217, 226, 255],
    frameBgActive: [204, 206, 218, 255],
    sliderGrab: [79, 124, 255, 255],
    sliderGrabHovered: [97, 138, 255, 255],
    sliderGrabActive: [115, 152, 255, 255],
    checkMark: [79, 124, 255, 255],
    text: [35, 36, 42, 255],
    textDisabled: [140, 142, 150, 255],
    header: [222, 224, 232, 255],
    headerHovered: [212, 214, 226, 255],
    headerActive: [200, 203, 218, 255],
    separator: [198, 200, 210, 255],
    resizeGrip: [180, 182, 194, 255],
    resizeGripHovered: [158, 160, 176, 255],
    resizeGripActive: [138, 140, 160, 255],
    scrollbarBg: [0, 0, 0, 16],
    scrollbarGrab: [170, 172, 186, 255],
    scrollbarGrabHovered: [150, 152, 168, 255],
    scrollbarGrabActive: [128, 130, 150, 255],
    tab: [236, 237, 241, 255],
    tabHovered: [222, 224, 232, 255],
    tabActive: [255, 255, 255, 255],
    textSelectedBg: [120, 156, 235, 110],
    tooltipBg: [255, 255, 255, 252],
    error: [200, 60, 60, 255],
    focusRing: [79, 124, 255, 200],
    plotLine: [79, 124, 255, 255],
    tableBgAlt: [0, 0, 0, 6],
    tableHeader: [236, 237, 241, 255],
  };

  // ---- default style variables ----

  const DefaultVars = {
    fontSize: 13,
    windowPadding: [10, 10],
    windowRounding: 8,
    windowBorder: 1,
    childRounding: 6,
    childBorder: 1,
    popupRounding: 8,
    popupBorder: 1,
    titleBarHeight: 34,
    titleRounding: 0,
    menuBarHeight: 30,
    framePadding: [8, 5],
    frameRounding: 5,
    frameBorder: 1,
    itemSpacing: [8, 7],
    itemInnerSpacing: [4, 4],
    indentSpacing: 16,
    scrollbarSize: 12,
    scrollbarRounding: 6,
    grabMinSize: 10,
    tabRounding: 6,
    shadow: true,
    shadowAlpha: 46,
    fadeDuration: 0.15,
    caretBlinkRate: 0.9,
  };

  /**
   * The visual style: named colors (style.colors), numeric metrics
   * (style.vars) and the font (style.font). Construct one with a partial
   * override object, or read it from an existing GUI via gui.style.
   */

  // ---- style model ----

  class Style {
    /**
     * @param {Object} [partial] override object
     * @param {string} [partial.theme] 'dark' (default) or 'light'
     * @param {Object} [partial.colors] color name -> [r,g,b,a] | '#hex' | {r,g,b,a}
     * @param {Object} [partial.vars] var name -> number (or [x, y] for vector vars)
     * @param {Object} [partial.font] { size, id }
     */
    constructor(partial = {}) {
      const theme = Style.themes[partial.theme || "dark"] || ThemeDark;
      this.colors = Object.assign({}, theme);

      if (partial.colors)
        for (const k of Object.keys(partial.colors))
          this.colors[k] = normColor(partial.colors[k]);
      this.vars = Object.assign({}, DefaultVars);

      if (partial.vars)
        for (const k of Object.keys(partial.vars)) {
          const v = partial.vars[k];
          this.vars[k] = Array.isArray(v) ? v.slice() : v;
        }
      this.font = {
        size:
          partial.font && partial.font.size
            ? partial.font.size
            : this.vars.fontSize,
        id: (partial.font && partial.font.id) || "default",
      };
    }
  }
  Style.themes = {
    dark: ThemeDark,
    light: ThemeLight,
  };

  /* ------------------------------------------------------------------------
   * Renderer proxy
   * --------------------------------------------------------------------
   * Sits between the core and the user-supplied renderer. It maintains the
   * clip stack (for culling), applies a translation offset (used when
   * replaying deferred popup content), forwards recording into a buffer when
   * a popup capture is active, and skips no-op or culled draw calls so that
   * backends never receive garbage.
   * -------------------------------------------------------------------- */

  // ---- feature-detection sentinel ----

  const EMPTY_FEATURES = Object.freeze({});

  // ---- renderer proxy: clip / offset / layers / recording ----

  class RendererProxy {
    constructor(gui, raw) {
      this.gui = gui;
      this.raw = raw || {};
      this.clip = null; // current intersected clip rect (culling only)
      this.clipStack = [];
      this.layer = Layers.GUI;
      this.cursor = "default";
      this.offset = {
        x: 0,
        y: 0,
      };
      this.recording = null; // draw-call buffer while capturing popup content
      this.calls = 0;
    }
    _has(method) {
      return typeof this.raw[method] === "function";
    }
    _call(method, callArgs) {
      this.calls++;

      if (this.recording) {
        this.recording.push([method, callArgs]);
      }

      if (this._has(method)) {
        this.raw[method].apply(this.raw, callArgs);
      }
    }
    _clipOk(clipX, clipY, clipWidth, clipHeight) {
      if (clipWidth <= 0 || clipHeight <= 0) {
        return false;
      }
      const c = this.clip;

      if (!c) {
        return true;
      }

      return (
        clipX < c.x + c.w &&
        clipX + clipWidth > c.x &&
        clipY < c.y + c.h &&
        clipY + clipHeight > c.y
      );
    }
    beginFrame(displayWidth, displayHeight) {
      this.calls = 0;
      this.clip = null;
      this.clipStack.length = 0;
      this.offset.x = 0;
      this.offset.y = 0;
      this.recording = null;

      if (this._has("beginFrame")) {
        this.raw.beginFrame(displayWidth, displayHeight);
      }
    }
    endFrame() {
      if (this._has("endFrame")) {
        this.raw.endFrame();
      }
    }
    setLayer(layerName) {
      this.layer = layerName;
      this._call("setLayer", [layerName]);
    }
    /**
     * Optional: change the mouse cursor style ('default', 'pointer', 'text',
     * 'move', 'grab', 'grabbing', 'ew-resize', 'ns-resize', 'nwse-resize',
     * 'nesw-resize'). Only called by the core when the raw renderer advertises
     * `features.cursor === true`.
     */
    setCursor(cursorName) {
      this.cursor = cursorName;
      this._call("setCursor", [cursorName]);
    }
    /** Capability set advertised by the raw renderer (e.g. { cursor: true, clip: true }). */
    get features() {
      return (this.raw && this.raw.features) || EMPTY_FEATURES;
    }
    pushClip(clipX, clipY, clipWidth, clipHeight) {
      const c = this.clip;
      const nx = Math.max(clipX, c ? c.x : -1e9);
      const ny = Math.max(clipY, c ? c.y : -1e9);
      const nr = Math.min(clipX + clipWidth, c ? c.x + c.w : 1e9);
      const nb = Math.min(clipY + clipHeight, c ? c.y + c.h : 1e9);
      this.clipStack.push(this.clip);
      this.clip =
        nr > nx && nb > ny
          ? {
              x: nx,
              y: ny,
              w: nr - nx,
              h: nb - ny,
            }
          : null;
      this._call("pushClip", [
        clipX + this.offset.x,
        clipY + this.offset.y,
        clipWidth,
        clipHeight,
      ]);
    }
    popClip() {
      this.clip = this.clipStack.pop() || null;
      this._call("popClip", []);
    }

    /* --- shapes ---------------------------------------------------------- */

    fillRect(xPos, yPos, width, height, fillColor) {
      if (!fillColor || !fillColor[3]) {
        return;
      }
      xPos += this.offset.x;
      yPos += this.offset.y;

      if (!this._clipOk(xPos, yPos, width, height)) {
        return;
      }
      this._call("fillRect", [xPos, yPos, width, height, fillColor]);
    }
    fillRoundedRect(xPos, yPos, width, height, cornerRadius, fillColor) {
      if (!fillColor || !fillColor[3]) {
        return;
      }
      xPos += this.offset.x;
      yPos += this.offset.y;

      if (!this._clipOk(xPos, yPos, width, height)) {
        return;
      }
      this._call("fillRoundedRect", [
        xPos,
        yPos,
        width,
        height,
        cornerRadius,
        fillColor,
      ]);
    }
    strokeRect(xPos, yPos, width, height, strokeColor, thickness) {
      if (!strokeColor || !strokeColor[3]) {
        return;
      }
      thickness = thickness || 1;
      xPos += this.offset.x;
      yPos += this.offset.y;

      if (
        !this._clipOk(
          xPos - thickness,
          yPos - thickness,
          width + thickness * 2,
          height + thickness * 2,
        )
      )
        return;
      this._call("strokeRect", [
        xPos,
        yPos,
        width,
        height,
        strokeColor,
        thickness,
      ]);
    }
    strokeRoundedRect(
      xPos,
      yPos,
      width,
      height,
      cornerRadius,
      strokeColor,
      thickness,
    ) {
      if (!strokeColor || !strokeColor[3]) {
        return;
      }
      thickness = thickness || 1;
      xPos += this.offset.x;
      yPos += this.offset.y;

      if (
        !this._clipOk(
          xPos - thickness,
          yPos - thickness,
          width + thickness * 2,
          height + thickness * 2,
        )
      )
        return;
      this._call("strokeRoundedRect", [
        xPos,
        yPos,
        width,
        height,
        cornerRadius,
        strokeColor,
        thickness,
      ]);
    }
    line(xStart, yStart, xEnd, yEnd, lineColor, thickness) {
      if (!lineColor || !lineColor[3]) {
        return;
      }
      thickness = thickness || 1;
      xStart += this.offset.x;
      yStart += this.offset.y;
      xEnd += this.offset.x;
      yEnd += this.offset.y;
      const m = thickness;

      if (
        !this._clipOk(
          Math.min(xStart, xEnd) - m,
          Math.min(yStart, yEnd) - m,
          Math.abs(xEnd - xStart) + m * 2,
          Math.abs(yEnd - yStart) + m * 2,
        )
      )
        return;
      this._call("line", [xStart, yStart, xEnd, yEnd, lineColor, thickness]);
    }
    polyline(points, lineColor, thickness) {
      if (!lineColor || !lineColor[3] || !points || points.length < 4) {
        return;
      }
      thickness = thickness || 1;
      let minX = 1e9,
        minY = 1e9,
        maxX = -1e9,
        maxY = -1e9;

      for (let i = 0; i < points.length; i += 2) {
        const px = points[i] + this.offset.x,
          py = points[i + 1] + this.offset.y;

        if (px < minX) {
          minX = px;
        }

        if (px > maxX) {
          maxX = px;
        }

        if (py < minY) {
          minY = py;
        }

        if (py > maxY) {
          maxY = py;
        }
      }

      if (
        !this._clipOk(
          minX - thickness,
          minY - thickness,
          maxX - minX + thickness * 2,
          maxY - minY + thickness * 2,
        )
      )
        return;
      const out = new Array(points.length);

      for (let i = 0; i < points.length; i += 2) {
        out[i] = points[i] + this.offset.x;
        out[i + 1] = points[i + 1] + this.offset.y;
      }
      this._call("polyline", [out, lineColor, thickness]);
    }
    fillPolygon(points, fillColor) {
      if (!fillColor || !fillColor[3] || !points || points.length < 6) {
        return;
      }
      let minX = 1e9,
        minY = 1e9,
        maxX = -1e9,
        maxY = -1e9;

      for (let i = 0; i < points.length; i += 2) {
        const px = points[i] + this.offset.x,
          py = points[i + 1] + this.offset.y;

        if (px < minX) {
          minX = px;
        }

        if (px > maxX) {
          maxX = px;
        }

        if (py < minY) {
          minY = py;
        }

        if (py > maxY) {
          maxY = py;
        }
      }

      if (!this._clipOk(minX, minY, maxX - minX, maxY - minY)) {
        return;
      }
      const out = new Array(points.length);

      for (let i = 0; i < points.length; i += 2) {
        out[i] = points[i] + this.offset.x;
        out[i + 1] = points[i + 1] + this.offset.y;
      }
      this._call("fillPolygon", [out, fillColor]);
    }
    fillCircle(centerX, centerY, radius, fillColor) {
      if (!fillColor || !fillColor[3] || radius <= 0) {
        return;
      }
      centerX += this.offset.x;
      centerY += this.offset.y;

      if (
        !this._clipOk(
          centerX - radius,
          centerY - radius,
          radius * 2,
          radius * 2,
        )
      ) {
        return;
      }
      this._call("fillCircle", [centerX, centerY, radius, fillColor]);
    }
    fillEllipse(centerX, centerY, radiusX, radiusY, fillColor) {
      if (!fillColor || !fillColor[3] || radiusX <= 0 || radiusY <= 0) {
        return;
      }
      centerX += this.offset.x;
      centerY += this.offset.y;

      if (
        !this._clipOk(
          centerX - radiusX,
          centerY - radiusY,
          radiusX * 2,
          radiusY * 2,
        )
      ) {
        return;
      }
      this._call("fillEllipse", [
        centerX,
        centerY,
        radiusX,
        radiusY,
        fillColor,
      ]);
    }
    drawImage(imageId, xPos, yPos, width, height, tintColor) {
      xPos += this.offset.x;
      yPos += this.offset.y;

      if (!this._clipOk(xPos, yPos, width, height)) {
        return;
      }
      this._call("drawImage", [
        imageId,
        xPos,
        yPos,
        width,
        height,
        tintColor || null,
      ]);
    }
    drawText(xPos, yPos, text, fillColor, options) {
      if (!fillColor || !fillColor[3] || !text) {
        return;
      }
      xPos += this.offset.x;
      yPos += this.offset.y;
      options = options || {};
      const h = options.fontSize ? options.fontSize * 1.3 : 16;
      let bx = xPos,
        bw = 1;

      if (this._has("textSize")) {
        const m = this.raw.textSize(text, options);
        bw = m.w;

        if (options.align === "center") {
          bx = xPos - m.w / 2;
        } else if (options.align === "right") bx = xPos - m.w;
      }

      if (!this._clipOk(bx, yPos - 2, bw, h + 4)) {
        return;
      }
      this._call("drawText", [xPos, yPos, text, fillColor, options]);
    }
    textSize(text, options) {
      if (this._has("textSize"))
        try {
          return this.raw.textSize(text, options);
        } catch (e) {
          /* fall through */
        }
      const fs = (options && options.fontSize) || 13;

      return {
        w: String(text == null ? "" : text).length * fs * 0.6,
        h: fs * 1.25,
      };
    }
  }

  /* ------------------------------------------------------------------------
   * Window
   * -------------------------------------------------------------------- */

  // ---- window record ----

  class Window {
    constructor(title, kind) {
      this.title = title;
      this.kind = kind; // 'window' | 'child'
      this.owner = null; // top-level window this belongs to
      this.idHash = fnv1a(title);
      this.x = 24;
      this.y = 24;
      this.w = 340;
      this.h = 260;
      this.minW = 90;
      this.minH = 48;
      this.maxW = Infinity;
      this.maxH = Infinity;
      this.flags = 0;
      this.open = true;
      this.collapsed = false;
      this.movable = true;
      this.resizable = true;
      this.collapsible = true;
      this.closable = false;
      this.noTitleBar = false;
      this.noClip = false;
      this.noScrollbar = false;
      this.alwaysOnTop = false;
      this.modal = false;
      this.autoResize = false;
      this.fixedSize = false;
      this.allowScrollX = false;
      this.scrollX = 0;
      this.scrollY = 0;
      this.scrollTargetX = 0;
      this.scrollTargetY = 0;
      this.maxScrollX = 0;
      this.maxScrollY = 0;
      this.hadScrollV = false;
      this.hadScrollH = false;
      this.contentW = 0;
      this.contentH = 0;
      this.titleH = 0;
      this.menuH = 0;
      this.padX = 10;
      this.padY = 10;
      this.alpha = 1;
      this.style = null; // per-window style overrides
      this.onClose = null;
      this.drawnFrame = -1;
      this.defaultX = 24;
      this.defaultY = 24;
      this.sizeW = 0;
      this.sizeH = 0; // user-requested size (from opts)
    }
  }

  /* ------------------------------------------------------------------------
   * GUI
   * -------------------------------------------------------------------- */

  /**
   * Live per-window/per-widget state (ids -> values). Readable for
   * inspection and by addons; the internal shape may change.
   * @member {Object} state
   * @memberof GUI
   */
  /**
   * The behavior flags (tooltips, animations, docking, ...). All of them are
   * live-toggleable at runtime: gui.flags.animations = false;
   * @member {Object} flags
   * @memberof GUI
   */
  /**
   * The active Style object (colors, vars, font).
   * @member {Style} style
   * @memberof GUI
   */
  /**
   * The addon namespaces attached to this instance: gui.addons.<name>.<fn>().
   * @member {Object} addons
   * @memberof GUI
   */
  /**
   * The live RendererProxy: use it for custom drawing from inside a window
   * (gui.renderer.rect(...), .line(...), .drawText(...), ...). Calls are
   * clipped, scroll-offset and culled automatically.
   * @member {Object} renderer
   * @memberof GUI
   */
  /**
   * When true, endFrame draws a small debug overlay (frame count, ids, ...).
   * @member {boolean} debugOverlay
   * @memberof GUI
   */
  /**
   * The clipboard callbacks ({ read: () => string, write: (text) => void })
   * used by inputText copy/paste.
   * @member {Object} clipboard
   * @memberof GUI
   */

  /**
   * The immediate-mode GUI. One instance per app; it owns the window/widget
   * state, the style, the flags, the renderer proxy and the addons.
   *
   * A frame is: beginFrame(input) -> beginWindow / widgets / endWindow
   * (repeat) -> endFrame(). See the README "Quick start" section for a full
   * example.
   */

  // ---- GUI: the main class ----

  class GUI {
    /**
     * Creates a GUI instance.
     * @param {Object} renderer the backend's renderer object (see the README
     *   "Implementing a backend" section and BACKEND.md for the contract)
     * @param {Object} [options]
     * @param {Object} [options.style] partial style ({ theme, colors, vars, font })
     * @param {Object} [options.flags] behavior flags — every key of gui.flags
     *   is toggleable, at construction time or later at runtime
     * @param {Object} [options.clipboard] { read: () => string, write: (text) => void }
     * @param {boolean|Array} [options.addons] which addons to attach: all
     *   registered addons (default), false for none, or a list of names
     * @param {boolean} [options.debugOverlay] draw the debug overlay in endFrame
     */
    constructor(renderer, options) {
      options = options || {};
      this.rawRenderer = renderer;
      this.renderer = new RendererProxy(this, renderer);
      this.style = new Style(options.style || {});
      this.clipboard = options.clipboard || {
        read: () => "",
        write: () => {},
      };
      this.flags = Object.assign(
        {
          keyboardShortcuts: true,
          // ctrl/cmd + c, v, x, a, z, y
          clipboard: true,
          // use the clipboard callbacks for copy/paste
          undoRedo: true,
          // ctrl+Z / ctrl+Y (+ mouse back/forward) in text fields
          rightClickNumeric: true,
          // right-click a slider/drag for direct value entry
          mouseBackForward: true,
          // mouse back/forward buttons: undo/redo in text,
          // otherwise close the topmost popup
          tooltips: true,
          animations: true,
          // window fade-in, tooltip fade, smooth scrolling
          keyboardNavigation: true,
          // Tab / Shift+Tab focus, Enter/Space activation
          windowMove: true,
          windowResize: true,
          resizeBarProximity: 8,
          // px near a window's outline where the
          // resize bars appear / edge bands grab
          // (0 disables the bars and bands; the
          // corner grip follows this distance too)
          windowDoubleReset: true,
          // double-click a title bar to restore position
          docking: true,
          // interactive docking: drag-over window grid +
          // screen-edge drop targets (see _dockHintUpdate)
          dockJoinHitGenerous: false,
          // join grid over a target window: true = the
          // whole window body selects a side; false
          // (default) = only directly over the drawn
          // 72x72 triangle square
          dockScreenHitGenerous: true,
          // screen-center grid: the selectable box
          // extends ~24px beyond the drawn 72x72 square
          windowContextMenu: true,
          // right-click a title bar / dock title / member
          // header for a small context menu (collapse,
          // undock, reset position, close — whatever the
          // window's flags/state allow)
          wheelScroll: true,
          doubleClick: true,
          // double-click text = word select, slider = value entry
          dragThreshold: 3,
          // px before a click becomes a drag
          scrollSpeed: 40,
          // px scrolled per unit of normalized wheel
          tooltipDelay: 0.5, // seconds a hover must persist before a tooltip shows
        },
        options.flags || {},
      );
      this.debugOverlay = !!options.debugOverlay;
      this._timeOffset = 0; // ms; used by tests to advance internal clocks

      const guiState = (this.state = {
        frameId: 0,
        now: nowMs(),
        lastNow: nowMs(),
        dt: 0,
        frameStart: nowMs(),
        displayW: 0,
        displayH: 0,
        mouse: {
          x: -1e4,
          y: -1e4,
          dx: 0,
          dy: 0,
          buttons: [false, false, false, false, false],
          prevButtons: [false, false, false, false, false],
          justPressed: [false, false, false, false, false],
          justReleased: [false, false, false, false, false],
          wheel: [0, 0],
          clickCount: 0,
          clickTime: -1e9,
          clickX: 0,
          clickY: 0,
        },
        keys: new Set(),
        prevKeys: new Set(),
        cursor: null,
        lastCursor: "default",
        textInput: "",
        textConsumed: false,
        activeId: 0,
        activeIdWindow: null,
        hoveredId: 0,
        focusedId: 0,
        dragDistance: 0,
        dragX: 0,
        dragY: 0,
        backForwardHandled: false,
        drag: null,
        // { type, win, ... } window/scrollbar drags
        windows: new Map(),
        zOrder: [],
        hoveredWindow: null,
        modalWin: null,
        focusedWindow: null,
        windowStates: new Map(),
        winCounter: 0,
        currentWindow: null,
        idStack: [],
        idStackSeeds: [],
        idStackSeed: 0,
        dupCount: new Map(),
        items: new Map(),
        itemPool: [],
        lastItem: null,
        focusList: [],
        lastFocusList: [],
        widgetStates: new Map(),
        nextItemWidth: 0,
        nextWindowPos: null,
        nextWindowSize: null,
        layout: null,
        savedLayout: [],
        groupStart: null,
        scrollStack: [],
        // scrollable containers, innermost last
        treeLines: [],
        popups: new Map(),
        popupList: [],
        currentMenu: null,
        // menu row array being recorded
        tooltip: null,
        disabledCount: 0,
        changedId: 0,
        clickedItemId: 0,
        styleStack: [],
        menuBar: null,
        tabStack: [],
        table: null,
        stats: {
          fps: 0,
          ms: 0,
          drawCalls: 0,
          items: 0,
          windows: 0,
          states: 0,
        },
        textSizeCache: new Map(),
        _lineHCache: 0,
        _lineHFrame: -1,
        // docking: pair-key -> dock descriptor (see gui.dock)
        docks: new Map(),
        pendingDocks: [],
        // app menu bar (see gui.setAppMenuBar)
        appMenu: null,
        appBarRect: null,
        appMenuSections: [],
        appMenuOwner: null,
        appMenuShortcuts: [],
        edgeDocks: {
          top: null,
          bottom: null,
          left: null,
          right: null,
        },
        _dockHint: null, // live drag-hint: window grid or screen-edge band
      });

      // addons: every registered addon installs itself into this.addons
      // (gui.addons.<name>.*). Pass opts.addons: false to disable all, or an
      // array of names to enable a subset.
      this.addons = {};
      this._installAddons(options.addons);
    }
    _installAddons(list) {
      if (list === false) {
        return;
      }
      const names = Array.isArray(list) ? list : Object.keys(MIM_ADDONS);

      for (const name of names) {
        const inst = MIM_ADDONS[name];

        if (!inst) {
          continue;
        }
        const methods = typeof inst === "function" ? inst(this, Mim) : inst;

        if (methods && typeof methods === "object") {
          this.addons[name] = methods;
        }
      }
    }

    /* ---------------------------- frame lifecycle ---------------------- */

    /**
     * Starts a GUI frame. Call once per frame, before any widgets: it routes wheel
     * scrolling, updates focus/keyboard bookkeeping and detects key/mouse edge
     *   * events from the input snapshot.
     * @param {object} input normalized input snapshot: { width, height,
     mouse: { x, y, buttons[5], wheelX, wheelY }, keys: Set of key
     tokens, text: characters typed since the last frame }
     */
    beginFrame(input) {
      const guiState = this.state;
      guiState.frameId++;
      // style scopes (per-window overrides, push/popStyle*) are per-frame
      // state: anything still on the stack at frame start was leaked —
      // clear it so one bad frame can never re-theme the whole UI
      guiState.styleStack.length = 0;
      const now = nowMs() + this._timeOffset;
      guiState.dt = clamp((now - guiState.lastNow) / 1000, 0, 0.25);
      guiState.lastNow = now;
      guiState.now = now;
      guiState.frameStart = now;
      input = input || {};
      guiState.displayW = input.width || 0;
      guiState.displayH = input.height || 0;

      // mouse
      const m = input.mouse || {};
      const mouse = guiState.mouse;
      mouse.dx = (m.x || 0) - mouse.x;
      mouse.dy = (m.y || 0) - mouse.y;
      mouse.x = m.x || 0;
      mouse.y = m.y || 0;
      const btns = Array.isArray(m.buttons)
        ? m.buttons
        : [!!m.left, !!m.right, !!m.middle, !!m.back, !!m.forward];

      for (let i = 0; i < 5; i++) {
        mouse.buttons[i] = !!btns[i];
        mouse.justPressed[i] = mouse.buttons[i] && !mouse.prevButtons[i];
        mouse.justReleased[i] = !mouse.buttons[i] && mouse.prevButtons[i];
      }
      mouse.wheel[0] = m.wheelX || 0;
      mouse.wheel[1] = m.wheelY || 0;
      // wheel: scroll the innermost scrollable container under the mouse,
      // else an open scrollable combo popup

      if (
        this.flags.wheelScroll &&
        (guiState.mouse.wheel[0] || guiState.mouse.wheel[1])
      ) {
        const wx = guiState.mouse.wheel[0],
          wy = guiState.mouse.wheel[1];
        let consumed = false;

        for (let i = guiState.scrollStack.length - 1; i >= 0; i--) {
          const sc = guiState.scrollStack[i];

          if (sc.frame !== guiState.frameId - 1) {
            continue;
          }

          if (pointInRect(guiState.mouse.x, guiState.mouse.y, sc.rect)) {
            const win = sc.win;

            if (wx !== 0 && win.maxScrollX > 0)
              win.scrollTargetX = clamp(
                win.scrollTargetX + wx * this.flags.scrollSpeed,
                0,
                win.maxScrollX,
              );

            if (wy !== 0 && win.maxScrollY > 0)
              win.scrollTargetY = clamp(
                win.scrollTargetY + wy * this.flags.scrollSpeed,
                0,
                win.maxScrollY,
              );
            consumed = true;
            break;
          }
        }

        if (!consumed && wy !== 0)
          for (const p of guiState.popupList) {
            if (
              p.open &&
              p.data.type === "combo" &&
              p.maxScroll > 0 &&
              p.w > 0 &&
              pointInRect(guiState.mouse.x, guiState.mouse.y, {
                x: p.x,
                y: p.y,
                w: p.w,
                h: p.h,
              })
            ) {
              p.scrollTargetY = clamp(
                (p.scrollTargetY || 0) + wy * this.flags.scrollSpeed,
                0,
                p.maxScroll,
              );
              consumed = true;
              break;
            }
          }

        if (consumed) {
          guiState.mouse.wheel[0] = 0;
          guiState.mouse.wheel[1] = 0;
        }
      }

      // double click tracking

      if (mouse.justPressed[0] || mouse.justPressed[1]) {
        if (
          guiState.now - mouse.clickTime < 400 &&
          Math.abs(mouse.x - mouse.clickX) < 6 &&
          Math.abs(mouse.y - mouse.clickY) < 6
        )
          mouse.clickCount = (mouse.clickCount % 2) + 1;
        else {
          mouse.clickCount = 1;
        }
        mouse.clickTime = guiState.now;
        mouse.clickX = mouse.x;
        mouse.clickY = mouse.y;
      }

      // active-widget drag distance

      if (guiState.activeId !== 0 && mouse.buttons[0])
        guiState.dragDistance = Math.max(
          guiState.dragDistance,
          Math.hypot(mouse.x - guiState.dragX, mouse.y - guiState.dragY),
        );

      // keyboard / text (s.keys is our own set; s.prevKeys holds last frame's)
      const ik =
        input.keys instanceof Set ? input.keys : new Set(input.keys || []);
      guiState.keys.clear();

      for (const k of ik) guiState.keys.add(k);
      guiState.textInput = typeof input.text === "string" ? input.text : "";
      guiState.textConsumed = false;
      guiState.backForwardHandled = false;

      // topmost window under the mouse, from last frame's rects, computed
      // BEFORE any window draws: title-bar chrome (chevron / close) and item
      // hover must never see a covered window as the hovered one, even on the
      // frame the mouse first lands on the overlap
      {
        let claim = null;

        for (let i = guiState.zOrder.length - 1; i >= 0; i--) {
          const w = guiState.zOrder[i];

          if (w.kind !== "window" || w.open === false) {
            continue;
          }
          const wh = w.collapsed ? w.titleH : w.h;

          if (
            mouse.x >= w.x &&
            mouse.x < w.x + w.w &&
            mouse.y >= w.y &&
            mouse.y < w.y + wh
          ) {
            claim = w;
            break;
          }
          // a dock's combined title strip belongs to the dock for hit-testing

          if (this._dockStripAt(w._dock, mouse.x, mouse.y)) {
            claim = w;
            break;
          }
        }
        guiState.hoveredWindow = claim;
        this._modalHoverClaim(guiState, mouse.x, mouse.y);
      }

      // per-frame resets
      guiState.dupCount = new Map();
      guiState.items.clear();
      guiState.lastItem = null;
      guiState.focusList.length = 0;
      guiState.changedId = 0;
      guiState.clickedItemId = 0;
      guiState.idStack.length = 0;
      guiState.idStackSeeds.length = 0;
      guiState.idStackSeed = 0;
      guiState.nextItemWidth = 0;
      guiState.nextWindowPos = null;
      guiState.nextWindowSize = null;
      guiState.treeLines.length = 0;
      guiState.menuBar = null;
      guiState.tabStack.length = 0;
      guiState.table = null;
      guiState.currentMenu = null;
      guiState.textSizeCache.clear();
      guiState.activeIdWindow = null;
      guiState._lineHFrame = -1;

      // apply dock() calls made before both windows existed

      if (guiState.pendingDocks.length) {
        const still = [];

        for (const [la, lb, opts] of guiState.pendingDocks) {
          const wa = guiState.windows.get(la),
            wb = guiState.windows.get(lb);

          if (wa && wb && wa !== wb) {
            this._makeDock(la, lb, opts);
          } else still.push([la, lb, opts]);
        }
        guiState.pendingDocks = still;
      }

      // finish any drag whose button was released last frame

      if (guiState.drag) {
        const d = guiState.drag;
        const up = !mouse.buttons[d.button == null ? 0 : d.button];

        if (up) {
          if (d.type === "closebtn" && pointInRect(mouse.x, mouse.y, d.rect)) {
            d.win.open = false;

            if (typeof d.win.onClose === "function") {
              d.win.onClose();
            }
          }
          // drop a dragged window — or dock (combined window) — onto a
          // docking hint (join grid / edge band / screen grid)
          const didDock =
            (d.type === "win-move" || d.type === "dock-move") &&
            this._applyDockHint(guiState, d);
          // a pure (unmoved) press+release on a title bar toggles collapse

          if (
            d.type === "win-move" &&
            !didDock &&
            d.collapse &&
            d.moved < this.flags.dragThreshold &&
            mouse.y >= d.win.y &&
            mouse.y < d.win.y + d.win.titleH
          ) {
            d.win.collapsed = !d.win.collapsed;
            d.win._collapseToggledAt = guiState.frameId;
          }
          guiState.drag = null;
          guiState.activeId = 0;
        }
      }

      // resolve a pending slim-header press (set in _drawDockChrome): a pure
      // click toggles the member's collapse, movement beyond the drag
      // threshold frees the member from its dock and starts moving it

      if (guiState._memberDrag) {
        const md = guiState._memberDrag;

        if (!mouse.buttons[0]) {
          guiState._memberDrag = null;
          guiState._dockCollapseToggle = {
            win: md.win,
          };
          guiState.activeId = 0;
        } else if (
          this.flags.windowMove &&
          Math.abs(mouse.x - md.x) + Math.abs(mouse.y - md.y) >=
            this.flags.dragThreshold
        ) {
          guiState._memberDrag = null;
          const w = md.win;
          this._undockMember(w);

          if (w && w.open !== false) {
            if (w.collapsed) {
              w.collapsed = false;

              if (w.h < 120) {
                w.h = 200;
              }
            }
            this._raise(w);
            guiState.drag = {
              type: "win-move",
              win: w,
              button: 0,
              offX: md.offX,
              offY: md.offY,
              x0: w.x,
              y0: w.y,
              moved: 0,
              collapse: false,
            };
            guiState.activeId = -1;
          }
        }
      }

      // which top-level window sits under the mouse (zOrder is draw order,
      // last = topmost). Computed from last frame's rects — stable enough.
      // (The same claim also runs in beginFrame, before any window draws, so
      // title-bar chrome handlers see the topmost window on the very frame
      // the mouse lands on an overlap; this endFrame pass adds popups and the
      // app bar on top and feeds the next frame.)
      let claim = null;

      for (let i = guiState.zOrder.length - 1; i >= 0; i--) {
        const w = guiState.zOrder[i];

        if (w.kind !== "window" || w.open === false) {
          continue;
        }
        const wh = w.collapsed ? w.titleH : w.h;

        if (
          mouse.x >= w.x &&
          mouse.x < w.x + w.w &&
          mouse.y >= w.y &&
          mouse.y < w.y + wh
        ) {
          claim = w;
          break;
        }
        // a dock's combined title strip belongs to the dock for hit-testing

        if (this._dockStripAt(w._dock, mouse.x, mouse.y)) {
          claim = w;
          break;
        }
      }
      guiState.hoveredWindow = claim;
      this._modalHoverClaim(guiState, mouse.x, mouse.y);
      // open popups claim hover above their owner window

      for (let i = guiState.popupList.length - 1; i >= 0; i--) {
        const p = guiState.popupList[i];

        if (
          p.open &&
          p.owner &&
          p.w > 0 &&
          mouse.x >= p.x &&
          mouse.x < p.x + p.w &&
          mouse.y >= p.y &&
          mouse.y < p.y + p.h
        ) {
          guiState.hoveredWindow = p.owner;
          break;
        }
      }

      // app menu bar: geometry, keyboard shortcuts, section clicks
      guiState.appBarGrab = false;
      guiState.appBarRect = null;
      guiState.appMenuSections = [];
      {
        const am = guiState.appMenu;

        if (am) {
          const W = guiState.displayW,
            H = guiState.displayH;
          const horizontal = am.pos === "top" || am.pos === "bottom";
          const th = horizontal ? am.thickness : H;
          const sw = horizontal ? W : am.sideWidth;
          guiState.appBarRect =
            am.pos === "top"
              ? {
                  x: 0,
                  y: 0,
                  w: W,
                  h: th,
                }
              : am.pos === "bottom"
                ? {
                    x: 0,
                    y: H - th,
                    w: W,
                    h: th,
                  }
                : am.pos === "left"
                  ? {
                      x: 0,
                      y: 0,
                      w: sw,
                      h: H,
                    }
                  : {
                      x: W - sw,
                      y: 0,
                      w: sw,
                      h: H,
                    };
          // live keyboard shortcuts (fire once on the pressed frame)

          for (const it of guiState.appMenuShortcuts) {
            const disabled =
              typeof it.disabled === "function" ? it.disabled() : !!it.disabled;

            if (disabled) {
              continue;
            }
            const modsOk =
              !it.keyMod || it.keyMod.every((k) => guiState.keys.has(k));

            if (
              modsOk &&
              this.isKeyPressed(it.key) &&
              typeof it.onActivated === "function"
            )
              it.onActivated();
          }
          const fontOptions = this._fo();
          const lineH = this._lineH();
          let cx = 8,
            cy = 6;
          let anyOpen = false;

          for (const sec of am.menus) {
            if (!sec || !sec.label) {
              continue;
            }
            const label = String(sec.label);
            const lw = this._measure(label, fontOptions).w;
            const rect = horizontal
              ? {
                  x: cx,
                  y:
                    am.pos === "bottom"
                      ? H - th + (th - lineH - 10) / 2
                      : (th - lineH - 10) / 2,
                  w: lw + 18,
                  h: lineH + 10,
                }
              : {
                  x: 8,
                  y: cy,
                  w: sw - 16,
                  h: lineH + 10,
                };

            if (horizontal) {
              cx += rect.w + 6;
            } else cy += rect.h + 2;
            const pid = "##appmenu" + fnv1a(label);
            const p = guiState.popups.get(pid);
            const open = !!(p && p.open && p.data && p.data.appMenu);

            if (open) {
              anyOpen = true;
            }
            guiState.appMenuSections.push({
              label,
              rect,
              pid,
              open,
              items: sec.items || [],
            });
          }
          const overBar = pointInRect(mouse.x, mouse.y, guiState.appBarRect);
          let overPopup = false;

          for (const p of guiState.popupList) {
            if (
              p.open &&
              p.data &&
              p.data.appMenu &&
              p.w > 0 &&
              pointInRect(mouse.x, mouse.y, {
                x: p.x,
                y: p.y,
                w: p.w,
                h: p.h,
              })
            ) {
              overPopup = true;
              break;
            }
          }
          // the whole bar region (and any open menu popup above it) blocks
          // input from reaching the windows underneath
          guiState.appBarGrab = overBar || overPopup;

          if (overPopup) {
            guiState.hoveredWindow = guiState.appMenuOwner;
          }

          if (overBar && !overPopup) {
            // the bar claims the hover: windows under it don't react
            guiState.hoveredWindow = null;

            for (const sec of guiState.appMenuSections) {
              const hov = pointInRect(mouse.x, mouse.y, sec.rect);

              if (!hov) {
                continue;
              }

              if (
                this.isMouseClicked(0) &&
                guiState.activeId === 0 &&
                !guiState.drag
              ) {
                const p = guiState.popups.get(sec.pid);

                if (sec.open) {
                  p.open = false;
                } else {
                  this._openPopup(
                    sec.pid,
                    horizontal
                      ? {
                          x: sec.rect.x,
                          y:
                            am.pos === "top"
                              ? th + 2
                              : guiState.appBarRect.y - 2,
                        }
                      : {
                          x: am.pos === "left" ? sw - 2 : W - sw - 2,
                          y: sec.rect.y,
                        },
                    {
                      type: "menu",
                      items: this._appMenuRows(sec.items, sec.pid),
                      appMenu: true,
                    },
                    fnv1a(sec.pid),
                    guiState.appMenuOwner,
                  );

                  for (const p2 of guiState.popupList)
                    if (p2.data && p2.data.appMenu && p2.id !== sec.pid) {
                      p2.open = false;
                    }
                }
              } else if (anyOpen && !sec.open && !this.isMouseDown(0)) {
                // slide: another label hovered while a menu is open
                this._openPopup(
                  sec.pid,
                  horizontal
                    ? {
                        x: sec.rect.x,
                        y:
                          am.pos === "top" ? th + 2 : guiState.appBarRect.y - 2,
                      }
                    : {
                        x: am.pos === "left" ? sw - 2 : W - sw - 2,
                        y: sec.rect.y,
                      },
                  {
                    type: "menu",
                    items: this._appMenuRows(sec.items, sec.pid),
                    appMenu: true,
                  },
                  fnv1a(sec.pid),
                  guiState.appMenuOwner,
                );

                for (const p2 of guiState.popupList)
                  if (p2.data && p2.data.appMenu && p2.id !== sec.pid) {
                    p2.open = false;
                  }
              }
              break;
            }
          }
        }
      }

      // screen-edge docks: layout + boundary/column drags
      this._edgeDocksFrame(guiState, mouse);
      // interactive docking hints for a window mid-drag
      this._dockHintUpdate(guiState, mouse);
      this.renderer.beginFrame(guiState.displayW, guiState.displayH);
      this.renderer.setLayer(Layers.Background);
    }

    /**
     * Ends the frame: draws popups, tooltips and the debug overlay, then
     *   * compacts per-frame state.
     */
    endFrame() {
      const guiState = this.state;

      // keyboard: tab focus cycling

      if (this.flags.keyboardNavigation && this.isKeyPressed("tab")) {
        const list = guiState.lastFocusList.length
          ? guiState.lastFocusList
          : guiState.focusList;

        if (list.length) {
          const dir = guiState.keys.has("shift") ? -1 : 1;
          let i = list.indexOf(guiState.focusedId);
          i =
            i < 0
              ? dir > 0
                ? 0
                : list.length - 1
              : (i + dir + list.length) % list.length;
          guiState.focusedId = list[i];
        }
      }
      // Escape: close the topmost popup (text edits handle Escape themselves)

      if (this.isKeyPressed("escape") && guiState.popupList.length)
        guiState.popupList[guiState.popupList.length - 1].open = false;
      // mouse back: close the topmost popup unless a text field handled it

      if (
        this.flags.mouseBackForward &&
        !guiState.backForwardHandled &&
        this.isMouseClicked(3) &&
        guiState.popupList.length
      )
        guiState.popupList[guiState.popupList.length - 1].open = false;

      // popups: outside-click dismissal, then draw pass (system + custom)
      this._popupPass();

      // resize edge bands + grip: the TOPMOST free window whose band
      // contains the mouse claims the cursor and, on click, a win-resize
      // drag (so the grip wins over the scrollbars, and at a corner the
      // two overlapping bands resize both directions at once)
      {
        const mouse = guiState.mouse;
        let claim = null,
          claimEdge = 0;

        if (
          this.flags.windowResize &&
          guiState.activeId === 0 &&
          guiState.disabledCount === 0 &&
          !guiState.drag &&
          !this._popupAtPoint(mouse.x, mouse.y)
        )
          for (let i = guiState.zOrder.length - 1; i >= 0; i--) {
            const win = guiState.zOrder[i];

            if (!win.open || win._dockKey || win._edge) {
              continue;
            }

            if (!win.resizable || win.autoResize || win.collapsed) {
              continue;
            }
            const edge = this._winResizeEdgeAt(win, mouse.x, mouse.y);

            if (edge) {
              claim = win;
              claimEdge = edge;
              break;
            }
          }

        if (
          claim &&
          guiState.modalWin &&
          claim !== guiState.modalWin &&
          guiState.zOrder.indexOf(claim) <
            guiState.zOrder.indexOf(guiState.modalWin)
        )
          claim = null; // the modal blocks windows drawn beneath it

        if (claim)
          if (guiState.appBarGrab) {
            // visible-order rule: the band only claims the point when the
            // claimed window is the TOPMOST window there — another window
            // painted over the band owns the point (input must not travel
            // through it to the band underneath). The app menu bar is drawn
            // above all windows, so it owns its region too.

            claim = null;
          } else {
            let topAt = null;

            for (let i = guiState.zOrder.length - 1; i >= 0; i--) {
              const w2 = guiState.zOrder[i];

              if (w2.kind !== "window" || w2.open === false) {
                continue;
              }
              const wh2 = w2.collapsed ? w2.titleH : w2.h;

              if (
                mouse.x >= w2.x &&
                mouse.x < w2.x + w2.w &&
                mouse.y >= w2.y &&
                mouse.y < w2.y + wh2
              ) {
                topAt = w2;
                break;
              }

              if (this._dockStripAt(w2._dock, mouse.x, mouse.y)) {
                topAt = w2;
                break;
              }
            }

            if (topAt && topAt !== claim) {
              claim = null;
            }
          }

        if (claim) {
          const horiz = claimEdge & 2 || claimEdge & 8,
            vert = claimEdge & 1 || claimEdge & 4;
          this._setCursor(
            horiz && vert ? "nwse-resize" : horiz ? "ew-resize" : "ns-resize",
            1,
          );

          if (this.isMouseClicked(0)) {
            guiState.drag = {
              type: "win-resize",
              win: claim,
              button: 0,
              edge: claimEdge,
              mx: mouse.x,
              my: mouse.y,
              x0: claim.x,
              y0: claim.y,
              w0: claim.w,
              h0: claim.h,
            };
            guiState.activeId = -1;
          }
        }
      }

      // screen-edge stack resize bars + docking hints draw above all
      this.renderer.setLayer(Layers.GUI);
      this._drawEdgeResizeBars();
      this._drawDockHints();

      // tooltips
      this._tooltipPass();
      guiState.scrollStack = guiState.scrollStack.filter(
        (sc) => sc.frame >= guiState.frameId - 1,
      );

      // apply a slim-header collapse toggle requested this frame (exactly one
      // member per click, the last-drawn header wins overlapping regions)

      if (guiState._dockCollapseToggle) {
        const w = guiState._dockCollapseToggle.win;

        if (w && w._dockKey) {
          w.collapsed = !w.collapsed;
        }
        guiState._dockCollapseToggle = null;
      }

      // dock bookkeeping: if a member stopped being drawn, dissolve the dock

      for (const [key, D] of Array.from(guiState.docks)) {
        const alive = (w) => !!(w && w.drawnFrame === guiState.frameId);

        if (!alive(D.a) || !alive(D.b)) {
          this._freeDockedMember(D.a);
          this._freeDockedMember(D.b);
          guiState.docks.delete(key);
        }
      }

      // window bookkeeping
      const seen = new Set();

      for (const w of guiState.windows.values()) {
        if (w.drawnFrame === guiState.frameId) {
          seen.add(w);
          // dock/edge members' rects are layout-driven; don't persist them

          if (w._dockKey || w._edge) {
            continue;
          }
          const st = guiState.windowStates.get(w.title);

          if (st) {
            st.x = w.x;
            st.y = w.y;
            st.w = w.w;
            st.h = w.h;
            st.collapsed = w.collapsed;
          } else
            guiState.windowStates.set(w.title, {
              x: w.x,
              y: w.y,
              w: w.w,
              h: w.h,
              collapsed: w.collapsed,
            });
        }
      }

      for (const title of Array.from(guiState.windows.keys())) {
        if (!seen.has(guiState.windows.get(title))) {
          guiState.windows.delete(title);
        }
      }
      guiState.zOrder = guiState.zOrder.filter((w) => seen.has(w));
      const norm = guiState.zOrder.filter((w) => !w.alwaysOnTop);
      const top = guiState.zOrder.filter((w) => w.alwaysOnTop);
      guiState.zOrder = norm.concat(top);

      if (
        !guiState.focusedWindow ||
        guiState.zOrder.indexOf(guiState.focusedWindow) < 0
      )
        guiState.focusedWindow =
          guiState.zOrder[guiState.zOrder.length - 1] || null;
      guiState.modalWin = null;

      for (const w of guiState.zOrder)
        if (w.modal && w.drawnFrame === guiState.frameId) {
          guiState.modalWin = w;
        }

      // clear stale focus / active

      if (
        guiState.activeId !== 0 &&
        Number.isInteger(guiState.activeId) &&
        !guiState.items.has(guiState.activeId)
      )
        guiState.activeId = 0;

      if (
        guiState.focusedId &&
        !guiState.focusList.includes(guiState.focusedId)
      )
        guiState.focusedId = 0;
      guiState.lastFocusList = guiState.focusList.slice();

      // recycle per-id widget state that no widget used this frame

      for (const [k, v] of guiState.widgetStates) {
        if (v.lastFrame !== guiState.frameId) {
          guiState.widgetStates.delete(k);
        }
      }

      // apply the requested cursor (only if the backend supports it)
      {
        const desired = guiState.cursor ? guiState.cursor.style : "default";
        guiState.cursor = null;
        const feats = this.renderer.features;

        if (feats && feats.cursor && desired !== guiState.lastCursor) {
          this.renderer.setCursor(desired);
          guiState.lastCursor = desired;
        } else if (feats && !feats.cursor && guiState.lastCursor !== "default")
          guiState.lastCursor = "default";
      }

      if (this.debugOverlay) {
        this._drawDebugOverlay();
      }
      const st = guiState.stats;
      const frameMs = nowMs() - guiState.frameStart;
      st.ms = st.ms ? lerp(st.ms, frameMs, 0.1) : frameMs;
      st.fps =
        guiState.dt > 0.0005
          ? lerp(st.fps || 1 / guiState.dt, 1 / guiState.dt, 0.08)
          : st.fps;
      st.drawCalls = this.renderer.calls;
      st.items = guiState.items.size;
      st.windows = guiState.zOrder.length;
      st.states = guiState.widgetStates.size;

      for (const it of guiState.items.values()) guiState.itemPool.push(it);
      guiState.items.clear();
      // swap the two key sets: prevKeys now holds this frame's snapshot,
      // keys becomes the (stale) buffer that beginFrame clears + refills
      {
        const t = guiState.keys;
        guiState.keys = guiState.prevKeys;
        guiState.prevKeys = t;
      }

      for (let i = 0; i < 5; i++)
        guiState.mouse.prevButtons[i] = guiState.mouse.buttons[i];
      this.renderer.endFrame();
    }

    /* ---------------------------- id system ----------------------------
     * IDs derive from the id stack (window title, pushId, tree nodes) plus
     * the widget label. `stateKey` is shared by duplicate instances of the
     * same labelled widget in the same context (stable persistent state);
     * `itemId` is unique per instance within a frame (unique rects/hover). */

    pushId(id) {
      const h = typeof id === "string" ? fnv1a(id) : (id | 0) >>> 0;
      const guiState = this.state;
      guiState.idStack.push(h);
      guiState.idStackSeed = hashPair(guiState.idStackSeed, h);
      guiState.idStackSeeds.push(guiState.idStackSeed);
    }
    /**
     * Pops n (default 1) id scopes pushed with pushId().
     * @param {number} [count=1]
     */
    popId(count = 1) {
      const guiState = this.state;

      for (let i = 0; i < count && guiState.idStack.length; i++)
        guiState.idStack.pop();
      guiState.idStackSeed = guiState.idStackSeeds.length
        ? guiState.idStackSeeds[guiState.idStackSeeds.length - 1]
        : 0;

      while (guiState.idStackSeeds.length > guiState.idStack.length)
        guiState.idStackSeeds.pop();
    }
    _id(label) {
      const guiState = this.state;
      const lh = fnv1a(String(label == null ? "" : label));
      const stateKey = hashPair(guiState.idStackSeed, lh);
      let inner = guiState.dupCount.get(guiState.idStackSeed);

      if (!inner) {
        inner = new Map();
        guiState.dupCount.set(guiState.idStackSeed, inner);
      }
      const n = inner.get(lh) || 0;
      inner.set(lh, n + 1);
      const itemId = hash3(stateKey, 0x9e3779b9, n);

      return {
        stateKey,
        itemId,
        instance: n,
      };
    }
    _state(stateKey) {
      const guiState = this.state;
      let v = guiState.widgetStates.get(stateKey);

      if (!v) {
        v = {
          lastFrame: guiState.frameId,
        };
        guiState.widgetStates.set(stateKey, v);
      }
      v.lastFrame = guiState.frameId;

      return v;
    }

    /* ---------------------------- items -------------------------------- */

    _canReceiveInput(win) {
      if (!win) {
        return false;
      }
      const guiState = this.state;

      if (guiState.disabledCount > 0) {
        return false;
      }
      const mw = guiState.modalWin;

      if (mw && win.kind !== "popup") {
        // a modal blocks only what it actually covers (topmost-element
        // rule); the modal's own widgets (and popups, which draw above
        // every window) are never blocked by it
        const top = win.owner || win;

        if (
          top !== mw &&
          guiState.zOrder.indexOf(top) < guiState.zOrder.indexOf(mw)
        ) {
          const mouse = guiState.mouse;
          const mh = mw.collapsed ? mw.titleH : mw.h;

          if (
            mouse.x >= mw.x &&
            mouse.x < mw.x + mw.w &&
            mouse.y >= mw.y &&
            mouse.y < mw.y + mh
          )
            return false;
        }
      }

      return true;
    }
    /* The topmost open popup covering (x, y), if any. Popups draw above all
     * windows and are handled in endFrame, so every window-chrome press
     * (title bar, chevron, close, dock edges, scrollbars) must refuse to
     * start when the click lands on an open popup — otherwise the press
     * double-fires (e.g. a menu-row click would also start a title-bar drag). */
    _popupAtPoint(x, y) {
      const guiState = this.state;

      for (let i = guiState.popupList.length - 1; i >= 0; i--) {
        const p = guiState.popupList[i];

        if (
          p.open &&
          p.w > 0 &&
          pointInRect(x, y, {
            x: p.x,
            y: p.y,
            w: p.w,
            h: p.h,
          })
        )
          return p;
      }

      return null;
    }
    _item(x, y, w, h, itemId, opts) {
      opts = opts || {};
      const guiState = this.state;
      let item = guiState.items.get(itemId);

      if (!item) {
        item = guiState.itemPool.pop() || {};
        guiState.items.set(itemId, item);
      }
      item.itemId = itemId;
      item.win = guiState.layout ? guiState.layout.container : null;
      item.x = x;
      item.y = y;
      item.w = w;
      item.h = h;
      item.focusable = opts.focusable !== false;
      const clip = this.renderer.clip;
      const inMenuBarBand = !!(
        guiState.menuBar &&
        guiState.menuBar.win === guiState.layout.container &&
        y >= guiState.layout.container.y + guiState.layout.container.titleH &&
        y + h <=
          guiState.layout.container.y +
            guiState.layout.container.titleH +
            guiState.layout.container.menuH
      );
      item.visible =
        w > 0 &&
        h > 0 &&
        (!clip ||
          rectsOverlap(
            {
              x,
              y,
              w,
              h,
            },
            clip,
          ) ||
          inMenuBarBand);
      item.hovered = false;
      item.active = false;
      item.clicked = false;
      item.enabled = guiState.disabledCount === 0;

      if (
        item.visible &&
        item.enabled &&
        item.win &&
        this._canReceiveInput(item.win)
      ) {
        const mouse = guiState.mouse;
        const top = item.win.owner || item.win;
        // menu bar items live in the band above the content clip
        const inMenuBar = !!(
          guiState.menuBar &&
          guiState.menuBar.win === item.win &&
          mouse.y >= item.win.y + item.win.titleH &&
          mouse.y < item.win.y + item.win.titleH + item.win.menuH
        );
        const inClip =
          !clip || pointInRect(mouse.x, mouse.y, clip) || inMenuBar;
        // open popups paint above every window: an item hidden beneath one
        // must not show hover highlighting or take input (items laid out
        // inside the popup itself are exempt)
        let underPopup = false;
        const container = guiState.layout && guiState.layout.container;

        if (!container || container.kind !== "popup")
          for (const p of guiState.popupList) {
            if (
              p.open &&
              p.w > 0 &&
              pointInRect(mouse.x, mouse.y, {
                x: p.x,
                y: p.y,
                w: p.w,
                h: p.h,
              })
            ) {
              underPopup = true;
              break;
            }
          }
        item.hovered =
          guiState.hoveredWindow === top &&
          inClip &&
          !underPopup &&
          mouse.x >= x &&
          mouse.x < x + w &&
          mouse.y >= y &&
          mouse.y < y + h;
      }

      if (item.focusable && item.visible && item.enabled) {
        guiState.focusList.push(itemId);
      }
      guiState.lastItem = item;

      return item;
    }
    _mouseIn(it) {
      const mouse = this.state.mouse;

      return (
        mouse.x >= it.x &&
        mouse.x < it.x + it.w &&
        mouse.y >= it.y &&
        mouse.y < it.y + it.h
      );
    }

    /* Standard click/active wiring for a widget item. */
    _clickable(it) {
      const guiState = this.state;

      if (it.hovered && guiState.disabledCount === 0) {
        this._setCursor("pointer", 1);
      }
      const wasActive = guiState.activeId === it.itemId; // this item owns the press (set on an earlier frame)

      if (it.hovered && this.isMouseClicked(0)) {
        guiState.activeId = it.itemId;
        guiState.activeIdWindow = it.win;
        guiState.hoveredId = it.itemId;
        guiState.clickedItemId = it.itemId;

        if (it.focusable) {
          guiState.focusedId = it.itemId;
        }
        guiState.dragX = guiState.mouse.x;
        guiState.dragY = guiState.mouse.y;
        guiState.dragDistance = 0;
        it.dragInit = false; // fresh press: let the widget (re)seed its drag state
        guiState.focusedWindow = it.win; // a click focuses but never reorders the draw order
      }
      it.active = guiState.activeId === it.itemId && this.isMouseDown(0);
      it.pressed = it.active && !wasActive;
      it.clicked = false;
      // release detection uses wasActive (captured before this frame's press),
      // because isMouseDown(0) is already false on the release frame

      if (wasActive && this.isMouseReleased(0)) {
        it.clicked =
          this._mouseIn(it) || guiState.dragDistance < this.flags.dragThreshold;
        guiState.activeId = 0;
        guiState.activeIdWindow = null;
      }

      return {
        active: it.active,
        pressed: it.pressed,
        released: wasActive && this.isMouseReleased(0),
        clicked: it.clicked,
      };
    }

    /* Bring a window (or popup) to the front of the draw order. Called only
     * when a window/dock MOVE drag actually starts moving — a plain click
     * never reorders the stack (otherwise the focused window would jump
     * above its neighbours and steal later clicks). The focused-window
     * marker (bright title bar) is set separately via s.focusedWindow. */
    _raise(win) {
      const guiState = this.state;

      if (!win) {
        return;
      }
      const top = win.owner || win;
      const i = guiState.zOrder.indexOf(top);

      if (i >= 0) {
        guiState.zOrder.splice(i, 1);
        guiState.zOrder.push(top);
      }
      guiState.focusedWindow = top;
    }

    /* Modal hover claim: an open modal owns the cursor only where it is
     * actually drawn — the topmost-element rule still applies. A window
     * painted above it (e.g. AlwaysOnTop) keeps its own input, and points
     * outside the modal's rect are unaffected (the modal blocks the windows
     * it covers, not the whole screen). */
    _modalHoverClaim(s, x, y) {
      const mw = s.modalWin;

      if (!mw) {
        return;
      }
      const mh = mw.collapsed ? mw.titleH : mw.h;

      if (x < mw.x || x >= mw.x + mw.w || y < mw.y || y >= mw.y + mh) {
        return;
      }
      const hv = s.hoveredWindow;

      if (hv && hv !== mw && s.zOrder.indexOf(hv) > s.zOrder.indexOf(mw)) {
        return; // topmost wins
      }
      s.hoveredWindow = mw;
    }

    /* Does (x, y) fall in a FREE dock's combined title-bar strip? The strip
     * is painted by the dock (during its first member's pass) but is not
     * part of either member's rect, so topmost hit-testing must treat it as
     * belonging to the dock's members. Without this, a window painted over
     * the strip would "own" the point and the dock's header would become
     * undraggable (softlock). */
    _dockStripAt(D, x, y) {
      if (!D || D._edge) {
        return false;
      }
      const tH = this._var("titleBarHeight");

      return x >= D.x && x < D.x + D.w && y >= D.y && y < D.y + tH;
    }
    _advance(x, y, w, h) {
      const layout = this.state.layout;

      if (!layout) {
        return;
      }
      const cx = x - layout.origin.x + layout.scroll.x;
      const cy = y - layout.origin.y + layout.scroll.y;

      if (!layout._same) {
        layout.lineStartX = cx;
        layout.lineY = cy;
      }
      layout.lineActive = true;
      layout.lineBottom = Math.max(layout.lineBottom, cy + h);
      layout.prevRight = cx + w;
      layout.y = Math.max(layout.y, cy + h);
      layout.contentRight = Math.max(layout.contentRight, cx + w);
      layout.itemCount++;
    }
    _nextPos() {
      const layout = this.state.layout;
      const itemSpacing = this._var("itemSpacing");
      let x, y;

      if (layout.lineActive && layout.sameLine) {
        const sl = layout.sameLine;
        layout.sameLine = null;
        layout._same = true;
        x =
          sl.offset != null
            ? layout.lineStartX + sl.offset
            : layout.prevRight +
              (sl.spacing != null ? sl.spacing : itemSpacing[0]);
        y = layout.lineY;
      } else if (layout.lineActive) {
        layout._same = false;
        x = layout.x + layout.indent;
        y = layout.lineBottom + itemSpacing[1];
      } else {
        layout._same = false;
        x = layout.x + layout.indent;
        y = layout.y;
      }

      return {
        x: layout.origin.x + x - layout.scroll.x,
        y: layout.origin.y + y - layout.scroll.y,
      };
    }

    /* ---------------------------- text helpers ------------------------- */

    _fo() {
      return {
        fontSize: this._var("fontSize"),
        fontId: this.style.font.id,
      };
    }
    _measure(str, fo) {
      fo = fo || this._fo();
      const key = str + "\x00" + fo.fontSize + "\x00" + fo.fontId;
      const guiState = this.state;
      let m = guiState.textSizeCache.get(key);

      if (!m) {
        m = this.renderer.textSize(str, fo);

        if (typeof m.w !== "number" || !isFinite(m.w)) {
          m.w = String(str).length * fo.fontSize * 0.6;
        }

        if (typeof m.h !== "number" || !isFinite(m.h)) {
          m.h = fo.fontSize * 1.25;
        }
        guiState.textSizeCache.set(key, m);
      }

      return m;
    }
    _lineH() {
      const guiState = this.state;

      if (guiState._lineHFrame === guiState.frameId && guiState._lineHCache)
        return guiState._lineHCache;
      guiState._lineHCache = this._measure("M").h;
      guiState._lineHFrame = guiState.frameId;

      return guiState._lineHCache;
    }
    _frameH() {
      const fp = this._var("framePadding");

      return this._lineH() + fp[1] * 2;
    }
    _drawText(x, y, str, color, fo, o) {
      fo = fo || this._fo();
      this.renderer.drawText(
        x,
        y,
        String(str == null ? "" : str),
        color,
        Object.assign(
          {
            fontSize: fo.fontSize,
            fontId: fo.fontId,
          },
          o || {},
        ),
      );
    }

    /* ---------------------------- style stack -------------------------- */

    _col(name, alphaMul) {
      const stack = this.state.styleStack;

      for (let i = stack.length - 1; i >= 0; i--) {
        const c = stack[i].colors && stack[i].colors[name];

        if (c) {
          return alphaMul != null && alphaMul < 1
            ? withAlpha(c, c[3] * alphaMul)
            : c;
        }
      }
      const c = this.style.colors[name] || [200, 200, 200, 255];

      return alphaMul != null && alphaMul < 1
        ? withAlpha(c, c[3] * alphaMul)
        : c;
    }
    _var(name) {
      const stack = this.state.styleStack;

      for (let i = stack.length - 1; i >= 0; i--) {
        const v = stack[i].vars && stack[i].vars[name];

        if (v !== undefined) {
          return v;
        }
      }

      return this.style.vars[name];
    }
    /**
     * Pushes an override for a style var (e.g. 'fontSize', 'framePadding',
     *   * 'indentSpacing'); pair with popStyleVar().
     * @param {string} name
     * @param {number|number[]} value
     */
    pushStyleVar(name, value) {
      this.state.styleStack.push({
        vars: {
          [name]: value,
        },
      });
    }
    /**
     * Pops n (default 1) pushed style-var overrides.
     * @param {number} [n=1]
     */
    popStyleVar(n = 1) {
      const st = this.state.styleStack;

      for (let i = 0; i < n && st.length; i++) st.pop();
    }
    /**
     * Pushes an override for a style color (e.g. 'WindowBg', 'FrameBg',
     *   * 'Text'); pair with popStyleColor().
     * @param {string} name
     * @param {number[]} color [r, g, b, a] with a in 0..255
     */
    pushStyleColor(name, color) {
      this.state.styleStack.push({
        colors: {
          [name]: normColor(color),
        },
      });
    }
    /**
     * Pops n (default 1) pushed style-color overrides.
     * @param {number} [n=1]
     */
    popStyleColor(n = 1) {
      const st = this.state.styleStack;

      for (let i = 0; i < n && st.length; i++) st.pop();
    }
    /**
     * Switches the global color theme ('dark' or 'light'): replaces
     *   * gui.style.colors with the theme palette. Per-window style overrides and
     *   * push/pop stacks are unaffected.
     * @param {string} name 'dark' or 'light'
     */
    setTheme(name) {
      const t = Style.themes[name];

      if (t) this.style.colors = Object.assign({}, t);
    }
    _applyStyleScope(win) {
      const scope = {
        colors: {},
        vars: {},
      };
      const st = win.style || null;

      if (st) {
        if (st.bg) {
          scope.colors.windowBg = normColor(st.bg);
        }

        if (st.border) {
          scope.colors.border = normColor(st.border);
        }

        if (st.titleBg) {
          scope.colors.titleBg = normColor(st.titleBg);
        }

        if (st.titleBgActive) {
          scope.colors.titleBgActive = normColor(st.titleBgActive);
        }

        if (st.frameBg) {
          scope.colors.frameBg = normColor(st.frameBg);
        }

        if (st.rounding != null) {
          scope.vars.windowRounding = st.rounding;
        }

        if (st.titleRounding != null) {
          scope.vars.titleRounding = st.titleRounding;
        }

        if (st.borderWidth != null) {
          scope.vars.windowBorder = st.borderWidth;
        }

        if (st.padding != null) {
          scope.vars.windowPadding = st.padding;
        }

        if (st.shadow != null) {
          scope.vars.shadow = !!st.shadow;
        }
      }
      this.state.styleStack.push(scope);
    }
    _popStyleScope(n = 1) {
      const st = this.state.styleStack;

      for (let i = 0; i < n && st.length; i++) st.pop();
    }

    /* ---------------------------- input queries ------------------------ */

    /**
     * True while mouse button b (0 left, 1 right, 2 middle, 3 back, 4
     *   * forward) is held down.
     * @param {number} [b=0]
     * @returns {boolean}
     */
    isMouseDown(b = 0) {
      return this.state.mouse.buttons[b];
    }
    /**
     * Requests a mouse cursor style for this frame (e.g. 'pointer', 'text',
     * 'move', 'grabbing', 'ew-resize', 'ns-resize', 'nwse-resize'). Higher
     * prio wins; the request is only sent to the renderer when its
     * `features.cursor` capability is set (see the renderer interface).
     */
    _setCursor(style, prio = 1) {
      const guiState = this.state;

      if (!guiState.cursor || prio >= guiState.cursor.prio)
        guiState.cursor = {
          style,
          prio,
        };
    }

    /**
     * True on the frame mouse button b was pressed.
     * @param {number} [b=0]
     * @returns {boolean}
     */
    isMouseClicked(b = 0) {
      return this.state.mouse.justPressed[b];
    }
    /**
     * True on the frame mouse button b was released.
     * @param {number} [b=0]
     * @returns {boolean}
     */
    isMouseReleased(b = 0) {
      return this.state.mouse.justReleased[b];
    }
    /**
     * True on the frame mouse button b was double-clicked (two presses
     *   * within the double-click interval).
     * @param {number} [b=0]
     * @returns {boolean}
     */
    isMouseDoubleClicked(b = 0) {
      const mouse = this.state.mouse;

      return mouse.justPressed[b] && mouse.clickCount >= 2;
    }
    /**
     * The current cursor position in screen coordinates.
     * @returns {Object} {x, y}
     */
    mousePos() {
      const m = this.state.mouse;

      return {
        x: m.x,
        y: m.y,
      };
    }
    /**
     * The cursor movement since the previous frame.
     * @returns {Object} {x, y}
     */
    mouseDelta() {
      const m = this.state.mouse;

      return {
        x: m.dx,
        y: m.dy,
      };
    }
    /**
     * True while key token k is held. Tokens: Mim.Key constants, single
     *   * lowercase letters, '0'..'9', 'f1'..'f12', 'tab', 'enter', 'escape',
     *   * 'backspace', 'delete', 'insert', 'home', 'end', 'pageup', 'pagedown',
     *   * arrows, 'shift', 'ctrl', 'alt', 'meta', ' '.
     * @param {string} k
     * @returns {boolean}
     */
    isKeyDown(k) {
      return this.state.keys.has(k);
    }
    /**
     * True on the frame key k was pressed.
     * @param {string} k
     * @returns {boolean}
     */
    isKeyPressed(k) {
      return this.state.keys.has(k) && !this.state.prevKeys.has(k);
    }
    /**
     * True on the frame key k was released.
     * @param {string} k
     * @returns {boolean}
     */
    isKeyReleased(k) {
      return !this.state.keys.has(k) && this.state.prevKeys.has(k);
    }
    get ctrl() {
      return this.isKeyDown("ctrl") || this.isKeyDown("meta");
    }
    get shift() {
      return this.isKeyDown("shift");
    }
    get alt() {
      return this.isKeyDown("alt");
    }

    /**
     * The last item registered this frame (an internal item object, or
     *   * null if none).
     * @returns {Object|null}
     */
    lastItem() {
      return this.state.lastItem;
    }
    /**
     * The screen rect of the last item, or null.
     * @returns {Object|null} {x, y, w, h}
     */
    lastItemRect() {
      const item = this.state.lastItem;

      return item
        ? {
            x: item.x,
            y: item.y,
            w: item.w,
            h: item.h,
          }
        : null;
    }
    /**
     * True if the last item is hovered (and reachable by the cursor).
     * @returns {boolean}
     */
    lastItemHovered() {
      const item = this.state.lastItem;

      return !!(item && item.hovered);
    }
    /**
     * True if the last item is active (pressed or being dragged).
     * @returns {boolean}
     */
    lastItemActive() {
      const item = this.state.lastItem;

      return !!(item && item.active);
    }
    /**
     * True if the last item was clicked this frame.
     * @returns {boolean}
     */
    lastItemClicked() {
      const item = this.state.lastItem;

      return !!(item && item.clicked);
    }
    /**
     * True if the last item's value changed this frame.
     * @returns {boolean}
     */
    lastItemChanged() {
      const item = this.state.lastItem;

      return item ? this.state.changedId === item.itemId : false;
    }
    /**
     * Shortcut for lastItemChanged().
     * @returns {boolean}
     */
    changed() {
      return this.lastItemChanged();
    }

    /* ---------------------------- layout API --------------------------- */

    /* Place the next element on the SAME LINE as the previous one: it keeps
     * the previous element's y (the line top) and its x is adjusted to the
     * right of the previous element's right edge plus `spacing` — the
     * automatic padding/margin. Omit `spacing` to use the style's horizontal
     * item spacing. Pass `offsetX` (second argument) instead to anchor the
     * next element at an absolute offset from the line's start (e.g.
     * sameLine(null, 120)). Only applies when there IS a previous element
     * on the current line ("if applicable") — at the top of a window, or
     * right after setCursorPos/setCursorScreenPos, it is a no-op. Call it
     * between elements: `button('a'); sameLine(); button('b');` */
    sameLine(spacing, offsetX) {
      const layout = this.state.layout;

      if (!layout || !layout.lineActive) {
        return; // nothing drawn yet: not applicable
      }
      layout.sameLine = {
        offset: offsetX == null ? null : offsetX,
        spacing: spacing == null ? null : spacing,
      };
    }
    /**
     * Increases the layout indent by amount px (default: the
     *   * 'indentSpacing' style var); pair with unindent().
     * @param {number} [amount]
     */
    indent(amount) {
      this.state.layout.indent += amount || this._var("indentSpacing");
    }
    /**
     * Decreases the layout indent by amount px (default: the 'indentSpacing'
     *   * style var), never below 0.
     * @param {number} [amount]
     */
    unindent(amount) {
      this.state.layout.indent = Math.max(
        0,
        this.state.layout.indent - (amount || this._var("indentSpacing")),
      );
    }
    /**
     * The layout cursor position, relative to the current window/child origin.
     * @returns {Object} {x, y}
     */
    getCursorPos() {
      const layout = this.state.layout;

      return {
        x: layout.x + layout.indent,
        y: layout.y,
      };
    }
    /**
     * The layout cursor position in absolute screen coordinates.
     * @returns {Object} {x, y}
     */
    getCursorScreenPos() {
      const layout = this.state.layout;

      return {
        x: layout.origin.x + layout.x + layout.indent - layout.scroll.x,
        y: layout.origin.y + layout.y - layout.scroll.y,
      };
    }
    /**
     * Moves the layout cursor to (x, y) relative to the current window/child
     *   * origin; the next item is placed there.
     * @param {number} x
     * @param {number} y
     */
    setCursorPos(x, y) {
      const layout = this.state.layout;
      layout.x = x - layout.indent;
      layout.y = y;
      layout.lineActive = false;
      layout.sameLine = null;
    }
    /**
     * Moves the layout cursor to absolute screen coordinates (x, y).
     * @param {number} x
     * @param {number} y
     */
    setCursorScreenPos(x, y) {
      const layout = this.state.layout;
      layout.x = x - layout.origin.x + layout.scroll.x - layout.indent;
      layout.y = y - layout.origin.y + layout.scroll.y;
      layout.lineActive = false;
      layout.sameLine = null;
    }
    /**
     * Forces the width of the next widget; 0 means the widget's default width.
     * @param {number} w
     */
    setNextItemWidth(w) {
      this.state.nextItemWidth = w;
    }
    /**
     * The remaining space right/below the cursor in the current region.
     * @returns {Object} {w, h}
     */
    getRegionAvail() {
      const layout = this.state.layout;

      return {
        w: Math.max(0, layout.avail.w - (layout.x + layout.indent)),
        h: Math.max(0, layout.avail.h - layout.y),
      };
    }

    /**
     * Consumes one empty line (the vertical item spacing).
     */
    spacing() {
      const pos = this._nextPos();
      this._item(
        pos.x,
        pos.y,
        0,
        0,
        hashPair(this.state.idStackSeed, 0x5a5a5a5a),
        {
          focusable: false,
        },
      );
      this._advance(pos.x, pos.y, 0, this._var("itemSpacing")[1]);
    }
    /**
     * Reserves an empty w x h rect at the cursor (layout only, nothing is
     *   * drawn).
     * @param {number} w
     * @param {number} h
     * @returns {Object} the created item (internal)
     */
    dummy(w, h) {
      const pos = this._nextPos();
      const item = this._item(
        pos.x,
        pos.y,
        w,
        h,
        hashPair(this.state.idStackSeed, 0x5a5a5a5b),
        {
          focusable: false,
        },
      );
      this._advance(item.x, item.y, w, h);

      return item;
    }
    /**
     * Draws a horizontal separator line; inside a menu, appends a separator
     *   * row.
     */
    separator() {
      if (this.state.currentMenu) {
        this.state.currentMenu.push({
          type: "sep",
        });

        return;
      }
      const layout = this.state.layout;
      const pos = this._nextPos();
      // inside a popup, "available width" is not known up front; span current
      // content width (min 80) instead of the 4000px popup sentinel
      const w = this.state.popupLayoutActive
        ? Math.max(80, layout.contentRight)
        : Math.max(0, layout.avail.w - layout.x - layout.indent);
      const item = this._item(
        pos.x,
        pos.y,
        w,
        1,
        hashPair(this.state.idStackSeed, 0x5a5a5a5c),
        {
          focusable: false,
        },
      );

      if (item.visible)
        this.renderer.line(
          pos.x,
          pos.y + 0.5,
          pos.x + w,
          pos.y + 0.5,
          this._col("separator"),
          1,
        );
      this._advance(pos.x, pos.y, w, 1 + this._var("itemSpacing")[1]);
    }
    /**
     * Draws a separator line with a small label centered on it.
     * @param {string} label
     */
    separatorText(label) {
      const pos = this._nextPos();
      const layout = this.state.layout;
      const w = this.state.popupLayoutActive
        ? Math.max(80, layout.contentRight)
        : Math.max(0, layout.avail.w - layout.x - layout.indent);
      const lineH = this._lineH();
      const item = this._item(
        pos.x,
        pos.y,
        w,
        lineH + 6,
        hashPair(this.state.idStackSeed, 0x5a5a5a5d),
        {
          focusable: false,
        },
      );

      if (item.visible) {
        const fontOptions = this._fo();
        this.renderer.line(
          pos.x,
          pos.y + lineH / 2 + 3,
          pos.x + w,
          pos.y + lineH / 2 + 3,
          this._col("separator"),
          1,
        );
        this._drawText(
          pos.x + 6,
          pos.y,
          label,
          this._col("textDisabled"),
          fontOptions,
        );
      }
      this._advance(pos.x, pos.y, w, lineH + 6);
    }

    /**
     * Starts a group: layout runs from a local origin so the elements that
     *   * follow can be treated as one item (lastItemRect(), ...).
     * @returns {Object} the group's start {x, y}
     */
    beginGroup() {
      const layout = this.state.layout;
      const snap = Object.assign({}, layout, {
        origin: {
          ...layout.origin,
        },
        scroll: {
          ...layout.scroll,
        },
      });
      this.state.savedLayout.push(snap);
      const itemSpacing = this._var("itemSpacing");
      let contentX = snap.x + snap.indent,
        contentY = snap.y;

      if (snap.lineActive && snap.sameLine) {
        const sl = snap.sameLine;
        contentX =
          sl.offset != null
            ? snap.lineStartX + sl.offset
            : snap.prevRight +
              (sl.spacing != null ? sl.spacing : itemSpacing[0]);
        contentY = snap.lineY;
      }
      this.state.groupStart = {
        x: snap.origin.x + contentX - snap.scroll.x,
        y: snap.origin.y + contentY - snap.scroll.y,
        contentX,
        contentY,
        contentRight0: snap.contentRight,
        lineActive0: snap.lineActive,
        newLine: (snap.lineActive && !snap.sameLine) || !snap.lineActive,
      };
      // the group is a layout region: its content width starts at its own
      // anchor (a full-width item drawn BEFORE the group must not inflate it)
      layout.contentRight = contentX;

      return {
        x: this.state.groupStart.x,
        y: this.state.groupStart.y,
      };
    }
    /**
     * Ends the current group.
     * @returns {Object|null} the group's combined screen rect {x, y, w, h} (null when no group is open)
     */
    endGroup() {
      const layout = this.state.layout;
      const g = this.state.groupStart;

      if (!layout || !g || !this.state.savedLayout.length) {
        return null;
      }
      const w = Math.max(0, layout.contentRight - g.contentX);
      const h = Math.max(0, layout.y - g.contentY);
      const prev = this.state.savedLayout.pop();
      this.state.layout = prev;
      // the group is an ITEM on the line it started on: the line bookkeeping
      // continues past it, so sameLine() after endGroup() places the next
      // element to the right of the group. (A pending request made BEFORE the
      // group was consumed by the group itself — it never leaks out.)

      if (g.newLine) {
        prev.lineStartX = g.contentX;
      }
      prev.lineY = g.contentY; // the group's top is its line top for sameLine purposes
      prev.lineActive = true;
      prev._same = false;
      prev.sameLine = null;
      prev.lineBottom = Math.max(prev.lineBottom, g.contentY + h);
      prev.prevRight = g.contentX + w;
      prev.y = g.contentY + h;
      prev.contentRight = Math.max(g.contentRight0, g.contentX + w);

      return {
        x: g.x,
        y: g.y,
        w,
        h,
      };
    }

    /**
     * Starts a disabled region: everything inside is drawn greyed out and
     *   * ignores input. Pair with endDisabled().
     */
    beginDisabled() {
      this.state.disabledCount++;
    }
    /**
     * Ends a disabled region started with beginDisabled().
     */
    endDisabled() {
      this.state.disabledCount = Math.max(0, this.state.disabledCount - 1);
    }

    /* ---------------------------- windows ------------------------------ */

    /**
     * Sets the screen position used by the next beginWindow() call.
     * @param {number} x
     * @param {number} y
     */
    setNextWindowPos(x, y) {
      this.state.nextWindowPos = {
        x,
        y,
      };
    }
    /**
     * Sets the size used by the next beginWindow() call.
     * @param {number} w
     * @param {number} h
     */
    setNextWindowSize(w, h) {
      this.state.nextWindowSize = {
        w,
        h,
      };
    }
    /**
     * The internal window object for the title (position, size, open state),
     *   * or null when the window does not exist. Read-only inspection; its fields
     *   * are internal.
     * @param {string} title
     * @returns {Object|null}
     */
    getWindow(title) {
      return this.state.windows.get(title) || null;
    }
    /**
     * True when the window is open. A title that was never created (and has
     *   * no persisted state) counts as open: windows are created lazily on their
     *   * first beginWindow().
     * @param {string} title
     * @returns {boolean}
     */
    isWindowOpen(title) {
      const w = this.state.windows.get(title);

      if (w) {
        return w.open;
      }
      const st = this.state.windowStates.get(title);

      return st ? st.open !== false : true;
    }
    /**
     * Opens or closes a window by title (takes effect on the window's next
     *   * beginWindow()).
     * @param {string} title
     * @param {boolean} open
     */
    setWindowOpen(title, open) {
      const w = this.state.windows.get(title);

      if (w) {
        w.open = !!open;
      }
    }

    /* ---------------------------- docking ------------------------------ */
    /* Join two windows into one combined, resizable container with a
     * draggable divider. `dir: 'h'` (default) lays A left of B (split
     * vertically); 'v' lays A above B. The combined rect moves/resizes as a
     * whole; the divider sets the split ratio. Either window undocks back to
     * an independent window (keeping its current sub-rect).
     *
     * Without an explicit `pos`/`size`, the combined window's size is the
     * sum of both windows' sizes in the dock direction (horizontal join:
     * width = A.w + B.w; vertical join: height = A.h + B.h); the other
     * dimension takes the larger window's size, anchored on it.
     *
     * EDGE COMBINATION: if one of the windows is globally docked (a screen-
     * edge stack unit), the combined window is formed INSIDE that edge
     * stack — it stays globally docked as one unit, its dimension along the
     * screen edge is the docked window's (a left-docked pair is both the
     * column's width, a top-docked pair both the row's height), NOT the sum
     * of both windows, and the split direction is forced so both members
     * span the full docked width/height. `pos`/`size`/`dir` are then
     * controlled by the stack. (This is also what happens when a window is
     * dropped onto a globally docked one with the drag join grid.) */

    _dockKeyFor(a, b) {
      const la = typeof a === "string" ? a : (a && a.title) || "";
      const lb = typeof b === "string" ? b : (b && b.title) || "";

      return la < lb ? la + "\x01" + lb : lb + "\x01" + la;
    }
    _findDock(a, b) {
      const guiState = this.state;

      if (a == null || b == null) {
        // single label: find the dock containing it
        const la = typeof a === "string" ? a : (a && a.title) || "";

        for (const D of guiState.docks.values())
          if ((D.a && D.a.title === la) || (D.b && D.b.title === la)) {
            return D;
          }

        return null;
      }

      return guiState.docks.get(this._dockKeyFor(a, b)) || null;
    }
    /**
     * Joins windows a and b into a single dock: one frame, two panes, a
     *   * draggable split divider and a shared title bar. The join is lazy: the
     *   * dock is created on the first frame both windows are open.
     *   * @param {string} a  title of the first window
     *   * @param {string} b  title of the second window
     * @param {Object} [opts] { dir: 'h' (side by side, default) | 'v' (stacked),
     ratio: 0.12..0.88 fraction taken by the first member, pos/size: dock
     rect, title: dock title }
     */
    dock(a, b, opts) {
      opts = opts || {};
      const guiState = this.state;
      const la = typeof a === "string" ? a : a && a.title;
      const lb = typeof b === "string" ? b : b && b.title;

      if (!la || !lb) {
        return null;
      }
      const wa = guiState.windows.get(la),
        wb = guiState.windows.get(lb);

      if (!wa || !wb || wa === wb) {
        guiState.pendingDocks.push([la, lb, opts]); // applied once both exist

        return null;
      }

      if (wa.noDock || wb.noDock) {
        return null; // the window refuses docking
      }

      return this._makeDock(la, lb, opts);
    }
    _makeDock(la, lb, opts) {
      const guiState = this.state;
      let wa = guiState.windows.get(la),
        wb = guiState.windows.get(lb);

      if (!wa || !wb || wa === wb) {
        return null;
      }

      if (wa.noDock || wb.noDock) {
        return null; // the window refuses docking
      }
      // Edge combination: when one (or both) of the windows is globally
      // docked on the SAME edge, the combined window stays inside that edge
      // stack as a single unit. The stack's unit id is member A's title, so
      // the edge-docked window becomes A.
      let combEdge = null;

      if (wa._edge && wb._edge) {
        if (wa._edge === wb._edge) {
          combEdge = wa._edge;
        }
      } else if (wa._edge) {
        combEdge = wa._edge;
      } else if (wb._edge) combEdge = wb._edge;

      if (combEdge && wa._edge !== combEdge && wb._edge === combEdge) {
        const tw = wa;
        wa = wb;
        wb = tw;
        const tl = la;
        la = lb;
        lb = tl;
      }

      if (!combEdge) {
        if (wa._edge) {
          this._removeFromEdge(wa); // joining a dock leaves the edge stack
        }

        if (wb._edge) {
          this._removeFromEdge(wb);
        }
      }
      const key = this._dockKeyFor(la, lb);
      const dock = {
        key,
        a: wa,
        b: wb,
        dir: opts.dir === "v" || opts.vertical ? "v" : "h",
        ratio: clamp(opts.ratio == null ? 0.5 : opts.ratio, 0.12, 0.88),
        x: wa.x,
        y: wa.y,
        w: wa.w,
        h: wa.h,
        minW: 200,
        minH: 140,
        collapsed: false,
        title: opts.title || null,
        defaultX: wa.x,
        defaultY: wa.y,
        frame: guiState.frameId,
      };

      if (opts.pos) {
        dock.x = opts.pos[0];
        dock.y = opts.pos[1];
      } else {
        dock.x = Math.min(wa.x, wb.x);
        dock.y = Math.min(wa.y, wb.y);
      }

      if (opts.size) {
        dock.w = opts.size[0];
        dock.h = opts.size[1];
      } else if (dock.dir === "h") {
        // combined width = both windows' widths added together; the height
        // takes the taller window's size (anchored on it, so it keeps its
        // position)
        dock.w = wa.w + wb.w;
        dock.h = Math.max(wa.h, wb.h);

        if (!opts.pos) {
          dock.y = wa.h >= wb.h ? wa.y : wb.y;
        }
      } else {
        // combined height = both windows' heights added together; the width
        // takes the wider window's size (anchored on it)
        dock.h = wa.h + wb.h;
        dock.w = Math.max(wa.w, wb.w);

        if (!opts.pos) {
          dock.x = wa.w >= wb.w ? wa.x : wb.x;
        }
      }

      if (combEdge) {
        // EDGE COMBINATION (round-7 rule): the combined window keeps the
        // docked window's dimension ALONG the screen edge — a left/right
        // docked pair is both the column's width, a top/bottom pair both
        // the row's height — NOT the sum of both windows like a free dock.
        // The other dimension adds both windows (so each keeps its full
        // size), and the split direction is forced so both members span the
        // full docked width/height. The dock becomes the stack's unit; its
        // slot grows by the newcomer's along-size.
        const E = guiState.edgeDocks[combEdge];
        const horiz = combEdge === "top" || combEdge === "bottom";
        const R = E && E._rect;
        const n = E ? E.wins.length : 1;
        const span = R
          ? horiz
            ? R.colW
            : R.colH
          : horiz
            ? wa.w + wb.w
            : wa.h + wb.h;
        const share = Math.max(20, Math.max(20, span - 12) - 4 * (n - 1));
        const alongW = horiz ? wa.w : wa.h;
        const alongX = horiz ? wb.w : wb.h;
        dock.dir = horiz ? "h" : "v";
        dock.ratio = clamp(alongW / (alongW + alongX), 0.12, 0.88);
        dock.x = wa.x;
        dock.y = wa.y;

        if (horiz) {
          dock.w = alongW + alongX;
          dock.h = wa.h;
        } else {
          dock.w = wa.w;
          dock.h = alongW + alongX;
        }
        dock.defaultX = dock.x;
        dock.defaultY = dock.y;
        dock._edge = combEdge;
        wa._edge = combEdge;
        wb._edge = combEdge;

        if (E) {
          E.fracs[wa.title] = (E.fracs[wa.title] || 1) + alongX / share;
        }
      }
      wa._dockKey = key;
      wb._dockKey = key;
      guiState.docks.set(key, dock);

      return dock;
    }
    _freeDockedMember(w) {
      if (!w) {
        return;
      }
      w._dockKey = null;
      w._dock = null;
      w._edge = null;
      w.sizedOnce = true;
      w.movable = true;
      w.resizable = !w.fixedSize && !w.autoResize;
      w.collapsible = !w.noTitleBar;
    }
    /**
     * Splits the dock of a and b back into two independent windows (each
     *   * keeps the sub-rect it occupied).
     * @param {string} a
     * @param {string} b
     * @returns {boolean} true if a dock was split
     */
    undock(a, b) {
      const guiState = this.state;
      const dock = this._findDock(a, b);

      if (!dock) {
        return false;
      }
      // each member keeps its current sub-rect as its own window rect
      this._freeDockedMember(dock.a);
      this._freeDockedMember(dock.b);
      guiState.docks.delete(dock.key);

      return true;
    }
    /* Free a single member of a dock: the member and its sibling (which keeps
     * its own sub-rect) become free windows and the dock is removed. This is
     * what dragging a member's slim header out of the dock does. */
    _undockMember(win) {
      const guiState = this.state;

      if (!win || !win._dockKey) {
        return;
      }
      const dock = guiState.docks.get(win._dockKey);

      if (!dock) {
        win._dockKey = null;
        win._dock = null;

        return;
      }
      const other = dock.a === win ? dock.b : dock.a;
      this._freeDockedMember(win);

      if (other) {
        this._freeDockedMember(other);
      }
      guiState.docks.delete(dock.key);
    }
    /**
     * True when a and b are currently members of the same dock.
     * @param {string} a
     * @param {string} b
     * @returns {boolean}
     */
    isDocked(a, b) {
      return !!this._findDock(a, b);
    }
    /**
     * All active docks, as plain objects.
     * @returns {Array} [{ id, a, b, dir, ratio, x, y, w, h, collapsed }] with a/b = member titles
     */
    getDocks() {
      return Array.from(this.state.docks.values()).map((D) => ({
        id: D.key,
        a: D.a ? D.a.title : null,
        b: D.b ? D.b.title : null,
        dir: D.dir,
        ratio: D.ratio,
        x: D.x,
        y: D.y,
        w: D.w,
        h: D.h,
        collapsed: D.collapsed,
      }));
    }
    /**
     * Sets the split ratio of the dock containing a and b (0.12..0.88, the
     *   * fraction taken by the first member).
     * @param {string} a
     * @param {string} b
     * @param {number} ratio
     * @returns {boolean} true if the dock exists
     */
    setDockRatio(a, b, ratio) {
      const dock = this._findDock(a, b);

      if (dock) {
        dock.ratio = clamp(ratio, 0.12, 0.88);
      }

      return !!dock;
    }

    /* Collapse a whole dock to just its combined title bar (hiding both
     * members); pass false to restore. The title bar carries a chevron that
     * toggles this, and an expand/close control while collapsed. */
    setDockCollapsed(a, b, collapsed) {
      const dock = this._findDock(a, b);

      if (!dock) {
        return false;
      }
      dock.collapsed = !!collapsed;

      return true;
    }
    /**
     * True when the dock of a and b is collapsed to just its title bar.
     * @param {string} a
     * @param {string} b
     * @returns {boolean}
     */
    isDockCollapsed(a, b) {
      const dock = this._findDock(a, b);

      return !!(dock && dock.collapsed);
    }

    /* ------------------------- window context menus --------------------- */
    /* Right-click a window title bar, a combined dock title bar, or a dock
     * member's slim header for a small menu holding only the operations the
     * window's flags/state currently allow: collapse/expand, undock, reset
     * position, close. Gated by the `windowContextMenu` flag. The menu is a
     * regular system popup: outside clicks dismiss it, a second right-click
     * on the same header toggles it closed. */
    _windowContextMenu(win) {
      const guiState = this.state;
      const id = "winctx:" + (win.idHash || fnv1a(win.title));
      const existing = guiState.popups.get(id);

      if (existing && existing.open) {
        existing.open = false;

        return this;
      }
      const mouse = guiState.mouse;
      const items = [];

      if (win.collapsible)
        items.push({
          label: win.collapsed ? "Expand" : "Collapse",
          onActivated: () => {
            win.collapsed = !win.collapsed;
            win._collapseToggledAt = guiState.frameId;
          },
        });

      if (win._edge)
        items.push({
          label: "Undock from screen edge",
          onActivated: () => this.undockEdge(win.title),
        });

      if (this.flags.windowDoubleReset && !win._edge)
        items.push({
          label: "Reset position",
          onActivated: () => {
            win.x = win.defaultX;
            win.y = win.defaultY;
          },
        });

      if (win.closable)
        items.push({
          label: "Close",
          onActivated: () => {
            win.open = false;

            if (typeof win.onClose === "function") {
              win.onClose();
            }
          },
        });

      if (items.length)
        this._openPopup(
          id,
          {
            x: mouse.x,
            y: mouse.y,
          },
          {
            type: "menu",
            items,
          },
          fnv1a(win.title),
          win,
        );

      return this;
    }
    _dockContextMenu(D) {
      const guiState = this.state;
      const id = "dockctx:" + D.key;
      const existing = guiState.popups.get(id);

      if (existing && existing.open) {
        existing.open = false;

        return this;
      }
      const mouse = guiState.mouse;
      const items = [
        {
          label: D.collapsed ? "Expand" : "Collapse",
          onActivated: () => {
            D.collapsed = !D.collapsed;
          },
        },
      ];

      for (const m of [D.a, D.b]) {
        if (m && m.open !== false)
          items.push({
            label: "Undock: " + m.title,
            onActivated: () => this._undockMember(m),
          });
      }
      items.push({
        type: "sep",
      });
      items.push({
        label: "Close",
        onActivated: () => {
          if (D.a) {
            D.a.open = false;
            this._freeDockedMember(D.a);
          }

          if (D.b) {
            D.b.open = false;
            this._freeDockedMember(D.b);
          }
          guiState.docks.delete(D.key);
        },
      });
      this._openPopup(
        id,
        {
          x: mouse.x,
          y: mouse.y,
        },
        {
          type: "menu",
          items,
        },
        fnv1a(D.key),
        D.a || D.b,
      );

      return this;
    }
    _memberContextMenu(win) {
      const guiState = this.state;
      const id = "memctx:" + (win.idHash || fnv1a(win.title));
      const existing = guiState.popups.get(id);

      if (existing && existing.open) {
        existing.open = false;

        return this;
      }
      const mouse = guiState.mouse;
      const items = [];

      if (win.collapsible)
        items.push({
          label: win.collapsed ? "Expand" : "Collapse",
          onActivated: () => {
            win.collapsed = !win.collapsed;
          },
        });
      items.push({
        label: "Undock",
        onActivated: () => this._undockMember(win),
      });
      this._openPopup(
        id,
        {
          x: mouse.x,
          y: mouse.y,
        },
        {
          type: "menu",
          items,
        },
        fnv1a(win.title),
        win,
      );

      return this;
    }

    /* ------------------------ screen-edge docks ------------------------- */
    /* Dock a window — or a whole dock (combined window) — to a screen edge.
     * The edge holds a stack of units sharing one column (left/right edges,
     * stacked vertically) or row (top/bottom edges, laid out horizontally);
     * each unit keeps a frac of the space. A unit is either a plain window
     * or a DOCK: passing a dock member's title docks the entire combined
     * window as one unit (dragging a dock onto a screen edge / the
     * screen-center grid does the same). Edge units are non-movable/
     * non-resizable (double-click a dock's title bar or call undockEdge()
     * to take it back — a docked dock comes back as a FREE dock, keeping
     * its combination); the gaps between units are draggable (resplit) and
     * the stack's INNER edge (the side facing away from the screen edge) is
     * draggable — a resize bar fades in when the cursor is within
     * `flags.resizeBarProximity` px of it — to scale the whole stack along
     * the dock direction only. Stacks never cover each other: left/right
     * columns own the full screen height, and top/bottom rows are laid out
     * in the space between them. */
    dockToEdge(a, edge) {
      const guiState = this.state;

      if (
        edge !== "top" &&
        edge !== "bottom" &&
        edge !== "left" &&
        edge !== "right"
      ) {
        return null;
      }
      const w = typeof a === "string" ? guiState.windows.get(a) : a;

      if (!w || w.noDock) {
        return null;
      }

      if (w._dockKey) {
        // a dock member: the WHOLE combined window is docked as one unit of
        // the edge stack (the stack identifies the unit by member A's title)
        const dock = guiState.docks.get(w._dockKey);

        if (!dock || !dock.a || !dock.b) {
          return null;
        }

        if (
          dock.a.noDock ||
          dock.b.noDock ||
          dock.a.open === false ||
          dock.b.open === false
        )
          return null;
        this._removeEdgeUnit(dock);
        const E =
          guiState.edgeDocks[edge] ||
          (guiState.edgeDocks[edge] = {
            wins: [],
            fracs: {},
          });
        const horiz = edge === "top" || edge === "bottom";

        if (!E.size) {
          E.size = horiz ? clamp(dock.h, 110, 300) : clamp(dock.w, 180, 420);
        }

        if (E.wins.indexOf(dock.a.title) < 0) {
          E.wins.push(dock.a.title);
          const n = E.wins.length;
          let total = 0;

          for (const t of E.wins) total += E.fracs[t] || 0;

          for (const t of E.wins) if (!(t in E.fracs)) E.fracs[t] = 1;
          // the newcomer (whole dock) takes an equal average share
          E.fracs[dock.a.title] = n > 1 ? total / (n - 1) : 1;
        }
        dock._edge = edge;
        dock.a._edge = edge;
        dock.b._edge = edge;
        dock.a.open = true;
        dock.b.open = true;

        return E;
      }
      this._removeFromEdge(w);
      const E =
        guiState.edgeDocks[edge] ||
        (guiState.edgeDocks[edge] = {
          wins: [],
          fracs: {},
        });
      const horiz = edge === "top" || edge === "bottom";

      if (!E.size) {
        E.size = horiz ? clamp(w.h, 110, 300) : clamp(w.w, 180, 420);
      }
      E.wins.push(w.title);
      const n = E.wins.length;
      let total = 0;

      for (const t of E.wins) total += E.fracs[t] || 0;

      for (const t of E.wins) if (!(t in E.fracs)) E.fracs[t] = 1;
      // the newcomer takes an equal average share of the stack
      E.fracs[w.title] = n > 1 ? total / (n - 1) : 1;
      w.open = true;

      return E;
    }
    /**
     * Removes a window (or a combined window) from its screen-edge stack,
     *   * freeing it as a free window at its current rect.
     * @param {string} a title (of the unit, or of any member of a combined unit)
     * @returns {boolean} true if it was edge-docked
     */
    undockEdge(a) {
      const guiState = this.state;
      const w = typeof a === "string" ? guiState.windows.get(a) : a;

      if (!w || !w._edge) {
        return false;
      }

      if (w._dockKey) {
        const dock = guiState.docks.get(w._dockKey);

        if (dock && (dock._edge || dock.a._edge || dock.b._edge)) {
          // a docked dock: the whole combined window leaves the edge stack
          // and survives as a FREE dock at its current slot rect
          this._removeEdgeUnit(dock);

          return true;
        }
      }
      this._removeFromEdge(w);
      w.movable = true;
      w.resizable =
        !w.fixedSize && !w.autoResize && !(w.flags & WindowFlags.NoResize);

      return true;
    }
    /* Remove an edge-docked DOCK (one stack unit) from its stack. */
    _removeEdgeUnit(D) {
      const guiState = this.state;
      const edge = D._edge || (D.a && D.a._edge) || (D.b && D.b._edge);

      if (!edge) {
        D._edge = null;

        if (D.a) {
          D.a._edge = null;
        }

        if (D.b) {
          D.b._edge = null;
        }

        return;
      }
      const E = guiState.edgeDocks[edge];

      if (E) {
        const i = E.wins.indexOf(D.a.title);

        if (i >= 0) {
          E.wins.splice(i, 1);
        }
        delete E.fracs[D.a.title];

        if (!E.wins.length) {
          guiState.edgeDocks[edge] = null;
        }
      }
      D._edge = null;

      if (D.a) {
        D.a._edge = null;
      }

      if (D.b) {
        D.b._edge = null;
      }
    }
    _removeFromEdge(w) {
      const guiState = this.state;

      if (!w._edge) {
        return;
      }
      const E = guiState.edgeDocks[w._edge];

      if (E) {
        const i = E.wins.indexOf(w.title);

        if (i >= 0) {
          E.wins.splice(i, 1);
        }
        delete E.fracs[w.title];

        if (!E.wins.length) {
          guiState.edgeDocks[w._edge] = null;
        }
      }
      w._edge = null;
    }

    /* Per-frame screen-edge work: drop dead entries, apply in-flight
     * boundary/column drags, lay the stack out, and start new drags. */
    _edgeDocksFrame(s, mo) {
      const am = s.appMenu;
      const W = s.displayW,
        H = s.displayH;
      // left/right columns own the full screen height; top/bottom rows are
      // laid out in the space between them, so edge stacks never cover each
      // other (a newly docked window shifts its stack, not the existing one)
      const leftW = s.edgeDocks.left ? s.edgeDocks.left.size : 0;
      const rightW = s.edgeDocks.right ? s.edgeDocks.right.size : 0;

      for (const edge of ["top", "bottom", "left", "right"]) {
        const E = s.edgeDocks[edge];

        if (!E) {
          continue;
        }
        // closed windows leave the stack (and are freed); windows that are
        // mid-join into a normal dock are handed over to the dock. A DOCK is
        // one unit of the stack, identified by member A's title — valid only
        // while the dock itself is edge-docked.
        E.wins = E.wins.filter((t) => {
          const w = s.windows.get(t);

          if (!w) {
            return false;
          }

          if (w._dockKey) {
            const dock = s.docks.get(w._dockKey);

            if (!dock || !dock._edge || dock.a.title !== t) {
              return false;
            }

            if (dock.a.open === false || dock.b.open === false) {
              dock._edge = null;
              dock.a._edge = null;
              dock.b._edge = null;

              return false;
            }

            return true;
          }

          if (w.open === false) {
            w._edge = null;

            return false;
          }

          return true;
        });

        if (!E.wins.length) {
          s.edgeDocks[edge] = null;
          continue;
        }
        const horiz = edge === "top" || edge === "bottom";
        const n = E.wins.length;
        let x0, y0, colW, colH;

        if (edge === "left") {
          x0 = am && am.pos === "left" ? am.sideWidth : 0;
          y0 = am && am.pos === "top" ? am.thickness : 0;
          colW = E.size;
          colH = H - y0 - (am && am.pos === "bottom" ? am.thickness : 0);
        } else if (edge === "right") {
          const bar = am && am.pos === "right" ? am.sideWidth : 0;
          x0 = W - bar - E.size;
          y0 = am && am.pos === "top" ? am.thickness : 0;
          colW = E.size;
          colH = H - y0 - (am && am.pos === "bottom" ? am.thickness : 0);
        } else if (edge === "top") {
          y0 = am && am.pos === "top" ? am.thickness : 0;
          // inset between the left/right columns so the row never covers them
          x0 = (am && am.pos === "left" ? am.sideWidth : 0) + leftW;
          colH = E.size;
          colW = Math.max(
            40,
            W -
              (am && am.pos === "left" ? am.sideWidth : 0) -
              leftW -
              (am && am.pos === "right" ? am.sideWidth : 0) -
              rightW,
          );
        } else {
          const bar = am && am.pos === "bottom" ? am.thickness : 0;
          y0 = H - bar - E.size;
          x0 = (am && am.pos === "left" ? am.sideWidth : 0) + leftW;
          colH = E.size;
          colW = Math.max(
            40,
            W -
              (am && am.pos === "left" ? am.sideWidth : 0) -
              leftW -
              (am && am.pos === "right" ? am.sideWidth : 0) -
              rightW,
          );
        }
        E._rect = {
          x0,
          y0,
          colW,
          colH,
        };

        // apply an in-flight boundary/column drag
        const d = s.drag;

        if (d && d.edgeDock === edge && this.isMouseDown(0))
          if (d.type === "edge-split") {
            // absolute from the drag's press-time snapshot — applying the
            // delta to the live fraction each frame would re-add it and keep
            // scaling while the mouse is held. The mouse delta is mapped
            // through the normalized fractions (x sum / share) so the
            // boundary follows the cursor 1:1 and stays where released.
            const delta =
              ((horiz ? mo.x - d.p0 : mo.y - d.p0) * d.sum) /
              Math.max(1, d.share);
            const ni = clamp(d.f0 + delta, 0.04, d.total - 0.04);
            E.fracs[E.wins[d.i]] = ni;
            E.fracs[E.wins[d.i + 1]] = d.total - ni;
            this._setCursor(horiz ? "ew-resize" : "ns-resize", 2);
          } else if (d.type === "edge-resize") {
            if (edge === "left") {
              E.size = clamp(mo.x - x0, 140, W * 0.65);
            } else if (edge === "right")
              E.size = clamp(
                W - (am && am.pos === "right" ? am.sideWidth : 0) - mo.x,
                140,
                W * 0.65,
              );
            else if (edge === "top") E.size = clamp(mo.y - y0, 100, H * 0.6);
            else
              E.size = clamp(
                H - (am && am.pos === "bottom" ? am.thickness : 0) - mo.y,
                100,
                H * 0.6,
              );
            this._setCursor(horiz ? "ns-resize" : "ew-resize", 2);
          }

        // lay the stack out
        const pad = 6,
          gap = 4;
        const totalGap = gap * (n - 1);
        const avail = Math.max(20, (horiz ? colW : colH) - pad * 2);
        const share = Math.max(20, avail - totalGap);
        let sum = 0;

        for (const t of E.wins) sum += E.fracs[t] || 0;

        if (sum <= 0) {
          for (const t of E.wins) E.fracs[t] = 1;
          sum = n;
        }
        E._bounds = [];
        let off = 0;

        for (let i = 0; i < n; i++) {
          const w = s.windows.get(E.wins[i]);

          if (!w) {
            continue;
          }
          const sz = Math.max(
            28,
            Math.round(((E.fracs[E.wins[i]] || 0) / sum) * share),
          );

          if (w._dock && w._dock._edge === edge) {
            // a combined window (dock) as one unit: the stack owns the
            // dock's outer rect; its members sub-layout as usual
            const dock = w._dock;

            if (horiz) {
              dock.x = x0 + pad + off;
              dock.y = y0 + pad;
              dock.w = sz;
              dock.h = colH - pad * 2;
            } else {
              dock.x = x0 + pad;
              dock.y = y0 + pad + off;
              dock.w = colW - pad * 2;
              dock.h = sz;
            }
            dock._edge = edge;
            dock.a._edge = edge;
            dock.b._edge = edge;
          } else {
            w._edge = edge;
            w.minW = 24;
            w.minH = 24; // edge windows may shrink below normal minimums

            if (horiz) {
              w.x = x0 + pad + off;
              w.y = y0 + pad;
              w.w = sz;
              w.h = colH - pad * 2;
            } else {
              w.x = x0 + pad;
              w.y = y0 + pad + off;
              w.w = colW - pad * 2;
              w.h = sz;
            }
          }
          off += sz;

          if (i < n - 1) {
            E._bounds.push(
              horiz
                ? {
                    i,
                    x: x0 + pad + off - 3,
                    y: y0 + 1,
                    w: gap + 6,
                    h: colH - 2,
                  }
                : {
                    i,
                    x: x0 + 1,
                    y: y0 + pad + off - 3,
                    w: colW - 2,
                    h: gap + 6,
                  },
            );
            off += gap;
          }
        }

        // start boundary / inner-edge drags + hover cursors. The bands only
        // claim input when NOTHING is painted over the point — a window or
        // popup covering the band is the topmost element and wins (input
        // must never travel through a window to the stack below it).
        const canDrag =
          !s.drag &&
          !s.appBarGrab &&
          s.disabledCount === 0 &&
          !this._popupAtPoint(mo.x, mo.y) &&
          !s.hoveredWindow; // hoveredWindow is null only when no window (or open modal) is under the cursor

        for (const b of E._bounds) {
          if (pointInRect(mo.x, mo.y, b)) {
            if (canDrag && this.isMouseClicked(0) && s.activeId === 0) {
              const fi0 = E.fracs[E.wins[b.i]] || 0.5;
              const fj0 = E.fracs[E.wins[b.i + 1]] || 0.5;
              let sumAll = 0;

              for (const t of E.wins) sumAll += E.fracs[t] || 0;
              s.drag = {
                type: "edge-split",
                edgeDock: edge,
                i: b.i,
                p0: horiz ? mo.x : mo.y,
                share,
                f0: fi0,
                total: fi0 + fj0,
                sum: Math.max(1e-6, sumAll),
              };
              s.activeId = -1;
            } else if (!s.drag) {
              this._setCursor(horiz ? "ew-resize" : "ns-resize", 1);
            }
            break;
          }
        }
        // inner-edge resize, same method as window side scaling: a
        // proximity band (resizeBarProximity px) on the side facing AWAY
        // from the screen edge (left-docked stacks resize from their right
        // side, top-docked from their bottom, ...) along the stack's span,
        // changing only the dock-direction dimension. A small bar fades in
        // over the inner edge (see _drawEdgeResizeBars).
        const N = Math.max(2, Math.floor(this.flags.resizeBarProximity || 8));
        const inInnerBand =
          edge === "left" || edge === "right"
            ? (edge === "left"
                ? mo.x >= x0 + colW - N && mo.x <= x0 + colW + N
                : mo.x >= x0 - N && mo.x <= x0 + N) &&
              mo.y >= y0 &&
              mo.y <= y0 + colH
            : (edge === "top"
                ? mo.y >= y0 + colH - N && mo.y <= y0 + colH + N
                : mo.y >= y0 - N && mo.y <= y0 + N) &&
              mo.x >= x0 &&
              mo.x <= x0 + colW;
        const resizing = d && d.edgeDock === edge && d.type === "edge-resize";
        // bar + cursor only while the band is the topmost thing at the
        // point (a covering window/popup takes the interaction instead);
        // an in-flight edge-resize drag keeps its bar regardless
        const bandLive = inInnerBand && !s.hoveredWindow; // hoveredWindow is null only when no window (or open modal) is under the cursor

        if (resizing) {
          E._barT = 1;
        } else if (bandLive)
          E._barT = this.flags.animations
            ? Math.min(1, (E._barT || 0) + s.dt / 0.12)
            : 1;
        else
          E._barT = this.flags.animations
            ? Math.max(0, (E._barT || 0) - s.dt / 0.12)
            : 0;

        if (bandLive)
          if (canDrag && this.isMouseClicked(0) && s.activeId === 0) {
            s.drag = {
              type: "edge-resize",
              edgeDock: edge,
            };
            s.activeId = -1;
          } else if (!s.drag) {
            this._setCursor(horiz ? "ns-resize" : "ew-resize", 1);
          }
      }
    }
    /* Fade-in resize bars over the inner edges of screen-edge stacks (the
     * visual half of the proximity band in _edgeDocksFrame). */
    _drawEdgeResizeBars() {
      const guiState = this.state;

      for (const edge of ["left", "right", "top", "bottom"]) {
        const E = guiState.edgeDocks[edge];

        if (!E || !E._barT || !E._rect) {
          continue;
        }
        const R = E._rect;
        const bw = 4;
        const horiz = edge === "top" || edge === "bottom";
        const span = horiz ? R.colW : R.colH;
        const len = Math.max(24, Math.min(64, span * 0.35));
        const fill = withAlpha(
          this._col("sliderGrab"),
          Math.round(230 * E._barT),
        );
        const lineC = withAlpha(this._col("border"), Math.round(140 * E._barT));
        let x, y, w, h;

        if (edge === "left") {
          x = R.x0 + R.colW - bw / 2;
          y = R.y0 + R.colH / 2 - len / 2;
          w = bw;
          h = len;
        } else if (edge === "right") {
          x = R.x0 - bw / 2;
          y = R.y0 + R.colH / 2 - len / 2;
          w = bw;
          h = len;
        } else if (edge === "top") {
          x = R.x0 + R.colW / 2 - len / 2;
          y = R.y0 + R.colH - bw / 2;
          w = len;
          h = bw;
        } else {
          x = R.x0 + R.colW / 2 - len / 2;
          y = R.y0 - bw / 2;
          w = len;
          h = bw;
        }
        this.renderer.fillRoundedRect(x, y, w, h, 2, fill);
        this.renderer.strokeRoundedRect(
          x + 0.5,
          y + 0.5,
          w - 1,
          h - 1,
          2,
          lineC,
          1,
        );
      }
    }

    /* ------------------- interactive docking hints ---------------------- */
    /* While a window is dragged (flags.docking on): show a 4-way join grid
     * over the target window under the cursor (drop joins the two — the
     * hovered part sets dir/order, center cancels), otherwise the screen-
     * edge band under the cursor (drop docks the window to that edge). */
    _dockHintUpdate(s, mo) {
      s._dockHint = null;
      const d = s.drag;

      if (
        !d ||
        (d.type !== "win-move" && d.type !== "dock-move") ||
        !this.flags.docking
      ) {
        return;
      }
      // a dock (combined window) is draggable onto screen edges too — it
      // joins the stack as one unit; the window join grid is window-only
      const w = d.type === "win-move" ? d.win : d.dock && d.dock.a;

      if (!w) {
        return;
      }

      if (d.type === "win-move") {
        if (w.noDock || w._edge) {
          return;
        }
      } else if (w.noDock || (d.dock.b && d.dock.b.noDock)) {
        return;
      }
      const W = s.displayW,
        H = s.displayH,
        B = 44;
      // 1) the screen-center dock grid (a square of four direction
      //    triangles): the triangle under the cursor is active; dropping on
      //    it docks the dragged window to that screen edge. The center apex
      //    has no direction, so dropping there is a plain drop. The global
      //    docking UI is treated as always-on-top: it claims the cursor
      //    even when a window sits under it. With dockHitGenerous the
      //    selectable area extends beyond the drawn square.
      const sp = this._dockGridParts(W / 2, H / 2);
      const sb = sp.box;
      const pad = this.flags.dockScreenHitGenerous ? 24 : 0;
      const sbHit = {
        x: sb.x - pad,
        y: sb.y - pad,
        w: sb.w + pad * 2,
        h: sb.h + pad * 2,
      };

      if (
        mo.x >= sbHit.x &&
        mo.x <= sbHit.x + sbHit.w &&
        mo.y >= sbHit.y &&
        mo.y <= sbHit.y + sbHit.h
      ) {
        s._dockHint = {
          kind: "screen",
          side: this._dockGridSide(sp, mo.x, mo.y, sbHit),
          parts: sp,
        };

        return;
      }
      // 2) screen-edge bands — also global (always-on-top, input priority)
      let edge = null;

      if (mo.y < B) {
        edge = "top";
      } else if (mo.y > H - B) edge = "bottom";
      else if (mo.x < B) edge = "left";
      else if (mo.x > W - B) edge = "right";

      if (edge) {
        s._dockHint = {
          kind: "edge",
          edge,
          band: this._edgeBandRect(edge, W, H),
        };

        return;
      }
      // 3) any open, dockable window under the cursor becomes a join target
      //    — including dock members and screen-edge windows (dropping on one
      //    combines it INSIDE the edge stack, see _applyDockHint). A dock
      //    has no join target (it already is a combined window) — for it
      //    only the global UI (steps 1-2) applies.

      if (d.type === "dock-move") {
        return;
      }

      for (let i = s.zOrder.length - 1; i >= 0; i--) {
        const t = s.zOrder[i];

        if (t === w || t.open === false || t.noDock || t.modal) {
          continue;
        }
        const th = t.collapsed ? t.titleH : t.h;

        if (mo.x >= t.x && mo.x < t.x + t.w && mo.y >= t.y && mo.y < t.y + th) {
          const cx = t.x + t.w / 2,
            cy = t.y + th / 2;
          const parts = this._dockGridParts(cx, cy);
          // generous: the whole target window is the side-selection area
          // (quadrants from its center); default: only the drawn square
          const hit = this.flags.dockJoinHitGenerous
            ? {
                x: t.x,
                y: t.y,
                w: t.w,
                h: th,
              }
            : parts.box;
          s._dockHint = {
            kind: "window",
            target: t,
            side: this._dockGridSide(parts, mo.x, mo.y, hit),
            parts,
          };

          return;
        }
      }
    }
    /* The docking grid: a square split into four direction triangles —
     * each triangle's base is one side of the square and its apex meets the
     * others at the center, where there is nothing to dock to. */
    _dockGridParts(cx, cy) {
      const s = 72;
      const hw = s / 2,
        hh = s / 2;

      return {
        box: {
          x: cx - hw,
          y: cy - hh,
          w: s,
          h: s,
        },
        t: [cx - hw, cy - hh, cx + hw, cy - hh, cx, cy],
        b: [cx - hw, cy + hh, cx + hw, cy + hh, cx, cy],
        l: [cx - hw, cy - hh, cx - hw, cy + hh, cx, cy],
        r: [cx + hw, cy - hh, cx + hw, cy + hh, cx, cy],
      };
    }
    /* Which direction triangle of the grid contains (x, y): 't' | 'b' |
     * 'l' | 'r', or null — outside the square, or at the center apex.
     * `hit` (optional) may extend the selectable area beyond the drawn box
     * (the generous dock-hit flag); the direction is still decided by the
     * 45-degree diagonal from the drawn square's center. */
    _dockGridSide(p, x, y, hit) {
      const b = hit || p.box;

      if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) {
        return null;
      }
      const cx = p.box.x + p.box.w / 2,
        cy = p.box.y + p.box.h / 2;
      const dx = Math.abs(x - cx),
        dy = Math.abs(y - cy);
      const hw = p.box.w / 2,
        hh = p.box.h / 2;

      if (dx <= 7 && dy <= 7) {
        return null; // center apex: nothing to dock to
      }

      if (dy >= (hh / hw) * dx) {
        return y < cy ? "t" : "b";
      }

      return x < cx ? "l" : "r";
    }
    /* A representative point (centroid) inside one direction triangle —
     * handy for tests and programmatic drops. */
    _dockGridPoint(p, side) {
      const v = p[side];

      return [(v[0] + v[2] + v[4]) / 3, (v[1] + v[3] + v[5]) / 3];
    }
    _edgeBandRect(edge, W, H) {
      const B = 44;

      return edge === "top"
        ? {
            x: 0,
            y: 0,
            w: W,
            h: B,
          }
        : edge === "bottom"
          ? {
              x: 0,
              y: H - B,
              w: W,
              h: B,
            }
          : edge === "left"
            ? {
                x: 0,
                y: 0,
                w: B,
                h: H,
              }
            : {
                x: W - B,
                y: 0,
                w: B,
                h: H,
              };
    }
    /* Which resize-edge band (1=bottom, 2=right, 4=top, 8=left) contains
     * (x, y), if any; 0 if none. A band is `resizeBarProximity` px on each
     * side of the window's outline, along that side's span. Near a corner
     * two bands overlap, so a point can claim two directions at once. */
    _winResizeEdgeAt(win, x, y) {
      const N = Math.max(0, Math.floor(this.flags.resizeBarProximity || 0));

      if (!N) {
        return 0;
      }
      const W = win.x + win.w,
        H = win.y + win.h;
      // each band hugs its side, extending N px beyond the window at both
      // ends so the outer corners claim two directions at once (a title-bar
      // click inside the window still starts a move: that drag begins
      // earlier in the frame than the band claim in endFrame)
      let edge = 0;

      if (x >= W - N && x <= W + N && y >= win.y - N && y <= H + N) {
        edge |= 2; // right
      }

      if (x >= win.x - N && x <= win.x + N && y >= win.y - N && y <= H + N) {
        edge |= 8; // left
      }

      if (y >= H - N && y <= H + N && x >= win.x - N && x <= W + N) {
        edge |= 1; // bottom
      }

      if (y >= win.y - N && y <= win.y + N && x >= win.x - N && x <= W + N) {
        edge |= 4; // top
      }

      return edge;
    }
    /* The corner grip zone (a square `resizeBarProximity` px into the
     * bottom-right corner). Interaction here takes priority over the
     * window's scrollbars, which stop short of this square. */
    _winGripRect(win) {
      const N = Math.max(1, Math.floor(this.flags.resizeBarProximity || 8));

      return {
        x: win.x + win.w - N,
        y: win.y + win.h - N,
        w: N,
        h: N,
      };
    }
    /* Apply a hint drop at the end of a win-move drag. Returns true if a
     * dock/edge-dock was created (suppresses the title-bar collapse toggle). */
    _applyDockHint(s, d) {
      const h = s._dockHint;
      s._dockHint = null;

      if (!h || !this.flags.docking) {
        return false;
      }
      const isDockMove = d.type === "dock-move";
      const D = isDockMove ? d.dock : null;
      const w = d.win;

      if (isDockMove) {
        if (!D || !D.a || !D.b || D.a.noDock || D.b.noDock) {
          return false;
        }
      } else if (!w || w.noDock) {
        return false;
      }

      if (h.kind === "window") {
        // the join grid only exists for window drags

        if (!w) {
          return false;
        }

        if (!h.side) {
          return false; // no direction triangle under the cursor: plain drop
        }
        const t = h.target;

        if (!t || t.open === false || t.noDock) {
          return false;
        }

        if (t._edge) {
          // EDGE COMBINATION (round-7): the dragged window combines with the
          // globally docked one INSIDE the edge stack. The combined window
          // keeps the docked window's dimension along the screen edge — NOT
          // the sum of both windows like a free dock (see _makeDock). If the
          // target is itself a docked dock, split it first: the stack keeps
          // the unit member, and the dragged window combines with that one.
          const unitEdge = t._edge;
          let unit = t;

          if (t._dockKey) {
            const oldD = s.docks.get(t._dockKey);

            if (oldD) {
              unit = oldD.a;
              this.undock(oldD.a.title, oldD.b.title); // clears _edge on both!
              unit._edge = unitEdge; // the stack keeps the unit member

              if (oldD.b) {
                oldD.b.x += 14;
                oldD.b.y += 14;
              } // keep the freed sibling visible
            }
          }

          if (unit === w || unit.open === false) {
            return false;
          }

          return !!this.dock(unit.title, w.title); // _makeDock applies the edge rule
        }
        // If the target belongs to an existing (free) dock, split that dock
        // first: both members become free windows in their current sub-rects,
        // and the dragged window joins the hovered member (the sibling stays
        // put).
        let tx = t.x,
          ty = t.y,
          tw = t.w,
          th2 = t.h;

        if (t._dockKey) {
          const oldD = s.docks.get(t._dockKey);

          if (oldD) {
            this.undock(oldD.a.title, oldD.b.title);

            if (t.collapsed) {
              // a collapsed member is just a header strip: re-expand it and
              // grow the join to the dock's full content area
              t.collapsed = false;
              const dT = this._var("titleBarHeight");
              tx = oldD.x;
              ty = oldD.y + dT;
              tw = Math.max(20, oldD.w - 6);
              th2 = Math.max(60, oldD.h - dT);
            }
          }
        }
        const a = h.side === "l" || h.side === "t" ? w : t; // first = left/top
        const b = a === w ? t : w;
        const dir = h.side === "l" || h.side === "r" ? "h" : "v";
        // combined size: both windows' sizes added together in the dock
        // direction; the cross dimension takes the larger window's size,
        // anchored on the larger one (so it keeps its position)

        if (dir === "h") {
          const cw = w.w + tw;
          const ch = Math.max(w.h, th2);

          return !!this.dock(a.title, b.title, {
            dir,
            ratio: 0.5,
            pos: [Math.min(w.x, tx), th2 >= w.h ? ty : w.y],
            size: [cw, ch],
          });
        }
        const cw = Math.max(w.w, tw);
        const ch = w.h + th2;

        return !!this.dock(a.title, b.title, {
          dir,
          ratio: 0.5,
          pos: [tw >= w.w ? tx : w.x, Math.min(w.y, ty)],
          size: [cw, ch],
        });
      }
      // edge band / screen grid: windows AND docks (combined windows) can be
      // globally docked — a dock joins the stack as one unit
      const unitTitle = isDockMove ? D.a.title : w.title;

      if (h.kind === "edge") {
        return !!this.dockToEdge(unitTitle, h.edge);
      }

      if (h.kind === "screen") {
        if (!h.side) {
          return false; // no direction triangle under the cursor: plain drop
        }
        const e =
          h.side === "t"
            ? "top"
            : h.side === "b"
              ? "bottom"
              : h.side === "l"
                ? "left"
                : "right";

        return !!this.dockToEdge(unitTitle, e);
      }

      return false;
    }
    /* Draw the live hint above everything (called at the end of the frame):
     * the screen-center dock grid (always), the highlighted edge band, and
     * the join grid at the center of the window being hovered. */
    _drawDockHints() {
      const guiState = this.state;
      const d = guiState.drag;

      if (
        !d ||
        (d.type !== "win-move" && d.type !== "dock-move") ||
        !this.flags.docking
      ) {
        return;
      }

      if (d.win && d.win.noDock) {
        return; // NoDock: no docking UI while dragging
      }

      if (d.dock && (d.dock.a.noDock || d.dock.b.noDock)) {
        return; // ditto, for a dock
      }
      const r = this.renderer;
      const W = guiState.displayW,
        H = guiState.displayH;
      const acc = this._col("sliderGrab");
      const h = guiState._dockHint;

      // The screen-center dock grid is a square split into four direction
      // triangles (one per screen edge, apexes meeting at the center). It is
      // always shown while a window is dragged; the triangle under the
      // cursor lights up, and dropping on it docks the window to that screen
      // edge. The center apex has no direction, so dropping there is a plain
      // drop.
      const sp = this._dockGridParts(W / 2, H / 2);
      this._drawDockGrid(
        r,
        sp,
        h && h.kind === "screen" ? h.side : null,
        acc,
        false,
      );

      if (h && h.kind === "edge") {
        const b = h.band;
        r.fillRoundedRect(
          b.x + 2,
          b.y + 2,
          b.w - 4,
          b.h - 4,
          4,
          withAlpha(acc, 48),
        );
        r.strokeRoundedRect(
          b.x + 2.5,
          b.y + 2.5,
          b.w - 5,
          b.h - 5,
          4,
          withAlpha(acc, 170),
          1.5,
        );
      }

      if (h && h.kind === "window") {
        this._drawDockGrid(r, h.parts, h.side, acc, true);
      }
    }
    /* One dock grid (as produced by _dockGridParts): a square of four
     * direction triangles. The triangle matching activeSide lights up;
     * overWindow adds the faint square outline that the join-on-a-window
     * variant uses. */
    _drawDockGrid(r, p, activeSide, acc, overWindow) {
      if (overWindow)
        r.strokeRoundedRect(
          p.box.x + 0.5,
          p.box.y + 0.5,
          p.box.w - 1,
          p.box.h - 1,
          4,
          withAlpha(this._col("text"), 80),
          1,
        );

      for (const k of ["t", "b", "l", "r"]) {
        const v = p[k];
        const on = activeSide === k;
        r.fillPolygon(v, on ? withAlpha(acc, 150) : withAlpha([0, 0, 0], 120));
        r.polyline(
          [v[0], v[1], v[2], v[3], v[4], v[5], v[0], v[1]],
          withAlpha(acc, on ? 255 : 170),
          on ? 2 : 1.2,
        );
      }
    }

    /* ---------------------------- app menu bar -------------------------- */
    /* A screen-edge bar (top/left/right/bottom) of programmatically defined
     * sections with dropdown menus — above all windows, for toggling
     * windows, running functions, etc.
     *
     *   gui.setAppMenuBar([
     *     { label: 'File', items: [
     *       { label: 'Save', shortcut: 'ctrl+s', key: 's', keyMod: ['ctrl'],
     *         onActivated: () => {...} },
     *       { sep: true },
     *       { label: 'Quit', onActivated: () => {...} },
     *     ]},
     *     { label: 'Windows', items: [
     *       { label: 'Show Properties Window', selected: () => gui.isWindowOpen('Props'),
     *         onActivated: () => gui.setWindowOpen('Props', true) },
     *     ]},
     *   ], { pos: 'top' });
     *
     * Item shape: { label, onActivated, shortcut (display only), key +
     * keyMod (live keyboard shortcut, e.g. key: 's', keyMod: ['ctrl']),
     * selected (bool or fn -> check mark), disabled (bool or fn),
     * sep: true, items: [...] (nested submenu) }.
     * Call gui.clearAppMenuBar() to remove it; gui.activateMenu('File','Save')
     * triggers an item programmatically. */
    setAppMenuBar(menus, opts) {
      opts = opts || {};
      const guiState = this.state;
      guiState.appMenu = {
        menus: menus || [],
        pos: ["top", "left", "right", "bottom"].includes(opts.pos)
          ? opts.pos
          : "top",
        thickness:
          opts.size > 0 ? opts.size : opts.thickness > 0 ? opts.thickness : 30,
        sideWidth: opts.width > 0 ? opts.width : 180,
      };
      guiState.appMenuOwner = {
        kind: "appmenu",
      };
      const sc = [];
      const walk = (list) => {
        for (const m of list || []) {
          if (m && m.key) {
            sc.push(m);
          }

          if (m && m.items) {
            walk(m.items);
          }
        }
      };
      walk(menus || []);
      guiState.appMenuShortcuts = sc;

      return this;
    }
    /**
     * Removes the app menu bar set with setAppMenuBar().
     */
    clearAppMenuBar() {
      const guiState = this.state;
      guiState.appMenu = null;
      guiState.appMenuShortcuts = [];

      for (const p of guiState.popupList)
        if (p.data && p.data.appMenu) p.open = false;

      return this;
    }
    /**
     * Triggers an app-menu item programmatically, by path: e.g.
     *   * activateMenu('File', 'Save layout').
     * @param {...string} path top-level label, then item (or submenu) labels
     * @returns {boolean} false when the path does not resolve
     */
    activateMenu(...path) {
      const am = this.state.appMenu;

      if (!am || !path.length) {
        return false;
      }
      let list = am.menus;

      for (let i = 0; i < path.length; i++) {
        const m = (list || []).find((x) => x && x.label === path[i]);

        if (!m) {
          return false;
        }

        if (i === path.length - 1) {
          const disabled =
            typeof m.disabled === "function" ? m.disabled() : !!m.disabled;

          if (disabled || typeof m.onActivated !== "function") {
            return false;
          }
          m.onActivated();

          return true;
        }
        list = m.items;
      }

      return false;
    }

    /* Compute one docked member's sub-rect from the dock layout, and apply
     * any in-flight dock drag (move / resize / split) so this frame is live. */
    _dockMemberLayout(win, D, s) {
      const mouse = s.mouse;
      const tH = this._var("titleBarHeight");
      const dw = 6; // divider thickness
      const isA = D.a === win;
      win._dock = D;
      win._dockIsA = isA;

      // 1) apply an in-flight dock drag (updates D before the rect is derived)
      const d = s.drag;

      if (d && d.dock === D && this.isMouseDown(0))
        if (d.type === "dock-move") {
          D.x = mouse.x - d.offX;
          D.y = mouse.y - d.offY;
          d.moved = Math.max(
            d.moved || 0,
            Math.abs(D.x - d.x0) + Math.abs(D.y - d.y0),
          );
          // the first real movement brings the whole dock to the front

          if (d.moved >= this.flags.dragThreshold && !d.raised) {
            d.raised = true;
            this._raise(D.b);
            this._raise(D.a);
          }
          this._setCursor("grabbing", 2);
        } else if (d.type === "dock-resize") {
          if (d.edge & 2) {
            const nw = clamp(d.w0 + (mouse.x - d.mx), D.minW, 1e5);
            D.x = d.x0 + (d.w0 - nw);
            D.w = nw;
          }

          if (d.edge & 1) {
            D.h = clamp(d.h0 + (mouse.y - d.my), D.minH, 1e5);
          }

          if (d.edge & 4) {
            const ny = clamp(d.y0 + (mouse.y - d.my), 0, 1e5);
            D.h = d.h0 + (d.y0 - ny);
            D.y = ny;
          }

          if (d.edge & 8) {
            const nw = clamp(d.w0 + (d.mx - mouse.x), D.minW, 1e5);
            D.x = d.x0 + d.w0 - nw;
            D.w = nw;
          }
          const corner =
            (d.edge & 2 && d.edge & 1) ||
            (d.edge & 4 && (d.edge & 2 || d.edge & 8));
          this._setCursor(
            corner
              ? "nwse-resize"
              : d.edge & 2 || d.edge & 8
                ? "ew-resize"
                : "ns-resize",
            2,
          );
        } else if (d.type === "dock-split") {
          if (D.dir === "h") {
            D.ratio = clamp((mouse.x - D.x - dw / 2) / (D.w - dw), 0.12, 0.88);
          } else
            D.ratio = clamp(
              (mouse.y - D.y - tH - dw / 2) / (D.h - tH - dw),
              0.12,
              0.88,
            );
          this._setCursor(D.dir === "h" ? "ew-resize" : "ns-resize", 2);
        }

      // 2) derive this member's sub-rect

      if (D.collapsed) {
        win.x = D.x;
        win.y = D.y + tH;
        win.w = 0;
        win.h = 0;
        win.titleH = 0;

        return;
      }
      const sh = Math.min(tH, 26); // slim member header height
      win.titleH = sh;
      const other = isA ? D.b : D.a;
      const myCollapsed = win.collapsed;
      const otherCollapsed = !!(other && other.collapsed);
      const ox = D.x,
        oy = D.y + tH;

      if (D.dir === "h") {
        const total = D.w - dw;
        const first =
          D.a && D.a.collapsed
            ? 0
            : D.b && D.b.collapsed
              ? total
              : Math.round(total * D.ratio);

        if (myCollapsed) {
          win.x = ox;
          win.y = oy;
          win.w = D.w;
          win.h = sh;
        } else if (otherCollapsed) {
          win.y = oy;
          win.h = D.h - tH;
          win.x = ox;
          win.w = D.w - dw;
        } else if (isA) {
          win.x = ox;
          win.y = oy;
          win.w = first;
          win.h = D.h - tH;
        } else {
          win.x = ox + first + dw;
          win.y = oy;
          win.w = total - first;
          win.h = D.h - tH;
        }
      } else {
        const total = D.h - tH;
        const first =
          D.a && D.a.collapsed
            ? 0
            : D.b && D.b.collapsed
              ? total
              : Math.round(total * D.ratio);

        if (myCollapsed) {
          win.x = ox;
          win.y = oy;
          win.w = D.w;
          win.h = sh;
        } else if (otherCollapsed) {
          win.x = ox;
          win.w = D.w - dw;
          win.y = oy;
          win.h = D.h - tH;
        } else if (isA) {
          win.x = ox;
          win.y = oy;
          win.w = D.w - dw;
          win.h = first;
        } else {
          win.x = ox;
          win.y = oy + first + dw;
          win.w = D.w - dw;
          win.h = total - first;
        }
      }
      win.w = Math.max(0, win.w);
      win.h = Math.max(0, win.h);
    }

    /* Draw a docked member's slim header, plus (for the first member) the
     * combined dock chrome: border, title bar with close button, divider.
     * Also handles dock chrome input (move / resize / split / close /
     * undock / member collapse). */
    _drawDockChrome(win, alpha) {
      const guiState = this.state;
      const dock = win._dock;
      const isA = win._dockIsA;
      const tH = this._var("titleBarHeight");
      const mouse = guiState.mouse;
      const r = this._var("windowRounding");
      const fontOptions = this._fo();
      const lineH = this._lineH();
      const inRect = (x, y, w, h) =>
        mouse.x >= x && mouse.x < x + w && mouse.y >= y && mouse.y < y + h;

      if (isA) {
        const dh = dock.collapsed ? tH : dock.h;
        const dragging = guiState.drag && guiState.drag.dock === dock;
        const focused =
          dragging ||
          guiState.hoveredWindow === dock.a ||
          guiState.hoveredWindow === dock.b;
        // border around the combined rect

        if (this._var("windowBorder") > 0)
          this.renderer.strokeRoundedRect(
            dock.x + 0.5,
            dock.y + 0.5,
            dock.w - 1,
            dh - 1,
            r,
            this._col("border", alpha),
            this._var("windowBorder"),
          );
        // combined title bar
        const tbColor = focused
          ? this._col("titleBgActive", alpha)
          : this._col("titleBg", alpha);
        this.renderer.fillRoundedRect(dock.x, dock.y, dock.w, tH, r, tbColor);
        this.renderer.fillRect(
          dock.x,
          dock.y + tH / 2,
          dock.w,
          tH / 2,
          tbColor,
        );
        // close button (right end): closes both members + removes the dock
        const bx = dock.x + dock.w - 16,
          by = dock.y + tH / 2;
        const hovClose = inRect(bx - 7, by - 9, 20, 18);

        // collapse/expand chevron (left end): hides/shows the members inside
        const ccx = dock.x + 14,
          ccy = dock.y + tH / 2;
        const ccColor = this._col(focused ? "text" : "textDisabled", alpha);

        if (dock.collapsed)
          this.renderer.fillPolygon(
            [ccx - 4, ccy - 4, ccx - 4, ccy + 4, ccx + 2, ccy],
            ccColor,
          );
        else
          this.renderer.fillPolygon(
            [ccx - 4, ccy - 3, ccx + 4, ccy - 3, ccx, ccy + 3],
            ccColor,
          );
        const inChevron = inRect(dock.x + 4, dock.y, 22, tH) && !hovClose;
        const title =
          dock.title ||
          (dock.a && dock.b
            ? dock.a.title + " +" + dock.b.title
            : dock.a
              ? dock.a.title
              : "");
        this._drawText(
          dock.x + 30,
          dock.y + (tH - lineH) / 2 + 1,
          title,
          this._col(focused ? "text" : "textDisabled", alpha),
          fontOptions,
        );

        if (hovClose)
          this.renderer.fillRoundedRect(
            bx - 7,
            by - 9,
            20,
            18,
            4,
            this._col("headerHovered", alpha),
          );
        this.renderer.line(
          bx - 3,
          by - 4,
          bx + 5,
          by + 4,
          this._col(hovClose ? "text" : "textDisabled", alpha),
          1.4,
        );
        this.renderer.line(
          bx + 5,
          by - 4,
          bx - 3,
          by + 4,
          this._col(hovClose ? "text" : "textDisabled", alpha),
          1.4,
        );

        // divider (between the two members)

        if (!dock.collapsed) {
          const dw = 6;

          if (dock.dir === "h") {
            const divX =
              dock.x + Math.round((dock.w - dw) * dock.ratio) + dw / 2;
            this.renderer.line(
              divX,
              dock.y + tH + 3,
              divX,
              dock.y + dock.h - 3,
              this._col("border", alpha),
              1.5,
            );
            this.renderer.fillRoundedRect(
              divX - 1.5,
              dock.y + dock.h / 2 - 8,
              3,
              16,
              1.5,
              this._col("border", alpha),
            );
          } else {
            const divY =
              dock.y +
              tH +
              Math.round((dock.h - tH - dw) * dock.ratio) +
              dw / 2;
            this.renderer.line(
              dock.x + 3,
              divY,
              dock.x + dock.w - 3,
              divY,
              this._col("border", alpha),
              1.5,
            );
            this.renderer.fillRoundedRect(
              dock.x + dock.w / 2 - 8,
              divY - 1.5,
              16,
              3,
              1.5,
              this._col("border", alpha),
            );
          }
        }

        // ---- dock chrome input (blocked while the app menu bar covers it)
        // Topmost-element rule: a click only reaches this dock's chrome when
        // nothing is painted over the point. s.hoveredWindow is the topmost
        // window under the cursor; over a dock it is one of the members —
        // the combined title strip is hit-tested as belonging to the members
        // (see _dockStripAt) — or null where no rect covers the point (the
        // divider strip). Any OTHER window (or an open modal) wins, so
        // input can't travel through it to the chrome underneath.
        const top = guiState.hoveredWindow;
        const chromeTop = top === dock.a || top === dock.b || top === null; // an open modal covering the point shows up as `top` and loses
        const clicked =
          this.isMouseClicked(0) &&
          guiState.activeId === 0 &&
          !guiState.drag &&
          guiState.disabledCount === 0 &&
          !guiState.appBarGrab &&
          !this._popupAtPoint(mouse.x, mouse.y) &&
          chromeTop;
        const gy = dock.y + dh;
        // eT covers the top 4px of the title bar (plus 4px above it) so a
        // dock can be scaled vertically from the top edge as well
        const eT =
          inRect(dock.x, dock.y - 4, dock.w, 8) && !hovClose && !inChevron;
        const eL = inRect(dock.x - 4, dock.y, 12, dh) && !hovClose;
        const eR =
          inRect(dock.x + dock.w - 8, dock.y, 12, dh) && mouse.y >= dock.y + tH;
        const eB = inRect(dock.x, gy - 8, dock.w, 12);
        const inTitle = inRect(dock.x, dock.y, dock.w, tH);
        let inDivider = false;

        if (!dock.collapsed) {
          const dw = 6;

          if (dock.dir === "h") {
            const divX =
              dock.x + Math.round((dock.w - dw) * dock.ratio) + dw / 2;
            inDivider =
              mouse.x >= divX - 4 &&
              mouse.x <= divX + 4 &&
              mouse.y >= dock.y + tH &&
              mouse.y < gy;
          } else {
            const divY =
              dock.y +
              tH +
              Math.round((dock.h - tH - dw) * dock.ratio) +
              dw / 2;
            inDivider =
              mouse.y >= divY - 4 &&
              mouse.y <= divY + 4 &&
              mouse.x >= dock.x &&
              mouse.x < dock.x + dock.w;
          }
        }

        if (clicked)
          if (hovClose) {
            if (dock.a) {
              dock.a.open = false;
              this._freeDockedMember(dock.a);
            }

            if (dock.b) {
              dock.b.open = false;
              this._freeDockedMember(dock.b);
            }
            guiState.docks.delete(dock.key);
            guiState.activeId = -1;
          } else if (inChevron) {
            dock.collapsed = !dock.collapsed;
            guiState.activeId = -1;
          } else if (eT && !dock._edge) {
            guiState.drag = {
              type: "dock-resize",
              dock: dock,
              win,
              button: 0,
              edge: (eL ? 8 : 0) | (eR ? 2 : 0) | (eB ? 1 : 0) | 4,
              mx: mouse.x,
              my: mouse.y,
              x0: dock.x,
              y0: dock.y,
              w0: dock.w,
              h0: dock.h,
            };
            guiState.activeId = -1;
          } else if (inTitle) {
            if (dock._edge) {
              // a globally docked dock: the stack owns its position/size, so
              // there is no move/resize — double-click frees it from the edge

              if (this.isMouseDoubleClicked(0)) {
                this.undockEdge(dock.a.title);
              }
            } else if (
              this.isMouseDoubleClicked(0) &&
              this.flags.windowDoubleReset
            ) {
              dock.x = dock.defaultX;
              dock.y = dock.defaultY;
            } else {
              // the dock is raised to the front once the drag actually moves
              // (see the dock-move apply in _dockMemberLayout)
              guiState.drag = {
                type: "dock-move",
                dock: dock,
                win,
                button: 0,
                offX: mouse.x - dock.x,
                offY: mouse.y - dock.y,
                x0: dock.x,
                y0: dock.y,
                moved: 0,
              };
              guiState.activeId = -1;
            }
          } else if ((eL || eR || eB) && !dock._edge) {
            guiState.drag = {
              type: "dock-resize",
              dock: dock,
              win,
              button: 0,
              edge: (eL ? 8 : 0) | (eR ? 2 : 0) | (eB ? 1 : 0),
              mx: mouse.x,
              my: mouse.y,
              x0: dock.x,
              y0: dock.y,
              w0: dock.w,
              h0: dock.h,
            };
            guiState.activeId = -1;
          } else if (inDivider)
            if (this.isMouseDoubleClicked(0)) {
              dock.ratio = 0.5;
            } else {
              guiState.drag = {
                type: "dock-split",
                dock: dock,
                win,
                button: 0,
              };
              guiState.activeId = -1;
            }
        // right-click the combined title bar: dock context menu (only when no
        // other window covers this spot)

        if (
          this.flags.windowContextMenu &&
          this.isMouseClicked(1) &&
          guiState.activeId === 0 &&
          guiState.disabledCount === 0 &&
          !guiState.drag &&
          !guiState.appBarGrab &&
          inTitle &&
          !hovClose
        ) {
          let covered = false;

          for (let i = guiState.zOrder.length - 1; i >= 0; i--) {
            const w2 = guiState.zOrder[i];

            if (w2.kind !== "window" || w2.open === false) {
              continue;
            }
            const h2 = w2.collapsed ? w2.titleH : w2.h;

            if (
              mouse.x >= w2.x &&
              mouse.x < w2.x + w2.w &&
              mouse.y >= w2.y &&
              mouse.y < w2.y + h2
            ) {
              covered = true;
              break;
            }
          }

          if (!covered) {
            this._dockContextMenu(dock);
          }
        }
        // hover cursors (dragging is prio 2 in _dockMemberLayout); a window
        // painted over the point owns the cursor instead (chromeTop). An
        // edge-docked dock has no move/resize cursors (the stack owns its
        // geometry — the stack's inner bar and gap spliters resize it).

        if (!guiState.drag && chromeTop)
          if (inChevron) {
            this._setCursor("pointer", 1);
          } else if (eT && !dock._edge)
            this._setCursor(eL || eR ? "nwse-resize" : "ns-resize", 1);
          else if (inTitle && !hovClose && !dock._edge)
            this._setCursor("move", 1);
          else if (inDivider)
            this._setCursor(dock.dir === "h" ? "ew-resize" : "ns-resize", 1);
          else if ((eL || eR) && !dock._edge) this._setCursor("ew-resize", 1);
          else if (eB && !dock._edge) this._setCursor("ns-resize", 1);
          else if (hovClose) this._setCursor("pointer", 1);
      }

      // ---- slim member header (both members, when not dock-collapsed) ----

      if (dock.collapsed || win.w <= 0 || win.h <= 0) {
        return;
      }
      const sh = win.titleH;
      const focused = guiState.hoveredWindow === win;
      this.renderer.fillRect(
        win.x,
        win.y,
        win.w,
        sh,
        win.collapsed
          ? this._col("titleBgCollapsed", alpha)
          : this._col("childBg", alpha),
      );
      this.renderer.line(
        win.x,
        win.y + sh + 0.5,
        win.x + win.w,
        win.y + sh + 0.5,
        this._col("border", alpha),
        1,
      );
      const ccx = win.x + 12,
        ccy = win.y + sh / 2;
      const cc = this._col(focused ? "text" : "textDisabled", alpha);

      if (win.collapsed)
        this.renderer.fillPolygon(
          [ccx - 4, ccy - 4, ccx - 4, ccy + 4, ccx + 2, ccy],
          cc,
        );
      else
        this.renderer.fillPolygon(
          [ccx - 4, ccy - 3, ccx + 4, ccy - 3, ccx - 0, ccy + 3],
          cc,
        );
      this._drawText(
        win.x + 24,
        win.y + (sh - lineH) / 2 + 1,
        win.title,
        this._col(focused ? "text" : "textDisabled", alpha),
        fontOptions,
      );
      // undock button (right end of the slim header)
      const ux = win.x + win.w - 13,
        uy = win.y + sh / 2;
      const hovU = inRect(ux - 8, uy - 8, 16, 16);

      if (hovU)
        this.renderer.fillRoundedRect(
          ux - 8,
          uy - 8,
          16,
          16,
          4,
          this._col("headerHovered", alpha),
        );
      // expand-style icon: small square + diagonal arrow
      this.renderer.strokeRoundedRect(
        ux - 4,
        uy - 1,
        7,
        5,
        1,
        this._col(hovU ? "text" : "textDisabled", alpha),
        1.2,
      );
      this.renderer.line(
        ux - 1,
        uy + 3,
        ux + 4,
        uy - 3,
        this._col(hovU ? "text" : "textDisabled", alpha),
        1.2,
      );
      this.renderer.polyline(
        [ux + 1, uy - 3, ux + 4, uy - 3, ux + 4, uy],
        this._col(hovU ? "text" : "textDisabled", alpha),
        1.2,
      );
      // input: test against LAST frame's header (this frame's layout may have
      // already reshaped the header after a sibling's collapse toggle); the
      // last-drawn member wins overlapping regions, so the request is stored
      // and applied in endFrame. A press on the header becomes either a
      // collapse toggle (no movement) or a drag that undocks this member.
      // note: no s.activeId === 0 guard here — when two members' slim
      // headers overlap (one is collapsed), the first-drawn member must not
      // claim activeId and block the last-drawn one from winning the press
      const clicked =
        this.isMouseClicked(0) &&
        !guiState.drag &&
        guiState.disabledCount === 0 &&
        !guiState.appBarGrab &&
        !this._popupAtPoint(mouse.x, mouse.y);
      const prev = win._dockPrevRect;
      const inPrevHeader =
        prev &&
        prev.h >= sh &&
        mouse.x >= prev.x &&
        mouse.x < prev.x + prev.w &&
        mouse.y >= prev.y &&
        mouse.y < prev.y + sh;

      if (inPrevHeader) {
        const pux = prev.x + prev.w - 13,
          puy = prev.y + sh / 2;
        const inU = inRect(pux - 8, puy - 8, 16, 16);

        if (clicked && inU) {
          this.undock(win);
        } else if (clicked && !inU) {
          guiState._memberDrag = {
            win,
            x: mouse.x,
            y: mouse.y,
            offX: mouse.x - win.x,
            offY: mouse.y - win.y,
          };
          guiState.activeId = -1;
        } else if (!guiState.drag && !inU && !inRect(win.x + 4, win.y, 22, sh))
          this._setCursor(this.flags.windowMove ? "move" : "default", 1);
      }

      if (
        this.flags.windowContextMenu &&
        this.isMouseClicked(1) &&
        guiState.activeId === 0 &&
        guiState.disabledCount === 0 &&
        !guiState.drag &&
        !guiState.appBarGrab &&
        guiState.hoveredWindow === win &&
        inPrevHeader
      )
        this._memberContextMenu(win);

      if (hovU) {
        this._setCursor("pointer", 1);
      }
    }

    /**
     * Opens (or re-enters) a window; draw its contents and call endWindow()
     *   * in the same frame.
     * @param {string} title window title (unique per GUI instance)
     * @param {Object} [opts] { pos, size, minSize, maxSize, zIndex, open, collapsed,
     flags (Mim.WindowFlags bits: Closable, ScrollX, AlwaysOnTop, Modal,
     NoTitleBar, NoClip, NoScrollbar, AutoResize, FixedSize, NoMove,
     NoResize, NoCollapse, NoDock), style, onClose, persist }
     * @returns {boolean} false when the window is closed / not drawn this frame; otherwise true (draw the contents)
     */
    beginWindow(title, opts) {
      opts = opts || {};
      const guiState = this.state;

      if (
        guiState.currentWindow &&
        guiState.currentWindow.drawnFrame === guiState.frameId
      )
        return false; // re-entry guard

      let win = guiState.windows.get(title);

      if (!win) {
        win = new Window(title, "window");
        win.owner = win;
        guiState.windows.set(title, win);
        win.createdFrame = guiState.frameId;
        const n = guiState.winCounter++;
        win.defaultX = 24 + (n % 6) * 36;
        win.defaultY = 24 + (n % 6) * 28;
        const st = guiState.windowStates.get(title);

        if (st) {
          win.x = st.x;
          win.y = st.y;
          win.w = st.w;
          win.h = st.h;
          win.collapsed = !!st.collapsed;
        } else {
          win.x = win.defaultX;
          win.y = win.defaultY;
        }
      }
      win.createdFrame = win.createdFrame || guiState.frameId;

      // options

      if (opts.open !== undefined) {
        win.open = !!opts.open;
      }

      if (opts.onClose) {
        win.onClose = opts.onClose;
      }

      if (opts.flags) {
        win.flags = opts.flags;
        win.closable = !!(win.flags & WindowFlags.Closable);
        win.alwaysOnTop = !!(win.flags & WindowFlags.AlwaysOnTop);
        win.modal = !!(win.flags & WindowFlags.Modal);
        win.noTitleBar = !!(win.flags & WindowFlags.NoTitleBar);
        win.noClip = !!(win.flags & WindowFlags.NoClip);
        win.noScrollbar = !!(win.flags & WindowFlags.NoScrollbar);
        win.autoResize = !!(win.flags & WindowFlags.AutoResize);
        win.fixedSize = !!(win.flags & WindowFlags.FixedSize);
        win.allowScrollX = !!(win.flags & WindowFlags.ScrollX);
        win.movable = !(win.flags & WindowFlags.NoMove);
        win.resizable =
          !(win.flags & WindowFlags.NoResize) &&
          !win.fixedSize &&
          !win.autoResize;
        win.collapsible =
          !(win.flags & WindowFlags.NoCollapse) && !win.noTitleBar;
        win.noDock = !!(win.flags & WindowFlags.NoDock);
      }

      if (opts.style) win.style = Object.assign({}, win.style, opts.style);

      if (opts.minSize) {
        win.minW = opts.minSize[0];
        win.minH = opts.minSize[1];
      }

      if (opts.maxSize) {
        win.maxW = opts.maxSize[0];
        win.maxH = opts.maxSize[1];
      }

      if (opts.collapsed !== undefined) {
        win.collapsed = !!opts.collapsed;
      }

      if (opts.size) {
        win.sizeW = opts.size[0];
        win.sizeH = opts.size[1];
      }

      if (opts.pos && !guiState.windowStates.has(title)) {
        win.x = opts.pos[0];
        win.y = opts.pos[1];
        win.defaultX = opts.pos[0];
        win.defaultY = opts.pos[1];
      }

      if (guiState.nextWindowPos) {
        win.x = guiState.nextWindowPos.x;
        win.y = guiState.nextWindowPos.y;
        guiState.nextWindowPos = null;
      }

      if (guiState.nextWindowSize) {
        if (guiState.nextWindowSize.w > 0) {
          win.w = guiState.nextWindowSize.w;
        }

        if (guiState.nextWindowSize.h > 0) {
          win.h = guiState.nextWindowSize.h;
        }
        guiState.nextWindowSize = null;
      }
      win.drawnFrame = guiState.frameId;

      if (guiState.zOrder.indexOf(win) < 0) {
        guiState.zOrder.push(win);
      }

      if (!win.open) {
        return false;
      }
      const stylePad = this._var("windowPadding");
      win.padX = stylePad[0];
      win.padY = stylePad[1];
      win.titleH = win.noTitleBar ? 0 : this._var("titleBarHeight");
      win.menuH = opts.menuBar ? this._var("menuBarHeight") : 0;

      // size

      if (win.autoResize) {
        win.w = win.contentW + win.padX * 2;
        win.h = win.contentH + win.padY * 2 + win.titleH + win.menuH;
      } else if (win.sizeW > 0 && !win.sizedOnce) {
        // size is an initial hint; user resizes afterwards must stick
        win.w = win.sizeW;
        win.h = win.sizeH > 0 ? win.sizeH : win.h;
        win.sizedOnce = true;
      }
      win.w = clamp(win.w, win.minW, win.maxW);
      win.h = clamp(win.h, win.minH, win.maxH);
      const mouse = guiState.mouse;

      // docked member: the dock layout drives this window's rect

      if (win._dockKey) {
        win._dockPrevRect = {
          x: win.x,
          y: win.y,
          w: win.w,
          h: win.h,
        };
        const dock = guiState.docks.get(win._dockKey);

        if (!dock || (dock.a !== win && dock.b !== win)) {
          win._dockKey = null;
          win._dock = null;
        } else {
          this._dockMemberLayout(win, dock, guiState);
          win.sizedOnce = true;
          win.movable = false; // the dock moves as a whole
          win.resizable = false; // the dock resizes as a whole
        }
      } else if (win._edge) {
        // screen-edge dock member: the edge layout (see _edgeDocksFrame)
        // drives this window's rect; it can't be moved or resized directly
        win._dock = null;
        win.sizedOnce = true;
        win.movable = false;
        win.resizable = false;
      } else {
        win._dock = null;
      }

      // a freshly positioned window may sit under the mouse: claim hover
      // (a collapsed window only occupies its header row)
      const claimH = win.collapsed ? win.titleH : win.h;

      if (
        !guiState.appBarGrab &&
        mouse.x >= win.x &&
        mouse.x < win.x + win.w &&
        mouse.y >= win.y &&
        mouse.y < win.y + claimH
      )
        if (
          guiState.hoveredWindow === null ||
          guiState.zOrder.indexOf(win) >
            guiState.zOrder.indexOf(guiState.hoveredWindow)
        )
          guiState.hoveredWindow = win;

      // window dragging / resizing

      if (guiState.drag && guiState.drag.win === win) {
        const d = guiState.drag;

        if (d.type === "win-move" && this.isMouseDown(0)) {
          win.x = mouse.x - d.offX;
          win.y = mouse.y - d.offY;
          d.moved = Math.max(
            d.moved || 0,
            Math.abs(win.x - d.x0) + Math.abs(win.y - d.y0),
          );
          // the first real movement brings the window to the front (a plain
          // title click — e.g. the collapse toggle — never reorders)

          if (d.moved >= this.flags.dragThreshold && !d.raised) {
            d.raised = true;
            this._raise(win);
          }
          this._setCursor("grabbing", 2);
        } else if (d.type === "win-resize" && this.isMouseDown(0)) {
          // each claimed edge scales the window in its direction; left/top
          // moves keep the opposite edge in place

          if (d.edge & 2) {
            win.w = clamp(d.w0 + (mouse.x - d.mx), win.minW, win.maxW);
          }

          if (d.edge & 8) {
            win.w = clamp(d.w0 + (d.mx - mouse.x), win.minW, win.maxW);
            win.x = d.x0 + d.w0 - win.w;
          }

          if (d.edge & 1) {
            win.h = clamp(d.h0 + (mouse.y - d.my), win.minH, win.maxH);
          }

          if (d.edge & 4) {
            win.h = clamp(d.h0 + (d.my - mouse.y), win.minH, win.maxH);
            win.y = d.y0 + d.h0 - win.h;
          }
          const horiz = d.edge & 2 || d.edge & 8,
            vert = d.edge & 1 || d.edge & 4;
          this._setCursor(
            horiz && vert ? "nwse-resize" : horiz ? "ew-resize" : "ns-resize",
            2,
          );
        }
      }

      if (
        this.isMouseClicked(0) &&
        guiState.hoveredWindow === win &&
        guiState.activeId === 0 &&
        guiState.disabledCount === 0 &&
        !this._popupAtPoint(mouse.x, mouse.y)
      ) {
        guiState.focusedWindow = win; // focus marker only — a click never reorders the stack
        // double-click a screen-edge window's title bar to free it from the edge

        if (
          win._edge &&
          !win.noTitleBar &&
          this.flags.windowDoubleReset &&
          mouse.x >= win.x &&
          mouse.x < win.x + win.w &&
          mouse.y >= win.y &&
          mouse.y < win.y + win.titleH &&
          this.isMouseDoubleClicked(0)
        )
          this.undockEdge(win.title);

        if (
          !win.noTitleBar &&
          win.movable &&
          this.flags.windowMove &&
          mouse.x >= win.x &&
          mouse.x < win.x + win.w &&
          mouse.y >= win.y &&
          mouse.y < win.y + win.titleH
        ) {
          const inClose =
            win.closable &&
            mouse.x >= win.x + win.w - 28 &&
            mouse.x <= win.x + win.w - 6;
          const inCollapse =
            win.collapsible && mouse.x >= win.x && mouse.x <= win.x + 28;

          if (!inClose && !inCollapse)
            if (this.isMouseDoubleClicked(0) && this.flags.windowDoubleReset) {
              win.x = win.defaultX;
              win.y = win.defaultY;
              // undo the collapse toggle caused by the first click of this double-click

              if (
                win._collapseToggledAt &&
                guiState.frameId - win._collapseToggledAt <= 30
              ) {
                win.collapsed = !win.collapsed;
                win._collapseToggledAt = 0;
              }
            } else {
              guiState.drag = {
                type: "win-move",
                win,
                button: 0,
                offX: mouse.x - win.x,
                offY: mouse.y - win.y,
                x0: win.x,
                y0: win.y,
                moved: 0,
                collapse: win.collapsible,
              };
              guiState.activeId = -1;
            }
        }
      }
      // a click ANYWHERE on the window (empty body included, not just the
      // title bar or a widget) is handled by that window: it becomes the
      // focused window. The click never reorders the draw order — the
      // topmost window under the cursor owns every click on its surface
      // (nothing can pass through it), and only a MOVE drag changes which
      // window is drawn on top.
      {
        const winH = win.collapsed ? win.titleH : win.h;

        if (
          (this.isMouseClicked(0) || this.isMouseClicked(1)) &&
          guiState.hoveredWindow === win &&
          guiState.activeId === 0 &&
          guiState.disabledCount === 0 &&
          !guiState.drag &&
          !guiState.appBarGrab &&
          !this._popupAtPoint(mouse.x, mouse.y) &&
          mouse.x >= win.x &&
          mouse.x < win.x + win.w &&
          mouse.y >= win.y &&
          mouse.y < win.y + winH
        )
          guiState.focusedWindow = win;
      }
      // right-click the title bar: window context menu (topmost window only;
      // dock members have their slim-header menu in _drawDockChrome)

      if (
        this.flags.windowContextMenu &&
        this.isMouseClicked(1) &&
        guiState.hoveredWindow === win &&
        guiState.activeId === 0 &&
        guiState.disabledCount === 0 &&
        !guiState.drag &&
        !guiState.appBarGrab &&
        !win.noTitleBar &&
        !win._dockKey &&
        mouse.x >= win.x &&
        mouse.x < win.x + win.w &&
        mouse.y >= win.y &&
        mouse.y < win.y + win.titleH
      )
        this._windowContextMenu(win);

      // per-frame resize-bar fade state: a small bar fades in on each side
      // of the window whose outline is within `resizeBarProximity` px of
      // the cursor (dock members / edge windows resize with their dock).
      // The topmost claim (cursor + click -> drag) is resolved in endFrame.

      if (!win._dockKey && !win._edge) {
        const rb =
          win._resizeBar ||
          (win._resizeBar = {
            sides: 0,
            t: 0,
          });
        const draggingResize =
          guiState.drag &&
          guiState.drag.type === "win-resize" &&
          guiState.drag.win === win;
        const edgeNow =
          win.resizable &&
          this.flags.windowResize &&
          !win.autoResize &&
          !win.collapsed
            ? this._winResizeEdgeAt(win, mouse.x, mouse.y)
            : 0;

        if (draggingResize) {
          rb.sides = guiState.drag.edge;
          rb.t = 1;
        } else if (edgeNow) {
          rb.sides = edgeNow;
          rb.t = this.flags.animations
            ? Math.min(1, rb.t + guiState.dt / 0.12)
            : 1;
        } else {
          rb.t = this.flags.animations
            ? Math.max(0, rb.t - guiState.dt / 0.12)
            : 0;

          if (!rb.t) {
            rb.sides = 0;
          }
        }
      }
      this.pushId(win.idHash);

      // fade-in

      if (this.flags.animations && win.createdFrame === guiState.frameId) {
        win.alpha = 0;
      }
      win.alpha = this.flags.animations
        ? Math.min(
            1,
            win.alpha + guiState.dt / Math.max(0.01, this._var("fadeDuration")),
          )
        : 1;

      // ---- draw chrome (GUI layer)
      this.renderer.setLayer(Layers.GUI);
      this._applyStyleScope(win);
      const r = this._var("windowRounding");
      const alpha = win.alpha;

      if (win.modal)
        this.renderer.fillRect(
          0,
          0,
          guiState.displayW,
          guiState.displayH,
          withAlpha([0, 0, 0], 110 * alpha),
        );

      if (win._dock) {
        // docked member: plain body; the dock chrome draws border/headers
        // (_drawDockChrome may undock this window mid-frame)
        const dock = win._dock;
        this.renderer.fillRect(
          win.x,
          win.y,
          win.w,
          win.h,
          this._col("windowBg", alpha),
        );
        this._drawDockChrome(win, alpha);

        if (dock.collapsed || win.w <= 0 || win.h <= 0) {
          this._popStyleScope();
          this.popId();

          return false;
        }
      } else {
        // a collapsed window renders its header only — no body behind it
        const bodyH = win.collapsed ? win.titleH : win.h;

        if (this._var("shadow") && alpha > 0.05 && !win.collapsed) {
          const sa = this._var("shadowAlpha") * alpha;
          this.renderer.fillRoundedRect(
            win.x,
            win.y + 5,
            win.w,
            bodyH,
            r + 6,
            withAlpha([0, 0, 0], sa * 0.4),
          );
          this.renderer.fillRoundedRect(
            win.x,
            win.y + 2,
            win.w,
            bodyH,
            r + 2,
            withAlpha([0, 0, 0], sa * 0.7),
          );
        }
        this.renderer.fillRoundedRect(
          win.x,
          win.y,
          win.w,
          bodyH,
          r,
          this._col("windowBg", alpha),
        );

        if (this._var("windowBorder") > 0)
          this.renderer.strokeRoundedRect(
            win.x + 0.5,
            win.y + 0.5,
            win.w - 1,
            bodyH - 1,
            r,
            this._col("border", alpha),
            this._var("windowBorder"),
          );
      }
      const focus = win === guiState.focusedWindow;

      if (!win.noTitleBar && !win._dock) {
        const tbY = win.y,
          tbH = win.titleH;
        const tbColor =
          (guiState.drag &&
            guiState.drag.win === win &&
            guiState.drag.type === "win-move") ||
          focus
            ? this._col("titleBgActive", alpha)
            : win.collapsed
              ? this._col("titleBgCollapsed", alpha)
              : this._col("titleBg", alpha);
        const tr = Math.min(this._var("titleRounding") || r, tbH / 2);
        this.renderer.fillRoundedRect(win.x, tbY, win.w, tbH, tr, tbColor);
        this.renderer.fillRect(win.x, tbY + tbH / 2, win.w, tbH / 2, tbColor);

        if (this._var("windowBorder") > 0 && !win.collapsed)
          this.renderer.line(
            win.x + 1,
            win.y + win.h - 0.5,
            win.x + win.w - 1,
            win.y + win.h - 0.5,
            withAlpha(this._col("border", alpha), 153),
            1,
          );

        if (win.collapsible) {
          const cx = win.x + 14,
            cy = tbY + tbH / 2;
          const c = this._col(focus ? "text" : "textDisabled", alpha);

          if (win.collapsed)
            this.renderer.fillPolygon(
              [cx - 3, cy - 5, cx - 3, cy + 5, cx + 4, cy],
              c,
            );
          else
            this.renderer.fillPolygon(
              [cx - 5, cy - 3, cx + 5, cy - 3, cx, cy + 4],
              c,
            );
          // arrow button: strictly bounded hit area; pressing it toggles at once
          // (blocked while the app menu bar covers this spot; only the
          // topmost window under the mouse may toggle — a covered window's
          // chevron must not fire when its area is overlapped)

          if (
            this.isMouseClicked(0) &&
            guiState.hoveredWindow === win &&
            guiState.activeId === 0 &&
            guiState.disabledCount === 0 &&
            !guiState.appBarGrab &&
            !this._popupAtPoint(mouse.x, mouse.y) &&
            mouse.x >= win.x &&
            mouse.x <= win.x + 28 &&
            mouse.y >= tbY &&
            mouse.y < tbY + tbH
          ) {
            win.collapsed = !win.collapsed;
            win._collapseToggledAt = guiState.frameId;
          }
        }
        {
          const fontOptions = this._fo();
          const pad = win.collapsible ? 26 : 10;
          const maxW = win.w - pad - (win.closable ? 32 : 10) - 8;
          let label = win.title;

          while (
            label.length > 2 &&
            this._measure(label + "…", fontOptions).w > maxW
          )
            label = label.slice(0, -1);

          if (label !== win.title) {
            label += "…";
          }
          this._drawText(
            win.x + pad,
            tbY + (tbH - this._measure(label, fontOptions).h) / 2 + 1,
            label,
            this._col(focus ? "text" : "textDisabled", alpha),
            fontOptions,
          );
        }

        if (win.closable) {
          const bx = win.x + win.w - 26,
            by = tbY + tbH / 2;
          // s.hoveredWindow === win keeps the hover (and the press) from
          // firing when this window's close button is overlapped by another
          const hov =
            mouse.x >= bx &&
            mouse.x < bx + 18 &&
            mouse.y >= by - 7 &&
            mouse.y < by + 7 &&
            guiState.disabledCount === 0 &&
            !guiState.appBarGrab &&
            guiState.hoveredWindow === win &&
            !this._popupAtPoint(mouse.x, mouse.y);

          if (hov) {
            const c = this._col("text", alpha);

            if (
              guiState.drag &&
              guiState.drag.win === win &&
              guiState.drag.type === "closebtn"
            )
              this.renderer.fillRoundedRect(
                bx - 3,
                by - 9,
                21,
                18,
                4,
                withAlpha(this._col("error", alpha), 0.35),
              );
            this.renderer.line(bx, by - 4, bx + 8, by + 4, c, 1.4);
            this.renderer.line(bx + 8, by - 4, bx, by + 4, c, 1.4);

            if (this.isMouseClicked(0) && guiState.activeId === 0) {
              guiState.drag = {
                type: "closebtn",
                win,
                button: 0,
                rect: {
                  x: bx - 3,
                  y: by - 9,
                  w: 21,
                  h: 18,
                },
              };
              guiState.activeId = -1;
            }
          } else {
            this.renderer.line(
              bx,
              by - 4,
              bx + 8,
              by + 4,
              this._col("textDisabled", alpha),
              1.4,
            );
            this.renderer.line(
              bx + 8,
              by - 4,
              bx,
              by + 4,
              this._col("textDisabled", alpha),
              1.4,
            );
          }
        }

        // title bar hover: move cursor (only for the topmost window under the mouse)

        if (
          guiState.hoveredWindow === win &&
          win.movable &&
          this.flags.windowMove &&
          guiState.disabledCount === 0 &&
          mouse.x >= win.x &&
          mouse.x < win.x + win.w &&
          mouse.y >= tbY &&
          mouse.y < tbY + tbH
        ) {
          const inClose =
            win.closable &&
            mouse.x >= win.x + win.w - 28 &&
            mouse.x <= win.x + win.w - 6;

          if (!inClose) {
            this._setCursor("move", 1);
          }
        }
      }

      // resize grip: a small triangle in the bottom-right corner (two
      // nested diagonal strokes) — the resize handle. It highlights when the
      // cursor is in its zone; that zone also takes click priority over the
      // window's scrollbars (see _winGripRect / _drawScrollBar).

      if (win.resizable && !win.autoResize && !win.collapsed) {
        const gx = win.x + win.w,
          gy = win.y + win.h;
        const s = clamp((r || 4) * 3, 10, 14);
        const gripHot =
          !win._dockKey &&
          !win._edge &&
          this.flags.windowResize &&
          this._winResizeEdgeAt(win, mouse.x, mouse.y) === 3;
        const gc = gripHot
          ? withAlpha(this._col("sliderGrab", alpha), 255)
          : withAlpha(this._col("border", alpha), 217);
        this.renderer.line(
          gx - s,
          gy - 2,
          gx - 2,
          gy - s,
          gc,
          gripHot ? 2 : 1.2,
        );
        this.renderer.line(
          gx - s - 6,
          gy - 2,
          gx - 2,
          gy - s - 6,
          gc,
          gripHot ? 2 : 1.2,
        );
      }

      // resize bars: a small handle fades in over each side whose outline
      // is within resizeBarProximity px of the cursor; dragging it scales
      // the window in that direction. At a corner two bars show and the
      // grip resizes both dimensions at once.
      const rb = win._resizeBar;

      if (
        rb &&
        rb.sides &&
        rb.t > 0 &&
        !win._dockKey &&
        !win._edge &&
        win.resizable &&
        this.flags.windowResize &&
        !win.autoResize &&
        !win.collapsed
      ) {
        const gx = win.x + win.w,
          gy = win.y + win.h;
        const bw = 4;
        const topY = win.y + win.titleH;
        const vLen = Math.max(24, Math.min(64, (win.h - win.titleH) * 0.35));
        const hLen = Math.max(24, Math.min(64, win.w * 0.35));
        const cyV = topY + (win.h - win.titleH) / 2;
        const cxH = win.x + win.w / 2;
        const fill = withAlpha(
          this._col("sliderGrab", alpha),
          Math.round(230 * rb.t * alpha),
        );
        const lineC = withAlpha(
          this._col("border", alpha),
          Math.round(140 * rb.t * alpha),
        );
        const bar = (x, y, w, h) => {
          this.renderer.fillRoundedRect(x, y, w, h, 2, fill);
          this.renderer.strokeRoundedRect(
            x + 0.5,
            y + 0.5,
            w - 1,
            h - 1,
            2,
            lineC,
            1,
          );
        };

        if (rb.sides & 2) {
          bar(gx - bw / 2, cyV - vLen / 2, bw, vLen); // right
        }

        if (rb.sides & 8) {
          bar(win.x - bw / 2, cyV - vLen / 2, bw, vLen); // left
        }

        if (rb.sides & 1) {
          bar(cxH - hLen / 2, gy - bw / 2, hLen, bw); // bottom
        }

        if (rb.sides & 4) {
          bar(cxH - hLen / 2, win.y - bw / 2, hLen, bw); // top
        }
      }

      if (win.menuH > 0) {
        const mbY = win.y + win.titleH;
        this.renderer.fillRect(
          win.x,
          mbY,
          win.w,
          win.menuH,
          this._col("menubarBg", alpha),
        );
        this.renderer.line(
          win.x + 1,
          mbY + win.menuH - 0.5,
          win.x + win.w - 1,
          mbY + win.menuH - 0.5,
          withAlpha(this._col("border", alpha), 0.5),
          1,
        );
        guiState.menuBar = {
          win,
          x: win.x + 10,
          y: mbY + (win.menuH - this._lineH()) / 2,
          h: win.menuH,
        };
      }

      if (win.collapsed) {
        this._popStyleScope();
        this.popId();

        return false;
      }

      // content region + clip
      const contentY = win.y + win.titleH + win.menuH;
      const contentH = win.h - win.titleH - win.menuH;

      if (!win.noClip) {
        this.renderer.pushClip(win.x, contentY, win.w, contentH);
      }
      const sbv = win.hadScrollV ? this._var("scrollbarSize") : 0;
      const sbh = win.hadScrollH ? this._var("scrollbarSize") : 0;

      // resolve the scroll target before layout so this frame's positions
      // already reflect any wheel/scrollbar delta from beginFrame

      if (this.flags.animations) {
        win.scrollX = lerp(
          win.scrollX,
          win.scrollTargetX,
          clamp(guiState.dt * 18, 0, 1),
        );
        win.scrollY = lerp(
          win.scrollY,
          win.scrollTargetY,
          clamp(guiState.dt * 18, 0, 1),
        );
      } else {
        win.scrollX = win.scrollTargetX;
        win.scrollY = win.scrollTargetY;
      }
      win.scrollX = clamp(win.scrollX, 0, win.maxScrollX);
      win.scrollY = clamp(win.scrollY, 0, win.maxScrollY);
      this._newLayout(
        win,
        win.x + win.padX,
        contentY + win.padY,
        win.w - win.padX * 2 - sbv,
        contentH - win.padY * 2 - sbh,
      );
      win.visibleContentW = win.w - win.padX * 2 - sbv;
      win.visibleContentH = contentH - win.padY * 2 - sbh;

      if (!win.noScrollbar)
        guiState.scrollStack.push({
          win,
          rect: {
            x: win.x,
            y: win.y + win.titleH,
            w: win.w,
            h: win.h - win.titleH,
          },
          frame: guiState.frameId,
        });

      if (win.modal) {
        guiState.modalWin = win;
      }
      guiState.currentWindow = win;

      return true;
    }

    /**
     * Closes the window opened by beginWindow: draws the frame, shadow,
     *   * scrollbars and title bar.
     */
    endWindow() {
      const guiState = this.state;
      const win = guiState.currentWindow;

      if (!win) {
        return;
      }
      const layout = guiState.layout;
      win.contentW = layout.contentRight;
      win.contentH = Math.max(layout.y, 1);
      const visW = win.visibleContentW;
      const visH = win.visibleContentH;
      win.maxScrollX = win.allowScrollX
        ? Math.max(0, win.contentW + win.padX - visW)
        : 0;
      win.maxScrollY = Math.max(0, win.contentH + win.padY - visH);
      win.hadScrollV =
        win.maxScrollY > 0 && !win.noScrollbar && !win.autoResize;
      win.hadScrollH =
        win.maxScrollX > 0 &&
        win.allowScrollX &&
        !win.noScrollbar &&
        !win.autoResize;

      if (win.autoResize) {
        const targetW = win.contentW + win.padX * 2;
        const targetH = win.contentH + win.padY * 2 + win.titleH + win.menuH;

        if (this.flags.animations) {
          win.w = lerp(win.w, clamp(targetW, win.minW, win.maxW), 0.35);
          win.h = lerp(win.h, clamp(targetH, win.minH, win.maxH), 0.35);
        } else {
          win.w = clamp(targetW, win.minW, win.maxW);
          win.h = clamp(targetH, win.minH, win.maxH);
        }
      }

      if (guiState.treeLines.length) {
        const bottom = layout.origin.y + layout.y - layout.scroll.y;

        for (const tl of guiState.treeLines) {
          this.renderer.line(
            tl.x + 0.5,
            tl.y0 + 0.5,
            tl.x + 0.5,
            Math.max(tl.y0 + 4, bottom),
            withAlpha(this._col("border"), 0.7),
            1,
          );
        }
      }

      if (!win.noScrollbar) {
        if (win.maxScrollY > 0)
          this._drawScrollBar(
            win,
            "v",
            win.x + win.w - this._var("scrollbarSize") + 1,
            win.y + win.titleH + 1,
            win.h - win.titleH - 2,
            this._var("scrollbarSize"),
            win.contentH + win.padY,
            visH,
          );

        if (win.maxScrollX > 0)
          this._drawScrollBar(
            win,
            "h",
            win.x + 1,
            win.y + win.h - this._var("scrollbarSize") + 1,
            win.w - 2,
            this._var("scrollbarSize"),
            win.contentW + win.padX,
            visW,
          );
      }

      if (!win.noClip) {
        this.renderer.popClip();
      }
      this._popStyleScope();
      this.popId();
      guiState.currentWindow = null;
    }
    _newLayout(container, ox, oy, availW, availH) {
      const L = {
        container,
        origin: {
          x: ox,
          y: oy,
        },
        x: 0,
        y: 0,
        lineStartX: 0,
        lineY: 0,
        lineBottom: 0,
        lineActive: false,
        _same: false,
        prevRight: 0,
        indent: 0,
        sameLine: null,
        scroll: {
          x: container.scrollX || 0,
          y: container.scrollY || 0,
        },
        avail: {
          w: availW,
          h: availH,
        },
        contentRight: 0,
        itemCount: 0,
      };
      this.state.layout = L;

      return L;
    }
    _drawScrollBar(
      win,
      axis,
      trackX,
      trackY,
      trackLen,
      trackThick,
      content,
      visible,
    ) {
      if (content <= visible + 0.5) {
        return;
      }
      const guiState = this.state;
      const sb = this._var("scrollbarSize");
      const rb = this._var("scrollbarRounding");
      const isV = axis === "v";
      const range = content - visible;
      const grabLen = Math.max(
        this._var("grabMinSize"),
        (visible / content) * trackLen,
      );
      const cur = isV ? win.scrollY : win.scrollX;
      const grabStart = trackY + (cur / range) * (trackLen - grabLen);
      const grabRect = isV
        ? {
            x: trackX + (trackThick - sb) / 2,
            y: grabStart,
            w: sb - 2,
            h: grabLen,
          }
        : {
            x: grabStart,
            y: trackY + (trackThick - sb) / 2,
            w: grabLen,
            h: sb - 2,
          };

      if (isV)
        this.renderer.fillRoundedRect(
          trackX + 1,
          trackY + 1,
          sb - 2,
          trackLen - 2,
          rb,
          this._col("scrollbarBg"),
        );
      else
        this.renderer.fillRoundedRect(
          trackX + 1,
          trackY + 1,
          trackLen - 2,
          sb - 2,
          rb,
          this._col("scrollbarBg"),
        );
      const mouse = guiState.mouse;
      const hov = pointInRect(mouse.x, mouse.y, grabRect);
      const dragging =
        guiState.drag &&
        guiState.drag.type === "scroll-" + axis &&
        guiState.drag.win === win;
      const grabColor = dragging
        ? this._col("scrollbarGrabActive")
        : hov
          ? this._col("scrollbarGrabHovered")
          : this._col("scrollbarGrab");
      this.renderer.fillRoundedRect(
        grabRect.x,
        grabRect.y,
        grabRect.w,
        grabRect.h,
        rb,
        grabColor,
      );
      const trackRect = isV
        ? {
            x: trackX + 1,
            y: trackY + 1,
            w: sb - 2,
            h: trackLen - 2,
          }
        : {
            x: trackX + 1,
            y: trackY + 1,
            w: trackLen - 2,
            h: sb - 2,
          };
      // the corner grip zone takes click priority over the scrollbar

      if (
        this.isMouseClicked(0) &&
        this._canReceiveInput(win) &&
        guiState.hoveredWindow === (win.owner || win) &&
        !this._popupAtPoint(mouse.x, mouse.y) &&
        pointInRect(mouse.x, mouse.y, trackRect) &&
        !pointInRect(mouse.x, mouse.y, this._winGripRect(win))
      ) {
        const along = isV ? mouse.y : mouse.x;
        const grabCenter = grabStart + grabLen / 2;
        guiState.drag = {
          type: "scroll-" + axis,
          win,
          button: 0,
          grabOffset: along - grabCenter,
          grabLen,
          range,
          trackLen,
        };
        guiState.activeId = -1;

        if (!hov) {
          const t = clamp(
            (along - trackY - grabLen / 2) / Math.max(1, trackLen - grabLen),
            0,
            1,
          );
          win["scrollTarget" + (isV ? "Y" : "X")] = t * range;
        }
      }

      if (
        guiState.drag &&
        guiState.drag.type === "scroll-" + axis &&
        guiState.drag.win === win
      )
        if (this.isMouseDown(0)) {
          const d = guiState.drag;
          const along = isV ? mouse.y : mouse.x;
          const t = clamp(
            (along - d.grabOffset - trackY) / Math.max(1, trackLen - grabLen),
            0,
            1,
          );
          win["scrollTarget" + (isV ? "Y" : "X")] = t * range;
        } else {
          guiState.drag = null;
          guiState.activeId = 0;
        }
    }

    /* ---------------------------- child regions ------------------------ */

    /**
     * Starts a scrollable child region inside the current window (its own
     *   * clip, scroll and id scope).
     * @param {string} label id label (##-prefixed for label-less)
     * @param {Object} [opts] { border, size, scrollX }
     * @returns {boolean} false when no window is open, otherwise true
     */
    beginChild(label, opts) {
      opts = opts || {};
      const guiState = this.state;
      const parent = guiState.currentWindow;

      if (!parent) {
        return false;
      }
      const ids = this._id(String(label == null ? "##child" : label));
      const key = "\x01child\x01" + ids.stateKey;
      let win = guiState.windows.get(key);

      if (!win) {
        win = new Window(key, "child");
        guiState.windows.set(key, win);
      }
      win.owner = parent.owner;
      win.open = true;
      const avail = this.getRegionAvail();
      const pos = this._nextPos();
      let w = opts.w == null ? 0 : opts.w;
      let h = opts.h == null ? 0 : opts.h;

      if (w === 0) {
        w = avail.w;
      } else if (w < 0) w = avail.w + w;

      if (h === 0) {
        h = avail.h;
      } else if (h < 0) h = avail.h + h;
      w = Math.max(10, w);
      h = Math.max(10, h);
      win.x = pos.x;
      win.y = pos.y;
      win.w = w;
      win.h = h;
      win.padX = opts.padding != null ? opts.padding : 6;
      win.padY = win.padX;
      win.titleH = 0;
      win.menuH = 0;
      win.movable = false;
      win.resizable = false;
      win.collapsible = false;
      win.noTitleBar = true;
      win.noClip = !!opts.noClip;
      win.noScrollbar = !!(opts.scrollY === false || opts.noScrollbar);
      win.allowScrollX = !!opts.scrollX;
      win.autoResize = false;
      win.collapsed = false;
      win.flags = 0;
      win.drawnFrame = guiState.frameId;
      this.pushId(ids.itemId);

      // draw child background
      const cr = this._var("childRounding");
      this.renderer.fillRoundedRect(
        win.x,
        win.y,
        win.w,
        win.h,
        cr,
        this._col("childBg"),
      );

      if (opts.border !== false && this._var("childBorder") > 0)
        this.renderer.strokeRoundedRect(
          win.x + 0.5,
          win.y + 0.5,
          win.w - 1,
          win.h - 1,
          cr,
          this._col("border"),
          1,
        );
      const cw = win.w - win.padX * 2;
      const ch = win.h - win.padY * 2;

      if (!win.noClip) {
        this.renderer.pushClip(win.x, win.y, win.w, win.h);
      }

      // resolve the scroll target before layout (endChild recomputes
      // maxScroll from the fresh content and clamps again)

      if (this.flags.animations) {
        win.scrollX = lerp(
          win.scrollX,
          win.scrollTargetX,
          clamp(guiState.dt * 18, 0, 1),
        );
        win.scrollY = lerp(
          win.scrollY,
          win.scrollTargetY,
          clamp(guiState.dt * 18, 0, 1),
        );
      } else {
        win.scrollX = win.scrollTargetX;
        win.scrollY = win.scrollTargetY;
      }
      win.scrollY = clamp(win.scrollY, 0, win.maxScrollY);
      win.scrollX = clamp(win.scrollX, 0, win.maxScrollX);
      const L0 = guiState.layout;
      this._newLayout(win, win.x + win.padX, win.y + win.padY, cw, ch);
      win.visibleContentW = cw;
      win.visibleContentH = ch;
      // fill (no advance) only when the child takes the WHOLE remaining
      // region — the default h=0 case. Smaller children advance normally.
      win._childFillH = Math.abs(h - avail.h) < 0.01;

      if (!win.noScrollbar)
        guiState.scrollStack.push({
          win,
          rect: {
            x: win.x,
            y: win.y,
            w: win.w,
            h: win.h,
          },
          frame: guiState.frameId,
        });
      guiState.savedLayout.push(L0);
      guiState._childReturn = {
        win,
        h,
      };
      guiState.currentWindow = win;

      return true;
    }

    /**
     * Ends the child region started with beginChild().
     */
    endChild() {
      const guiState = this.state;
      const win = guiState.currentWindow;

      if (!win) {
        return;
      }
      const layout = guiState.layout;
      win.contentW = layout.contentRight;
      win.contentH = Math.max(layout.y, 1);
      const visH = win.visibleContentH;
      const visW = win.visibleContentW;
      win.maxScrollY = Math.max(0, win.contentH + win.padY - visH);
      win.maxScrollX = win.allowScrollX
        ? Math.max(0, win.contentW + win.padX - visW)
        : 0;
      // re-clamp after the fresh maxScroll (scroll was resolved in beginChild)
      win.scrollY = clamp(win.scrollY, 0, win.maxScrollY);
      win.scrollX = clamp(win.scrollX, 0, win.maxScrollX);
      win.hadScrollV = win.maxScrollY > 0 && !win.noScrollbar;

      if (win.maxScrollY > 0)
        this._drawScrollBar(
          win,
          "v",
          win.x + win.w - this._var("scrollbarSize") + 1,
          win.y + 1,
          win.h - 2,
          this._var("scrollbarSize"),
          win.contentH + win.padY,
          visH,
        );

      if (!win.noClip) {
        this.renderer.popClip();
      }
      this.popId();
      const prev = guiState.savedLayout.pop();
      guiState.layout = prev;
      const info = guiState._childReturn;

      if (info && prev) {
        const cx = win.x - prev.origin.x + prev.scroll.x;
        const cy = win.y - prev.origin.y + prev.scroll.y;

        if (win._childFillH) {
          prev.lineActive = false;
          prev.x = cx - prev.indent;
          prev.y = prev.avail.h;
          prev.contentRight = Math.max(prev.contentRight, cx + win.w);
        } else {
          this._advance(win.x, win.y, win.w, win.h);
        }
      }
      guiState.currentWindow = prev ? prev.container : null;
    }

    /* ---------------------------- popups -------------------------------
     * Two kinds of popups:
     *  - system popups (combo lists, menus, value entry): data driven,
     *    drawn automatically in endFrame, so they always render on top.
     *  - custom popups (beginPopup/endPopup, context menus): user content,
     *    drawn inline at the call site. Follow the ImGui convention and call
     *    them at top level, after your windows, so they stay on top.
     * -------------------------------------------------------------------- */

    _openPopup(id, anchor, data, sourceId, owner) {
      const guiState = this.state;

      if (guiState.popups.has(id)) {
        return guiState.popups.get(id);
      }
      const p = {
        id,
        kind: "popup",
        open: true,
        ox: anchor.x,
        oy: anchor.y,
        x: anchor.x,
        y: anchor.y,
        w: 0,
        h: 0,
        data: data || {},
        sourceId: sourceId || 0,
        owner:
          owner ||
          (guiState.currentWindow
            ? guiState.currentWindow.owner || guiState.currentWindow
            : guiState.hoveredWindow) ||
          null,
        frame: guiState.frameId,
      };
      guiState.popups.set(id, p);
      guiState.popupList.push(p);

      return p;
    }
    /**
     * Opens a popup anchored near (x, y).
     * @param {string} id
     * @param {Object} anchor {x, y}
     * @param {Object} [opts] { kind, owner }
     */
    openPopup(id, anchor, opts) {
      opts = opts || {};

      return this._openPopup(
        id,
        anchor,
        {
          type: opts.kind || "custom",
        },
        opts.sourceId || 0,
        opts.owner || null,
      );
    }
    /**
     * Closes the popup with the given id (no-op when it is not open).
     * @param {string} id
     */
    closePopup(id) {
      const p = this.state.popups.get(id);

      if (p) {
        p.open = false;
      }
    }
    /**
     * True when the popup with the given id is open.
     * @param {string} id
     * @returns {boolean}
     */
    isPopupOpen(id) {
      const p = this.state.popups.get(id);

      return !!(p && p.open);
    }

    /**
     * Begins drawing the contents of an open popup.
     * @param {string} id
     * @returns {boolean} false when the popup is not open, otherwise true
     */
    beginPopup(id) {
      const guiState = this.state;
      const p = guiState.popups.get(id);

      if (!p || !p.open || guiState.popupLayoutActive) {
        return false;
      }
      const isTip = p.data.type === "tooltip";

      if (isTip) {
        p.ox = guiState.mouse.x + 14;
        p.oy = guiState.mouse.y + 18;
      }

      if (p.w <= 0) {
        p.x = p.ox;
        p.y = p.oy;
        p.w = 150;
        p.h = 80;
      } // first-frame estimate
      this.renderer.setLayer(isTip ? Layers.Foreground : Layers.GUI);
      const bgc = isTip ? this._col("tooltipBg") : this._col("popupBg");
      this.renderer.fillRoundedRect(
        p.x,
        p.y,
        p.w,
        p.h,
        this._var("popupRounding"),
        bgc,
      );
      this.renderer.strokeRoundedRect(
        p.x + 0.5,
        p.y + 0.5,
        p.w - 1,
        p.h - 1,
        this._var("popupRounding"),
        this._col("border"),
        this._var("popupBorder"),
      );
      this.renderer.pushClip(
        p.x + 1,
        p.y + 1,
        Math.max(1, p.w - 2),
        Math.max(1, p.h - 2),
      );
      guiState.savedLayout.push(guiState.layout);
      this._newLayout(p, p.x + 8, p.y + 6, 4000, 4000);
      guiState.popupLayoutActive = p;
      guiState.currentWindow = p;

      return true;
    }
    /* Convert a declarative menu config (setAppMenuBar) into the row shape
     * that _drawMenuPopup renders. Nested `items` become data-driven submenus. */
    _appMenuRows(list, idSeed) {
      const rows = [];

      for (const m of list || []) {
        if (!m) {
          continue;
        }

        if (m.sep || m.type === "sep") {
          rows.push({
            type: "sep",
          });
          continue;
        }
        const disabled =
          typeof m.disabled === "function" ? m.disabled() : !!m.disabled;
        const label = String(m.label != null ? m.label : "");

        if (m.items && m.items.length)
          rows.push({
            type: "submenu",
            label,
            subId: "##appsub" + fnv1a(idSeed + "\x01" + label),
            shortcut: m.shortcut || "",
            disabled,
            items: m.items,
          });
        else {
          rows.push({
            type: "item",
            label,
            shortcut: m.shortcut || "",
            selected:
              typeof m.selected === "function" ? m.selected() : !!m.selected,
            disabled,
            onActivated:
              typeof m.onActivated === "function" ? m.onActivated : null,
          });
        }
      }

      return rows;
    }

    /* Draw the app menu bar strip (above all windows). Section geometry is
     * computed in beginFrame into state.appMenuSections; dropdowns are the
     * normal menu popups, drawn by the popup pass after this strip. */
    _drawAppMenuBar() {
      const guiState = this.state;
      const am = guiState.appMenu;

      if (!am || !guiState.appBarRect) {
        return;
      }
      const R = guiState.appBarRect;
      const fontOptions = this._fo();
      const lineH = this._lineH();
      this.renderer.setLayer(Layers.GUI);
      this.renderer.fillRoundedRect(
        R.x,
        R.y,
        R.w,
        R.h,
        0,
        this._col("menubarBg"),
      );
      const bc = this._col("border");

      if (am.pos === "top")
        this.renderer.line(
          R.x,
          R.y + R.h - 0.5,
          R.x + R.w,
          R.y + R.h - 0.5,
          bc,
          1,
        );
      else if (am.pos === "bottom")
        this.renderer.line(R.x, R.y + 0.5, R.x + R.w, R.y + 0.5, bc, 1);
      else if (am.pos === "left")
        this.renderer.line(
          R.x + R.w - 0.5,
          R.y,
          R.x + R.w - 0.5,
          R.y + R.h,
          bc,
          1,
        );
      else this.renderer.line(R.x + 0.5, R.y, R.x + 0.5, R.y + R.h, bc, 1);

      for (const sec of guiState.appMenuSections) {
        const hov =
          guiState.mouse.x >= sec.rect.x &&
          guiState.mouse.x < sec.rect.x + sec.rect.w &&
          guiState.mouse.y >= sec.rect.y &&
          guiState.mouse.y < sec.rect.y + sec.rect.h;

        if (sec.open || hov)
          this.renderer.fillRoundedRect(
            sec.rect.x,
            sec.rect.y,
            sec.rect.w,
            sec.rect.h,
            4,
            this._col(sec.open ? "headerActive" : "headerHovered"),
          );
        this._drawText(
          sec.rect.x + 9,
          sec.rect.y + (sec.rect.h - lineH) / 2 + 1,
          sec.label,
          this._col("text"),
          fontOptions,
        );
      }
    }

    /**
     * Ends the popup contents started with beginPopup().
     */
    endPopup() {
      const guiState = this.state;
      const p = guiState.popupLayoutActive;

      if (!p) {
        return;
      }
      const layout = guiState.layout;
      const w = Math.max(40, layout.contentRight + 16);
      const h = Math.max(30, layout.y + 12);
      p.x = clamp(p.ox, 4, Math.max(4, guiState.displayW - w - 4));
      p.y = clamp(p.oy, 4, Math.max(4, guiState.displayH - h - 4));
      p.w = w;
      p.h = h;
      this.renderer.popClip();
      const prev = guiState.savedLayout.pop();
      guiState.layout = prev;
      guiState.popupLayoutActive = null;
      guiState.currentWindow = prev ? prev.container : null;
    }

    /**
     * Opens a context popup on right-click of the current window (or of the
     *   * hovered item when no window is open).
     * @param {string} id
     * @returns {boolean} true when the popup was opened this frame
     */
    beginPopupContextWindow(id) {
      const guiState = this.state;
      const win = guiState.currentWindow;

      if (win && win.kind === "window" && !guiState.popups.has(id)) {
        const mouse = guiState.mouse;
        const contentRect = {
          x: win.x,
          y: win.y + win.titleH,
          w: win.w,
          h: win.h - win.titleH,
        };

        if (
          this.isMouseClicked(1) &&
          guiState.activeId === 0 &&
          !guiState.drag &&
          guiState.hoveredWindow === (win.owner || win) &&
          pointInRect(mouse.x, mouse.y, contentRect)
        )
          this._openPopup(
            id,
            {
              x: mouse.x,
              y: mouse.y,
            },
            {
              type: "custom",
            },
            0,
            win.owner || win,
          );
      }

      return this.beginPopup(id);
    }
    /**
     * Opens a context popup on right-click of the last item.
     * @param {string} id
     * @returns {boolean} true when the popup was opened this frame
     */
    beginPopupContextItem(id) {
      const guiState = this.state;
      const item = guiState.lastItem;

      if (
        item &&
        !guiState.popups.has(id) &&
        this.isMouseClicked(1) &&
        item.hovered &&
        guiState.activeId === 0 &&
        !guiState.drag
      )
        this._openPopup(
          id,
          {
            x: guiState.mouse.x,
            y: guiState.mouse.y + 4,
          },
          {
            type: "custom",
          },
          item.itemId,
          item.win ? item.win.owner || item.win : null,
        );

      return this.beginPopup(id);
    }
    _popupPass() {
      const guiState = this.state;

      // dismiss on outside click (popups opened by this very click are exempt:
      // their rect is not laid out yet and the click point is the source)

      if (this.isMouseClicked(0) && guiState.popupList.length) {
        const mouse = guiState.mouse;
        let inside = false;

        for (const p of guiState.popupList) {
          if (!p.open || p.frame === guiState.frameId) {
            continue;
          }

          if (
            p.w > 0 &&
            pointInRect(mouse.x, mouse.y, {
              x: p.x,
              y: p.y,
              w: p.w,
              h: p.h,
            })
          )
            inside = true;
        }

        if (!inside)
          for (const p of guiState.popupList) {
            if (
              p.open &&
              p.frame !== guiState.frameId &&
              p.sourceId !== guiState.clickedItemId
            )
              p.open = false;
          }
      }

      if (guiState.popupList.length) {
        guiState.popupList = guiState.popupList.filter((p) => p.open);

        for (const [k, p] of guiState.popups)
          if (!p.open) guiState.popups.delete(k);
      }

      // app menu bar strip (under its dropdowns, above all windows)

      if (guiState.appMenu) {
        this._drawAppMenuBar();
      }

      // draw system popups (dynamic length: submenus may open mid-pass)
      this.renderer.setLayer(Layers.GUI);

      for (let i = 0; i < guiState.popupList.length; i++) {
        const p = guiState.popupList[i];

        if (!p.open) {
          continue;
        }

        if (p.data.type === "menu") {
          this._drawMenuPopup(p);
        } else if (p.data.type === "combo") this._drawComboPopup(p);
        else if (p.data.type === "value") this._drawValuePopup(p);
      }
    }
    _popupLayout(p, x, y, w, h) {
      const guiState = this.state;
      const old = guiState.layout;
      const prevClaim = guiState.hoveredWindow;
      guiState.savedLayout.push(old);
      this._newLayout(p, x, y, w, h);

      if (p.owner) {
        guiState.hoveredWindow = p.owner;
      }

      return prevClaim;
    }
    _endPopupLayout(p, prevClaim) {
      const guiState = this.state;
      const prev = guiState.savedLayout.pop();
      guiState.layout = prev;
      guiState.hoveredWindow = prevClaim;
    }
    _drawMenuPopup(p) {
      const guiState = this.state;
      const rows = p.data.items || [];
      const fontOptions = this._fo();
      const lineH = this._lineH();
      const rowH = lineH + 10;
      const pad = 6;
      let w = p.data.width || 140;

      for (const r of rows) {
        if (r.type === "sep") {
          continue;
        }
        const lw = this._measure(r.label, fontOptions).w;
        const sw = r.shortcut ? this._measure(r.shortcut, fontOptions).w : 0;
        w = Math.max(
          w,
          lw +
            sw +
            (r.type === "submenu" ? 20 : 0) +
            (r.selected ? 20 : 0) +
            26,
        );
      }
      w = clamp(w, 120, 340);
      const h = rows.length * rowH + pad * 2;
      let x = clamp(p.ox, 4, Math.max(4, guiState.displayW - w - 4));
      let y = p.oy;

      if (y + h > guiState.displayH - 4) {
        y = Math.max(4, p.oy - h - 4);
      }
      p.x = x;
      p.y = y;
      p.w = w;
      p.h = h;
      this.renderer.fillRoundedRect(
        x,
        y,
        w,
        h,
        this._var("popupRounding"),
        this._col("popupBg"),
      );
      this.renderer.strokeRoundedRect(
        x + 0.5,
        y + 0.5,
        w - 1,
        h - 1,
        this._var("popupRounding"),
        this._col("border"),
        this._var("popupBorder"),
      );
      this.renderer.pushClip(x + 1, y + 1, w - 2, h - 2);
      const prevClaim = this._popupLayout(
        p,
        x + pad,
        y + pad,
        w - pad * 2,
        h - pad * 2,
      );

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];
        const ry = y + pad + i * rowH;

        if (r.type === "sep") {
          this.renderer.line(
            x + 4,
            ry + rowH / 2 + 0.5,
            x + w - 4,
            ry + rowH / 2 + 0.5,
            this._col("separator"),
            1,
          );
          continue;
        }
        const itemId = hash3(fnv1a(p.id), 0x9e37, i);
        const item = this._item(x + 4, ry, w - 8, rowH - 2, itemId);

        if (item.hovered && this.isMouseClicked(0) && !r.disabled) {
          if (typeof r.onActivated === "function") {
            r.onActivated();
          }

          for (const q of guiState.popupList) q.open = false;
        }

        if (item.visible) {
          if (item.hovered && !r.disabled)
            this.renderer.fillRoundedRect(
              x + 4,
              ry,
              w - 8,
              rowH - 2,
              4,
              this._col("headerHovered"),
            );
          else if (item.active && !r.disabled)
            this.renderer.fillRoundedRect(
              x + 4,
              ry,
              w - 8,
              rowH - 2,
              4,
              this._col("headerActive"),
            );
          const tx = x + 10 + (r.selected ? 16 : 0);

          if (r.selected) {
            const cx = x + 12,
              cy = ry + (rowH - 2) / 2;
            this.renderer.polyline(
              [cx - 3, cy, cx - 1, cy + 3, cx + 4, cy - 3],
              this._col("checkMark"),
              1.6,
            );
          }
          const tc = r.disabled ? this._col("textDisabled") : this._col("text");
          this._drawText(
            tx,
            ry + (rowH - 2 - lineH) / 2,
            r.label,
            tc,
            fontOptions,
          );

          if (r.shortcut) {
            const m = this._measure(r.shortcut, fontOptions);
            this._drawText(
              x + w - 10 - m.w,
              ry + (rowH - 2 - lineH) / 2,
              r.shortcut,
              this._col("textDisabled"),
              fontOptions,
            );
          }

          if (r.type === "submenu") {
            const ax = x + w - 16,
              ay = ry + (rowH - 2) / 2;
            this.renderer.fillPolygon(
              [ax, ay - 4, ax, ay + 4, ax + 5, ay],
              this._col("textDisabled"),
            );
          }
        }

        if (
          r.type === "submenu" &&
          item.hovered &&
          !r.disabled &&
          !this.isMouseClicked(0)
        ) {
          const sub = guiState.popups.get(r.subId);

          if (!sub || !sub.open)
            this._openPopup(
              r.subId,
              {
                x: x + w - 8,
                y: ry + 2,
              },
              {
                type: "menu",
                items: [],
              },
              itemId,
              p.owner,
            );
          // fully data-driven submenus (app menu bar): fill the rows once
          const sub2 = guiState.popups.get(r.subId);

          if (sub2 && sub2.open && sub2.data.items.length === 0 && r.items)
            sub2.data.items.push(...this._appMenuRows(r.items, r.subId));
        }
      }
      this._endPopupLayout(p, prevClaim);
      this.renderer.popClip();
    }
    _drawComboPopup(p) {
      const guiState = this.state;
      const items = p.data.items || [];
      const fontOptions = this._fo();
      const lineH = this._lineH();
      const rowH = lineH + 10;
      const pad = 6;
      const maxVis = p.data.maxVisible || 8;
      const visRows = Math.min(items.length, maxVis);
      const w = clamp(p.data.width || 160, 80, 400);
      const h = visRows * rowH + pad * 2;
      const x = clamp(p.ox, 4, Math.max(4, guiState.displayW - w - 4));
      const y = clamp(p.oy, 4, Math.max(4, guiState.displayH - h - 4));
      p.x = x;
      p.y = y;
      p.w = w;
      p.h = h;

      // scrolling
      p.maxScroll = Math.max(0, (items.length - visRows) * rowH);

      if (p.scrollTargetY == null) {
        p.scrollTargetY = 0;
        p.scrollY = 0;
      }
      p.scrollY = lerp(p.scrollY, p.scrollTargetY, 0.55);
      p.scrollTargetY = clamp(p.scrollTargetY, 0, p.maxScroll);
      p.scrollY = clamp(p.scrollY, 0, p.maxScroll);

      // type-ahead

      if (!guiState.textConsumed && guiState.textInput && p.open) {
        guiState.textConsumed = true;
        p.typeChar = (p.typeChar || "") + guiState.textInput[0].toLowerCase();
        p.typeTime = guiState.now;

        for (let i = 0; i < items.length; i++) {
          if (String(items[i]).toLowerCase().indexOf(p.typeChar) === 0) {
            p.hi = i;
            break;
          }
        }
      }

      if (p.typeChar && guiState.now - p.typeTime > 800) {
        p.typeChar = null;
        p.hi = -1;
      }
      this.renderer.fillRoundedRect(
        x,
        y,
        w,
        h,
        this._var("popupRounding"),
        this._col("popupBg"),
      );
      this.renderer.strokeRoundedRect(
        x + 0.5,
        y + 0.5,
        w - 1,
        h - 1,
        this._var("popupRounding"),
        this._col("border"),
        this._var("popupBorder"),
      );
      this.renderer.pushClip(x + 1, y + 1, w - 2, h - 2);
      const prevClaim = this._popupLayout(
        p,
        x + pad,
        y + pad,
        w - pad * 2,
        h - pad * 2,
      );
      const cur = p.data.value();
      const first = Math.floor(p.scrollY / rowH);

      for (let i = first; i < Math.min(items.length, first + visRows); i++) {
        const ry = y + pad + (i - first) * rowH;
        const itemId = hash3(fnv1a(p.id), 0x6c0b, i);
        const item = this._item(x + pad, ry, w - pad * 2, rowH - 2, itemId);

        if (item.hovered) {
          p.hi = i;
        }

        if (item.hovered && this.isMouseClicked(0)) {
          p.data.set(i);
          p.open = false;
        }

        if (item.visible) {
          if (i === cur)
            this.renderer.fillRoundedRect(
              x + pad,
              ry,
              w - pad * 2,
              rowH - 2,
              4,
              this._col("header"),
            );
          else if (item.hovered)
            this.renderer.fillRoundedRect(
              x + pad,
              ry,
              w - pad * 2,
              rowH - 2,
              4,
              this._col("headerHovered"),
            );

          if (i === cur) {
            const cx = x + pad + 8,
              cy = ry + (rowH - 2) / 2;
            this.renderer.polyline(
              [cx - 3, cy, cx - 1, cy + 3, cx + 4, cy - 3],
              this._col("checkMark"),
              1.6,
            );
          }
          let str = String(items[i]);
          const maxW = w - pad * 2 - (i === cur ? 22 : 8);

          while (
            str.length > 2 &&
            this._measure(str + "…", fontOptions).w > maxW
          )
            str = str.slice(0, -1);

          if (str !== String(items[i])) {
            str += "…";
          }
          this._drawText(
            x + pad + (i === cur ? 20 : 8),
            ry + (rowH - 2 - lineH) / 2,
            str,
            this._col("text"),
            fontOptions,
          );
        }
      }
      // enter selects the highlighted row

      if (p.hi >= 0 && this.isKeyPressed("enter")) {
        p.data.set(p.hi);
        p.open = false;
      }
      this._endPopupLayout(p, prevClaim);
      this.renderer.popClip();

      if (p.maxScroll > 0) {
        const sb = this._var("scrollbarSize");
        const grabH = Math.max(
          this._var("grabMinSize"),
          (visRows / items.length) * (h - 2),
        );
        const grabY = y + 1 + (p.scrollY / p.maxScroll) * (h - 2 - grabH);
        this.renderer.fillRoundedRect(
          x + w - sb + 1,
          y + 1,
          sb - 2,
          h - 2,
          this._var("scrollbarRounding"),
          this._col("scrollbarBg"),
        );
        this.renderer.fillRoundedRect(
          x + w - sb + 2,
          grabY,
          sb - 4,
          grabH,
          this._var("scrollbarRounding"),
          this._col("scrollbarGrab"),
        );
      }
    }
    _drawValuePopup(p) {
      const guiState = this.state;
      const d = p.data;
      const fontOptions = this._fo();
      const lineH = this._lineH();
      const pad = 8;
      const fieldH = lineH + 10;
      const labelH = d.label ? lineH + 4 : 0;
      const w = 150;
      const h = pad * 2 + labelH + fieldH;
      const x = clamp(p.ox, 4, Math.max(4, guiState.displayW - w - 4));
      const y = clamp(p.oy, 4, Math.max(4, guiState.displayH - h - 4));
      p.x = x;
      p.y = y;
      p.w = w;
      p.h = h;
      this.renderer.fillRoundedRect(
        x,
        y,
        w,
        h,
        this._var("popupRounding"),
        this._col("popupBg"),
      );
      this.renderer.strokeRoundedRect(
        x + 0.5,
        y + 0.5,
        w - 1,
        h - 1,
        this._var("popupRounding"),
        this._col("border"),
        this._var("popupBorder"),
      );
      this.renderer.pushClip(x + 1, y + 1, w - 2, h - 2);
      const prevClaim = this._popupLayout(
        p,
        x + pad,
        y + pad,
        w - pad * 2,
        h - pad * 2,
      );

      if (d.label)
        this._drawText(
          x + pad,
          y + pad,
          d.label,
          this._col("textDisabled"),
          fontOptions,
        );
      const fy = y + pad + labelH;
      const fw = w - pad * 2;
      const itemId = hash3(fnv1a(p.id), 0x745a, 1);
      const item = this._item(x + pad, fy, fw, fieldH, itemId);
      const step = (d.max - d.min) / 100;
      const k = (t) => this.isKeyPressed(t);

      if (item.hovered && this.isMouseClicked(0)) {
        guiState.focusedId = itemId;
        guiState.activeId = itemId;
        d.editing = true;
        d.buf = ""; // start with an empty buffer; typing replaces the value
        d.caret = 0;
      }

      if (d.editing) {
        if (k("enter")) {
          const v = parseFloat(d.buf);

          if (isFinite(v)) {
            d.set(clamp(v, d.min, d.max));
          }
          p.open = false;
        } else if (k("escape")) {
          p.open = false;
          d.editing = false;
        } else if (k("left")) {
          d.caret = Math.max(0, d.caret - 1);
        } else if (k("right")) d.caret = Math.min(d.buf.length, d.caret + 1);
        else if (k("backspace") && d.caret > 0) {
          d.buf = d.buf.slice(0, d.caret - 1) + d.buf.slice(d.caret);
          d.caret = d.caret - 1;
        } else if ((k("up") || k("right")) && this.ctrl) {
          d.set(clamp(d.value() + step * 10, d.min, d.max));
          d.buf = fmtVal(d.value(), d.fmt || "%.3f");
          d.caret = d.buf.length;
        } else if ((k("down") || k("left")) && this.ctrl) {
          d.set(clamp(d.value() - step * 10, d.min, d.max));
          d.buf = fmtVal(d.value(), d.fmt || "%.3f");
          d.caret = d.buf.length;
        } else if (!guiState.textConsumed && guiState.textInput) {
          guiState.textConsumed = true;
          const t = guiState.textInput.replace(/[^0-9.eE+-]/g, "");

          if (t) {
            d.buf += t;
            d.caret = d.buf.length;
          }
        }

        if (
          guiState.focusedId !== itemId &&
          guiState.activeId !== itemId &&
          !item.hovered
        )
          d.editing = false;
      }

      if (item.visible) {
        this._drawFrame(x + pad, fy, fw, fieldH, item);
        const str = d.editing ? d.buf : fmtVal(d.value(), d.fmt || "%.3f");
        const m = this._measure(str, fontOptions);
        this._drawText(
          x + pad + (fw - m.w) / 2,
          fy + (fieldH - lineH) / 2 + 1,
          str,
          this._col("text"),
          fontOptions,
        );

        if (d.editing) {
          const cx = this._measure(d.buf.slice(0, d.caret), fontOptions).w;
          this.renderer.line(
            x + pad + (fw - this._measure(d.buf, fontOptions).w) / 2 + cx,
            fy + 2,
            x + pad + (fw - this._measure(d.buf, fontOptions).w) / 2 + cx,
            fy + fieldH - 2,
            this._col("text"),
            1,
          );
        }
      }
      this._endPopupLayout(p, prevClaim);
      this.renderer.popClip();
    }

    /* ---------------------------- tooltips ------------------------------ */

    /**
     * Sets a text tooltip for the hovered last item. It appears after
     *   * flags.tooltipDelay seconds of continuous hover, above every window, just
     *   * above the cursor (flipping below when there is no room).
     * @param {string} text
     */
    setTooltip(text) {
      if (!this.flags.tooltips) {
        return;
      }
      const guiState = this.state;
      const item = guiState.lastItem;

      if (!item || !item.hovered || !item.enabled) {
        return;
      }

      if (guiState.tooltip && guiState.tooltip.id === item.itemId) {
        return;
      }
      guiState.tooltip = {
        id: item.itemId,
        text: String(text),
        since: guiState.now,
      };
    }
    /**
     * Begins a rich tooltip (widgets allowed inside); drawn after
     *   * flags.tooltipDelay seconds of hover over the last item.
     * @returns {boolean} false when it should not be drawn, otherwise true
     */
    beginTooltip() {
      const guiState = this.state;

      if (!this.flags.tooltips) {
        return false;
      }
      const item = guiState.lastItem;

      if (!item || !item.hovered) {
        return false;
      }

      if (!guiState.tooltip || guiState.tooltip.id !== item.itemId)
        guiState.tooltip = {
          id: item.itemId,
          text: "",
          since: guiState.now,
        };

      if (guiState.now - guiState.tooltip.since < this.flags.tooltipDelay) {
        return false;
      }

      if (!guiState.popups.has("##tooltip"))
        this._openPopup(
          "##tooltip",
          {
            x: guiState.mouse.x + 14,
            y: guiState.mouse.y + 18,
          },
          {
            type: "tooltip",
          },
          item.itemId,
          item.win ? item.win.owner || item.win : guiState.hoveredWindow,
        );

      return this.beginPopup("##tooltip");
    }
    /**
     * Ends the tooltip started with beginTooltip().
     */
    endTooltip() {
      this.endPopup();
    }
    _tooltipPass() {
      const guiState = this.state;
      const tp = guiState.popups.get("##tooltip");

      if (tp && tp.open) {
        const item = guiState.items.get(tp.sourceId);

        if (!item || !item.hovered) {
          tp.open = false;
        }
      }

      if (!guiState.tooltip) {
        return;
      }
      const item = guiState.items.get(guiState.tooltip.id);

      if (!item || !item.hovered) {
        guiState.tooltip = null;

        return;
      }
      // only the topmost hovered element may own a tooltip: when windows
      // overlap, items behind the topmost window are not hovered, but guard
      // explicitly anyway (popup rows are exempt — they always float on top)

      if (item.win) {
        const top = item.win.owner || item.win;

        if (
          (top.kind === "window" || top.kind === "child") &&
          guiState.hoveredWindow &&
          top !== guiState.hoveredWindow
        ) {
          guiState.tooltip = null;

          return;
        }
      }
      const age = guiState.now - guiState.tooltip.since;

      if (age < this.flags.tooltipDelay) {
        return;
      }
      const fontOptions = this._fo();
      const maxW = 280;
      const lines = wrapText(guiState.tooltip.text, maxW, (t) =>
        this._measure(t, fontOptions),
      );
      const pad = 8;
      let tw = 0;

      for (const l of lines) tw = Math.max(tw, this._measure(l, fontOptions).w);
      const w = tw + pad * 2;
      const h = lines.length * this._lineH() + pad * 2;
      // pop up at the cursor, above it when there is room (else below),
      // clamped on-screen; drawn on the foreground layer (above all windows)
      const x = clamp(
        guiState.mouse.x + 14,
        4,
        Math.max(4, guiState.displayW - w - 4),
      );
      let y = guiState.mouse.y - h - 12;

      if (y < 4) {
        y = guiState.mouse.y + 18;
      }
      y = clamp(y, 4, Math.max(4, guiState.displayH - h - 4));
      const a = this.flags.animations
        ? clamp((age - this.flags.tooltipDelay) / 0.12, 0, 1)
        : 1;
      this.renderer.setLayer(Layers.Foreground);
      this.renderer.fillRoundedRect(
        x,
        y,
        w,
        h,
        this._var("popupRounding"),
        withAlpha(this._col("tooltipBg"), a),
      );
      this.renderer.strokeRoundedRect(
        x + 0.5,
        y + 0.5,
        w - 1,
        h - 1,
        this._var("popupRounding"),
        withAlpha(this._col("border"), a),
        1,
      );

      for (let i = 0; i < lines.length; i++) {
        this._drawText(
          x + pad,
          y + pad + i * this._lineH(),
          lines[i],
          withAlpha(this._col("text"), a),
          fontOptions,
        );
      }
    }

    /* ---------------------------- debug overlay ------------------------- */

    _drawDebugOverlay() {
      const guiState = this.state;
      const st = guiState.stats;
      const x = 8,
        y = 8,
        w = 220;
      const lines = [
        "Mim v" + VERSION,
        "FPS " + (st.fps | 0) + "   (" + st.ms.toFixed(2) + " ms)",
        "draw calls   " + st.drawCalls,
        "items        " + st.items,
        "windows      " + st.windows,
        "states       " + st.states,
        "mouse        " +
          (guiState.mouse.x | 0) +
          ", " +
          (guiState.mouse.y | 0),
        "active       " +
          (guiState.activeId || "-") +
          "  hover " +
          (guiState.hoveredId || "-"),
      ];
      const fs = 11;
      const lh = fs * 1.4;
      const h = lines.length * lh + 12;
      this.renderer.setLayer(Layers.Foreground);
      this.renderer.fillRoundedRect(x, y, w, h, 6, [20, 21, 26, 225]);
      this.renderer.strokeRoundedRect(
        x + 0.5,
        y + 0.5,
        w - 1,
        h - 1,
        6,
        [70, 71, 84, 255],
        1,
      );

      for (let i = 0; i < lines.length; i++) {
        this.renderer.drawText(
          x + 8,
          y + 7 + i * lh,
          lines[i],
          [222, 224, 230, 255],
          {
            fontSize: fs,
            fontId: this.style.font.id,
          },
        );
      }
    }

    /* ---------------------------- state access -------------------------- */

    /**
     * Reads the id-scoped value stored with setState() (undefined when none
     *   * was stored yet). The label is scoped by the current id stack, so the same
     *   * label in different windows/children is independent.
     * @param {string} label
     * @returns {*} the stored value, or undefined
     */
    state(label) {
      const k = hashPair(
        this.state.idStackSeed,
        fnv1a(String(label == null ? "" : label)),
      );
      const v = this.state.widgetStates.get(k);

      if (!v) {
        return undefined;
      }

      return v.value !== undefined ? v.value : v;
    }
    /**
     * Stores an id-scoped value that can be read back with state(). Survives
     *   * across frames; scoped by the current id stack.
     * @param {string} label
     * @param {*} value
     * @returns {GUI} the gui instance (chainable)
     */
    setState(label, value) {
      const k = hashPair(
        this.state.idStackSeed,
        fnv1a(String(label == null ? "" : label)),
      );
      let v = this.state.widgetStates.get(k);

      if (!v) {
        v = {};
        this.state.widgetStates.set(k, v);
      }
      v.lastFrame = this.state.frameId;
      v.value = value;

      return this;
    }

    /* ---------------------------- custom drawing ------------------------ */

    /**
     * Runs fn with the renderer switched to the given layer ('background',
     * 'gui', or 'foreground'), then restores the previous layer. Use it for
     * custom drawing passes around the GUI (e.g. a background grid before
     * the windows, or a HUD overlay after gui.endFrame()).
     */
    layer(name, fn) {
      const prev = this.renderer.layer || Layers.GUI;
      this.renderer.setLayer(name);
      fn(this.renderer);
      this.renderer.setLayer(prev);
    }

    /* ---------------------------- frame helpers ------------------------- */

    _frameWidget(label, opts) {
      opts = opts || {};
      const guiState = this.state;
      const ids = this._id(label);
      const fontOptions = this._fo();
      const fp = this._var("framePadding");
      const itemSpacing = this._var("itemSpacing");
      const lineH = this._lineH();
      const h = opts.h || lineH + fp[1] * 2;
      const lw = label ? this._measure(label, fontOptions).w : 0;
      const pos = this._nextPos();
      const availW = this.getRegionAvail().w;
      let w = guiState.nextItemWidth > 0 ? guiState.nextItemWidth : opts.w || 0;
      guiState.nextItemWidth = 0;
      let labelAbove = false;
      let frameX = pos.x,
        frameY = pos.y;
      let rectY = pos.y,
        rectH = h;

      if (w <= 0)
        if (lw > 0 && availW >= lw + itemSpacing[0] * 2 + 40) {
          w = availW - lw - itemSpacing[0];
        } else {
          w = availW;
          labelAbove = lw > 0;
        }
      w = Math.max(20, w);

      if (labelAbove) {
        rectY = pos.y;
        rectH = h + lineH + 3;
        frameY = pos.y + lineH + 3;
      }
      const item = this._item(frameX, rectY, w, rectH, ids.itemId, {
        focusable: opts.focusable !== false,
      });
      const labelRect = labelAbove
        ? {
            x: frameX,
            y: pos.y,
            w: lw,
            h: lineH,
          }
        : {
            x: frameX + w + itemSpacing[0],
            y: pos.y + (h - lineH) / 2,
            w: lw,
            h: lineH,
          };
      this._advance(frameX, rectY, w, rectH);

      return {
        ids,
        it: item,
        x: frameX,
        y: frameY,
        w,
        h,
        labelRect,
        fo: fontOptions,
        fp,
        lineH,
      };
    }
    _drawFrame(x, y, w, h, it) {
      const rr = this._var("frameRounding");
      const bg = !it.enabled
        ? this._col("frameBg")
        : it.active
          ? this._col("frameBgActive")
          : it.hovered
            ? this._col("frameBgHovered")
            : this._col("frameBg");
      this.renderer.fillRoundedRect(x, y, w, h, rr, bg);

      if (this._var("frameBorder") > 0)
        this.renderer.strokeRoundedRect(
          x + 0.5,
          y + 0.5,
          w - 1,
          h - 1,
          rr,
          this._col("border"),
          1,
        );
    }
    _drawFocusRing(it) {
      if (
        this.state.focusedId !== it.itemId ||
        !this.flags.keyboardNavigation
      ) {
        return;
      }
      const rr = this._var("frameRounding") + 2;
      this.renderer.strokeRoundedRect(
        it.x - 1.5,
        it.y - 1.5,
        it.w + 3,
        it.h + 3,
        rr,
        this._col("focusRing"),
        1,
      );
    }
    _caretFromX(buf, mouse, textX, textW) {
      const fontOptions = this._fo();
      const whole = this._measure(buf, fontOptions).w;
      const rel = clamp(mouse - textX, 0, whole);
      let best = 0;

      for (let i = 0; i < buf.length; i++) {
        if (this._measure(buf.slice(0, i + 1), fontOptions).w <= rel) {
          best = i + 1;
        } else break;
      }

      return best;
    }
    _wordSelect(buf, caret) {
      const isWord = (c) => /\w/.test(c);
      let a = caret,
        b = caret;

      if (caret >= buf.length || !isWord(buf[caret]))
        return [caret, Math.min(buf.length, caret + 1)];

      while (a > 0 && isWord(buf[a - 1])) a--;

      while (b < buf.length && isWord(buf[b])) b++;

      return [a, b];
    }

    /* ======================= WIDGETS ==================================== */

    /**
     * Draws a line of text at the cursor position.
     * @param {string} str
     * @param {number[]} [color] optional [r, g, b, a]
     */
    text(str, color) {
      const pos = this._nextPos();
      const fontOptions = this._fo();
      const m = this._measure(String(str), fontOptions);
      const item = this._item(
        pos.x,
        pos.y,
        m.w,
        m.h,
        this._id(String(str)).itemId,
        {
          focusable: false,
        },
      );

      if (item.visible) {
        this._drawText(
          pos.x,
          pos.y,
          str,
          color || this._col("text"),
          fontOptions,
        );
      }
      this._advance(pos.x, pos.y, m.w, m.h);
    }
    /**
     * Draws a line of text in the given color.
     * @param {number[]} color
     * @param {string} str
     */
    textColored(color, str) {
      this.text(str, color);
    }
    /**
     * Draws text wrapped to a width.
     * @param {string} str
     * @param {Object} [opts] { w: wrap width (default: the full available width) }
     */
    textWrapped(str, opts) {
      opts = opts || {};
      const pos = this._nextPos();
      const fontOptions = this._fo();
      const lineH = this._lineH();
      const w = opts.maxWidth > 0 ? opts.maxWidth : this.getRegionAvail().w;
      const lines = wrapText(String(str), w, (t) =>
        this._measure(t, fontOptions),
      );
      const h = lines.length * lineH;
      const item = this._item(
        pos.x,
        pos.y,
        w,
        h,
        this._id(String(str) + "##wrapped").itemId,
        {
          focusable: false,
        },
      );

      if (item.visible)
        for (let i = 0; i < lines.length; i++) {
          this._drawText(
            pos.x,
            pos.y + i * lineH,
            lines[i],
            opts.color || this._col("text"),
            fontOptions,
          );
        }
      this._advance(pos.x, pos.y, w, h);
    }

    /**
     * A push button; returns true on the frame it is clicked.
     * @param {string} label
     * @param {Object} [opts] { w, h, disabled, tooltip }
     * @returns {boolean}
     */
    button(label, options) {
      options = options || {};
      const fontOptions = this._fo();
      const lineH = this._lineH();
      const fp = this._var("framePadding");
      const pos = this._nextPos();
      const textWidth = this._measure(label, fontOptions).w;
      const w =
        options.width > 0 ? options.width : Math.max(24, textWidth + fp[0] * 2);
      const h = options.height > 0 ? options.height : lineH + fp[1] * 2;
      const item = this._item(pos.x, pos.y, w, h, this._id(label).itemId);
      const res = this._clickable(item);
      const kbd =
        this.flags.keyboardNavigation &&
        this.state.focusedId === item.itemId &&
        (this.isKeyPressed("enter") || this.isKeyPressed(" "));
      const clicked = res.clicked || kbd;

      if (clicked) {
        this.state.changedId = item.itemId;
      }

      if (item.visible) {
        this._drawFrame(pos.x, pos.y, w, h, item);
        const tc = item.enabled ? this._col("text") : this._col("textDisabled");
        this._drawText(
          pos.x + (w - textWidth) / 2,
          pos.y + (h - lineH) / 2 + 1,
          label,
          tc,
          fontOptions,
        );
      }
      this._drawFocusRing(item);
      this._advance(item.x, item.y, w, h);

      return clicked;
    }
    /**
     * A compact button sized to a text line (no frame padding); true when
     *   * clicked.
     * @param {string} label
     * @returns {boolean}
     */
    smallButton(label) {
      const fontOptions = this._fo();
      const lineH = this._lineH();
      const pos = this._nextPos();
      const textWidth = this._measure(label, fontOptions).w;
      const w = textWidth + 8;
      const h = lineH + 2;
      const item = this._item(pos.x, pos.y, w, h, this._id(label).itemId);
      const res = this._clickable(item);
      const kbd =
        this.flags.keyboardNavigation &&
        this.state.focusedId === item.itemId &&
        (this.isKeyPressed("enter") || this.isKeyPressed(" "));
      const clicked = res.clicked || kbd;

      if (item.visible) {
        this._drawFrame(pos.x, pos.y, w, h, item);
        const tc = item.enabled ? this._col("text") : this._col("textDisabled");
        this._drawText(
          pos.x + (w - textWidth) / 2,
          pos.y + (h - lineH) / 2 + 1,
          label,
          tc,
          fontOptions,
        );
      }
      this._drawFocusRing(item);
      this._advance(item.x, item.y, w, h);

      return clicked;
    }

    /**
     * A checkbox with a label.
     * @param {string} label
     * @param {boolean|null} value current value, or null for library-kept state
     * @returns {boolean} the checkbox value (possibly toggled)
     */
    checkbox(label, checked) {
      const guiState = this.state;
      const ids = this._id(label);
      const st = this._state(ids.stateKey);
      const stateful = checked == null;

      if (stateful) {
        checked = !!st.value;
      }
      const fontOptions = this._fo();
      const lineH = this._lineH();
      const pos = this._nextPos();
      const box = Math.max(lineH, 16);
      const lw = this._measure(label, fontOptions).w;
      const isp = this._var("itemInnerSpacing");
      const w = box + isp[0] + lw;
      const item = this._item(pos.x, pos.y, w, box, ids.itemId);
      const res = this._clickable(item);
      let changed = false;
      const kbd =
        this.flags.keyboardNavigation &&
        guiState.focusedId === item.itemId &&
        this.isKeyPressed(" ");

      if (res.clicked || kbd) {
        checked = !checked;
        changed = true;
      }

      if (stateful) {
        st.value = checked;
      }

      if (changed) {
        guiState.changedId = item.itemId;
      }

      if (item.visible) {
        this._drawFrame(pos.x, pos.y, box, box, item);

        if (checked) {
          const bx = pos.x + box * 0.24,
            by = pos.y + box * 0.54;
          this.renderer.polyline(
            [
              bx,
              by,
              bx + box * 0.16,
              by + box * 0.18,
              bx + box * 0.42,
              by - box * 0.2,
            ],
            this._col("checkMark"),
            2,
          );
        }
        this._drawText(
          pos.x + box + isp[0],
          pos.y + (box - lineH) / 2 + 1,
          label,
          item.enabled ? this._col("text") : this._col("textDisabled"),
          fontOptions,
        );
      }
      this._drawFocusRing(item);
      this._advance(item.x, item.y, w, box);

      return checked;
    }

    /**
     * A radio button; checked when value === index.
     * @param {string} label
     * @param {number|null} value the current selection, or null for library-kept state
     * @param {number} index this button's value
     * @returns {number} the current selection (this button's index when clicked, otherwise the passed value)
     */
    radioButton(label, checked, groupIndex) {
      const guiState = this.state;
      const ids = this._id(label);
      const selected = checked === groupIndex;
      const fontOptions = this._fo();
      const lineH = this._lineH();
      const pos = this._nextPos();
      const box = Math.max(lineH, 14);
      const lw = this._measure(label, fontOptions).w;
      const isp = this._var("itemInnerSpacing");
      const w = box + isp[0] + lw;
      const item = this._item(pos.x, pos.y, w, box, ids.itemId);
      const res = this._clickable(item);
      let changed = false;
      const kbd =
        this.flags.keyboardNavigation &&
        guiState.focusedId === item.itemId &&
        this.isKeyPressed(" ");

      if ((res.clicked || kbd) && !selected) {
        checked = groupIndex;
        changed = true;
      }

      if (changed) {
        guiState.changedId = item.itemId;
      }

      if (item.visible) {
        this._drawFrame(pos.x, pos.y, box, box, item);

        if (selected)
          this.renderer.fillCircle(
            pos.x + box / 2,
            pos.y + box / 2,
            box * 0.26,
            item.enabled ? this._col("checkMark") : this._col("textDisabled"),
          );
        this._drawText(
          pos.x + box + isp[0],
          pos.y + (box - lineH) / 2 + 1,
          label,
          item.enabled ? this._col("text") : this._col("textDisabled"),
          fontOptions,
        );
      }
      this._drawFocusRing(item);
      this._advance(item.x, item.y, w, box);

      return checked;
    }

    /**
     * A horizontal float slider: clicking the track jumps the value to the
     *   * click position, dragging adjusts relative to the grabbed point, and
     *   * right-clicking opens an exact numeric entry field.
     * @param {string} label
     * @param {number|null} value
     * @param {number} vmin
     * @param {number} vmax
     * @param {string} [fmt] '%f'-style format (default '%.3f')
     * @returns {number} the new value
     */
    sliderFloat(label, value, minValue, maxValue, format) {
      const ids = this._id(label);
      const st = this._state(ids.stateKey);
      const stateful = value == null;
      // consume a direct-entry commit that landed in the previous endFrame

      if (st.pending != null) {
        value = st.pending;
        st.pending = null;
      }

      if (stateful) {
        value = value != null ? value : st.value != null ? st.value : minValue;
      }

      if (!isFinite(value)) {
        value = minValue;
      }
      value = clamp(value, minValue, maxValue);
      const range = maxValue - minValue;
      const fw = this._frameWidget(label);
      const item = fw.it;
      let changed = false;

      if (!isFinite(range) || range <= 0) {
        if (item.visible) {
          this._drawFrame(fw.x, fw.y, fw.w, fw.h, item);

          if (fw.labelRect.w > 0)
            this._drawText(
              fw.labelRect.x,
              fw.labelRect.y,
              label,
              this._col("textDisabled"),
              fw.fo,
            );
        }

        return value;
      }
      const res = this._clickable(item);
      const guiState = this.state;
      const openValuePopup = () => {
        this._openPopup(
          "##val" + item.itemId,
          {
            x: fw.x,
            y: fw.y + fw.h + 2,
          },
          {
            type: "value",
            min: minValue,
            max: maxValue,
            fmt: format || "%.3f",
            label: String(label),
            value: () =>
              stateful ? (st.value != null ? st.value : minValue) : value,
            // commits happen in endFrame (after this frame's return), so route
            // the result through st.pending; the widget consumes it next frame
            set: (v) => {
              st.pending = v;

              if (stateful) {
                st.value = v;
              }
            },
          },
          item.itemId,
        );
      };

      if (
        this.flags.rightClickNumeric &&
        item.hovered &&
        this.isMouseClicked(1)
      ) {
        openValuePopup();
      } else if (
        this.flags.doubleClick &&
        item.hovered &&
        this.isMouseDoubleClicked(0)
      )
        openValuePopup();

      if (res.active) {
        const innerW = Math.max(1, fw.w - 6);
        // drag bookkeeping lives on the item (per visible instance), not st,
        // because duplicate labels share st across frames

        if (!item.dragInit) {
          item.dragInit = true;
          st.dragX0 = guiState.mouse.x;
          // click-to-set: the value jumps to where the slider was clicked;
          // dragging then continues from that exact point
          value =
            minValue + clamp01((guiState.mouse.x - fw.x - 3) / innerW) * range;
          st.dragV0 = value;
        }
        value = st.dragV0 + ((guiState.mouse.x - st.dragX0) / innerW) * range;
        changed = true;
      }
      value = clamp(value, minValue, maxValue);

      if (
        item.hovered &&
        guiState.mouse.wheel[1] &&
        (guiState.focusedId === item.itemId || res.active) &&
        this.flags.wheelScroll
      ) {
        value = clamp(
          value + ((guiState.mouse.wheel[1] > 0 ? -1 : 1) * range) / 50,
          minValue,
          maxValue,
        );
        changed = true;
      }

      if (guiState.focusedId === item.itemId && this.flags.keyboardNavigation) {
        const step = range / 100;

        if (this.isKeyPressed("left") || this.isKeyPressed("down")) {
          value = clamp(value - step, minValue, maxValue);
          changed = true;
        }

        if (this.isKeyPressed("right") || this.isKeyPressed("up")) {
          value = clamp(value + step, minValue, maxValue);
          changed = true;
        }

        if (this.isKeyPressed("pageup")) {
          value = clamp(value + step * 10, minValue, maxValue);
          changed = true;
        }

        if (this.isKeyPressed("pagedown")) {
          value = clamp(value - step * 10, minValue, maxValue);
          changed = true;
        }

        if (this.isKeyPressed("home")) {
          value = minValue;
          changed = true;
        }

        if (this.isKeyPressed("end")) {
          value = maxValue;
          changed = true;
        }
      }

      if (stateful) {
        st.value = value;
      }

      if (changed) {
        guiState.changedId = item.itemId;
      }

      if (item.visible) {
        this._drawFrame(fw.x, fw.y, fw.w, fw.h, item);
        const frac = clamp01((value - minValue) / range);
        const grabW = clamp(fw.w * 0.09, 8, 22);
        const innerW = Math.max(1, fw.w - 6);
        const gx = fw.x + 3 + (innerW - grabW) * frac;
        const gc = !item.enabled
          ? this._col("textDisabled")
          : res.active
            ? this._col("sliderGrabActive")
            : item.hovered
              ? this._col("sliderGrabHovered")
              : this._col("sliderGrab");
        this.renderer.fillRoundedRect(gx, fw.y + 3, grabW, fw.h - 6, 3, gc);
        const vstr = fmtVal(value, format || "%.3f");
        const vm = this._measure(vstr, fw.fo);

        if (vm.w < fw.w - 10)
          this._drawText(
            fw.x + (fw.w - vm.w) / 2,
            fw.y + (fw.h - vm.h) / 2 + 1,
            vstr,
            item.enabled ? this._col("text") : this._col("textDisabled"),
            fw.fo,
          );

        if (fw.labelRect.w > 0)
          this._drawText(
            fw.labelRect.x,
            fw.labelRect.y,
            label,
            item.enabled ? this._col("text") : this._col("textDisabled"),
            fw.fo,
          );
      }
      this._drawFocusRing(item);

      if (item.hovered) {
        this.setTooltip(fmtVal(value, format || "%.3f"));
      }

      return value;
    }

    /**
     * A horizontal integer slider (values rounded); same interactions as
     *   * sliderFloat.
     * @param {string} label
     * @param {number|null} value
     * @param {number} vmin
     * @param {number} vmax
     * @param {string} [fmt] '%d'-style format
     * @returns {number} the new integer value
     */
    sliderInt(label, value, minValue, maxValue, format) {
      value = this.sliderFloat(
        label,
        value,
        minValue,
        maxValue,
        format || "%d",
      );

      return Math.round(value);
    }

    /**
     * A slider that routes to sliderInt when min/max/value are int-like,
     *   * otherwise to sliderFloat.
     * @param {string} label
     * @param {number|null} value
     * @param {number} min
     * @param {number} max
     * @param {Object} [opts] { int, fmt }
     * @returns {number} the new value
     */
    slider(label, value, minValue, maxValue, options) {
      options = options || {};
      const intLike =
        options.int ||
        (Number.isInteger(minValue) &&
          Number.isInteger(maxValue) &&
          (value == null || Number.isInteger(value)));

      return intLike
        ? this.sliderInt(label, value, minValue, maxValue, options.fmt)
        : this.sliderFloat(label, value, minValue, maxValue, options.fmt);
    }

    /**
     * A float drag: while held, the value changes by speed per pixel of
     *   * mouse movement.
     * @param {string} label
     * @param {number|null} value
     * @param {number} speed value change per pixel
     * @param {number} vmin
     * @param {number} vmax
     * @returns {number} the new value
     */
    dragFloat(label, value, dragSpeed, minValue, maxValue) {
      const ids = this._id(label);
      const st = this._state(ids.stateKey);
      const stateful = value == null;

      if (st.pending != null) {
        value = st.pending;
        st.pending = null;
      }

      if (stateful) {
        value = value != null ? value : st.value != null ? st.value : minValue;
      }

      if (!isFinite(value)) {
        value = minValue;
      }
      value = clamp(value, minValue, maxValue);
      const fw = this._frameWidget(label);
      const item = fw.it;
      let changed = false;
      const guiState = this.state;
      const res = this._clickable(item);
      const openValuePopup = () => {
        this._openPopup(
          "##val" + item.itemId,
          {
            x: fw.x,
            y: fw.y + fw.h + 2,
          },
          {
            type: "value",
            min: minValue,
            max: maxValue,
            fmt: "%.3f",
            label: String(label),
            value: () =>
              stateful ? (st.value != null ? st.value : minValue) : value,
            set: (v) => {
              value = v;
              changed = true;

              if (stateful) {
                st.value = v;
              }
            },
          },
          item.itemId,
        );
      };

      if (
        this.flags.rightClickNumeric &&
        item.hovered &&
        this.isMouseClicked(1)
      ) {
        openValuePopup();
      } else if (
        this.flags.doubleClick &&
        item.hovered &&
        this.isMouseDoubleClicked(0)
      )
        openValuePopup();

      if (res.active) {
        const mult = this.shift ? 0.1 : this.ctrl ? 10 : 1;
        value = clamp(
          value + guiState.mouse.dx * dragSpeed * mult,
          minValue,
          maxValue,
        );
        changed = true;
      }

      if (
        item.hovered &&
        guiState.mouse.wheel[1] &&
        (guiState.focusedId === item.itemId || res.active) &&
        this.flags.wheelScroll
      ) {
        value = clamp(
          value + (guiState.mouse.wheel[1] > 0 ? -1 : 1) * dragSpeed,
          minValue,
          maxValue,
        );
        changed = true;
      }

      if (guiState.focusedId === item.itemId && this.flags.keyboardNavigation) {
        if (this.isKeyPressed("left") || this.isKeyPressed("down")) {
          value = clamp(value - dragSpeed, minValue, maxValue);
          changed = true;
        }

        if (this.isKeyPressed("right") || this.isKeyPressed("up")) {
          value = clamp(value + dragSpeed, minValue, maxValue);
          changed = true;
        }

        if (this.isKeyPressed("home")) {
          value = minValue;
          changed = true;
        }

        if (this.isKeyPressed("end")) {
          value = maxValue;
          changed = true;
        }
      }

      if (stateful) {
        st.value = value;
      }

      if (changed) {
        guiState.changedId = item.itemId;
      }

      if (item.visible) {
        this._drawFrame(fw.x, fw.y, fw.w, fw.h, item);
        const vstr = fmtVal(value, "%.3f");
        const vm = this._measure(vstr, fw.fo);
        this._drawText(
          fw.x + (fw.w - vm.w) / 2,
          fw.y + (fw.h - vm.h) / 2 + 1,
          vstr,
          item.enabled ? this._col("text") : this._col("textDisabled"),
          fw.fo,
        );

        if (fw.labelRect.w > 0)
          this._drawText(
            fw.labelRect.x,
            fw.labelRect.y,
            label,
            item.enabled ? this._col("text") : this._col("textDisabled"),
            fw.fo,
          );
      }
      this._drawFocusRing(item);

      return value;
    }
    /**
     * An integer drag (a dragFloat with rounded results).
     * @param {string} label
     * @param {number|null} value
     * @param {number} speed
     * @param {number} vmin
     * @param {number} vmax
     * @returns {number} the new integer value
     */
    dragInt(label, value, dragSpeed, minValue, maxValue) {
      return Math.round(
        this.dragFloat(label, value, dragSpeed, minValue, maxValue),
      );
    }

    /**
     * An editable integer field: typing, arrow steps (step / stepFast),
     *   * select-all, undo/redo and right-click numeric entry.
     * @param {string} label
     * @param {number|null} value or null for library-kept state
     * @param {Object} [opts] { w, min, max, step (default 1), stepFast (default 10) }
     * @returns {number} the current value (invalid input is rejected and the last valid value kept)
     */
    inputInt(label, value, options) {
      options = options || {};
      const min = options.min != null ? options.min : -Infinity;
      const max = options.max != null ? options.max : Infinity;
      const step = options.step != null ? options.step : 1;
      const stepFast = options.stepFast != null ? options.stepFast : 10;

      return this._input(label, value, {
        parse: (b) =>
          /^[+-]?\d+$/.test(String(b).trim()) ? parseInt(b, 10) : NaN,
        invalid: (v) => !isFinite(v),
        clamp: (v) => clamp(Math.round(v), min, max),
        fmt: (v) => fmtVal(v, "%d"),
        step: (v, dir, fast) =>
          clamp(Math.round(v) + dir * (fast ? stepFast : step), min, max),
        sanitize: (t) => t.replace(/[^0-9+-]/g, ""),
        live: true,
        init: 0,
      });
    }
    /**
     * An editable float field (same editing as inputInt).
     * @param {string} label
     * @param {number|null} value or null for library-kept state
     * @param {Object} [opts] { w, min, max, step (default 0.1), stepFast (default 1), fmt }
     * @returns {number} the current value (invalid input is rejected and the last valid value kept)
     */
    inputFloat(label, value, options) {
      options = options || {};
      const min = options.min != null ? options.min : -Infinity;
      const max = options.max != null ? options.max : Infinity;
      const step = options.step != null ? options.step : 0.1;
      const stepFast = options.stepFast != null ? options.stepFast : 1;
      const fmt = options.fmt || "%.3f";

      return this._input(label, value, {
        parse: (b) => {
          const v = parseFloat(b);

          return isFinite(v) ? v : NaN;
        },
        invalid: (v) => !isFinite(v),
        clamp: (v) => clamp(v, min, max),
        fmt: (v) => fmtVal(v, fmt),
        step: (v, dir, fast) =>
          clamp(v + dir * (fast ? stepFast : step), min, max),
        sanitize: (t) => {
          let out = t.replace(/[^0-9.eE+-]/g, "");
          const dot = out.indexOf(".");

          if (dot >= 0) {
            out = out.slice(0, dot + 1) + out.slice(dot + 1).replace(/\./g, "");
          }

          return out;
        },
        live: true,
        init: 0,
      });
    }

    /**
     * A full-featured text field: caret, selection, copy/paste (via the
     *   * clipboard callbacks), select-all, undo/redo, arrow keys, Home/End and
     *   * word delete.
     * @param {string} label
     * @param {string|null} value or null for library-kept state
     * @param {Object} [opts] { w, maxLength, onSubmit }
     * @returns {string} the current text
     */
    inputText(label, value, options) {
      options = options || {};

      return this._input(label, value, {
        parse: (b) => b,
        invalid: () => false,
        clamp: null,
        fmt: (v) => String(v == null ? "" : v),
        step: null,
        sanitize: (t) => t.replace(/[\r\n]+/g, " "),
        live: true,
        init: "",
        maxLength: options.maxLength,
        onSubmit: options.onSubmit,
      });
    }
    _input(label, value, cfg) {
      const guiState = this.state;
      const ids = this._id(label);
      const st = this._state(ids.stateKey);
      const stateful = value == null;

      if (stateful) {
        value =
          st.value !== undefined ? st.value : cfg.init != null ? cfg.init : "";
      }

      if (typeof value !== "string" && typeof value !== "number")
        value = cfg.init != null ? cfg.init : "";
      const fw = this._frameWidget(label);
      const item = fw.it;
      const res = this._clickable(item);
      let changed = false;
      const fp = fw.fp;
      const textX = fw.x + fp[0];
      const textW = Math.max(4, fw.w - fp[0] * 2);
      const textY = fw.y + fp[1];
      const editing = st.edit === true && guiState.focusedId === item.itemId;
      const commit = () => {
        if (st.buf == null) {
          st.edit = false;

          return;
        }
        const p = cfg.parse(st.buf);

        if (!cfg.invalid(p)) {
          const v = cfg.clamp ? cfg.clamp(p) : p;

          if (v !== value) {
            value = v;
            changed = true;
          }
        } else {
          st.flash = guiState.now;
        }
        st.buf = null;
        st.edit = false;
        st.sel = null;
      };

      if (!editing)
        if (item.hovered && this.isMouseClicked(0)) {
          st.edit = true;
          st.buf = cfg.fmt(value);
          st.base = st.buf;
          st.caret = this._caretFromX(st.buf, guiState.mouse.x, textX, textW);
          st.sel = null;
          st.caretT = 0;
          st.undo = [];
          st.redo = [];
          guiState.focusedId = item.itemId;
          guiState.activeId = item.itemId;
        } else if (item.hovered && this.isMouseClicked(1)) {
          st.edit = true;
          st.buf = cfg.fmt(value);
          st.base = st.buf;
          st.caret = st.buf.length;
          st.sel = [0, st.buf.length];
          st.caretT = 0;
          st.undo = [];
          st.redo = [];
          guiState.focusedId = item.itemId;
          guiState.activeId = item.itemId;
        }

      if (editing) {
        st.buf = st.buf != null ? st.buf : cfg.fmt(value);
        const L = st.buf.length;
        // self-heal a caret that ever drifted past the buffer end

        if (st.caret > L) {
          st.caret = L;
        }

        if (item.hovered) {
          this._setCursor("text", 2);
        }
        const mouse = guiState.mouse;
        const k = (t) => this.isKeyPressed(t);
        // undo = past snapshots (state before each edit); redo = states
        // displaced by undo. A new edit clears redo.
        const pushUndo = () => {
          if (!this.flags.undoRedo) {
            return;
          }

          if (!st.undo) {
            st.undo = [];
            st.redo = [];
          }
          const last = st.undo[st.undo.length - 1];

          if (last && last.buf === st.buf && last.caret === st.caret) {
            return;
          }
          st.undo.push({
            buf: st.buf,
            caret: st.caret,
          });

          if (st.undo.length > 32) {
            st.undo.shift();
          }
          st.redo = [];
        };
        const doUndo = () => {
          if (!st.undo || !st.undo.length) {
            return;
          }

          if (!st.redo) {
            st.redo = [];
          }
          st.redo.push({
            buf: st.buf,
            caret: st.caret,
          });
          const snap = st.undo.pop();
          st.buf = snap.buf;
          st.caret = snap.caret;
          st.sel = null;
        };
        const doRedo = () => {
          if (!st.redo || !st.redo.length) {
            return;
          }

          if (!st.undo) {
            st.undo = [];
          }
          st.undo.push({
            buf: st.buf,
            caret: st.caret,
          });
          const snap = st.redo.pop();
          st.buf = snap.buf;
          st.caret = snap.caret;
          st.sel = null;
        };

        // mouse interactions

        if (item.hovered && this.isMouseClicked(0)) {
          if (this.isMouseDoubleClicked(0) && this.flags.doubleClick)
            st.sel = this._wordSelect(st.buf, st.caret);
          else {
            st.caret = this._caretFromX(st.buf, mouse.x, textX, textW);
            st.sel = null;
          }
          st.caretT = 0;
        }

        if (
          mouse.wheel[1] &&
          this.flags.wheelScroll &&
          cfg.step &&
          (guiState.focusedId === item.itemId || res.active)
        ) {
          const dir = mouse.wheel[1] > 0 ? -1 : 1;
          value = cfg.step(value, dir, this.shift);
          changed = true;
          st.buf = cfg.fmt(value);
          st.caret = st.buf.length;
          st.sel = null;
        }

        if (k("escape")) {
          if (st.buf !== st.base) {
            st.buf = st.base;
            st.caret = st.buf.length;
            const p = cfg.parse(st.base);

            if (!cfg.invalid(p)) {
              const v = cfg.clamp ? cfg.clamp(p) : p;

              if (v !== value) {
                value = v;
                changed = true;
              }
            }
          }
          st.edit = false;
          st.buf = null;
          st.sel = null;
        } else if (k("enter")) {
          commit();

          if (cfg.onSubmit) {
            cfg.onSubmit(value);
          }
        } else if (k("tab")) {
          commit();

          if (this.flags.keyboardNavigation) {
            const list = guiState.lastFocusList.length
              ? guiState.lastFocusList
              : guiState.focusList;
            const i = list.indexOf(item.itemId);

            if (i >= 0 && list.length > 1) {
              guiState.focusedId = list[(i + 1) % list.length];
            }
          }
        } else if (k("backspace")) {
          pushUndo();

          if (st.sel) {
            st.buf = st.buf.slice(0, st.sel[0]) + st.buf.slice(st.sel[1]);
            st.caret = st.sel[0];
            st.sel = null;
          } else if (st.caret > 0) {
            st.buf = st.buf.slice(0, st.caret - 1) + st.buf.slice(st.caret);
            st.caret = st.caret - 1;
          }
          st.caretT = 0;
        } else if (k("delete")) {
          pushUndo();

          if (st.sel) {
            st.buf = st.buf.slice(0, st.sel[0]) + st.buf.slice(st.sel[1]);
            st.caret = st.sel[0];
            st.sel = null;
          } else if (st.caret < L) {
            st.buf = st.buf.slice(0, st.caret) + st.buf.slice(st.caret + 1);
          }
          st.caretT = 0;
        } else if (k("left")) {
          const c = Math.max(0, st.caret - 1);

          if (this.shift && st.sel) {
            st.sel = [Math.min(st.sel[0], c), Math.max(st.sel[1], c)];
          } else if (this.shift) st.sel = [c, st.caret];
          else {
            st.caret = c;
            st.sel = null;
          }
          st.caretT = 0;
        } else if (k("right")) {
          const c = Math.min(L, st.caret + 1);

          if (this.shift && st.sel) {
            st.sel = [Math.min(st.sel[0], c), Math.max(st.sel[1], c)];
          } else if (this.shift) st.sel = [st.caret, c];
          else {
            st.caret = c;
            st.sel = null;
          }
          st.caretT = 0;
        } else if (k("home")) {
          if (this.shift) {
            st.sel = [0, st.caret];
          }
          st.caret = 0;

          if (!this.shift) {
            st.sel = null;
          }
        } else if (k("end")) {
          if (this.shift) {
            st.sel = [st.caret, L];
          }
          st.caret = L;

          if (!this.shift) {
            st.sel = null;
          }
        } else if (k("pageup") || k("pagedown")) {
          if (cfg.step) {
            value = cfg.step(value, k("pageup") ? 1 : -1, true);
            changed = true;
            st.buf = cfg.fmt(value);
            st.caret = st.buf.length;
          } else {
            st.caret = clamp(st.caret + (k("pageup") ? -12 : 12), 0, L);
          }
        } else if (cfg.step && k("up")) {
          value = cfg.step(value, 1, this.shift);
          changed = true;
          st.buf = cfg.fmt(value);
          st.caret = st.buf.length;
          st.sel = null;
        } else if (cfg.step && k("down")) {
          value = cfg.step(value, -1, this.shift);
          changed = true;
          st.buf = cfg.fmt(value);
          st.caret = st.buf.length;
          st.sel = null;
        } else if (this.ctrl && this.flags.keyboardShortcuts)
          if (k("a")) {
            st.sel = [0, L];
          } else if (k("c") && st.sel) {
            if (this.flags.clipboard) {
              this.clipboard.write(st.buf.slice(st.sel[0], st.sel[1]));
            }
          } else if (k("x") && st.sel) {
            if (this.flags.clipboard) {
              this.clipboard.write(st.buf.slice(st.sel[0], st.sel[1]));
            }
            pushUndo();
            st.buf = st.buf.slice(0, st.sel[0]) + st.buf.slice(st.sel[1]);
            st.caret = st.sel[0];
            st.sel = null;
          } else if (k("v")) {
            if (this.flags.clipboard) {
              let t = String(this.clipboard.read() || "");
              t = cfg.sanitize ? cfg.sanitize(t) : t;

              if (t) {
                pushUndo();
                const a = st.sel ? st.sel[0] : st.caret;
                const b = st.sel ? st.sel[1] : st.caret;
                st.buf = st.buf.slice(0, a) + t + st.buf.slice(b);
                st.caret = a + t.length;
                st.sel = null;

                if (cfg.maxLength && st.buf.length > cfg.maxLength) {
                  st.buf = st.buf.slice(0, cfg.maxLength);
                  st.caret = st.buf.length;
                }
              }
            }
          } else if (k("z") && !this.shift) {
            doUndo();
          } else if (k("y") || (k("z") && this.shift)) doRedo();

        if (this.flags.mouseBackForward && this.flags.undoRedo) {
          if (this.isMouseClicked(3)) {
            doUndo();
            guiState.backForwardHandled = true;
          }

          if (this.isMouseClicked(4)) {
            doRedo();
            guiState.backForwardHandled = true;
          }
        }
        // commit() (enter/escape above) may have ended the edit this frame;
        // the remaining blocks must not run on a cleared buffer

        if (st.edit === true) {
          if (!guiState.textConsumed && guiState.textInput) {
            guiState.textConsumed = true;
            let t = guiState.textInput;

            if (cfg.sanitize) {
              t = cfg.sanitize(t);
            }

            if (t) {
              pushUndo();
              const a = st.sel ? st.sel[0] : st.caret;
              const b = st.sel ? st.sel[1] : st.caret;
              st.buf = st.buf.slice(0, a) + t + st.buf.slice(b);
              st.caret = a + t.length;
              st.sel = null;

              if (cfg.maxLength && st.buf.length > cfg.maxLength) {
                st.buf = st.buf.slice(0, cfg.maxLength);
                st.caret = st.buf.length;
              }
            }
          }

          if (cfg.live) {
            const p = cfg.parse(st.buf);

            if (!cfg.invalid(p)) {
              const v = cfg.clamp ? cfg.clamp(p) : p;

              if (v !== value) {
                value = v;
                changed = true;
              }
            }
          }
        }
        st.caretT = (st.caretT || 0) + guiState.dt;

        if (guiState.focusedId !== item.itemId && !this.isMouseDown(0)) {
          commit();
        }
      }

      if (item.visible) {
        this._drawFrame(fw.x, fw.y, fw.w, fw.h, item);
        this.renderer.pushClip(fw.x, fw.y, fw.w, fw.h);
        // re-check live state: commit() may have run this frame and cleared st.buf

        if (st.edit === true && st.buf != null) {
          const drawStr = st.buf;
          const wholeW = this._measure(drawStr, fw.fo).w;
          let textScroll = st.textScroll || 0;
          const caretX = this._measure(drawStr.slice(0, st.caret), fw.fo).w;

          if (caretX + 4 > textScroll + textW) {
            textScroll = caretX + 4 - textW;
          }

          if (caretX - 4 < textScroll) {
            textScroll = Math.max(0, caretX - 4);
          }
          st.textScroll = Math.max(0, textScroll);

          if (st.sel) {
            const a = Math.min(st.sel[0], st.sel[1]);
            const b = Math.max(st.sel[0], st.sel[1]);
            const x1 = this._measure(drawStr.slice(0, a), fw.fo).w - textScroll;
            const x2 = this._measure(drawStr.slice(0, b), fw.fo).w - textScroll;
            this.renderer.fillRect(
              textX + x1,
              textY,
              Math.max(1, x2 - x1),
              fw.lineH,
              this._col("textSelectedBg"),
            );
          }
          this._drawText(
            textX - textScroll,
            textY,
            drawStr,
            item.enabled ? this._col("text") : this._col("textDisabled"),
            fw.fo,
          );
          const blink = this.flags.animations
            ? Math.floor((st.caretT || 0) / this._var("caretBlinkRate")) % 2 ===
              0
            : true;

          if (blink || st.sel) {
            const cx =
              this._measure(drawStr.slice(0, st.caret), fw.fo).w - textScroll;
            this.renderer.line(
              textX + cx,
              textY + 1,
              textX + cx,
              textY + fw.lineH - 1,
              this._col("text"),
              1,
            );
          }

          if (st.flash && guiState.now - st.flash < 400)
            this.renderer.strokeRoundedRect(
              fw.x + 0.5,
              fw.y + 0.5,
              fw.w - 1,
              fw.h - 1,
              this._var("frameRounding"),
              this._col("error"),
              1.5,
            );
        } else {
          const display = cfg.fmt(value);
          this._drawText(
            textX,
            textY,
            display,
            item.enabled ? this._col("text") : this._col("textDisabled"),
            fw.fo,
          );

          if (guiState.focusedId === item.itemId && item.enabled) {
            const m = this._measure(display, fw.fo).w;
            this.renderer.line(
              textX + m + 2,
              textY + 1,
              textX + m + 2,
              textY + fw.lineH - 1,
              this._col("text"),
              1,
            );
          }
        }
        this.renderer.popClip();

        if (fw.labelRect.w > 0)
          this._drawText(
            fw.labelRect.x,
            fw.labelRect.y,
            label,
            item.enabled ? this._col("text") : this._col("textDisabled"),
            fw.fo,
          );
      }
      this._drawFocusRing(item);

      if (stateful) {
        st.value = value;
      }

      if (changed) {
        guiState.changedId = item.itemId;
      }

      return value;
    }

    /**
     * A dropdown list: clicking opens a popup of the items; the selected
     *   * row is shown on the button.
     * @param {string} label
     * @param {number|null} value selected index into items, or null for library-kept state
     * @param {Array} items row labels
     * @param {Object} [opts] { w, maxVisible (default 8) }
     * @returns {number} the selected index
     */
    combo(label, value, itemList, options) {
      options = options || {};
      const guiState = this.state;
      const ids = this._id(label);
      const st = this._state(ids.stateKey);
      const stateful = value == null;
      // consume a selection committed in the previous endFrame (popup pass)

      if (st.pending != null) {
        value = st.pending;
        st.pending = null;
      }

      if (stateful) {
        value = value != null ? value : st.value != null ? st.value : 0;
      }
      value = clamp(Math.round(value), 0, Math.max(0, itemList.length - 1));
      const fw = this._frameWidget(label);
      const item = fw.it;
      const res = this._clickable(item);
      let changed = false;
      const pid = "##combo" + item.itemId;
      const p = guiState.popups.get(pid);
      const openIt = () =>
        this._openPopup(
          pid,
          {
            x: fw.x,
            y: fw.y + fw.h + 2,
          },
          {
            type: "combo",
            items: itemList,
            maxVisible: options.maxVisible || 8,
            width: fw.w,
            value: () => (stateful ? (st.value != null ? st.value : 0) : value),
            set: (i) => {
              st.pending = i;

              if (stateful) {
                st.value = i;
              }
            },
          },
          item.itemId,
        );

      if (res.clicked)
        if (p && p.open) {
          p.open = false;
        } else openIt();

      if (guiState.focusedId === item.itemId && this.flags.keyboardNavigation) {
        if (this.isKeyPressed("up")) {
          value = (value - 1 + itemList.length) % itemList.length;
          changed = true;

          if (stateful) {
            st.value = value;
          }
        }

        if (this.isKeyPressed("down")) {
          value = (value + 1) % itemList.length;
          changed = true;

          if (stateful) {
            st.value = value;
          }
        }

        if (this.isKeyPressed("enter") || this.isKeyPressed(" "))
          if (p && p.open) {
            p.open = false;
          } else openIt();
      }

      if (item.visible) {
        this._drawFrame(fw.x, fw.y, fw.w, fw.h, item);
        let preview = itemList[value] != null ? String(itemList[value]) : "";
        const arrowW = 18;
        const maxW = fw.w - arrowW - fpPad(this);

        while (
          preview.length > 2 &&
          this._measure(preview + "…", fw.fo).w > maxW
        )
          preview = preview.slice(0, -1);

        if (preview !== String(itemList[value])) {
          preview += "…";
        }
        this._drawText(
          fw.x + 8,
          fw.y + (fw.h - fw.lineH) / 2 + 1,
          preview,
          item.enabled ? this._col("text") : this._col("textDisabled"),
          fw.fo,
        );
        const ax = fw.x + fw.w - 14,
          ay = fw.y + fw.h / 2;
        this.renderer.fillPolygon(
          [ax - 4, ay - 2.5, ax + 4, ay - 2.5, ax, ay + 3],
          item.enabled ? this._col("text") : this._col("textDisabled"),
        );

        if (fw.labelRect.w > 0)
          this._drawText(
            fw.labelRect.x,
            fw.labelRect.y,
            label,
            item.enabled ? this._col("text") : this._col("textDisabled"),
            fw.fo,
          );
      }
      this._drawFocusRing(item);

      if (stateful) {
        st.value = value;
      }

      if (changed) {
        guiState.changedId = item.itemId;
      }

      return value;
    }

    /**
     * A selectable list box: a bordered, scrollable list of rows where the
     * user picks exactly one entry. The selected row is highlighted, the box
     * scrolls with the wheel (and a scrollbar when needed), and the selected
     * row is kept in view.
     * @param {string} label
     * @param {number} value  selected index (or null for stateful)
     * @param {Array}  items  row texts
     * @param {Object} [opts] { w, h, rows, rowH, label } — label:false hides the caption
     * @returns {number} the selected index
     */
    listBox(label, value, itemList, options) {
      options = options || {};
      const guiState = this.state;
      const ids = this._id(label);
      const st = this._state(ids.stateKey);
      const stateful = value == null;

      if (stateful) {
        value = st.value != null ? st.value : 0;
      }
      itemList = itemList || [];
      const fontOptions = this._fo();
      const lineH = this._lineH();
      const itemSpacing = this._var("itemSpacing");
      const rowH = options.rowH || lineH + 10;
      const avail = this.getRegionAvail();
      const w = options.w > 0 ? options.w : avail.w;
      const maxRows = Math.max(1, options.rows || 8);
      const visible = Math.min(itemList.length || 1, maxRows);
      const boxH =
        options.h > 0
          ? options.h
          : visible * (rowH + itemSpacing[1]) + itemSpacing[1];
      const pos = this._nextPos();
      let boxTop = pos.y;

      if (options.label !== false && label) {
        this._drawText(
          pos.x,
          pos.y,
          label,
          this._col("textDisabled"),
          fontOptions,
        );
        this._advance(pos.x, pos.y, w, lineH);
        const p2 = this._nextPos();
        boxTop = p2.y;
      }
      let changed = false;

      if (
        this.beginChild("##listbox" + ids.itemId, {
          w: w,
          h: boxH,
          padding: 4,
        })
      ) {
        const boxAvail = this.getRegionAvail();

        for (let i = 0; i < itemList.length; i++) {
          const p = this._nextPos();
          const rw = boxAvail.w;
          const itemId = hash3(fnv1a(ids.itemId), 0x1b33, i);
          const item = this._item(p.x, p.y, rw, rowH, itemId, {
            focusable: false,
          });
          const res = this._clickable(item);

          if (item.visible) {
            if (i === value || item.hovered)
              this.renderer.fillRoundedRect(
                p.x + 2,
                p.y + 2,
                rw - 4,
                rowH - 4,
                this._var("frameRounding"),
                i === value
                  ? this._col("headerActive")
                  : this._col("headerHovered"),
              );
            this._drawText(
              p.x + 10,
              p.y + (rowH - lineH) / 2 + 1,
              String(itemList[i]),
              item.enabled ? this._col("text") : this._col("textDisabled"),
              fontOptions,
            );
          }
          this._advance(p.x, p.y, rw, rowH);

          if (res.clicked && i !== value) {
            value = i;
            changed = true;
          }
        }
        this.endChild();
        // a fixed-height child reports fill; the parent cursor should advance
        // only by the box height, so re-pin the layout here
        const layout = guiState.layout;

        if (layout) {
          layout.y = boxTop - layout.origin.y + layout.scroll.y + boxH;
        }
        // keep the selected row in view
        const cr = guiState._childReturn;

        if (cr && cr.win) {
          const cw = cr.win;
          const pitch = rowH + itemSpacing[1];
          const top = value * pitch;
          const bot = top + rowH;
          const vh = cw.visibleContentH || 0;

          if (top < cw.scrollY) {
            cw.scrollTargetY = top;
          } else if (bot > cw.scrollY + vh) cw.scrollTargetY = bot - vh;
        }
      }
      this._advance(pos.x, boxTop, w, boxH);

      if (stateful) {
        st.value = value;
      }

      if (changed) {
        guiState.changedId = ids.itemId;
      }

      return value;
    }

    /**
     * A full-width clickable row (list item).
     * @param {string} label
     * @param {boolean} selected whether it is drawn as selected
     * @param {Object} [opts] { w, h, disabled }
     * @returns {boolean} true when clicked
     */
    selectable(label, isSelected, options) {
      options = options || {};
      const fontOptions = this._fo();
      const lineH = this._lineH();
      const pos = this._nextPos();
      const layout = this.state.layout;
      const w =
        options.width > 0
          ? options.width
          : Math.max(10, layout.avail.w - layout.x - layout.indent);
      const item = this._item(
        pos.x,
        pos.y,
        w,
        lineH + 6,
        this._id(label).itemId,
      );
      const res = this._clickable(item);
      const kbd =
        this.flags.keyboardNavigation &&
        this.state.focusedId === item.itemId &&
        this.isKeyPressed(" ");
      const clicked = res.clicked || kbd;

      if (item.visible) {
        if (isSelected || item.hovered)
          this.renderer.fillRoundedRect(
            pos.x,
            pos.y,
            w,
            lineH + 6,
            this._var("frameRounding"),
            isSelected ? this._col("headerActive") : this._col("headerHovered"),
          );
        this._drawText(
          pos.x + 8,
          pos.y + (lineH + 6 - lineH) / 2,
          label,
          item.enabled ? this._col("text") : this._col("textDisabled"),
          fontOptions,
        );

        if (options.callback && clicked) {
          options.callback();
        }
      }
      this._drawFocusRing(item);
      this._advance(item.x, item.y, w, lineH + 6);

      return clicked;
    }

    /**
     * A progress bar filled to fraction (clamped to 0..1), optionally with
     *   * overlay text centered on the bar.
     * @param {number} fraction
     * @param {Object} [opts] { h, overlay: text or null, size }
     * @returns {boolean} true when hovered
     */
    progressBar(fraction, opts) {
      opts = opts || {};
      const fontOptions = this._fo();
      const lineH = this._lineH();
      const pos = this._nextPos();
      const layout = this.state.layout;
      const w =
        opts.width > 0
          ? opts.width
          : Math.max(10, layout.avail.w - layout.x - layout.indent);
      const h = opts.height > 0 ? opts.height : Math.max(12, lineH + 4);
      const item = this._item(
        pos.x,
        pos.y,
        w,
        h,
        this._id("##progress" + (opts.id || "x")).itemId,
        {
          focusable: false,
        },
      );
      const frac = clamp01(isFinite(fraction) ? fraction : 0);

      if (item.visible) {
        this.renderer.fillRoundedRect(
          pos.x,
          pos.y,
          w,
          h,
          this._var("frameRounding"),
          this._col("frameBg"),
        );

        if (frac > 0)
          this.renderer.fillRoundedRect(
            pos.x + 2,
            pos.y + 2,
            Math.max(2, (w - 4) * frac),
            h - 4,
            this._var("frameRounding") - 1,
            this._col("sliderGrab"),
          );
        const overlay =
          opts.overlay != null
            ? String(opts.overlay)
            : Math.round(frac * 100) + "%";
        const m = this._measure(overlay, fontOptions);

        if (m.w < w - 12)
          this._drawText(
            pos.x + (w - m.w) / 2,
            pos.y + (h - lineH) / 2 + 1,
            overlay,
            this._col("text"),
            fontOptions,
          );
      }
      this._advance(item.x, item.y, w, h);

      return item.hovered;
    }

    /**
     * A collapsible section header (chevron + label); clicking toggles its
     *   * open state.
     * @param {string} label
     * @param {Object} [opts] { open: initial open state, or null for library-kept state }
     * @returns {boolean} true when the section is open (draw its contents in that case)
     */
    collapsingHeader(label, options) {
      options = options || {};
      const guiState = this.state;
      const ids = this._id(label);
      const st = this._state(ids.stateKey);
      const stateful = options.open == null;
      let open = stateful ? !!st.open : !!options.open;
      const fontOptions = this._fo();
      const lineH = this._lineH();
      const pos = this._nextPos();
      const layout = guiState.layout;
      const w = Math.max(10, layout.avail.w - layout.x - layout.indent);
      const h = lineH + 8;
      const item = this._item(pos.x, pos.y, w, h, ids.itemId);
      const res = this._clickable(item);
      let changed = false;
      const kbd =
        this.flags.keyboardNavigation &&
        guiState.focusedId === item.itemId &&
        (this.isKeyPressed(" ") || this.isKeyPressed("enter"));

      if (res.clicked || kbd) {
        open = !open;
        changed = true;
      }

      if (stateful) {
        st.open = open;
      }

      if (changed) {
        guiState.changedId = item.itemId;
      }

      if (item.visible) {
        const bg = !item.enabled
          ? this._col("header")
          : item.active
            ? this._col("headerActive")
            : item.hovered
              ? this._col("headerHovered")
              : this._col("header");
        this.renderer.fillRoundedRect(
          pos.x,
          pos.y,
          w,
          h,
          this._var("frameRounding"),
          bg,
        );
        const cx = pos.x + 12,
          cy = pos.y + h / 2;
        const c = item.enabled ? this._col("text") : this._col("textDisabled");

        if (open) {
          this.renderer.fillPolygon(
            [cx - 5, cy - 3, cx + 5, cy - 3, cx, cy + 4],
            c,
          );
        } else
          this.renderer.fillPolygon(
            [cx - 3, cy - 5, cx - 3, cy + 5, cx + 4, cy],
            c,
          );
        this._drawText(
          pos.x + 24,
          pos.y + (h - lineH) / 2 + 1,
          label,
          c,
          fontOptions,
        );
      }
      this._drawFocusRing(item);
      this._advance(item.x, item.y, w, h);

      return open;
    }

    /**
     * A tree node (one indent step deeper while open).
     * @param {string} label
     * @returns {boolean} true when open (draw the nested content in that case)
     */
    treeNode(label) {
      const guiState = this.state;
      const ids = this._id(label);
      const st = this._state(ids.stateKey);
      let open = !!st.open;
      const fontOptions = this._fo();
      const lineH = this._lineH();
      const pos = this._nextPos();
      const layout = guiState.layout;
      const w = Math.max(10, layout.avail.w - layout.x - layout.indent);
      const h = lineH + 6;
      const item = this._item(pos.x, pos.y, w, h, ids.itemId);
      const res = this._clickable(item);
      let changed = false;
      const kbd =
        this.flags.keyboardNavigation &&
        guiState.focusedId === item.itemId &&
        (this.isKeyPressed(" ") || this.isKeyPressed("enter"));

      if (res.clicked || kbd) {
        open = !open;
        changed = true;
      }
      st.open = open;

      if (changed) {
        guiState.changedId = item.itemId;
      }

      if (item.visible) {
        if (item.hovered)
          this.renderer.fillRoundedRect(
            pos.x,
            pos.y,
            w,
            h,
            this._var("frameRounding"),
            this._col("headerHovered"),
          );
        const cx = pos.x + 10,
          cy = pos.y + h / 2;

        if (open)
          this.renderer.fillPolygon(
            [cx - 4, cy - 2.5, cx + 4, cy - 2.5, cx, cy + 3.5],
            this._col("text"),
          );
        else
          this.renderer.fillPolygon(
            [cx - 2.5, cy - 4, cx - 2.5, cy + 4, cx + 3.5, cy],
            this._col("textDisabled"),
          );
        this._drawText(
          pos.x + 20,
          pos.y + (h - lineH) / 2 + 1,
          label,
          this._col("text"),
          fontOptions,
        );
      }

      if (open) {
        guiState.treeLines.push({
          x: pos.x + 10,
          y0: pos.y + h,
        });
        this.pushId(ids.itemId);
        this.indent(24); // child content aligns right of the parent label
      }
      this._advance(item.x, item.y, w, h);

      return open;
    }
    /**
     * Closes one open tree node.
     */
    treePop() {
      const guiState = this.state;

      if (guiState.treeLines.length) {
        guiState.treeLines.pop();
        this.popId();
        this.unindent(24);
      }
    }
    /**
     * Closes tree nodes until the depth is n.
     * @param {number} n
     */
    treePopToLevel(n) {
      while (this.state.treeLines.length > n) this.treePop();
    }

    /* ---------------------------- tabs ---------------------------------- */

    /**
     * Begins a tab bar; the following beginTabItem() calls fill it.
     * @param {string} id
     * @returns {boolean} true when the bar is drawn
     */
    beginTabBar(id) {
      const guiState = this.state;
      const ids = this._id(id || "##tabbar");
      const st = this._state(ids.stateKey);

      if (st.tab == null) {
        st.tab = 0;
      }
      const pos = this._nextPos();
      const layout = guiState.layout;
      const lineH = this._lineH();
      const barH = lineH + 12;
      const w = Math.max(10, layout.avail.w - layout.x - layout.indent);
      guiState.tabStack.push({
        st,
        x: pos.x,
        y: pos.y,
        w,
        barH,
        count: 0,
        prevCount: st.count || 1,
        cursor: 0,
        origOriginY: layout.origin.y,
        origAvailH: layout.avail.h,
        contentY: layout.y,
        active: false,
      });

      return true;
    }
    /**
     * Begins a tab item inside the current tab bar.
     * @param {string} label
     * @param {Object} [opts]
     * @returns {boolean} true when this tab is active (draw its contents), otherwise false
     */
    beginTabItem(label, options) {
      options = options || {};
      const guiState = this.state;
      const bar = guiState.tabStack[guiState.tabStack.length - 1];

      if (!bar) {
        return false;
      }
      const idx = bar.count++;
      const st = bar.st;
      const fontOptions = this._fo();
      const lineH = this._lineH();
      const ids = this._id(label);
      const lw = this._measure(label, fontOptions).w;
      const tw = lw + 22 + (options.closable ? 14 : 0);
      bar.cursor = bar.cursor || 0;
      const x = bar.x + bar.cursor;
      bar.cursor += tw + 4;
      const y = bar.y;
      const h = bar.barH;
      const active = st.tab === idx;
      const item = this._item(x, y, tw, h, ids.itemId);
      const res = this._clickable(item);

      if (res.clicked)
        if (options.closable && guiState.mouse.x >= x + tw - 16) {
          if (typeof options.onClose === "function") {
            options.onClose();
          }
        } else if (!active) {
          st.tab = idx;
          guiState.changedId = item.itemId;
        }

      if (item.visible) {
        const rr = this._var("tabRounding");
        const bg = active
          ? this._col("tabActive")
          : item.hovered
            ? this._col("tabHovered")
            : this._col("tab");
        this.renderer.fillRoundedRect(x, y, tw, h, rr, bg);

        if (active) {
          this.renderer.fillRect(x + rr, y + h - 2, tw - rr * 2, 2, bg);
        }
        this._drawText(
          x + 11,
          y + (h - lineH) / 2,
          label,
          active ? this._col("text") : this._col("textDisabled"),
          fontOptions,
        );

        if (options.closable && (item.hovered || active)) {
          const bx = x + tw - 12,
            by = y + h / 2;
          this.renderer.line(
            bx - 3,
            by - 3,
            bx + 3,
            by + 3,
            this._col("textDisabled"),
            1.2,
          );
          this.renderer.line(
            bx + 3,
            by - 3,
            bx - 3,
            by + 3,
            this._col("textDisabled"),
            1.2,
          );
        }
      }

      if (guiState.focusedId === item.itemId && this.flags.keyboardNavigation) {
        const n = Math.max(1, bar.prevCount);

        if (this.isKeyPressed("left")) {
          st.tab = (st.tab - 1 + n) % n;
        }

        if (this.isKeyPressed("right")) {
          st.tab = (st.tab + 1) % n;
        }
      }

      if (active) {
        const layout = guiState.layout;
        bar.active = true;
        // The content origin must be built from CONTENT coordinates
        // (origOriginY + contentY), not the bar's current screen y: the
        // screen y shifts with the window scroll, and using it here
        // stretched the tab region (and resized fill/share plots) every
        // time the window scrolled.
        layout.origin.y = bar.origOriginY + bar.contentY + h + 2;
        layout.avail.h = bar.origAvailH - bar.contentY - h - 2;
        layout.x = 0;
        layout.y = 0;
        layout.lineActive = false;
        layout.lineBottom = 0;
        layout.contentRight = 0;
        layout._same = false;
      }

      return active;
    }
    /**
     * Ends the tab item started with beginTabItem().
     */
    endTabItem() {
      const guiState = this.state;
      const bar = guiState.tabStack[guiState.tabStack.length - 1];

      if (!bar || !bar.active) {
        return;
      }
      const layout = guiState.layout;
      layout.lineActive = false;
      layout.x = 0;
      layout.y = layout.avail.h;
      bar.active = false;
    }
    /**
     * Ends the tab bar started with beginTabBar().
     */
    endTabBar() {
      const guiState = this.state;
      const bar = guiState.tabStack.pop();

      if (!bar) {
        return;
      }
      bar.st.count = bar.count;
      const layout = guiState.layout;
      layout.origin.y = bar.origOriginY;
      layout.avail.h = bar.origAvailH;
      layout.x = 0;
      layout.y = layout.avail.h;
      layout.lineActive = false;
    }

    /* ---------------------------- menu bar ------------------------------ */

    /**
     * Begins a window menu bar (a row of menus in the title area).
     * @returns {boolean} false when not drawn, otherwise true
     */
    beginMenuBar() {
      const guiState = this.state;

      return !!guiState.menuBar;
    }
    /**
     * Ends the window menu bar started with beginMenuBar().
     */
    endMenuBar() {
      this.state.menuBar = null;
    }

    /**
     * Opens a menu inside the current window menu bar.
     * @param {string} label
     * @returns {boolean} false when the menu is not open, otherwise true
     */
    beginMenu(label) {
      const guiState = this.state;

      if (guiState.currentMenu) {
        // nested menu inside an open menu
        const parent = guiState.currentMenu.popup;
        const subId = "##sub" + fnv1a(label + "\x01" + parent.id);
        guiState.currentMenu.rows.push({
          type: "submenu",
          label,
          subId,
        });
        const sub = guiState.popups.get(subId);

        if (sub && sub.open) {
          guiState.currentMenu = {
            popup: sub,
            rows: sub.data.items,
            _parent: guiState.currentMenu,
          };
          sub.data.items.length = 0;

          return true;
        }

        return false;
      }

      if (!guiState.menuBar) {
        return false;
      }
      const mb = guiState.menuBar;
      const fontOptions = this._fo();
      const lineH = this._lineH();
      const lw = this._measure(label, fontOptions).w;
      const w = lw + 20;
      const x = mb.x,
        y = mb.y - 4;
      mb.x += w + 6;
      const pid = "##menu" + fnv1a(label + "\x01" + mb.win.idHash);
      const p = guiState.popups.get(pid);
      const itemId = hash3(fnv1a(pid), 0x42a1, 0);
      const item = this._item(x, y, w, lineH + 8, itemId, {
        focusable: false,
      });
      let opened = false;

      if (p && p.open) {
        if (item.hovered && this.isMouseClicked(0)) {
          p.open = false;
        } else {
          opened = true;
          p.data.items.length = 0;
          guiState.currentMenu = {
            popup: p,
            rows: p.data.items,
            _parent: null,
          };
        }

        if (item.visible && item.hovered)
          this.renderer.fillRoundedRect(
            x,
            y,
            w,
            lineH + 8,
            4,
            this._col("headerHovered"),
          );
      } else {
        if (item.hovered && this.isMouseClicked(0)) {
          guiState.clickedItemId = itemId; // protect the popup from same-frame/next-frame dismissal
          this._openPopup(
            pid,
            {
              x,
              y: y + lineH + 12,
            },
            {
              type: "menu",
              items: [],
            },
            itemId,
            mb.win,
          );
        }

        if (item.visible && item.hovered)
          this.renderer.fillRoundedRect(
            x,
            y,
            w,
            lineH + 8,
            4,
            this._col("headerHovered"),
          );
      }

      if (item.visible) {
        this._drawText(x + 10, y + 4, label, this._col("text"), fontOptions);
      }

      return opened;
    }
    /**
     * Closes the menu started with beginMenu().
     */
    endMenu() {
      const guiState = this.state;

      if (guiState.currentMenu) {
        guiState.currentMenu = guiState.currentMenu._parent || null;
      }
    }

    /**
     * A menu row with an optional shortcut label.
     * @param {string} label
     * @param {string} [shortcut] 'ctrl+s'-style display string
     * @param {Object} [opts] { selected: bool or () => bool (checkmark), disabled }
     * @returns {boolean} true when clicked
     */
    menuItem(label, shortcutLabel, options) {
      options = options || {};
      const guiState = this.state;

      if (guiState.currentMenu) {
        guiState.currentMenu.rows.push({
          type: "item",
          label,
          shortcut: shortcutLabel || "",
          selected: !!options.selected,
          disabled: !!options.disabled,
          onActivated: options.onActivated || null,
        });

        return false;
      }

      if (guiState.popupLayoutActive) {
        const fontOptions = this._fo();
        const lineH = this._lineH();
        const pos = this._nextPos();
        // natural width (label + shortcut + padding) so the popup sizes to content
        const labelW = this._measure(label, fontOptions).w;
        const scW = shortcutLabel
          ? this._measure(shortcutLabel, fontOptions).w + 16
          : 0;
        const w = Math.max(40, labelW + scW + (options.selected ? 26 : 20));
        const item = this._item(
          pos.x,
          pos.y,
          w,
          lineH + 6,
          this._id("##mi" + label).itemId,
        );
        const res = this._clickable(item);

        if (res.clicked && typeof options.onActivated === "function") {
          options.onActivated();
        }

        if (res.clicked) {
          for (const p of guiState.popupList) p.open = false;
        }

        if (item.visible) {
          if (item.hovered)
            this.renderer.fillRoundedRect(
              pos.x,
              pos.y,
              w,
              lineH + 6,
              4,
              this._col("headerHovered"),
            );
          const tx = pos.x + 10 + (options.selected ? 16 : 0);

          if (options.selected) {
            const cx = pos.x + 14,
              cy = pos.y + (lineH + 6) / 2;
            this.renderer.polyline(
              [cx - 3, cy, cx - 1, cy + 3, cx + 4, cy - 3],
              this._col("checkMark"),
              1.6,
            );
          }
          this._drawText(tx, pos.y + 3, label, this._col("text"), fontOptions);

          if (shortcutLabel) {
            const m = this._measure(shortcutLabel, fontOptions);
            this._drawText(
              pos.x + w - 8 - m.w,
              pos.y + 3,
              shortcutLabel,
              this._col("textDisabled"),
              fontOptions,
            );
          }
        }
        this._advance(pos.x, pos.y, w, lineH + 6);

        return res.clicked;
      }

      return false;
    }

    /* ---------------------------- tables -------------------------------- */

    /**
     * Begins a table with cols columns.
     * @param {string} label
     * @param {number} cols number of columns
     * @param {Object} [opts] { colWidths: [w, ...] (entries <= 0 are flexible), borders (default true) }
     * @returns {boolean} true when the table is drawn
     */
    beginTable(label, cols, opts) {
      opts = opts || {};
      const guiState = this.state;
      const ids = this._id(label);
      const pos = this._nextPos();
      const layout = guiState.layout;
      const availW = Math.max(10, layout.avail.w - layout.x - layout.indent);
      const widths =
        opts.colWidths && opts.colWidths.length === cols
          ? opts.colWidths
          : null;
      const fixedTotal = widths
        ? widths.reduce((a, b) => a + (b > 0 ? b : 0), 0)
        : 0;
      const flexCount = widths ? widths.filter((b) => b <= 0).length : cols;
      const flexW = flexCount > 0 ? (availW - fixedTotal) / flexCount : 0;
      const colW = [];

      for (let i = 0; i < cols; i++)
        colW.push(widths && widths[i] > 0 ? widths[i] : flexW);
      guiState.table = {
        x0: pos.x,
        colW,
        cols,
        rowH: this._lineH() + 10,
        y: pos.y,
        rowBottom: pos.y,
        startY: pos.y,
        borders: opts.borders !== false,
        rowIndex: 0,
        cell: -1,
        _availW0: layout.avail.w,
      };

      return true;
    }
    _tableCellX(i) {
      const t = this.state.table;
      let x = t.x0;

      for (let c = 0; c < i; c++) x += t.colW[c];

      return x;
    }
    _tableSyncLayout() {
      const t = this.state.table;

      if (!t) {
        return;
      }
      const layout = this.state.layout;
      layout.x = t.x0 - layout.origin.x + layout.scroll.x;
      layout.y = t.y - layout.origin.y + layout.scroll.y;
      layout.lineActive = false;
      layout.avail.w = t._availW0;
    }
    _tableVLines(y0, y1) {
      const t = this.state.table;

      for (let c = 1; c < t.cols; c++) {
        const x = this._tableCellX(c);
        this.renderer.line(
          x + 0.5,
          y0,
          x + 0.5,
          y1,
          withAlpha(this._col("separator"), 0.5),
          1,
        );
      }
    }
    /**
     * Draws the table's header row from the column definitions.
     * @param {Array} labels cell texts (same length as cols)
     */
    tableHeader(labels) {
      const t = this.state.table;

      if (!t) {
        return;
      }
      const fontOptions = this._fo();
      const lineH = this._lineH();
      const y = t.y;
      const totalW = t.colW.reduce((a, b) => a + b, 0);
      this.renderer.fillRoundedRect(
        t.x0,
        y,
        totalW,
        t.rowH,
        4,
        this._col("tableHeader"),
      );

      for (let i = 0; i < t.cols; i++) {
        const x = this._tableCellX(i);
        const str = labels && labels[i] != null ? String(labels[i]) : "";
        this._drawText(
          x + 8,
          y + (t.rowH - lineH) / 2,
          str,
          this._col("text"),
          fontOptions,
        );
      }
      this.renderer.line(
        t.x0,
        y + t.rowH - 0.5,
        t.x0 + totalW,
        y + t.rowH - 0.5,
        this._col("separator"),
        1,
      );
      this._tableVLines(y, y + t.rowH);
      t.rowBottom = y + t.rowH;
      t.y = t.rowBottom;
      this._tableSyncLayout();
    }
    /**
     * Draws a table row from an array of cell values.
     * @param {Array} values missing cells render as a dash
     */
    tableRow(values) {
      const t = this.state.table;

      if (!t) {
        return;
      }
      const fontOptions = this._fo();
      const lineH = this._lineH();
      const y = t.y;
      const totalW = t.colW.reduce((a, b) => a + b, 0);

      if (t.rowIndex % 2 === 1)
        this.renderer.fillRoundedRect(
          t.x0,
          y,
          totalW,
          t.rowH,
          2,
          this._col("tableBgAlt"),
        );

      for (let i = 0; i < t.cols; i++) {
        const x = this._tableCellX(i);
        let str = values && values[i] != null ? String(values[i]) : "";

        if (this._measure(str, fontOptions).w > t.colW[i] - 14) {
          while (
            str.length > 1 &&
            this._measure(str + "…", fontOptions).w > t.colW[i] - 14
          )
            str = str.slice(0, -1);
          str += "…";
        }
        this._drawText(
          x + 8,
          y + (t.rowH - lineH) / 2,
          str,
          this._col("text"),
          fontOptions,
        );
      }
      this.renderer.line(
        t.x0,
        y + t.rowH - 0.5,
        t.x0 + totalW,
        y + t.rowH - 0.5,
        withAlpha(this._col("separator"), 0.6),
        1,
      );
      this._tableVLines(y, y + t.rowH);
      t.rowBottom = y + t.rowH;
      t.y = t.rowBottom;
      t.rowIndex++;
      this._tableSyncLayout();
    }
    /**
     * Opens a manual table cell; draw its content (even a widget) and close
     *   * the row with tableEndRow().
     * @param {number} i column index
     * @returns {Object|null} the cell rect {x, y, w, h}, or null when no table is open
     */
    tableCell(i) {
      const t = this.state.table;

      if (!t) {
        return null;
      }
      i = clamp(Math.floor(i), 0, t.cols - 1);

      if (i <= t.cell) {
        t.y = t.rowBottom;
        t.cell = -1;
      }
      t.cell = i;
      const x = this._tableCellX(i) + 8;
      const y = t.y + (t.rowH - this._lineH()) / 2;
      const layout = this.state.layout;
      layout.x = x - layout.origin.x + layout.scroll.x;
      layout.y = y - layout.origin.y + layout.scroll.y;
      layout.lineActive = false;
      layout.avail.w = Math.max(4, t.colW[i] - 16);

      return {
        x,
        y: t.y,
        w: t.colW[i] - 8,
        h: t.rowH,
      };
    }
    /**
     * Closes the current table row (after manual cells).
     */
    tableEndRow() {
      const t = this.state.table;

      if (!t) {
        return;
      }
      const layout = this.state.layout;
      t.rowBottom = Math.max(
        t.rowBottom,
        layout.origin.y + layout.y - layout.scroll.y,
      );
      const totalW = t.colW.reduce((a, b) => a + b, 0);
      this.renderer.line(
        t.x0,
        t.rowBottom - 0.5,
        t.x0 + totalW,
        t.rowBottom - 0.5,
        withAlpha(this._col("separator"), 0.6),
        1,
      );
      this._tableVLines(t.y, t.rowBottom);
      t.y = t.rowBottom;
      t.rowIndex++;
      t.cell = -1;
      this._tableSyncLayout();
    }
    /**
     * Ends the table started with beginTable().
     */
    endTable() {
      const t = this.state.table;

      if (!t) {
        return;
      }
      const totalW = t.colW.reduce((a, b) => a + b, 0);
      const h = Math.max(1, t.y - t.startY);
      this.renderer.strokeRoundedRect(
        t.x0 + 0.5,
        t.startY + 0.5,
        totalW - 1,
        h - 1,
        4,
        this._col("separator"),
        1,
      );
      this._tableSyncLayout();
      const layout = this.state.layout;
      layout.lineActive = false;
      this.state.table = null;
    }

    /* ---------------------------- plots / images ------------------------ */

    /* Height for plot widgets: explicit opts.h wins; opts.share: n splits the
       region evenly among n sibling plots; otherwise the plot FILLS the
       remaining region (ImGui-style default). Siblings share via per-frame
       groups keyed by container + n, so each gets exactly avail/n (minus the
       spacing between members). */
    /**
     * Computes the height (px) a plot with these opts should take, using the
     *   * same h/share rules as plotLines() and the plot addons.
     * @param {Object} opts { h, share }
     * @param {number} minH minimum height
     * @param {number} [extra] extra pixels reserved for other content
     * @returns {number}
     */
    plotHeight(opts, minH, extra) {
      opts = opts || {};
      extra = extra || 0;
      const guiState = this.state;
      const itemSpacing = this._var("itemSpacing");
      const avail = this.getRegionAvail().h;

      if (opts.share > 0) {
        if (guiState._shareFrame !== guiState.frameId) {
          guiState._shareFrame = guiState.frameId;
          guiState._shareGroups = {};
        }
        const cont = guiState.layout && guiState.layout.container;
        const key =
          ((cont && (cont.title || cont.label)) || "") + ":" + opts.share;
        let g = guiState._shareGroups[key];

        if (!g) {
          g = {
            n: opts.share,
            avail0: avail,
          };
          guiState._shareGroups[key] = g;
        }
        // safety margin: content bookkeeping (trailing spacing + padding
        // rounding) exceeds the raw avail by ~one spacing — stay clear of
        // the scrollbar rather than overflow it
        const ideal =
          (g.avail0 - g.n * (extra + itemSpacing[1]) - itemSpacing[1] - 20) /
          g.n;

        return Math.max(minH, Math.min(ideal, avail));
      }

      return Math.max(minH, avail);
    }

    /**
     * A mini line chart of the given values.
     * @param {string} label
     * @param {Array} values numbers
     * @param {Object} [opts] { h, share, min, max, overlay, color } — with no h the plot fills the remaining region; share: n splits the remaining height evenly with n-1 sibling plots
     * @returns {boolean} true when hovered
     */
    plotLines(label, seriesValues, options) {
      options = options || {};

      if (options.h == null)
        options = Object.assign({}, options, {
          h: this.plotHeight(options, 60),
        });
      const fw = this._frameWidget(label, {
        focusable: false,
        h: options.h,
      });
      const item = fw.it;
      seriesValues = (seriesValues || []).filter((v) => isFinite(v));

      if (item.visible && seriesValues.length > 1) {
        this._drawFrame(fw.x, fw.y, fw.w, fw.h, item);
        let vmin = options.min != null ? options.min : Infinity;
        let vmax = options.max != null ? options.max : -Infinity;

        if (options.min == null || options.max == null)
          for (const v of seriesValues) {
            if (v < vmin) {
              vmin = v;
            }

            if (v > vmax) {
              vmax = v;
            }
          }

        if (vmax <= vmin) {
          vmax = vmin + 1;
        }
        const px = fw.x + 4,
          py = fw.y + 4;
        const pw = Math.max(1, fw.w - 8),
          ph = Math.max(1, fw.h - 8);
        const pts = new Array(seriesValues.length * 2);

        for (let i = 0; i < seriesValues.length; i++) {
          pts[i * 2] = px + (i / (seriesValues.length - 1)) * pw;
          pts[i * 2 + 1] =
            py + ph - ((seriesValues[i] - vmin) / (vmax - vmin)) * ph;
        }
        this.renderer.polyline(pts, this._col("plotLine"), 1.5);

        if (item.hovered) {
          const frac = clamp01((this.state.mouse.x - px) / pw);
          const vi = clamp(
            Math.round(frac * (seriesValues.length - 1)),
            0,
            seriesValues.length - 1,
          );
          const vx = px + (vi / (seriesValues.length - 1)) * pw;
          this.renderer.line(
            vx,
            py,
            vx,
            py + ph,
            withAlpha(this._col("text"), 110),
            1,
          );
          const overlay = fmtVal(seriesValues[vi], "%.2f");
          const m = this._measure(overlay, fw.fo);
          this._drawText(
            fw.x + fw.w - m.w - 5,
            fw.y + 2,
            overlay,
            this._col("text"),
            fw.fo,
          );
        } else if (options.overlay != null) {
          const m = this._measure(String(options.overlay), fw.fo);
          this._drawText(
            fw.x + fw.w - m.w - 5,
            fw.y + 2,
            options.overlay,
            this._col("textDisabled"),
            fw.fo,
          );
        }

        if (fw.labelRect.w > 0)
          this._drawText(
            fw.labelRect.x,
            fw.labelRect.y,
            label,
            this._col("textDisabled"),
            fw.fo,
          );
      } else if (item.visible) {
        this._drawFrame(fw.x, fw.y, fw.w, fw.h, item);

        if (fw.labelRect.w > 0)
          this._drawText(
            fw.labelRect.x,
            fw.labelRect.y,
            label,
            this._col("textDisabled"),
            fw.fo,
          );
      }
      this._advance(item.x, item.y, item.w, item.h);

      return item.hovered;
    }

    /**
     * Draws an image (the backend resolves imageId via its drawImage method).
     * @param {*} imageId string or object id for the backend
     * @param {number} w
     * @param {number} h
     * @param {Object} [opts] { id: id-scope label, tint }
     * @returns {boolean} true when hovered
     */
    image(imageId, w, h, opts) {
      opts = opts || {};
      const pos = this._nextPos();
      const item = this._item(
        pos.x,
        pos.y,
        w,
        h,
        this._id("##img" + (opts.id || imageId)).itemId,
        {
          focusable: false,
        },
      );

      if (item.visible)
        this.renderer.drawImage(
          imageId,
          pos.x,
          pos.y,
          w,
          h,
          opts.tint ? normColor(opts.tint) : null,
        );
      this._advance(item.x, item.y, w, h);

      return item.hovered;
    }
  }

  /* Small local helper for combo preview padding */

  // ---- misc helpers ----

  function fpPad(gui) {
    return 8;
  }

  /* ------------------------------------------------------------------------
   * Exports — a single global symbol.
   * -------------------------------------------------------------------- */

  /**
   * @namespace Mim
   * The single global the library installs (or what require('mim.js')
   * returns in Node). Everything public hangs off this object:
   * the GUI class, the style class, the constant tables (Layers, Key,
   * MouseButton, WindowFlags), the color helpers (Mim.Color) and the addon
   * registry (Mim.registerAddon).
   */

  // ---- public export object ----

  const Mim = {
    /** @member {GUI} The GUI class (the main entry point). */
    GUI,
    /** @member {Style} The style class (colors, vars, font). */
    Style,
    /** @member {Object} Layer names for gui.layer() / renderer.setLayer(). */
    Layers,
    /** @member {Object} Key tokens for the isKey*() queries and input.keys. */
    Key,
    /** @member {Object} Mouse button indices (0 left, 1 right, 2 middle,
     *  3 back, 4 forward). */
    MouseButton,
    /** @member {Object} Window option flags (bitmask for beginWindow). */
    WindowFlags,
    /**
     * @member {Object} Color helpers: rgba(r,g,b,a), hex('#rrggbb'),
     *   mix(c1, c2, t), withAlpha(c, a). Colors are [r,g,b,a] arrays, 0..255.
     */
    Color: {
      rgba,
      hex: hexToColor,
      mix: mixColor,
      withAlpha,
    },
    /** @member {string} The library version. */
    version: VERSION,
    /**
     * Registers an addon: the factory is stored and installed onto every GUI
     * instance as gui.addons.<name> (existing instances pick it up on their
     * next reloadAddons() call).
     * @param {string} name the addon namespace (gui.addons.<name>)
     * @param {function} factory (gui, Mim) => ({ methodName: fn, ... }) — the
     *   returned object's methods become the addon's API. Use the public GUI
     *   API plus gui.renderer for custom drawing; keep the file
     *   self-contained and dependency-free.
     * @returns {Mim} the Mim namespace (chainable)
     */
    registerAddon(name, factory) {
      MIM_ADDONS[String(name)] = factory;

      return Mim;
    },
    /**
     * Removes a registered addon (new GUI instances no longer get it;
     * existing instances can drop it with reloadAddons()).
     * @param {string} name
     * @returns {Mim} the Mim namespace (chainable)
     */
    unregisterAddon(name) {
      delete MIM_ADDONS[String(name)];

      return Mim;
    },
    /**
     * @returns {string[]} the names of all registered addons
     */
    addonNames() {
      return Object.keys(MIM_ADDONS);
    },
  };
  /**
   * Reinstalls the addons on this instance: all registered addons by
   * default, or only the named ones (list of names / false for none).
   * Call it after Mim.registerAddon(...) on an existing instance.
   * @param {boolean|Array} [list]
   * @returns {Object} the gui.addons object
   */
  GUI.prototype.reloadAddons = function (list) {
    this.addons = {};
    this._installAddons(list === undefined ? true : list);

    return this.addons;
  };

  if (global) {
    global.Mim = Mim;
  }

  return Mim;
})(
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof self !== "undefined"
      ? self
      : this,
);
