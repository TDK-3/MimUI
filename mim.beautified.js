/* ============================================================================
 * Mim — a single-file immediate-mode GUI library for JavaScript
 * ----------------------------------------------------------------------------
 * Mim is a Dear-ImGui inspired immediate mode GUI whose core is completely
 * backend agnostic. The core never draws anything itself and never touches
 * platform APIs. It issues drawing commands through a renderer interface
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
 * RENDERER INTERFACE (implemented by the host, e.g. demo/p5-backend.js)
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
    'use strict';

    const VERSION = '1.4.3';

    /* ------------------------------------------------------------------------
     * Small utilities
     * -------------------------------------------------------------------- */

    const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
    const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
    const lerp = (a, b, t) => a + (b - a) * t;
    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

    function nowMs() {
        if (typeof performance !== 'undefined' && performance.now) return performance.now();
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
        return (Math.imul(a >>> 0, 0x9e3779b1) ^ Math.imul(b >>> 0, 0x85ebca6b)) >>> 0;
    }
    function hash3(a, b, c) {
        return (hashPair(a, b) ^ Math.imul(c >>> 0, 0xcc9e2d51)) >>> 0;
    }

    function pointInRect(x, y, r) {
        return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
    }
    function rectsOverlap(a, b) {
        return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
    }

    /* Colors are plain arrays [r, g, b, a] (0..255). Never mutate a color you
     * obtained from the style; use mix/withAlpha which return new arrays. */
    const rgba = (r, g, b, a) => [r | 0, g | 0, b | 0, a == null ? 255 : a | 0];
    function hexToColor(str) {
        let m = /^#?([0-9a-f]{3,8})$/i.exec(String(str).trim());
        if (!m) return rgba(255, 0, 255, 255);
        let h = m[1];
        if (h.length === 3 || h.length === 4)
            h = h
                .split('')
                .map((c) => c + c)
                .join('');
        if (h.length === 6) h = 'ff' + h; // #rrggbb -> alpha first? we store [r,g,b,a]; append alpha
        const r = parseInt(h.slice(0, 2), 16);
        const g = parseInt(h.slice(2, 4), 16);
        const b = parseInt(h.slice(4, 6), 16);
        const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) : 255;
        return [r, g, b, a];
    }
    function normColor(c) {
        if (c == null) return null;
        if (typeof c === 'string') return hexToColor(c);
        if (Array.isArray(c)) return [c[0] | 0, c[1] | 0, c[2] | 0, c[3] == null ? 255 : c[3] | 0];
        if (typeof c.r === 'number')
            return [c.r | 0, c.g | 0, c.b | 0, c.a == null ? 255 : (c.a * (c.a > 1 ? 1 : 255)) | 0];
        return rgba(200, 200, 200, 255);
    }
    function mixColor(c1, c2, t) {
        return [
            lerp(c1[0], c2[0], t) | 0,
            lerp(c1[1], c2[1], t) | 0,
            lerp(c1[2], c2[2], t) | 0,
            lerp(c1[3], c2[3], t) | 0,
        ];
    }
    function withAlpha(c, a) {
        return [c[0], c[1], c[2], a | 0];
    }

    /* Word-wrap `str` to maxW pixels using measure(line) -> width. */
    function wrapText(str, maxW, measure) {
        const out = [];
        let line = '';
        for (const rawPart of String(str).split(' ')) {
            if (rawPart === '') {
                out.push(line);
                line = '';
                continue;
            }
            const candidate = line ? line + ' ' + rawPart : rawPart;
            if (measure(candidate).w <= maxW || line === '') {
                // hard-break words that are longer than maxW on their own
                if (line === '' && measure(rawPart).w > maxW) {
                    let chunk = '';
                    for (const ch of rawPart) {
                        if (chunk && measure(chunk + ch).w > maxW) {
                            out.push(chunk);
                            chunk = ch;
                        } else chunk += ch;
                    }
                    line = chunk;
                } else if (line === '') line = rawPart;
                else line = candidate;
            } else {
                out.push(line);
                line = rawPart;
            }
        }
        if (line || out.length === 0) out.push(line);
        return out;
    }

    function fmtVal(v, fmt) {
        if (v == null || !isFinite(v)) return '∞';
        if (fmt === '%d') return String(Math.round(v));
        const m = /^%\.(\d+)f$/.exec(fmt || '');
        if (m) return v.toFixed(+m[1]);
        if (Math.abs(v) >= 10000) return v.toFixed(0);
        return String(Math.round(v * 1000) / 1000);
    }

    /* ------------------------------------------------------------------------
     * Public constants
     * -------------------------------------------------------------------- */

    const Layers = Object.freeze({
        Background: 'background',
        GUI: 'gui',
        Foreground: 'foreground',
    });

    const Key = Object.freeze({
        Space: ' ',
        Enter: 'enter',
        Tab: 'tab',
        Escape: 'escape',
        Backspace: 'backspace',
        Delete: 'delete',
        Insert: 'insert',
        Home: 'home',
        End: 'end',
        PageUp: 'pageup',
        PageDown: 'pagedown',
        Left: 'left',
        Right: 'right',
        Up: 'up',
        Down: 'down',
        Shift: 'shift',
        Ctrl: 'ctrl',
        Alt: 'alt',
        Meta: 'meta',
        F1: 'f1',
        F2: 'f2',
        F3: 'f3',
        F4: 'f4',
        F5: 'f5',
        F6: 'f6',
        F7: 'f7',
        F8: 'f8',
        F9: 'f9',
        F10: 'f10',
        F11: 'f11',
        F12: 'f12',
    });

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

    class Style {
        constructor(partial = {}) {
            const theme = Style.themes[partial.theme || 'dark'] || ThemeDark;
            this.colors = Object.assign({}, theme);
            if (partial.colors) {
                for (const k of Object.keys(partial.colors))
                    this.colors[k] = normColor(partial.colors[k]);
            }
            this.vars = Object.assign({}, DefaultVars);
            if (partial.vars) {
                for (const k of Object.keys(partial.vars)) {
                    const v = partial.vars[k];
                    this.vars[k] = Array.isArray(v) ? v.slice() : v;
                }
            }
            this.font = {
                size: partial.font && partial.font.size ? partial.font.size : this.vars.fontSize,
                id: (partial.font && partial.font.id) || 'default',
            };
        }
    }
    Style.themes = { dark: ThemeDark, light: ThemeLight };

    /* ------------------------------------------------------------------------
     * Renderer proxy
     * --------------------------------------------------------------------
     * Sits between the core and the user-supplied renderer. It maintains the
     * clip stack (for culling), applies a translation offset (used when
     * replaying deferred popup content), forwards recording into a buffer when
     * a popup capture is active, and skips no-op or culled draw calls so that
     * backends never receive garbage.
     * -------------------------------------------------------------------- */

    const EMPTY_FEATURES = Object.freeze({});

    class RendererProxy {
        constructor(gui, raw) {
            this.gui = gui;
            this.raw = raw || {};
            this.clip = null; // current intersected clip rect (culling only)
            this.clipStack = [];
            this.layer = Layers.GUI;
            this.cursor = 'default';
            this.offset = { x: 0, y: 0 };
            this.recording = null; // draw-call buffer while capturing popup content
            this.calls = 0;
        }

        _has(m) {
            return typeof this.raw[m] === 'function';
        }

        _call(m, args) {
            this.calls++;
            if (this.recording) this.recording.push([m, args]);
            if (this._has(m)) this.raw[m].apply(this.raw, args);
        }

        _clipOk(x, y, w, h) {
            if (w <= 0 || h <= 0) return false;
            const c = this.clip;
            if (!c) return true;
            return x < c.x + c.w && x + w > c.x && y < c.y + c.h && y + h > c.y;
        }

        beginFrame(w, h) {
            this.calls = 0;
            this.clip = null;
            this.clipStack.length = 0;
            this.offset.x = 0;
            this.offset.y = 0;
            this.recording = null;
            if (this._has('beginFrame')) this.raw.beginFrame(w, h);
        }
        endFrame() {
            if (this._has('endFrame')) this.raw.endFrame();
        }
        setLayer(l) {
            this.layer = l;
            this._call('setLayer', [l]);
        }
        /**
         * Optional: change the mouse cursor style ('default', 'pointer', 'text',
         * 'move', 'grab', 'grabbing', 'ew-resize', 'ns-resize', 'nwse-resize',
         * 'nesw-resize'). Only called by the core when the raw renderer advertises
         * `features.cursor === true`.
         */
        setCursor(c) {
            this.cursor = c;
            this._call('setCursor', [c]);
        }
        /** Capability set advertised by the raw renderer (e.g. { cursor: true, clip: true }). */
        get features() {
            return (this.raw && this.raw.features) || EMPTY_FEATURES;
        }

        pushClip(x, y, w, h) {
            const c = this.clip;
            const nx = Math.max(x, c ? c.x : -1e9);
            const ny = Math.max(y, c ? c.y : -1e9);
            const nr = Math.min(x + w, c ? c.x + c.w : 1e9);
            const nb = Math.min(y + h, c ? c.y + c.h : 1e9);
            this.clipStack.push(this.clip);
            this.clip = nr > nx && nb > ny ? { x: nx, y: ny, w: nr - nx, h: nb - ny } : null;
            this._call('pushClip', [x + this.offset.x, y + this.offset.y, w, h]);
        }
        popClip() {
            this.clip = this.clipStack.pop() || null;
            this._call('popClip', []);
        }

        /* --- shapes ---------------------------------------------------------- */

        fillRect(x, y, w, h, c) {
            if (!c || !c[3]) return;
            x += this.offset.x;
            y += this.offset.y;
            if (!this._clipOk(x, y, w, h)) return;
            this._call('fillRect', [x, y, w, h, c]);
        }
        fillRoundedRect(x, y, w, h, r, c) {
            if (!c || !c[3]) return;
            x += this.offset.x;
            y += this.offset.y;
            if (!this._clipOk(x, y, w, h)) return;
            this._call('fillRoundedRect', [x, y, w, h, r, c]);
        }
        strokeRect(x, y, w, h, c, t) {
            if (!c || !c[3]) return;
            t = t || 1;
            x += this.offset.x;
            y += this.offset.y;
            if (!this._clipOk(x - t, y - t, w + t * 2, h + t * 2)) return;
            this._call('strokeRect', [x, y, w, h, c, t]);
        }
        strokeRoundedRect(x, y, w, h, r, c, t) {
            if (!c || !c[3]) return;
            t = t || 1;
            x += this.offset.x;
            y += this.offset.y;
            if (!this._clipOk(x - t, y - t, w + t * 2, h + t * 2)) return;
            this._call('strokeRoundedRect', [x, y, w, h, r, c, t]);
        }
        line(x1, y1, x2, y2, c, t) {
            if (!c || !c[3]) return;
            t = t || 1;
            x1 += this.offset.x;
            y1 += this.offset.y;
            x2 += this.offset.x;
            y2 += this.offset.y;
            const m = t;
            if (
                !this._clipOk(
                    Math.min(x1, x2) - m,
                    Math.min(y1, y2) - m,
                    Math.abs(x2 - x1) + m * 2,
                    Math.abs(y2 - y1) + m * 2,
                )
            )
                return;
            this._call('line', [x1, y1, x2, y2, c, t]);
        }
        polyline(pts, c, t) {
            if (!c || !c[3] || !pts || pts.length < 4) return;
            t = t || 1;
            let minX = 1e9,
                minY = 1e9,
                maxX = -1e9,
                maxY = -1e9;
            for (let i = 0; i < pts.length; i += 2) {
                const px = pts[i] + this.offset.x,
                    py = pts[i + 1] + this.offset.y;
                if (px < minX) minX = px;
                if (px > maxX) maxX = px;
                if (py < minY) minY = py;
                if (py > maxY) maxY = py;
            }
            if (!this._clipOk(minX - t, minY - t, maxX - minX + t * 2, maxY - minY + t * 2)) return;
            const out = new Array(pts.length);
            for (let i = 0; i < pts.length; i += 2) {
                out[i] = pts[i] + this.offset.x;
                out[i + 1] = pts[i + 1] + this.offset.y;
            }
            this._call('polyline', [out, c, t]);
        }
        fillPolygon(pts, c) {
            if (!c || !c[3] || !pts || pts.length < 6) return;
            let minX = 1e9,
                minY = 1e9,
                maxX = -1e9,
                maxY = -1e9;
            for (let i = 0; i < pts.length; i += 2) {
                const px = pts[i] + this.offset.x,
                    py = pts[i + 1] + this.offset.y;
                if (px < minX) minX = px;
                if (px > maxX) maxX = px;
                if (py < minY) minY = py;
                if (py > maxY) maxY = py;
            }
            if (!this._clipOk(minX, minY, maxX - minX, maxY - minY)) return;
            const out = new Array(pts.length);
            for (let i = 0; i < pts.length; i += 2) {
                out[i] = pts[i] + this.offset.x;
                out[i + 1] = pts[i + 1] + this.offset.y;
            }
            this._call('fillPolygon', [out, c]);
        }
        fillCircle(cx, cy, r, c) {
            if (!c || !c[3] || r <= 0) return;
            cx += this.offset.x;
            cy += this.offset.y;
            if (!this._clipOk(cx - r, cy - r, r * 2, r * 2)) return;
            this._call('fillCircle', [cx, cy, r, c]);
        }
        fillEllipse(cx, cy, rx, ry, c) {
            if (!c || !c[3] || rx <= 0 || ry <= 0) return;
            cx += this.offset.x;
            cy += this.offset.y;
            if (!this._clipOk(cx - rx, cy - ry, rx * 2, ry * 2)) return;
            this._call('fillEllipse', [cx, cy, rx, ry, c]);
        }
        drawImage(id, x, y, w, h, tint) {
            x += this.offset.x;
            y += this.offset.y;
            if (!this._clipOk(x, y, w, h)) return;
            this._call('drawImage', [id, x, y, w, h, tint || null]);
        }
        drawText(x, y, str, c, o) {
            if (!c || !c[3] || !str) return;
            x += this.offset.x;
            y += this.offset.y;
            o = o || {};
            const h = o.fontSize ? o.fontSize * 1.3 : 16;
            let bx = x,
                bw = 1;
            if (this._has('textSize')) {
                const m = this.raw.textSize(str, o);
                bw = m.w;
                if (o.align === 'center') bx = x - m.w / 2;
                else if (o.align === 'right') bx = x - m.w;
            }
            if (!this._clipOk(bx, y - 2, bw, h + 4)) return;
            this._call('drawText', [x, y, str, c, o]);
        }
        textSize(str, o) {
            if (this._has('textSize')) {
                try {
                    return this.raw.textSize(str, o);
                } catch (e) {
                    /* fall through */
                }
            }
            const fs = (o && o.fontSize) || 13;
            return {
                w: String(str == null ? '' : str).length * fs * 0.6,
                h: fs * 1.25,
            };
        }
    }

    /* ------------------------------------------------------------------------
     * Window
     * -------------------------------------------------------------------- */

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

    class GUI {
        /* options:
         *   style:    partial style ({theme, colors, vars, font})
         *   flags:    behavior flags (see below; all toggleable at runtime)
         *   clipboard:{ read: () => string, write: (text) => void }
         */
        constructor(renderer, options) {
            options = options || {};
            this.rawRenderer = renderer;
            this.renderer = new RendererProxy(this, renderer);
            this.style = new Style(options.style || {});
            this.clipboard = options.clipboard || { read: () => '', write: () => {} };
            this.flags = Object.assign(
                {
                    keyboardShortcuts: true, // ctrl/cmd + c, v, x, a, z, y
                    clipboard: true, // use the clipboard callbacks for copy/paste
                    undoRedo: true, // ctrl+Z / ctrl+Y (+ mouse back/forward) in text fields
                    rightClickNumeric: true, // right-click a slider/drag for direct value entry
                    mouseBackForward: true, // mouse back/forward buttons: undo/redo in text,
                    // otherwise close the topmost popup
                    tooltips: true,
                    animations: true, // window fade-in, tooltip fade, smooth scrolling
                    keyboardNavigation: true, // Tab / Shift+Tab focus, Enter/Space activation
                    windowMove: true,
                    windowResize: true,
                    resizeBarProximity: 8, // px near a window's outline where the
                    // resize bars appear / edge bands grab
                    // (0 disables the bars and bands; the
                    // corner grip follows this distance too)
                    windowDoubleReset: true, // double-click a title bar to restore position
                    docking: true, // interactive docking: drag-over window grid +
                    // screen-edge drop targets (see _dockHintUpdate)
                    dockJoinHitGenerous: false, // join grid over a target window: true = the
                    // whole window body selects a side; false
                    // (default) = only directly over the drawn
                    // 72x72 triangle square
                    dockScreenHitGenerous: true, // screen-center grid: the selectable box
                    // extends ~24px beyond the drawn 72x72 square
                    windowContextMenu: true, // right-click a title bar / dock title / member
                    // header for a small context menu (collapse,
                    // undock, reset position, close — whatever the
                    // window's flags/state allow)
                    wheelScroll: true,
                    doubleClick: true, // double-click text = word select, slider = value entry
                    dragThreshold: 3, // px before a click becomes a drag
                    scrollSpeed: 40, // px scrolled per unit of normalized wheel
                    tooltipDelay: 0.5, // seconds a hover must persist before a tooltip shows
                },
                options.flags || {},
            );
            this.debugOverlay = !!options.debugOverlay;
            this._timeOffset = 0; // ms; used by tests to advance internal clocks

            const s = (this.state = {
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
                lastCursor: 'default',
                textInput: '',
                textConsumed: false,
                activeId: 0,
                activeIdWindow: null,
                hoveredId: 0,
                focusedId: 0,
                dragDistance: 0,
                dragX: 0,
                dragY: 0,
                backForwardHandled: false,
                drag: null, // { type, win, ... } window/scrollbar drags
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
                scrollStack: [], // scrollable containers, innermost last
                treeLines: [],
                popups: new Map(),
                popupList: [],
                currentMenu: null, // menu row array being recorded
                tooltip: null,
                disabledCount: 0,
                changedId: 0,
                clickedItemId: 0,
                styleStack: [],
                menuBar: null,
                tabStack: [],
                table: null,
                stats: { fps: 0, ms: 0, drawCalls: 0, items: 0, windows: 0, states: 0 },
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
                edgeDocks: { top: null, bottom: null, left: null, right: null },
                _dockHint: null, // live drag-hint: window grid or screen-edge band
            });

            // addons: every registered addon installs itself into this.addons
            // (gui.addons.<name>.*). Pass opts.addons: false to disable all, or an
            // array of names to enable a subset.
            this.addons = {};
            this._installAddons(options.addons);
        }

        _installAddons(list) {
            if (list === false) return;
            const names = Array.isArray(list) ? list : Object.keys(MIM_ADDONS);
            for (const name of names) {
                const inst = MIM_ADDONS[name];
                if (!inst) continue;
                const methods = typeof inst === 'function' ? inst(this, Mim) : inst;
                if (methods && typeof methods === 'object') this.addons[name] = methods;
            }
        }

        /* ---------------------------- frame lifecycle ---------------------- */

        beginFrame(input) {
            const s = this.state;
            s.frameId++;
            // style scopes (per-window overrides, push/popStyle*) are per-frame
            // state: anything still on the stack at frame start was leaked —
            // clear it so one bad frame can never re-theme the whole UI
            s.styleStack.length = 0;
            const now = nowMs() + this._timeOffset;
            s.dt = clamp((now - s.lastNow) / 1000, 0, 0.25);
            s.lastNow = now;
            s.now = now;
            s.frameStart = now;

            input = input || {};
            s.displayW = input.width || 0;
            s.displayH = input.height || 0;

            // mouse
            const m = input.mouse || {};
            const mo = s.mouse;
            mo.dx = (m.x || 0) - mo.x;
            mo.dy = (m.y || 0) - mo.y;
            mo.x = m.x || 0;
            mo.y = m.y || 0;
            const btns = Array.isArray(m.buttons)
                ? m.buttons
                : [!!m.left, !!m.right, !!m.middle, !!m.back, !!m.forward];
            for (let i = 0; i < 5; i++) {
                mo.buttons[i] = !!btns[i];
                mo.justPressed[i] = mo.buttons[i] && !mo.prevButtons[i];
                mo.justReleased[i] = !mo.buttons[i] && mo.prevButtons[i];
            }
            mo.wheel[0] = m.wheelX || 0;
            mo.wheel[1] = m.wheelY || 0;
            // wheel: scroll the innermost scrollable container under the mouse,
            // else an open scrollable combo popup
            if (this.flags.wheelScroll && (s.mouse.wheel[0] || s.mouse.wheel[1])) {
                const wx = s.mouse.wheel[0],
                    wy = s.mouse.wheel[1];
                let consumed = false;
                for (let i = s.scrollStack.length - 1; i >= 0; i--) {
                    const sc = s.scrollStack[i];
                    if (sc.frame !== s.frameId - 1) continue;
                    if (pointInRect(s.mouse.x, s.mouse.y, sc.rect)) {
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
                if (!consumed && wy !== 0) {
                    for (const p of s.popupList) {
                        if (
                            p.open &&
                            p.data.type === 'combo' &&
                            p.maxScroll > 0 &&
                            p.w > 0 &&
                            pointInRect(s.mouse.x, s.mouse.y, {
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
                }
                if (consumed) {
                    s.mouse.wheel[0] = 0;
                    s.mouse.wheel[1] = 0;
                }
            }

            // double click tracking
            if (mo.justPressed[0] || mo.justPressed[1]) {
                if (
                    s.now - mo.clickTime < 400 &&
                    Math.abs(mo.x - mo.clickX) < 6 &&
                    Math.abs(mo.y - mo.clickY) < 6
                ) {
                    mo.clickCount = (mo.clickCount % 2) + 1;
                } else {
                    mo.clickCount = 1;
                }
                mo.clickTime = s.now;
                mo.clickX = mo.x;
                mo.clickY = mo.y;
            }

            // active-widget drag distance
            if (s.activeId !== 0 && mo.buttons[0]) {
                s.dragDistance = Math.max(
                    s.dragDistance,
                    Math.hypot(mo.x - s.dragX, mo.y - s.dragY),
                );
            }

            // keyboard / text (s.keys is our own set; s.prevKeys holds last frame's)
            const ik = input.keys instanceof Set ? input.keys : new Set(input.keys || []);
            s.keys.clear();
            for (const k of ik) s.keys.add(k);
            s.textInput = typeof input.text === 'string' ? input.text : '';
            s.textConsumed = false;
            s.backForwardHandled = false;

            // topmost window under the mouse, from last frame's rects, computed
            // BEFORE any window draws: title-bar chrome (chevron / close) and item
            // hover must never see a covered window as the hovered one, even on the
            // frame the mouse first lands on the overlap
            {
                let claim = null;
                for (let i = s.zOrder.length - 1; i >= 0; i--) {
                    const w = s.zOrder[i];
                    if (w.kind !== 'window' || w.open === false) continue;
                    const wh = w.collapsed ? w.titleH : w.h;
                    if (mo.x >= w.x && mo.x < w.x + w.w && mo.y >= w.y && mo.y < w.y + wh) {
                        claim = w;
                        break;
                    }
                    // a dock's combined title strip belongs to the dock for hit-testing
                    if (this._dockStripAt(w._dock, mo.x, mo.y)) {
                        claim = w;
                        break;
                    }
                }
                s.hoveredWindow = claim;
                this._modalHoverClaim(s, mo.x, mo.y);
            }

            // per-frame resets
            s.dupCount = new Map();
            s.items.clear();
            s.lastItem = null;
            s.focusList.length = 0;
            s.changedId = 0;
            s.clickedItemId = 0;
            s.idStack.length = 0;
            s.idStackSeeds.length = 0;
            s.idStackSeed = 0;
            s.nextItemWidth = 0;
            s.nextWindowPos = null;
            s.nextWindowSize = null;
            s.treeLines.length = 0;
            s.menuBar = null;
            s.tabStack.length = 0;
            s.table = null;
            s.currentMenu = null;
            s.textSizeCache.clear();
            s.activeIdWindow = null;
            s._lineHFrame = -1;

            // apply dock() calls made before both windows existed
            if (s.pendingDocks.length) {
                const still = [];
                for (const [la, lb, opts] of s.pendingDocks) {
                    const wa = s.windows.get(la),
                        wb = s.windows.get(lb);
                    if (wa && wb && wa !== wb) this._makeDock(la, lb, opts);
                    else still.push([la, lb, opts]);
                }
                s.pendingDocks = still;
            }

            // finish any drag whose button was released last frame
            if (s.drag) {
                const d = s.drag;
                const up = !mo.buttons[d.button == null ? 0 : d.button];
                if (up) {
                    if (d.type === 'closebtn' && pointInRect(mo.x, mo.y, d.rect)) {
                        d.win.open = false;
                        if (typeof d.win.onClose === 'function') d.win.onClose();
                    }
                    // drop a dragged window — or dock (combined window) — onto a
                    // docking hint (join grid / edge band / screen grid)
                    const didDock =
                        (d.type === 'win-move' || d.type === 'dock-move') &&
                        this._applyDockHint(s, d);
                    // a pure (unmoved) press+release on a title bar toggles collapse
                    if (
                        d.type === 'win-move' &&
                        !didDock &&
                        d.collapse &&
                        d.moved < this.flags.dragThreshold &&
                        mo.y >= d.win.y &&
                        mo.y < d.win.y + d.win.titleH
                    ) {
                        d.win.collapsed = !d.win.collapsed;
                        d.win._collapseToggledAt = s.frameId;
                    }
                    s.drag = null;
                    s.activeId = 0;
                }
            }

            // resolve a pending slim-header press (set in _drawDockChrome): a pure
            // click toggles the member's collapse, movement beyond the drag
            // threshold frees the member from its dock and starts moving it
            if (s._memberDrag) {
                const md = s._memberDrag;
                if (!mo.buttons[0]) {
                    s._memberDrag = null;
                    s._dockCollapseToggle = { win: md.win };
                    s.activeId = 0;
                } else if (
                    this.flags.windowMove &&
                    Math.abs(mo.x - md.x) + Math.abs(mo.y - md.y) >= this.flags.dragThreshold
                ) {
                    s._memberDrag = null;
                    const w = md.win;
                    this._undockMember(w);
                    if (w && w.open !== false) {
                        if (w.collapsed) {
                            w.collapsed = false;
                            if (w.h < 120) w.h = 200;
                        }
                        this._raise(w);
                        s.drag = {
                            type: 'win-move',
                            win: w,
                            button: 0,
                            offX: md.offX,
                            offY: md.offY,
                            x0: w.x,
                            y0: w.y,
                            moved: 0,
                            collapse: false,
                        };
                        s.activeId = -1;
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
            for (let i = s.zOrder.length - 1; i >= 0; i--) {
                const w = s.zOrder[i];
                if (w.kind !== 'window' || w.open === false) continue;
                const wh = w.collapsed ? w.titleH : w.h;
                if (mo.x >= w.x && mo.x < w.x + w.w && mo.y >= w.y && mo.y < w.y + wh) {
                    claim = w;
                    break;
                }
                // a dock's combined title strip belongs to the dock for hit-testing
                if (this._dockStripAt(w._dock, mo.x, mo.y)) {
                    claim = w;
                    break;
                }
            }
            s.hoveredWindow = claim;
            this._modalHoverClaim(s, mo.x, mo.y);
            // open popups claim hover above their owner window
            for (let i = s.popupList.length - 1; i >= 0; i--) {
                const p = s.popupList[i];
                if (
                    p.open &&
                    p.owner &&
                    p.w > 0 &&
                    mo.x >= p.x &&
                    mo.x < p.x + p.w &&
                    mo.y >= p.y &&
                    mo.y < p.y + p.h
                ) {
                    s.hoveredWindow = p.owner;
                    break;
                }
            }

            // app menu bar: geometry, keyboard shortcuts, section clicks
            s.appBarGrab = false;
            s.appBarRect = null;
            s.appMenuSections = [];
            {
                const am = s.appMenu;
                if (am) {
                    const W = s.displayW,
                        H = s.displayH;
                    const horizontal = am.pos === 'top' || am.pos === 'bottom';
                    const th = horizontal ? am.thickness : H;
                    const sw = horizontal ? W : am.sideWidth;
                    s.appBarRect =
                        am.pos === 'top'
                            ? { x: 0, y: 0, w: W, h: th }
                            : am.pos === 'bottom'
                              ? { x: 0, y: H - th, w: W, h: th }
                              : am.pos === 'left'
                                ? { x: 0, y: 0, w: sw, h: H }
                                : { x: W - sw, y: 0, w: sw, h: H };
                    // live keyboard shortcuts (fire once on the pressed frame)
                    for (const it of s.appMenuShortcuts) {
                        const disabled =
                            typeof it.disabled === 'function' ? it.disabled() : !!it.disabled;
                        if (disabled) continue;
                        const modsOk = !it.keyMod || it.keyMod.every((k) => s.keys.has(k));
                        if (
                            modsOk &&
                            this.isKeyPressed(it.key) &&
                            typeof it.onActivated === 'function'
                        )
                            it.onActivated();
                    }
                    const fo = this._fo();
                    const lineH = this._lineH();
                    let cx = 8,
                        cy = 6;
                    let anyOpen = false;
                    for (const sec of am.menus) {
                        if (!sec || !sec.label) continue;
                        const label = String(sec.label);
                        const lw = this._measure(label, fo).w;
                        const rect = horizontal
                            ? {
                                  x: cx,
                                  y:
                                      am.pos === 'bottom'
                                          ? H - th + (th - lineH - 10) / 2
                                          : (th - lineH - 10) / 2,
                                  w: lw + 18,
                                  h: lineH + 10,
                              }
                            : { x: 8, y: cy, w: sw - 16, h: lineH + 10 };
                        if (horizontal) cx += rect.w + 6;
                        else cy += rect.h + 2;
                        const pid = '##appmenu' + fnv1a(label);
                        const p = s.popups.get(pid);
                        const open = !!(p && p.open && p.data && p.data.appMenu);
                        if (open) anyOpen = true;
                        s.appMenuSections.push({
                            label,
                            rect,
                            pid,
                            open,
                            items: sec.items || [],
                        });
                    }
                    const overBar = pointInRect(mo.x, mo.y, s.appBarRect);
                    let overPopup = false;
                    for (const p of s.popupList) {
                        if (
                            p.open &&
                            p.data &&
                            p.data.appMenu &&
                            p.w > 0 &&
                            pointInRect(mo.x, mo.y, { x: p.x, y: p.y, w: p.w, h: p.h })
                        ) {
                            overPopup = true;
                            break;
                        }
                    }
                    // the whole bar region (and any open menu popup above it) blocks
                    // input from reaching the windows underneath
                    s.appBarGrab = overBar || overPopup;
                    if (overPopup) s.hoveredWindow = s.appMenuOwner;
                    if (overBar && !overPopup) {
                        // the bar claims the hover: windows under it don't react
                        s.hoveredWindow = null;
                        for (const sec of s.appMenuSections) {
                            const hov = pointInRect(mo.x, mo.y, sec.rect);
                            if (!hov) continue;
                            if (this.isMouseClicked(0) && s.activeId === 0 && !s.drag) {
                                const p = s.popups.get(sec.pid);
                                if (sec.open) {
                                    p.open = false;
                                } else {
                                    this._openPopup(
                                        sec.pid,
                                        horizontal
                                            ? {
                                                  x: sec.rect.x,
                                                  y: am.pos === 'top' ? th + 2 : s.appBarRect.y - 2,
                                              }
                                            : {
                                                  x: am.pos === 'left' ? sw - 2 : W - sw - 2,
                                                  y: sec.rect.y,
                                              },
                                        {
                                            type: 'menu',
                                            items: this._appMenuRows(sec.items, sec.pid),
                                            appMenu: true,
                                        },
                                        fnv1a(sec.pid),
                                        s.appMenuOwner,
                                    );
                                    for (const p2 of s.popupList)
                                        if (p2.data && p2.data.appMenu && p2.id !== sec.pid)
                                            p2.open = false;
                                }
                            } else if (anyOpen && !sec.open && !this.isMouseDown(0)) {
                                // slide: another label hovered while a menu is open
                                this._openPopup(
                                    sec.pid,
                                    horizontal
                                        ? {
                                              x: sec.rect.x,
                                              y: am.pos === 'top' ? th + 2 : s.appBarRect.y - 2,
                                          }
                                        : {
                                              x: am.pos === 'left' ? sw - 2 : W - sw - 2,
                                              y: sec.rect.y,
                                          },
                                    {
                                        type: 'menu',
                                        items: this._appMenuRows(sec.items, sec.pid),
                                        appMenu: true,
                                    },
                                    fnv1a(sec.pid),
                                    s.appMenuOwner,
                                );
                                for (const p2 of s.popupList)
                                    if (p2.data && p2.data.appMenu && p2.id !== sec.pid)
                                        p2.open = false;
                            }
                            break;
                        }
                    }
                }
            }

            // screen-edge docks: layout + boundary/column drags
            this._edgeDocksFrame(s, mo);
            // interactive docking hints for a window mid-drag
            this._dockHintUpdate(s, mo);

            this.renderer.beginFrame(s.displayW, s.displayH);
            this.renderer.setLayer(Layers.Background);
        }

        endFrame() {
            const s = this.state;

            // keyboard: tab focus cycling
            if (this.flags.keyboardNavigation && this.isKeyPressed('tab')) {
                const list = s.lastFocusList.length ? s.lastFocusList : s.focusList;
                if (list.length) {
                    const dir = s.keys.has('shift') ? -1 : 1;
                    let i = list.indexOf(s.focusedId);
                    i =
                        i < 0
                            ? dir > 0
                                ? 0
                                : list.length - 1
                            : (i + dir + list.length) % list.length;
                    s.focusedId = list[i];
                }
            }
            // Escape: close the topmost popup (text edits handle Escape themselves)
            if (this.isKeyPressed('escape') && s.popupList.length) {
                s.popupList[s.popupList.length - 1].open = false;
            }
            // mouse back: close the topmost popup unless a text field handled it
            if (
                this.flags.mouseBackForward &&
                !s.backForwardHandled &&
                this.isMouseClicked(3) &&
                s.popupList.length
            ) {
                s.popupList[s.popupList.length - 1].open = false;
            }

            // popups: outside-click dismissal, then draw pass (system + custom)
            this._popupPass();

            // resize edge bands + grip: the TOPMOST free window whose band
            // contains the mouse claims the cursor and, on click, a win-resize
            // drag (so the grip wins over the scrollbars, and at a corner the
            // two overlapping bands resize both directions at once)
            {
                const mo = s.mouse;
                let claim = null,
                    claimEdge = 0;
                if (
                    this.flags.windowResize &&
                    s.activeId === 0 &&
                    s.disabledCount === 0 &&
                    !s.drag &&
                    !this._popupAtPoint(mo.x, mo.y)
                ) {
                    for (let i = s.zOrder.length - 1; i >= 0; i--) {
                        const win = s.zOrder[i];
                        if (!win.open || win._dockKey || win._edge) continue;
                        if (!win.resizable || win.autoResize || win.collapsed) continue;
                        const edge = this._winResizeEdgeAt(win, mo.x, mo.y);
                        if (edge) {
                            claim = win;
                            claimEdge = edge;
                            break;
                        }
                    }
                }
                if (
                    claim &&
                    s.modalWin &&
                    claim !== s.modalWin &&
                    s.zOrder.indexOf(claim) < s.zOrder.indexOf(s.modalWin)
                )
                    claim = null; // the modal blocks windows drawn beneath it
                if (claim) {
                    // visible-order rule: the band only claims the point when the
                    // claimed window is the TOPMOST window there — another window
                    // painted over the band owns the point (input must not travel
                    // through it to the band underneath). The app menu bar is drawn
                    // above all windows, so it owns its region too.
                    if (s.appBarGrab) claim = null;
                    else {
                        let topAt = null;
                        for (let i = s.zOrder.length - 1; i >= 0; i--) {
                            const w2 = s.zOrder[i];
                            if (w2.kind !== 'window' || w2.open === false) continue;
                            const wh2 = w2.collapsed ? w2.titleH : w2.h;
                            if (
                                mo.x >= w2.x &&
                                mo.x < w2.x + w2.w &&
                                mo.y >= w2.y &&
                                mo.y < w2.y + wh2
                            ) {
                                topAt = w2;
                                break;
                            }
                            if (this._dockStripAt(w2._dock, mo.x, mo.y)) {
                                topAt = w2;
                                break;
                            }
                        }
                        if (topAt && topAt !== claim) claim = null;
                    }
                }
                if (claim) {
                    const horiz = claimEdge & 2 || claimEdge & 8,
                        vert = claimEdge & 1 || claimEdge & 4;
                    this._setCursor(
                        horiz && vert ? 'nwse-resize' : horiz ? 'ew-resize' : 'ns-resize',
                        1,
                    );
                    if (this.isMouseClicked(0)) {
                        s.drag = {
                            type: 'win-resize',
                            win: claim,
                            button: 0,
                            edge: claimEdge,
                            mx: mo.x,
                            my: mo.y,
                            x0: claim.x,
                            y0: claim.y,
                            w0: claim.w,
                            h0: claim.h,
                        };
                        s.activeId = -1;
                    }
                }
            }

            // screen-edge stack resize bars + docking hints draw above all
            this.renderer.setLayer(Layers.GUI);
            this._drawEdgeResizeBars();
            this._drawDockHints();

            // tooltips
            this._tooltipPass();

            s.scrollStack = s.scrollStack.filter((sc) => sc.frame >= s.frameId - 1);

            // apply a slim-header collapse toggle requested this frame (exactly one
            // member per click, the last-drawn header wins overlapping regions)
            if (s._dockCollapseToggle) {
                const w = s._dockCollapseToggle.win;
                if (w && w._dockKey) w.collapsed = !w.collapsed;
                s._dockCollapseToggle = null;
            }

            // dock bookkeeping: if a member stopped being drawn, dissolve the dock
            for (const [key, D] of Array.from(s.docks)) {
                const alive = (w) => !!(w && w.drawnFrame === s.frameId);
                if (!alive(D.a) || !alive(D.b)) {
                    this._freeDockedMember(D.a);
                    this._freeDockedMember(D.b);
                    s.docks.delete(key);
                }
            }

            // window bookkeeping
            const seen = new Set();
            for (const w of s.windows.values()) {
                if (w.drawnFrame === s.frameId) {
                    seen.add(w);
                    // dock/edge members' rects are layout-driven; don't persist them
                    if (w._dockKey || w._edge) continue;
                    const st = s.windowStates.get(w.title);
                    if (st) {
                        st.x = w.x;
                        st.y = w.y;
                        st.w = w.w;
                        st.h = w.h;
                        st.collapsed = w.collapsed;
                    } else
                        s.windowStates.set(w.title, {
                            x: w.x,
                            y: w.y,
                            w: w.w,
                            h: w.h,
                            collapsed: w.collapsed,
                        });
                }
            }
            for (const title of Array.from(s.windows.keys())) {
                if (!seen.has(s.windows.get(title))) s.windows.delete(title);
            }
            s.zOrder = s.zOrder.filter((w) => seen.has(w));
            const norm = s.zOrder.filter((w) => !w.alwaysOnTop);
            const top = s.zOrder.filter((w) => w.alwaysOnTop);
            s.zOrder = norm.concat(top);
            if (!s.focusedWindow || s.zOrder.indexOf(s.focusedWindow) < 0)
                s.focusedWindow = s.zOrder[s.zOrder.length - 1] || null;
            s.modalWin = null;
            for (const w of s.zOrder) if (w.modal && w.drawnFrame === s.frameId) s.modalWin = w;

            // clear stale focus / active
            if (s.activeId !== 0 && Number.isInteger(s.activeId) && !s.items.has(s.activeId))
                s.activeId = 0;
            if (s.focusedId && !s.focusList.includes(s.focusedId)) s.focusedId = 0;
            s.lastFocusList = s.focusList.slice();

            // recycle per-id widget state that no widget used this frame
            for (const [k, v] of s.widgetStates) {
                if (v.lastFrame !== s.frameId) s.widgetStates.delete(k);
            }

            // apply the requested cursor (only if the backend supports it)
            {
                const desired = s.cursor ? s.cursor.style : 'default';
                s.cursor = null;
                const feats = this.renderer.features;
                if (feats && feats.cursor && desired !== s.lastCursor) {
                    this.renderer.setCursor(desired);
                    s.lastCursor = desired;
                } else if (feats && !feats.cursor && s.lastCursor !== 'default') {
                    s.lastCursor = 'default';
                }
            }

            if (this.debugOverlay) this._drawDebugOverlay();

            const st = s.stats;
            const frameMs = nowMs() - s.frameStart;
            st.ms = st.ms ? lerp(st.ms, frameMs, 0.1) : frameMs;
            st.fps = s.dt > 0.0005 ? lerp(st.fps || 1 / s.dt, 1 / s.dt, 0.08) : st.fps;
            st.drawCalls = this.renderer.calls;
            st.items = s.items.size;
            st.windows = s.zOrder.length;
            st.states = s.widgetStates.size;

            for (const it of s.items.values()) s.itemPool.push(it);
            s.items.clear();
            // swap the two key sets: prevKeys now holds this frame's snapshot,
            // keys becomes the (stale) buffer that beginFrame clears + refills
            {
                const t = s.keys;
                s.keys = s.prevKeys;
                s.prevKeys = t;
            }
            for (let i = 0; i < 5; i++) s.mouse.prevButtons[i] = s.mouse.buttons[i];

            this.renderer.endFrame();
        }

        /* ---------------------------- id system ----------------------------
         * IDs derive from the id stack (window title, pushId, tree nodes) plus
         * the widget label. `stateKey` is shared by duplicate instances of the
         * same labelled widget in the same context (stable persistent state);
         * `itemId` is unique per instance within a frame (unique rects/hover). */

        pushId(id) {
            const h = typeof id === 'string' ? fnv1a(id) : (id | 0) >>> 0;
            const s = this.state;
            s.idStack.push(h);
            s.idStackSeed = hashPair(s.idStackSeed, h);
            s.idStackSeeds.push(s.idStackSeed);
        }
        popId(count = 1) {
            const s = this.state;
            for (let i = 0; i < count && s.idStack.length; i++) s.idStack.pop();
            s.idStackSeed = s.idStackSeeds.length ? s.idStackSeeds[s.idStackSeeds.length - 1] : 0;
            while (s.idStackSeeds.length > s.idStack.length) s.idStackSeeds.pop();
        }

        _id(label) {
            const s = this.state;
            const lh = fnv1a(String(label == null ? '' : label));
            const stateKey = hashPair(s.idStackSeed, lh);
            let inner = s.dupCount.get(s.idStackSeed);
            if (!inner) {
                inner = new Map();
                s.dupCount.set(s.idStackSeed, inner);
            }
            const n = inner.get(lh) || 0;
            inner.set(lh, n + 1);
            const itemId = hash3(stateKey, 0x9e3779b9, n);
            return { stateKey, itemId, instance: n };
        }

        _state(stateKey) {
            const s = this.state;
            let v = s.widgetStates.get(stateKey);
            if (!v) {
                v = { lastFrame: s.frameId };
                s.widgetStates.set(stateKey, v);
            }
            v.lastFrame = s.frameId;
            return v;
        }

        /* ---------------------------- items -------------------------------- */

        _canReceiveInput(win) {
            if (!win) return false;
            const s = this.state;
            if (s.disabledCount > 0) return false;
            const mw = s.modalWin;
            if (mw && win.kind !== 'popup') {
                // a modal blocks only what it actually covers (topmost-element
                // rule); the modal's own widgets (and popups, which draw above
                // every window) are never blocked by it
                const top = win.owner || win;
                if (top !== mw && s.zOrder.indexOf(top) < s.zOrder.indexOf(mw)) {
                    const mo = s.mouse;
                    const mh = mw.collapsed ? mw.titleH : mw.h;
                    if (mo.x >= mw.x && mo.x < mw.x + mw.w && mo.y >= mw.y && mo.y < mw.y + mh)
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
            const s = this.state;
            for (let i = s.popupList.length - 1; i >= 0; i--) {
                const p = s.popupList[i];
                if (p.open && p.w > 0 && pointInRect(x, y, { x: p.x, y: p.y, w: p.w, h: p.h }))
                    return p;
            }
            return null;
        }

        _item(x, y, w, h, itemId, opts) {
            opts = opts || {};
            const s = this.state;
            let it = s.items.get(itemId);
            if (!it) {
                it = s.itemPool.pop() || {};
                s.items.set(itemId, it);
            }
            it.itemId = itemId;
            it.win = s.layout ? s.layout.container : null;
            it.x = x;
            it.y = y;
            it.w = w;
            it.h = h;
            it.focusable = opts.focusable !== false;
            const clip = this.renderer.clip;
            const inMenuBarBand = !!(
                s.menuBar &&
                s.menuBar.win === s.layout.container &&
                y >= s.layout.container.y + s.layout.container.titleH &&
                y + h <= s.layout.container.y + s.layout.container.titleH + s.layout.container.menuH
            );
            it.visible =
                w > 0 && h > 0 && (!clip || rectsOverlap({ x, y, w, h }, clip) || inMenuBarBand);
            it.hovered = false;
            it.active = false;
            it.clicked = false;
            it.enabled = s.disabledCount === 0;
            if (it.visible && it.enabled && it.win && this._canReceiveInput(it.win)) {
                const mo = s.mouse;
                const top = it.win.owner || it.win;
                // menu bar items live in the band above the content clip
                const inMenuBar = !!(
                    s.menuBar &&
                    s.menuBar.win === it.win &&
                    mo.y >= it.win.y + it.win.titleH &&
                    mo.y < it.win.y + it.win.titleH + it.win.menuH
                );
                const inClip = !clip || pointInRect(mo.x, mo.y, clip) || inMenuBar;
                // open popups paint above every window: an item hidden beneath one
                // must not show hover highlighting or take input (items laid out
                // inside the popup itself are exempt)
                let underPopup = false;
                const container = s.layout && s.layout.container;
                if (!container || container.kind !== 'popup') {
                    for (const p of s.popupList) {
                        if (
                            p.open &&
                            p.w > 0 &&
                            pointInRect(mo.x, mo.y, { x: p.x, y: p.y, w: p.w, h: p.h })
                        ) {
                            underPopup = true;
                            break;
                        }
                    }
                }
                it.hovered =
                    s.hoveredWindow === top &&
                    inClip &&
                    !underPopup &&
                    mo.x >= x &&
                    mo.x < x + w &&
                    mo.y >= y &&
                    mo.y < y + h;
            }
            if (it.focusable && it.visible && it.enabled) s.focusList.push(itemId);
            s.lastItem = it;
            return it;
        }

        _mouseIn(it) {
            const mo = this.state.mouse;
            return mo.x >= it.x && mo.x < it.x + it.w && mo.y >= it.y && mo.y < it.y + it.h;
        }

        /* Standard click/active wiring for a widget item. */
        _clickable(it) {
            const s = this.state;
            if (it.hovered && s.disabledCount === 0) this._setCursor('pointer', 1);
            const wasActive = s.activeId === it.itemId; // this item owns the press (set on an earlier frame)
            if (it.hovered && this.isMouseClicked(0)) {
                s.activeId = it.itemId;
                s.activeIdWindow = it.win;
                s.hoveredId = it.itemId;
                s.clickedItemId = it.itemId;
                if (it.focusable) s.focusedId = it.itemId;
                s.dragX = s.mouse.x;
                s.dragY = s.mouse.y;
                s.dragDistance = 0;
                it.dragInit = false; // fresh press: let the widget (re)seed its drag state
                s.focusedWindow = it.win; // a click focuses but never reorders the draw order
            }
            it.active = s.activeId === it.itemId && this.isMouseDown(0);
            it.pressed = it.active && !wasActive;
            it.clicked = false;
            // release detection uses wasActive (captured before this frame's press),
            // because isMouseDown(0) is already false on the release frame
            if (wasActive && this.isMouseReleased(0)) {
                it.clicked = this._mouseIn(it) || s.dragDistance < this.flags.dragThreshold;
                s.activeId = 0;
                s.activeIdWindow = null;
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
            const s = this.state;
            if (!win) return;
            const top = win.owner || win;
            const i = s.zOrder.indexOf(top);
            if (i >= 0) {
                s.zOrder.splice(i, 1);
                s.zOrder.push(top);
            }
            s.focusedWindow = top;
        }

        /* Modal hover claim: an open modal owns the cursor only where it is
         * actually drawn — the topmost-element rule still applies. A window
         * painted above it (e.g. AlwaysOnTop) keeps its own input, and points
         * outside the modal's rect are unaffected (the modal blocks the windows
         * it covers, not the whole screen). */
        _modalHoverClaim(s, x, y) {
            const mw = s.modalWin;
            if (!mw) return;
            const mh = mw.collapsed ? mw.titleH : mw.h;
            if (x < mw.x || x >= mw.x + mw.w || y < mw.y || y >= mw.y + mh) return;
            const hv = s.hoveredWindow;
            if (hv && hv !== mw && s.zOrder.indexOf(hv) > s.zOrder.indexOf(mw)) return; // topmost wins
            s.hoveredWindow = mw;
        }

        /* Does (x, y) fall in a FREE dock's combined title-bar strip? The strip
         * is painted by the dock (during its first member's pass) but is not
         * part of either member's rect, so topmost hit-testing must treat it as
         * belonging to the dock's members. Without this, a window painted over
         * the strip would "own" the point and the dock's header would become
         * undraggable (softlock). */
        _dockStripAt(D, x, y) {
            if (!D || D._edge) return false;
            const tH = this._var('titleBarHeight');
            return x >= D.x && x < D.x + D.w && y >= D.y && y < D.y + tH;
        }

        _advance(x, y, w, h) {
            const L = this.state.layout;
            if (!L) return;
            const cx = x - L.origin.x + L.scroll.x;
            const cy = y - L.origin.y + L.scroll.y;
            if (!L._same) {
                L.lineStartX = cx;
                L.lineY = cy;
            }
            L.lineActive = true;
            L.lineBottom = Math.max(L.lineBottom, cy + h);
            L.prevRight = cx + w;
            L.y = Math.max(L.y, cy + h);
            L.contentRight = Math.max(L.contentRight, cx + w);
            L.itemCount++;
        }

        _nextPos() {
            const L = this.state.layout;
            const sp = this._var('itemSpacing');
            let x, y;
            if (L.lineActive && L.sameLine) {
                const sl = L.sameLine;
                L.sameLine = null;
                L._same = true;
                x =
                    sl.offset != null
                        ? L.lineStartX + sl.offset
                        : L.prevRight + (sl.spacing != null ? sl.spacing : sp[0]);
                y = L.lineY;
            } else if (L.lineActive) {
                L._same = false;
                x = L.x + L.indent;
                y = L.lineBottom + sp[1];
            } else {
                L._same = false;
                x = L.x + L.indent;
                y = L.y;
            }
            return { x: L.origin.x + x - L.scroll.x, y: L.origin.y + y - L.scroll.y };
        }

        /* ---------------------------- text helpers ------------------------- */

        _fo() {
            return { fontSize: this._var('fontSize'), fontId: this.style.font.id };
        }
        _measure(str, fo) {
            fo = fo || this._fo();
            const key = str + '\x00' + fo.fontSize + '\x00' + fo.fontId;
            const s = this.state;
            let m = s.textSizeCache.get(key);
            if (!m) {
                m = this.renderer.textSize(str, fo);
                if (typeof m.w !== 'number' || !isFinite(m.w))
                    m.w = String(str).length * fo.fontSize * 0.6;
                if (typeof m.h !== 'number' || !isFinite(m.h)) m.h = fo.fontSize * 1.25;
                s.textSizeCache.set(key, m);
            }
            return m;
        }
        _lineH() {
            const s = this.state;
            if (s._lineHFrame === s.frameId && s._lineHCache) return s._lineHCache;
            s._lineHCache = this._measure('M').h;
            s._lineHFrame = s.frameId;
            return s._lineHCache;
        }
        _frameH() {
            const fp = this._var('framePadding');
            return this._lineH() + fp[1] * 2;
        }
        _drawText(x, y, str, color, fo, o) {
            fo = fo || this._fo();
            this.renderer.drawText(
                x,
                y,
                String(str == null ? '' : str),
                color,
                Object.assign({ fontSize: fo.fontSize, fontId: fo.fontId }, o || {}),
            );
        }

        /* ---------------------------- style stack -------------------------- */

        _col(name, alphaMul) {
            const stack = this.state.styleStack;
            for (let i = stack.length - 1; i >= 0; i--) {
                const c = stack[i].colors && stack[i].colors[name];
                if (c) return alphaMul != null && alphaMul < 1 ? withAlpha(c, c[3] * alphaMul) : c;
            }
            const c = this.style.colors[name] || [200, 200, 200, 255];
            return alphaMul != null && alphaMul < 1 ? withAlpha(c, c[3] * alphaMul) : c;
        }
        _var(name) {
            const stack = this.state.styleStack;
            for (let i = stack.length - 1; i >= 0; i--) {
                const v = stack[i].vars && stack[i].vars[name];
                if (v !== undefined) return v;
            }
            return this.style.vars[name];
        }
        pushStyleVar(name, value) {
            this.state.styleStack.push({ vars: { [name]: value } });
        }
        popStyleVar(n = 1) {
            const st = this.state.styleStack;
            for (let i = 0; i < n && st.length; i++) st.pop();
        }
        pushStyleColor(name, color) {
            this.state.styleStack.push({ colors: { [name]: normColor(color) } });
        }
        popStyleColor(n = 1) {
            const st = this.state.styleStack;
            for (let i = 0; i < n && st.length; i++) st.pop();
        }
        setTheme(name) {
            const t = Style.themes[name];
            if (t) this.style.colors = Object.assign({}, t);
        }

        _applyStyleScope(win) {
            const scope = { colors: {}, vars: {} };
            const st = win.style || null;
            if (st) {
                if (st.bg) scope.colors.windowBg = normColor(st.bg);
                if (st.border) scope.colors.border = normColor(st.border);
                if (st.titleBg) scope.colors.titleBg = normColor(st.titleBg);
                if (st.titleBgActive) scope.colors.titleBgActive = normColor(st.titleBgActive);
                if (st.frameBg) scope.colors.frameBg = normColor(st.frameBg);
                if (st.rounding != null) scope.vars.windowRounding = st.rounding;
                if (st.titleRounding != null) scope.vars.titleRounding = st.titleRounding;
                if (st.borderWidth != null) scope.vars.windowBorder = st.borderWidth;
                if (st.padding != null) scope.vars.windowPadding = st.padding;
                if (st.shadow != null) scope.vars.shadow = !!st.shadow;
            }
            this.state.styleStack.push(scope);
        }
        _popStyleScope(n = 1) {
            const st = this.state.styleStack;
            for (let i = 0; i < n && st.length; i++) st.pop();
        }

        /* ---------------------------- input queries ------------------------ */

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
            const s = this.state;
            if (!s.cursor || prio >= s.cursor.prio) s.cursor = { style, prio };
        }

        isMouseClicked(b = 0) {
            return this.state.mouse.justPressed[b];
        }
        isMouseReleased(b = 0) {
            return this.state.mouse.justReleased[b];
        }
        isMouseDoubleClicked(b = 0) {
            const mo = this.state.mouse;
            return mo.justPressed[b] && mo.clickCount >= 2;
        }
        mousePos() {
            const m = this.state.mouse;
            return { x: m.x, y: m.y };
        }
        mouseDelta() {
            const m = this.state.mouse;
            return { x: m.dx, y: m.dy };
        }
        isKeyDown(k) {
            return this.state.keys.has(k);
        }
        isKeyPressed(k) {
            return this.state.keys.has(k) && !this.state.prevKeys.has(k);
        }
        isKeyReleased(k) {
            return !this.state.keys.has(k) && this.state.prevKeys.has(k);
        }
        get ctrl() {
            return this.isKeyDown('ctrl') || this.isKeyDown('meta');
        }
        get shift() {
            return this.isKeyDown('shift');
        }
        get alt() {
            return this.isKeyDown('alt');
        }

        lastItem() {
            return this.state.lastItem;
        }
        lastItemRect() {
            const it = this.state.lastItem;
            return it ? { x: it.x, y: it.y, w: it.w, h: it.h } : null;
        }
        lastItemHovered() {
            const it = this.state.lastItem;
            return !!(it && it.hovered);
        }
        lastItemActive() {
            const it = this.state.lastItem;
            return !!(it && it.active);
        }
        lastItemClicked() {
            const it = this.state.lastItem;
            return !!(it && it.clicked);
        }
        lastItemChanged() {
            const it = this.state.lastItem;
            return it ? this.state.changedId === it.itemId : false;
        }
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
            const L = this.state.layout;
            if (!L || !L.lineActive) return; // nothing drawn yet: not applicable
            L.sameLine = {
                offset: offsetX == null ? null : offsetX,
                spacing: spacing == null ? null : spacing,
            };
        }
        indent(amount) {
            this.state.layout.indent += amount || this._var('indentSpacing');
        }
        unindent(amount) {
            this.state.layout.indent = Math.max(
                0,
                this.state.layout.indent - (amount || this._var('indentSpacing')),
            );
        }
        getCursorPos() {
            const L = this.state.layout;
            return { x: L.x + L.indent, y: L.y };
        }
        getCursorScreenPos() {
            const L = this.state.layout;
            return {
                x: L.origin.x + L.x + L.indent - L.scroll.x,
                y: L.origin.y + L.y - L.scroll.y,
            };
        }
        setCursorPos(x, y) {
            const L = this.state.layout;
            L.x = x - L.indent;
            L.y = y;
            L.lineActive = false;
            L.sameLine = null;
        }
        setCursorScreenPos(x, y) {
            const L = this.state.layout;
            L.x = x - L.origin.x + L.scroll.x - L.indent;
            L.y = y - L.origin.y + L.scroll.y;
            L.lineActive = false;
            L.sameLine = null;
        }
        setNextItemWidth(w) {
            this.state.nextItemWidth = w;
        }
        getRegionAvail() {
            const L = this.state.layout;
            return {
                w: Math.max(0, L.avail.w - (L.x + L.indent)),
                h: Math.max(0, L.avail.h - L.y),
            };
        }

        spacing() {
            const pos = this._nextPos();
            this._item(pos.x, pos.y, 0, 0, hashPair(this.state.idStackSeed, 0x5a5a5a5a), {
                focusable: false,
            });
            this._advance(pos.x, pos.y, 0, this._var('itemSpacing')[1]);
        }
        dummy(w, h) {
            const pos = this._nextPos();
            const it = this._item(
                pos.x,
                pos.y,
                w,
                h,
                hashPair(this.state.idStackSeed, 0x5a5a5a5b),
                { focusable: false },
            );
            this._advance(it.x, it.y, w, h);
            return it;
        }
        separator() {
            if (this.state.currentMenu) {
                this.state.currentMenu.push({ type: 'sep' });
                return;
            }
            const L = this.state.layout;
            const pos = this._nextPos();
            // inside a popup, "available width" is not known up front; span current
            // content width (min 80) instead of the 4000px popup sentinel
            const w = this.state.popupLayoutActive
                ? Math.max(80, L.contentRight)
                : Math.max(0, L.avail.w - L.x - L.indent);
            const it = this._item(
                pos.x,
                pos.y,
                w,
                1,
                hashPair(this.state.idStackSeed, 0x5a5a5a5c),
                { focusable: false },
            );
            if (it.visible) {
                this.renderer.line(
                    pos.x,
                    pos.y + 0.5,
                    pos.x + w,
                    pos.y + 0.5,
                    this._col('separator'),
                    1,
                );
            }
            this._advance(pos.x, pos.y, w, 1 + this._var('itemSpacing')[1]);
        }
        separatorText(label) {
            const pos = this._nextPos();
            const L = this.state.layout;
            const w = this.state.popupLayoutActive
                ? Math.max(80, L.contentRight)
                : Math.max(0, L.avail.w - L.x - L.indent);
            const lineH = this._lineH();
            const it = this._item(
                pos.x,
                pos.y,
                w,
                lineH + 6,
                hashPair(this.state.idStackSeed, 0x5a5a5a5d),
                { focusable: false },
            );
            if (it.visible) {
                const fo = this._fo();
                this.renderer.line(
                    pos.x,
                    pos.y + lineH / 2 + 3,
                    pos.x + w,
                    pos.y + lineH / 2 + 3,
                    this._col('separator'),
                    1,
                );
                this._drawText(pos.x + 6, pos.y, label, this._col('textDisabled'), fo);
            }
            this._advance(pos.x, pos.y, w, lineH + 6);
        }

        beginGroup() {
            const L = this.state.layout;
            const snap = Object.assign({}, L, {
                origin: { ...L.origin },
                scroll: { ...L.scroll },
            });
            this.state.savedLayout.push(snap);
            const sp = this._var('itemSpacing');
            let contentX = snap.x + snap.indent,
                contentY = snap.y;
            if (snap.lineActive && snap.sameLine) {
                const sl = snap.sameLine;
                contentX =
                    sl.offset != null
                        ? snap.lineStartX + sl.offset
                        : snap.prevRight + (sl.spacing != null ? sl.spacing : sp[0]);
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
            L.contentRight = contentX;
            return { x: this.state.groupStart.x, y: this.state.groupStart.y };
        }
        endGroup() {
            const L = this.state.layout;
            const g = this.state.groupStart;
            if (!L || !g || !this.state.savedLayout.length) return null;
            const w = Math.max(0, L.contentRight - g.contentX);
            const h = Math.max(0, L.y - g.contentY);
            const prev = this.state.savedLayout.pop();
            this.state.layout = prev;
            // the group is an ITEM on the line it started on: the line bookkeeping
            // continues past it, so sameLine() after endGroup() places the next
            // element to the right of the group. (A pending request made BEFORE the
            // group was consumed by the group itself — it never leaks out.)
            if (g.newLine) prev.lineStartX = g.contentX;
            prev.lineY = g.contentY; // the group's top is its line top for sameLine purposes
            prev.lineActive = true;
            prev._same = false;
            prev.sameLine = null;
            prev.lineBottom = Math.max(prev.lineBottom, g.contentY + h);
            prev.prevRight = g.contentX + w;
            prev.y = g.contentY + h;
            prev.contentRight = Math.max(g.contentRight0, g.contentX + w);
            return { x: g.x, y: g.y, w, h };
        }

        beginDisabled() {
            this.state.disabledCount++;
        }
        endDisabled() {
            this.state.disabledCount = Math.max(0, this.state.disabledCount - 1);
        }

        /* ---------------------------- windows ------------------------------ */

        setNextWindowPos(x, y) {
            this.state.nextWindowPos = { x, y };
        }
        setNextWindowSize(w, h) {
            this.state.nextWindowSize = { w, h };
        }
        getWindow(title) {
            return this.state.windows.get(title) || null;
        }
        isWindowOpen(title) {
            const w = this.state.windows.get(title);
            if (w) return w.open;
            const st = this.state.windowStates.get(title);
            return st ? st.open !== false : true;
        }
        setWindowOpen(title, open) {
            const w = this.state.windows.get(title);
            if (w) w.open = !!open;
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
            const la = typeof a === 'string' ? a : (a && a.title) || '';
            const lb = typeof b === 'string' ? b : (b && b.title) || '';
            return la < lb ? la + '\x01' + lb : lb + '\x01' + la;
        }
        _findDock(a, b) {
            const s = this.state;
            if (a == null || b == null) {
                // single label: find the dock containing it
                const la = typeof a === 'string' ? a : (a && a.title) || '';
                for (const D of s.docks.values())
                    if ((D.a && D.a.title === la) || (D.b && D.b.title === la)) return D;
                return null;
            }
            return s.docks.get(this._dockKeyFor(a, b)) || null;
        }
        dock(a, b, opts) {
            opts = opts || {};
            const s = this.state;
            const la = typeof a === 'string' ? a : a && a.title;
            const lb = typeof b === 'string' ? b : b && b.title;
            if (!la || !lb) return null;
            const wa = s.windows.get(la),
                wb = s.windows.get(lb);
            if (!wa || !wb || wa === wb) {
                s.pendingDocks.push([la, lb, opts]); // applied once both exist
                return null;
            }
            if (wa.noDock || wb.noDock) return null; // the window refuses docking
            return this._makeDock(la, lb, opts);
        }
        _makeDock(la, lb, opts) {
            const s = this.state;
            let wa = s.windows.get(la),
                wb = s.windows.get(lb);
            if (!wa || !wb || wa === wb) return null;
            if (wa.noDock || wb.noDock) return null; // the window refuses docking
            // Edge combination: when one (or both) of the windows is globally
            // docked on the SAME edge, the combined window stays inside that edge
            // stack as a single unit. The stack's unit id is member A's title, so
            // the edge-docked window becomes A.
            let combEdge = null;
            if (wa._edge && wb._edge) {
                if (wa._edge === wb._edge) combEdge = wa._edge;
            } else if (wa._edge) combEdge = wa._edge;
            else if (wb._edge) combEdge = wb._edge;
            if (combEdge && wa._edge !== combEdge && wb._edge === combEdge) {
                const tw = wa;
                wa = wb;
                wb = tw;
                const tl = la;
                la = lb;
                lb = tl;
            }
            if (!combEdge) {
                if (wa._edge) this._removeFromEdge(wa); // joining a dock leaves the edge stack
                if (wb._edge) this._removeFromEdge(wb);
            }
            const key = this._dockKeyFor(la, lb);
            const D = {
                key,
                a: wa,
                b: wb,
                dir: opts.dir === 'v' || opts.vertical ? 'v' : 'h',
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
                frame: s.frameId,
            };
            if (opts.pos) {
                D.x = opts.pos[0];
                D.y = opts.pos[1];
            } else {
                D.x = Math.min(wa.x, wb.x);
                D.y = Math.min(wa.y, wb.y);
            }
            if (opts.size) {
                D.w = opts.size[0];
                D.h = opts.size[1];
            } else if (D.dir === 'h') {
                // combined width = both windows' widths added together; the height
                // takes the taller window's size (anchored on it, so it keeps its
                // position)
                D.w = wa.w + wb.w;
                D.h = Math.max(wa.h, wb.h);
                if (!opts.pos) D.y = wa.h >= wb.h ? wa.y : wb.y;
            } else {
                // combined height = both windows' heights added together; the width
                // takes the wider window's size (anchored on it)
                D.h = wa.h + wb.h;
                D.w = Math.max(wa.w, wb.w);
                if (!opts.pos) D.x = wa.w >= wb.w ? wa.x : wb.x;
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
                const E = s.edgeDocks[combEdge];
                const horiz = combEdge === 'top' || combEdge === 'bottom';
                const R = E && E._rect;
                const n = E ? E.wins.length : 1;
                const span = R ? (horiz ? R.colW : R.colH) : horiz ? wa.w + wb.w : wa.h + wb.h;
                const share = Math.max(20, Math.max(20, span - 12) - 4 * (n - 1));
                const alongW = horiz ? wa.w : wa.h;
                const alongX = horiz ? wb.w : wb.h;
                D.dir = horiz ? 'h' : 'v';
                D.ratio = clamp(alongW / (alongW + alongX), 0.12, 0.88);
                D.x = wa.x;
                D.y = wa.y;
                if (horiz) {
                    D.w = alongW + alongX;
                    D.h = wa.h;
                } else {
                    D.w = wa.w;
                    D.h = alongW + alongX;
                }
                D.defaultX = D.x;
                D.defaultY = D.y;
                D._edge = combEdge;
                wa._edge = combEdge;
                wb._edge = combEdge;
                if (E) E.fracs[wa.title] = (E.fracs[wa.title] || 1) + alongX / share;
            }
            wa._dockKey = key;
            wb._dockKey = key;
            s.docks.set(key, D);
            return D;
        }
        _freeDockedMember(w) {
            if (!w) return;
            w._dockKey = null;
            w._dock = null;
            w._edge = null;
            w.sizedOnce = true;
            w.movable = true;
            w.resizable = !w.fixedSize && !w.autoResize;
            w.collapsible = !w.noTitleBar;
        }
        undock(a, b) {
            const s = this.state;
            const D = this._findDock(a, b);
            if (!D) return false;
            // each member keeps its current sub-rect as its own window rect
            this._freeDockedMember(D.a);
            this._freeDockedMember(D.b);
            s.docks.delete(D.key);
            return true;
        }
        /* Free a single member of a dock: the member and its sibling (which keeps
         * its own sub-rect) become free windows and the dock is removed. This is
         * what dragging a member's slim header out of the dock does. */
        _undockMember(win) {
            const s = this.state;
            if (!win || !win._dockKey) return;
            const D = s.docks.get(win._dockKey);
            if (!D) {
                win._dockKey = null;
                win._dock = null;
                return;
            }
            const other = D.a === win ? D.b : D.a;
            this._freeDockedMember(win);
            if (other) this._freeDockedMember(other);
            s.docks.delete(D.key);
        }
        isDocked(a, b) {
            return !!this._findDock(a, b);
        }
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
        setDockRatio(a, b, ratio) {
            const D = this._findDock(a, b);
            if (D) D.ratio = clamp(ratio, 0.12, 0.88);
            return !!D;
        }

        /* Collapse a whole dock to just its combined title bar (hiding both
         * members); pass false to restore. The title bar carries a chevron that
         * toggles this, and an expand/close control while collapsed. */
        setDockCollapsed(a, b, collapsed) {
            const D = this._findDock(a, b);
            if (!D) return false;
            D.collapsed = !!collapsed;
            return true;
        }
        isDockCollapsed(a, b) {
            const D = this._findDock(a, b);
            return !!(D && D.collapsed);
        }

        /* ------------------------- window context menus --------------------- */
        /* Right-click a window title bar, a combined dock title bar, or a dock
         * member's slim header for a small menu holding only the operations the
         * window's flags/state currently allow: collapse/expand, undock, reset
         * position, close. Gated by the `windowContextMenu` flag. The menu is a
         * regular system popup: outside clicks dismiss it, a second right-click
         * on the same header toggles it closed. */
        _windowContextMenu(win) {
            const s = this.state;
            const id = 'winctx:' + (win.idHash || fnv1a(win.title));
            const existing = s.popups.get(id);
            if (existing && existing.open) {
                existing.open = false;
                return this;
            }
            const mo = s.mouse;
            const items = [];
            if (win.collapsible)
                items.push({
                    label: win.collapsed ? 'Expand' : 'Collapse',
                    onActivated: () => {
                        win.collapsed = !win.collapsed;
                        win._collapseToggledAt = s.frameId;
                    },
                });
            if (win._edge)
                items.push({
                    label: 'Undock from screen edge',
                    onActivated: () => this.undockEdge(win.title),
                });
            if (this.flags.windowDoubleReset && !win._edge)
                items.push({
                    label: 'Reset position',
                    onActivated: () => {
                        win.x = win.defaultX;
                        win.y = win.defaultY;
                    },
                });
            if (win.closable)
                items.push({
                    label: 'Close',
                    onActivated: () => {
                        win.open = false;
                        if (typeof win.onClose === 'function') win.onClose();
                    },
                });
            if (items.length)
                this._openPopup(
                    id,
                    { x: mo.x, y: mo.y },
                    { type: 'menu', items },
                    fnv1a(win.title),
                    win,
                );
            return this;
        }
        _dockContextMenu(D) {
            const s = this.state;
            const id = 'dockctx:' + D.key;
            const existing = s.popups.get(id);
            if (existing && existing.open) {
                existing.open = false;
                return this;
            }
            const mo = s.mouse;
            const items = [
                {
                    label: D.collapsed ? 'Expand' : 'Collapse',
                    onActivated: () => {
                        D.collapsed = !D.collapsed;
                    },
                },
            ];
            for (const m of [D.a, D.b]) {
                if (m && m.open !== false)
                    items.push({
                        label: 'Undock: ' + m.title,
                        onActivated: () => this._undockMember(m),
                    });
            }
            items.push({ type: 'sep' });
            items.push({
                label: 'Close',
                onActivated: () => {
                    if (D.a) {
                        D.a.open = false;
                        this._freeDockedMember(D.a);
                    }
                    if (D.b) {
                        D.b.open = false;
                        this._freeDockedMember(D.b);
                    }
                    s.docks.delete(D.key);
                },
            });
            this._openPopup(
                id,
                { x: mo.x, y: mo.y },
                { type: 'menu', items },
                fnv1a(D.key),
                D.a || D.b,
            );
            return this;
        }
        _memberContextMenu(win) {
            const s = this.state;
            const id = 'memctx:' + (win.idHash || fnv1a(win.title));
            const existing = s.popups.get(id);
            if (existing && existing.open) {
                existing.open = false;
                return this;
            }
            const mo = s.mouse;
            const items = [];
            if (win.collapsible)
                items.push({
                    label: win.collapsed ? 'Expand' : 'Collapse',
                    onActivated: () => {
                        win.collapsed = !win.collapsed;
                    },
                });
            items.push({
                label: 'Undock',
                onActivated: () => this._undockMember(win),
            });
            this._openPopup(
                id,
                { x: mo.x, y: mo.y },
                { type: 'menu', items },
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
            const s = this.state;
            if (edge !== 'top' && edge !== 'bottom' && edge !== 'left' && edge !== 'right')
                return null;
            const w = typeof a === 'string' ? s.windows.get(a) : a;
            if (!w || w.noDock) return null;
            if (w._dockKey) {
                // a dock member: the WHOLE combined window is docked as one unit of
                // the edge stack (the stack identifies the unit by member A's title)
                const D = s.docks.get(w._dockKey);
                if (!D || !D.a || !D.b) return null;
                if (D.a.noDock || D.b.noDock || D.a.open === false || D.b.open === false)
                    return null;
                this._removeEdgeUnit(D);
                const E = s.edgeDocks[edge] || (s.edgeDocks[edge] = { wins: [], fracs: {} });
                const horiz = edge === 'top' || edge === 'bottom';
                if (!E.size) E.size = horiz ? clamp(D.h, 110, 300) : clamp(D.w, 180, 420);
                if (E.wins.indexOf(D.a.title) < 0) {
                    E.wins.push(D.a.title);
                    const n = E.wins.length;
                    let total = 0;
                    for (const t of E.wins) total += E.fracs[t] || 0;
                    for (const t of E.wins) if (!(t in E.fracs)) E.fracs[t] = 1;
                    // the newcomer (whole dock) takes an equal average share
                    E.fracs[D.a.title] = n > 1 ? total / (n - 1) : 1;
                }
                D._edge = edge;
                D.a._edge = edge;
                D.b._edge = edge;
                D.a.open = true;
                D.b.open = true;
                return E;
            }
            this._removeFromEdge(w);
            const E = s.edgeDocks[edge] || (s.edgeDocks[edge] = { wins: [], fracs: {} });
            const horiz = edge === 'top' || edge === 'bottom';
            if (!E.size) E.size = horiz ? clamp(w.h, 110, 300) : clamp(w.w, 180, 420);
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
        undockEdge(a) {
            const s = this.state;
            const w = typeof a === 'string' ? s.windows.get(a) : a;
            if (!w || !w._edge) return false;
            if (w._dockKey) {
                const D = s.docks.get(w._dockKey);
                if (D && (D._edge || D.a._edge || D.b._edge)) {
                    // a docked dock: the whole combined window leaves the edge stack
                    // and survives as a FREE dock at its current slot rect
                    this._removeEdgeUnit(D);
                    return true;
                }
            }
            this._removeFromEdge(w);
            w.movable = true;
            w.resizable = !w.fixedSize && !w.autoResize && !(w.flags & WindowFlags.NoResize);
            return true;
        }
        /* Remove an edge-docked DOCK (one stack unit) from its stack. */
        _removeEdgeUnit(D) {
            const s = this.state;
            const edge = D._edge || (D.a && D.a._edge) || (D.b && D.b._edge);
            if (!edge) {
                D._edge = null;
                if (D.a) D.a._edge = null;
                if (D.b) D.b._edge = null;
                return;
            }
            const E = s.edgeDocks[edge];
            if (E) {
                const i = E.wins.indexOf(D.a.title);
                if (i >= 0) E.wins.splice(i, 1);
                delete E.fracs[D.a.title];
                if (!E.wins.length) s.edgeDocks[edge] = null;
            }
            D._edge = null;
            if (D.a) D.a._edge = null;
            if (D.b) D.b._edge = null;
        }
        _removeFromEdge(w) {
            const s = this.state;
            if (!w._edge) return;
            const E = s.edgeDocks[w._edge];
            if (E) {
                const i = E.wins.indexOf(w.title);
                if (i >= 0) E.wins.splice(i, 1);
                delete E.fracs[w.title];
                if (!E.wins.length) s.edgeDocks[w._edge] = null;
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
            for (const edge of ['top', 'bottom', 'left', 'right']) {
                const E = s.edgeDocks[edge];
                if (!E) continue;
                // closed windows leave the stack (and are freed); windows that are
                // mid-join into a normal dock are handed over to the dock. A DOCK is
                // one unit of the stack, identified by member A's title — valid only
                // while the dock itself is edge-docked.
                E.wins = E.wins.filter((t) => {
                    const w = s.windows.get(t);
                    if (!w) return false;
                    if (w._dockKey) {
                        const D = s.docks.get(w._dockKey);
                        if (!D || !D._edge || D.a.title !== t) return false;
                        if (D.a.open === false || D.b.open === false) {
                            D._edge = null;
                            D.a._edge = null;
                            D.b._edge = null;
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

                const horiz = edge === 'top' || edge === 'bottom';
                const n = E.wins.length;
                let x0, y0, colW, colH;
                if (edge === 'left') {
                    x0 = am && am.pos === 'left' ? am.sideWidth : 0;
                    y0 = am && am.pos === 'top' ? am.thickness : 0;
                    colW = E.size;
                    colH = H - y0 - (am && am.pos === 'bottom' ? am.thickness : 0);
                } else if (edge === 'right') {
                    const bar = am && am.pos === 'right' ? am.sideWidth : 0;
                    x0 = W - bar - E.size;
                    y0 = am && am.pos === 'top' ? am.thickness : 0;
                    colW = E.size;
                    colH = H - y0 - (am && am.pos === 'bottom' ? am.thickness : 0);
                } else if (edge === 'top') {
                    y0 = am && am.pos === 'top' ? am.thickness : 0;
                    // inset between the left/right columns so the row never covers them
                    x0 = (am && am.pos === 'left' ? am.sideWidth : 0) + leftW;
                    colH = E.size;
                    colW = Math.max(
                        40,
                        W -
                            (am && am.pos === 'left' ? am.sideWidth : 0) -
                            leftW -
                            (am && am.pos === 'right' ? am.sideWidth : 0) -
                            rightW,
                    );
                } else {
                    const bar = am && am.pos === 'bottom' ? am.thickness : 0;
                    y0 = H - bar - E.size;
                    x0 = (am && am.pos === 'left' ? am.sideWidth : 0) + leftW;
                    colH = E.size;
                    colW = Math.max(
                        40,
                        W -
                            (am && am.pos === 'left' ? am.sideWidth : 0) -
                            leftW -
                            (am && am.pos === 'right' ? am.sideWidth : 0) -
                            rightW,
                    );
                }

                E._rect = { x0, y0, colW, colH };

                // apply an in-flight boundary/column drag
                const d = s.drag;
                if (d && d.edgeDock === edge && this.isMouseDown(0)) {
                    if (d.type === 'edge-split') {
                        // absolute from the drag's press-time snapshot — applying the
                        // delta to the live fraction each frame would re-add it and keep
                        // scaling while the mouse is held. The mouse delta is mapped
                        // through the normalized fractions (x sum / share) so the
                        // boundary follows the cursor 1:1 and stays where released.
                        const delta =
                            ((horiz ? mo.x - d.p0 : mo.y - d.p0) * d.sum) / Math.max(1, d.share);
                        const ni = clamp(d.f0 + delta, 0.04, d.total - 0.04);
                        E.fracs[E.wins[d.i]] = ni;
                        E.fracs[E.wins[d.i + 1]] = d.total - ni;
                        this._setCursor(horiz ? 'ew-resize' : 'ns-resize', 2);
                    } else if (d.type === 'edge-resize') {
                        if (edge === 'left') E.size = clamp(mo.x - x0, 140, W * 0.65);
                        else if (edge === 'right')
                            E.size = clamp(
                                W - (am && am.pos === 'right' ? am.sideWidth : 0) - mo.x,
                                140,
                                W * 0.65,
                            );
                        else if (edge === 'top') E.size = clamp(mo.y - y0, 100, H * 0.6);
                        else
                            E.size = clamp(
                                H - (am && am.pos === 'bottom' ? am.thickness : 0) - mo.y,
                                100,
                                H * 0.6,
                            );
                        this._setCursor(horiz ? 'ns-resize' : 'ew-resize', 2);
                    }
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
                    if (!w) continue;
                    const sz = Math.max(28, Math.round(((E.fracs[E.wins[i]] || 0) / sum) * share));
                    if (w._dock && w._dock._edge === edge) {
                        // a combined window (dock) as one unit: the stack owns the
                        // dock's outer rect; its members sub-layout as usual
                        const D = w._dock;
                        if (horiz) {
                            D.x = x0 + pad + off;
                            D.y = y0 + pad;
                            D.w = sz;
                            D.h = colH - pad * 2;
                        } else {
                            D.x = x0 + pad;
                            D.y = y0 + pad + off;
                            D.w = colW - pad * 2;
                            D.h = sz;
                        }
                        D._edge = edge;
                        D.a._edge = edge;
                        D.b._edge = edge;
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
                                type: 'edge-split',
                                edgeDock: edge,
                                i: b.i,
                                p0: horiz ? mo.x : mo.y,
                                share,
                                f0: fi0,
                                total: fi0 + fj0,
                                sum: Math.max(1e-6, sumAll),
                            };
                            s.activeId = -1;
                        } else if (!s.drag) this._setCursor(horiz ? 'ew-resize' : 'ns-resize', 1);
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
                    edge === 'left' || edge === 'right'
                        ? (edge === 'left'
                              ? mo.x >= x0 + colW - N && mo.x <= x0 + colW + N
                              : mo.x >= x0 - N && mo.x <= x0 + N) &&
                          mo.y >= y0 &&
                          mo.y <= y0 + colH
                        : (edge === 'top'
                              ? mo.y >= y0 + colH - N && mo.y <= y0 + colH + N
                              : mo.y >= y0 - N && mo.y <= y0 + N) &&
                          mo.x >= x0 &&
                          mo.x <= x0 + colW;
                const resizing = d && d.edgeDock === edge && d.type === 'edge-resize';
                // bar + cursor only while the band is the topmost thing at the
                // point (a covering window/popup takes the interaction instead);
                // an in-flight edge-resize drag keeps its bar regardless
                const bandLive = inInnerBand && !s.hoveredWindow; // hoveredWindow is null only when no window (or open modal) is under the cursor
                if (resizing) E._barT = 1;
                else if (bandLive)
                    E._barT = this.flags.animations ? Math.min(1, (E._barT || 0) + s.dt / 0.12) : 1;
                else
                    E._barT = this.flags.animations ? Math.max(0, (E._barT || 0) - s.dt / 0.12) : 0;
                if (bandLive) {
                    if (canDrag && this.isMouseClicked(0) && s.activeId === 0) {
                        s.drag = { type: 'edge-resize', edgeDock: edge };
                        s.activeId = -1;
                    } else if (!s.drag) this._setCursor(horiz ? 'ns-resize' : 'ew-resize', 1);
                }
            }
        }
        /* Fade-in resize bars over the inner edges of screen-edge stacks (the
         * visual half of the proximity band in _edgeDocksFrame). */
        _drawEdgeResizeBars() {
            const s = this.state;
            for (const edge of ['left', 'right', 'top', 'bottom']) {
                const E = s.edgeDocks[edge];
                if (!E || !E._barT || !E._rect) continue;
                const R = E._rect;
                const bw = 4;
                const horiz = edge === 'top' || edge === 'bottom';
                const span = horiz ? R.colW : R.colH;
                const len = Math.max(24, Math.min(64, span * 0.35));
                const fill = withAlpha(this._col('sliderGrab'), Math.round(230 * E._barT));
                const lineC = withAlpha(this._col('border'), Math.round(140 * E._barT));
                let x, y, w, h;
                if (edge === 'left') {
                    x = R.x0 + R.colW - bw / 2;
                    y = R.y0 + R.colH / 2 - len / 2;
                    w = bw;
                    h = len;
                } else if (edge === 'right') {
                    x = R.x0 - bw / 2;
                    y = R.y0 + R.colH / 2 - len / 2;
                    w = bw;
                    h = len;
                } else if (edge === 'top') {
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
                this.renderer.strokeRoundedRect(x + 0.5, y + 0.5, w - 1, h - 1, 2, lineC, 1);
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
            if (!d || (d.type !== 'win-move' && d.type !== 'dock-move') || !this.flags.docking)
                return;
            // a dock (combined window) is draggable onto screen edges too — it
            // joins the stack as one unit; the window join grid is window-only
            const w = d.type === 'win-move' ? d.win : d.dock && d.dock.a;
            if (!w) return;
            if (d.type === 'win-move') {
                if (w.noDock || w._edge) return;
            } else if (w.noDock || (d.dock.b && d.dock.b.noDock)) return;
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
                    kind: 'screen',
                    side: this._dockGridSide(sp, mo.x, mo.y, sbHit),
                    parts: sp,
                };
                return;
            }
            // 2) screen-edge bands — also global (always-on-top, input priority)
            let edge = null;
            if (mo.y < B) edge = 'top';
            else if (mo.y > H - B) edge = 'bottom';
            else if (mo.x < B) edge = 'left';
            else if (mo.x > W - B) edge = 'right';
            if (edge) {
                s._dockHint = {
                    kind: 'edge',
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
            if (d.type === 'dock-move') return;
            for (let i = s.zOrder.length - 1; i >= 0; i--) {
                const t = s.zOrder[i];
                if (t === w || t.open === false || t.noDock || t.modal) continue;
                const th = t.collapsed ? t.titleH : t.h;
                if (mo.x >= t.x && mo.x < t.x + t.w && mo.y >= t.y && mo.y < t.y + th) {
                    const cx = t.x + t.w / 2,
                        cy = t.y + th / 2;
                    const parts = this._dockGridParts(cx, cy);
                    // generous: the whole target window is the side-selection area
                    // (quadrants from its center); default: only the drawn square
                    const hit = this.flags.dockJoinHitGenerous
                        ? { x: t.x, y: t.y, w: t.w, h: th }
                        : parts.box;
                    s._dockHint = {
                        kind: 'window',
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
                box: { x: cx - hw, y: cy - hh, w: s, h: s },
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
            if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) return null;
            const cx = p.box.x + p.box.w / 2,
                cy = p.box.y + p.box.h / 2;
            const dx = Math.abs(x - cx),
                dy = Math.abs(y - cy);
            const hw = p.box.w / 2,
                hh = p.box.h / 2;
            if (dx <= 7 && dy <= 7) return null; // center apex: nothing to dock to
            if (dy >= (hh / hw) * dx) return y < cy ? 't' : 'b';
            return x < cx ? 'l' : 'r';
        }
        /* A representative point (centroid) inside one direction triangle —
         * handy for tests and programmatic drops. */
        _dockGridPoint(p, side) {
            const v = p[side];
            return [(v[0] + v[2] + v[4]) / 3, (v[1] + v[3] + v[5]) / 3];
        }
        _edgeBandRect(edge, W, H) {
            const B = 44;
            return edge === 'top'
                ? { x: 0, y: 0, w: W, h: B }
                : edge === 'bottom'
                  ? { x: 0, y: H - B, w: W, h: B }
                  : edge === 'left'
                    ? { x: 0, y: 0, w: B, h: H }
                    : { x: W - B, y: 0, w: B, h: H };
        }
        /* Which resize-edge band (1=bottom, 2=right, 4=top, 8=left) contains
         * (x, y), if any; 0 if none. A band is `resizeBarProximity` px on each
         * side of the window's outline, along that side's span. Near a corner
         * two bands overlap, so a point can claim two directions at once. */
        _winResizeEdgeAt(win, x, y) {
            const N = Math.max(0, Math.floor(this.flags.resizeBarProximity || 0));
            if (!N) return 0;
            const W = win.x + win.w,
                H = win.y + win.h;
            // each band hugs its side, extending N px beyond the window at both
            // ends so the outer corners claim two directions at once (a title-bar
            // click inside the window still starts a move: that drag begins
            // earlier in the frame than the band claim in endFrame)
            let edge = 0;
            if (x >= W - N && x <= W + N && y >= win.y - N && y <= H + N) edge |= 2; // right
            if (x >= win.x - N && x <= win.x + N && y >= win.y - N && y <= H + N) edge |= 8; // left
            if (y >= H - N && y <= H + N && x >= win.x - N && x <= W + N) edge |= 1; // bottom
            if (y >= win.y - N && y <= win.y + N && x >= win.x - N && x <= W + N) edge |= 4; // top
            return edge;
        }
        /* The corner grip zone (a square `resizeBarProximity` px into the
         * bottom-right corner). Interaction here takes priority over the
         * window's scrollbars, which stop short of this square. */
        _winGripRect(win) {
            const N = Math.max(1, Math.floor(this.flags.resizeBarProximity || 8));
            return { x: win.x + win.w - N, y: win.y + win.h - N, w: N, h: N };
        }
        /* Apply a hint drop at the end of a win-move drag. Returns true if a
         * dock/edge-dock was created (suppresses the title-bar collapse toggle). */
        _applyDockHint(s, d) {
            const h = s._dockHint;
            s._dockHint = null;
            if (!h || !this.flags.docking) return false;
            const isDockMove = d.type === 'dock-move';
            const D = isDockMove ? d.dock : null;
            const w = d.win;
            if (isDockMove) {
                if (!D || !D.a || !D.b || D.a.noDock || D.b.noDock) return false;
            } else if (!w || w.noDock) return false;
            if (h.kind === 'window') {
                // the join grid only exists for window drags
                if (!w) return false;
                if (!h.side) return false; // no direction triangle under the cursor: plain drop
                const t = h.target;
                if (!t || t.open === false || t.noDock) return false;
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
                    if (unit === w || unit.open === false) return false;
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
                            const dT = this._var('titleBarHeight');
                            tx = oldD.x;
                            ty = oldD.y + dT;
                            tw = Math.max(20, oldD.w - 6);
                            th2 = Math.max(60, oldD.h - dT);
                        }
                    }
                }
                const a = h.side === 'l' || h.side === 't' ? w : t; // first = left/top
                const b = a === w ? t : w;
                const dir = h.side === 'l' || h.side === 'r' ? 'h' : 'v';
                // combined size: both windows' sizes added together in the dock
                // direction; the cross dimension takes the larger window's size,
                // anchored on the larger one (so it keeps its position)
                if (dir === 'h') {
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
            if (h.kind === 'edge') return !!this.dockToEdge(unitTitle, h.edge);
            if (h.kind === 'screen') {
                if (!h.side) return false; // no direction triangle under the cursor: plain drop
                const e =
                    h.side === 't'
                        ? 'top'
                        : h.side === 'b'
                          ? 'bottom'
                          : h.side === 'l'
                            ? 'left'
                            : 'right';
                return !!this.dockToEdge(unitTitle, e);
            }
            return false;
        }
        /* Draw the live hint above everything (called at the end of the frame):
         * the screen-center dock grid (always), the highlighted edge band, and
         * the join grid at the center of the window being hovered. */
        _drawDockHints() {
            const s = this.state;
            const d = s.drag;
            if (!d || (d.type !== 'win-move' && d.type !== 'dock-move') || !this.flags.docking)
                return;
            if (d.win && d.win.noDock) return; // NoDock: no docking UI while dragging
            if (d.dock && (d.dock.a.noDock || d.dock.b.noDock)) return; // ditto, for a dock
            const r = this.renderer;
            const W = s.displayW,
                H = s.displayH;
            const acc = this._col('sliderGrab');
            const h = s._dockHint;

            // The screen-center dock grid is a square split into four direction
            // triangles (one per screen edge, apexes meeting at the center). It is
            // always shown while a window is dragged; the triangle under the
            // cursor lights up, and dropping on it docks the window to that screen
            // edge. The center apex has no direction, so dropping there is a plain
            // drop.
            const sp = this._dockGridParts(W / 2, H / 2);
            this._drawDockGrid(r, sp, h && h.kind === 'screen' ? h.side : null, acc, false);

            if (h && h.kind === 'edge') {
                const b = h.band;
                r.fillRoundedRect(b.x + 2, b.y + 2, b.w - 4, b.h - 4, 4, withAlpha(acc, 48));
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
            if (h && h.kind === 'window') {
                this._drawDockGrid(r, h.parts, h.side, acc, true);
            }
        }
        /* One dock grid (as produced by _dockGridParts): a square of four
         * direction triangles. The triangle matching activeSide lights up;
         * overWindow adds the faint square outline that the join-on-a-window
         * variant uses. */
        _drawDockGrid(r, p, activeSide, acc, overWindow) {
            if (overWindow) {
                r.strokeRoundedRect(
                    p.box.x + 0.5,
                    p.box.y + 0.5,
                    p.box.w - 1,
                    p.box.h - 1,
                    4,
                    withAlpha(this._col('text'), 80),
                    1,
                );
            }
            for (const k of ['t', 'b', 'l', 'r']) {
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
            const s = this.state;
            s.appMenu = {
                menus: menus || [],
                pos: ['top', 'left', 'right', 'bottom'].includes(opts.pos) ? opts.pos : 'top',
                thickness: opts.size > 0 ? opts.size : opts.thickness > 0 ? opts.thickness : 30,
                sideWidth: opts.width > 0 ? opts.width : 180,
            };
            s.appMenuOwner = { kind: 'appmenu' };
            const sc = [];
            const walk = (list) => {
                for (const m of list || []) {
                    if (m && m.key) sc.push(m);
                    if (m && m.items) walk(m.items);
                }
            };
            walk(menus || []);
            s.appMenuShortcuts = sc;
            return this;
        }
        clearAppMenuBar() {
            const s = this.state;
            s.appMenu = null;
            s.appMenuShortcuts = [];
            for (const p of s.popupList) if (p.data && p.data.appMenu) p.open = false;
            return this;
        }
        activateMenu(...path) {
            const am = this.state.appMenu;
            if (!am || !path.length) return false;
            let list = am.menus;
            for (let i = 0; i < path.length; i++) {
                const m = (list || []).find((x) => x && x.label === path[i]);
                if (!m) return false;
                if (i === path.length - 1) {
                    const disabled = typeof m.disabled === 'function' ? m.disabled() : !!m.disabled;
                    if (disabled || typeof m.onActivated !== 'function') return false;
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
            const mo = s.mouse;
            const tH = this._var('titleBarHeight');
            const dw = 6; // divider thickness
            const isA = D.a === win;
            win._dock = D;
            win._dockIsA = isA;

            // 1) apply an in-flight dock drag (updates D before the rect is derived)
            const d = s.drag;
            if (d && d.dock === D && this.isMouseDown(0)) {
                if (d.type === 'dock-move') {
                    D.x = mo.x - d.offX;
                    D.y = mo.y - d.offY;
                    d.moved = Math.max(d.moved || 0, Math.abs(D.x - d.x0) + Math.abs(D.y - d.y0));
                    // the first real movement brings the whole dock to the front
                    if (d.moved >= this.flags.dragThreshold && !d.raised) {
                        d.raised = true;
                        this._raise(D.b);
                        this._raise(D.a);
                    }
                    this._setCursor('grabbing', 2);
                } else if (d.type === 'dock-resize') {
                    if (d.edge & 2) {
                        const nw = clamp(d.w0 + (mo.x - d.mx), D.minW, 1e5);
                        D.x = d.x0 + (d.w0 - nw);
                        D.w = nw;
                    }
                    if (d.edge & 1) D.h = clamp(d.h0 + (mo.y - d.my), D.minH, 1e5);
                    if (d.edge & 4) {
                        const ny = clamp(d.y0 + (mo.y - d.my), 0, 1e5);
                        D.h = d.h0 + (d.y0 - ny);
                        D.y = ny;
                    }
                    if (d.edge & 8) {
                        const nw = clamp(d.w0 + (d.mx - mo.x), D.minW, 1e5);
                        D.x = d.x0 + d.w0 - nw;
                        D.w = nw;
                    }
                    const corner =
                        (d.edge & 2 && d.edge & 1) || (d.edge & 4 && (d.edge & 2 || d.edge & 8));
                    this._setCursor(
                        corner
                            ? 'nwse-resize'
                            : d.edge & 2 || d.edge & 8
                              ? 'ew-resize'
                              : 'ns-resize',
                        2,
                    );
                } else if (d.type === 'dock-split') {
                    if (D.dir === 'h')
                        D.ratio = clamp((mo.x - D.x - dw / 2) / (D.w - dw), 0.12, 0.88);
                    else D.ratio = clamp((mo.y - D.y - tH - dw / 2) / (D.h - tH - dw), 0.12, 0.88);
                    this._setCursor(D.dir === 'h' ? 'ew-resize' : 'ns-resize', 2);
                }
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

            if (D.dir === 'h') {
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
            const s = this.state;
            const D = win._dock;
            const isA = win._dockIsA;
            const tH = this._var('titleBarHeight');
            const mo = s.mouse;
            const r = this._var('windowRounding');
            const fo = this._fo();
            const lineH = this._lineH();
            const inRect = (x, y, w, h) => mo.x >= x && mo.x < x + w && mo.y >= y && mo.y < y + h;

            if (isA) {
                const dh = D.collapsed ? tH : D.h;
                const dragging = s.drag && s.drag.dock === D;
                const focused = dragging || s.hoveredWindow === D.a || s.hoveredWindow === D.b;
                // border around the combined rect
                if (this._var('windowBorder') > 0) {
                    this.renderer.strokeRoundedRect(
                        D.x + 0.5,
                        D.y + 0.5,
                        D.w - 1,
                        dh - 1,
                        r,
                        this._col('border', alpha),
                        this._var('windowBorder'),
                    );
                }
                // combined title bar
                const tbColor = focused
                    ? this._col('titleBgActive', alpha)
                    : this._col('titleBg', alpha);
                this.renderer.fillRoundedRect(D.x, D.y, D.w, tH, r, tbColor);
                this.renderer.fillRect(D.x, D.y + tH / 2, D.w, tH / 2, tbColor);
                // close button (right end): closes both members + removes the dock
                const bx = D.x + D.w - 16,
                    by = D.y + tH / 2;
                const hovClose = inRect(bx - 7, by - 9, 20, 18);

                // collapse/expand chevron (left end): hides/shows the members inside
                const ccx = D.x + 14,
                    ccy = D.y + tH / 2;
                const ccColor = this._col(focused ? 'text' : 'textDisabled', alpha);
                if (D.collapsed)
                    this.renderer.fillPolygon(
                        [ccx - 4, ccy - 4, ccx - 4, ccy + 4, ccx + 2, ccy],
                        ccColor,
                    );
                else
                    this.renderer.fillPolygon(
                        [ccx - 4, ccy - 3, ccx + 4, ccy - 3, ccx, ccy + 3],
                        ccColor,
                    );
                const inChevron = inRect(D.x + 4, D.y, 22, tH) && !hovClose;
                const title =
                    D.title || (D.a && D.b ? D.a.title + ' +' + D.b.title : D.a ? D.a.title : '');
                this._drawText(
                    D.x + 30,
                    D.y + (tH - lineH) / 2 + 1,
                    title,
                    this._col(focused ? 'text' : 'textDisabled', alpha),
                    fo,
                );

                if (hovClose)
                    this.renderer.fillRoundedRect(
                        bx - 7,
                        by - 9,
                        20,
                        18,
                        4,
                        this._col('headerHovered', alpha),
                    );
                this.renderer.line(
                    bx - 3,
                    by - 4,
                    bx + 5,
                    by + 4,
                    this._col(hovClose ? 'text' : 'textDisabled', alpha),
                    1.4,
                );
                this.renderer.line(
                    bx + 5,
                    by - 4,
                    bx - 3,
                    by + 4,
                    this._col(hovClose ? 'text' : 'textDisabled', alpha),
                    1.4,
                );

                // divider (between the two members)
                if (!D.collapsed) {
                    const dw = 6;
                    if (D.dir === 'h') {
                        const divX = D.x + Math.round((D.w - dw) * D.ratio) + dw / 2;
                        this.renderer.line(
                            divX,
                            D.y + tH + 3,
                            divX,
                            D.y + D.h - 3,
                            this._col('border', alpha),
                            1.5,
                        );
                        this.renderer.fillRoundedRect(
                            divX - 1.5,
                            D.y + D.h / 2 - 8,
                            3,
                            16,
                            1.5,
                            this._col('border', alpha),
                        );
                    } else {
                        const divY = D.y + tH + Math.round((D.h - tH - dw) * D.ratio) + dw / 2;
                        this.renderer.line(
                            D.x + 3,
                            divY,
                            D.x + D.w - 3,
                            divY,
                            this._col('border', alpha),
                            1.5,
                        );
                        this.renderer.fillRoundedRect(
                            D.x + D.w / 2 - 8,
                            divY - 1.5,
                            16,
                            3,
                            1.5,
                            this._col('border', alpha),
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
                const top = s.hoveredWindow;
                const chromeTop = top === D.a || top === D.b || top === null; // an open modal covering the point shows up as `top` and loses
                const clicked =
                    this.isMouseClicked(0) &&
                    s.activeId === 0 &&
                    !s.drag &&
                    s.disabledCount === 0 &&
                    !s.appBarGrab &&
                    !this._popupAtPoint(mo.x, mo.y) &&
                    chromeTop;
                const gy = D.y + dh;
                // eT covers the top 4px of the title bar (plus 4px above it) so a
                // dock can be scaled vertically from the top edge as well
                const eT = inRect(D.x, D.y - 4, D.w, 8) && !hovClose && !inChevron;
                const eL = inRect(D.x - 4, D.y, 12, dh) && !hovClose;
                const eR = inRect(D.x + D.w - 8, D.y, 12, dh) && mo.y >= D.y + tH;
                const eB = inRect(D.x, gy - 8, D.w, 12);
                const inTitle = inRect(D.x, D.y, D.w, tH);
                let inDivider = false;
                if (!D.collapsed) {
                    const dw = 6;
                    if (D.dir === 'h') {
                        const divX = D.x + Math.round((D.w - dw) * D.ratio) + dw / 2;
                        inDivider =
                            mo.x >= divX - 4 && mo.x <= divX + 4 && mo.y >= D.y + tH && mo.y < gy;
                    } else {
                        const divY = D.y + tH + Math.round((D.h - tH - dw) * D.ratio) + dw / 2;
                        inDivider =
                            mo.y >= divY - 4 && mo.y <= divY + 4 && mo.x >= D.x && mo.x < D.x + D.w;
                    }
                }
                if (clicked) {
                    if (hovClose) {
                        if (D.a) {
                            D.a.open = false;
                            this._freeDockedMember(D.a);
                        }
                        if (D.b) {
                            D.b.open = false;
                            this._freeDockedMember(D.b);
                        }
                        s.docks.delete(D.key);
                        s.activeId = -1;
                    } else if (inChevron) {
                        D.collapsed = !D.collapsed;
                        s.activeId = -1;
                    } else if (eT && !D._edge) {
                        s.drag = {
                            type: 'dock-resize',
                            dock: D,
                            win,
                            button: 0,
                            edge: (eL ? 8 : 0) | (eR ? 2 : 0) | (eB ? 1 : 0) | 4,
                            mx: mo.x,
                            my: mo.y,
                            x0: D.x,
                            y0: D.y,
                            w0: D.w,
                            h0: D.h,
                        };
                        s.activeId = -1;
                    } else if (inTitle) {
                        if (D._edge) {
                            // a globally docked dock: the stack owns its position/size, so
                            // there is no move/resize — double-click frees it from the edge
                            if (this.isMouseDoubleClicked(0)) this.undockEdge(D.a.title);
                        } else if (this.isMouseDoubleClicked(0) && this.flags.windowDoubleReset) {
                            D.x = D.defaultX;
                            D.y = D.defaultY;
                        } else {
                            // the dock is raised to the front once the drag actually moves
                            // (see the dock-move apply in _dockMemberLayout)
                            s.drag = {
                                type: 'dock-move',
                                dock: D,
                                win,
                                button: 0,
                                offX: mo.x - D.x,
                                offY: mo.y - D.y,
                                x0: D.x,
                                y0: D.y,
                                moved: 0,
                            };
                            s.activeId = -1;
                        }
                    } else if ((eL || eR || eB) && !D._edge) {
                        s.drag = {
                            type: 'dock-resize',
                            dock: D,
                            win,
                            button: 0,
                            edge: (eL ? 8 : 0) | (eR ? 2 : 0) | (eB ? 1 : 0),
                            mx: mo.x,
                            my: mo.y,
                            x0: D.x,
                            y0: D.y,
                            w0: D.w,
                            h0: D.h,
                        };
                        s.activeId = -1;
                    } else if (inDivider) {
                        if (this.isMouseDoubleClicked(0)) D.ratio = 0.5;
                        else {
                            s.drag = { type: 'dock-split', dock: D, win, button: 0 };
                            s.activeId = -1;
                        }
                    }
                }
                // right-click the combined title bar: dock context menu (only when no
                // other window covers this spot)
                if (
                    this.flags.windowContextMenu &&
                    this.isMouseClicked(1) &&
                    s.activeId === 0 &&
                    s.disabledCount === 0 &&
                    !s.drag &&
                    !s.appBarGrab &&
                    inTitle &&
                    !hovClose
                ) {
                    let covered = false;
                    for (let i = s.zOrder.length - 1; i >= 0; i--) {
                        const w2 = s.zOrder[i];
                        if (w2.kind !== 'window' || w2.open === false) continue;
                        const h2 = w2.collapsed ? w2.titleH : w2.h;
                        if (
                            mo.x >= w2.x &&
                            mo.x < w2.x + w2.w &&
                            mo.y >= w2.y &&
                            mo.y < w2.y + h2
                        ) {
                            covered = true;
                            break;
                        }
                    }
                    if (!covered) this._dockContextMenu(D);
                }
                // hover cursors (dragging is prio 2 in _dockMemberLayout); a window
                // painted over the point owns the cursor instead (chromeTop). An
                // edge-docked dock has no move/resize cursors (the stack owns its
                // geometry — the stack's inner bar and gap spliters resize it).
                if (!s.drag && chromeTop) {
                    if (inChevron) this._setCursor('pointer', 1);
                    else if (eT && !D._edge)
                        this._setCursor(eL || eR ? 'nwse-resize' : 'ns-resize', 1);
                    else if (inTitle && !hovClose && !D._edge) this._setCursor('move', 1);
                    else if (inDivider)
                        this._setCursor(D.dir === 'h' ? 'ew-resize' : 'ns-resize', 1);
                    else if ((eL || eR) && !D._edge) this._setCursor('ew-resize', 1);
                    else if (eB && !D._edge) this._setCursor('ns-resize', 1);
                    else if (hovClose) this._setCursor('pointer', 1);
                }
            }

            // ---- slim member header (both members, when not dock-collapsed) ----
            if (D.collapsed || win.w <= 0 || win.h <= 0) return;
            const sh = win.titleH;
            const focused = s.hoveredWindow === win;
            this.renderer.fillRect(
                win.x,
                win.y,
                win.w,
                sh,
                win.collapsed ? this._col('titleBgCollapsed', alpha) : this._col('childBg', alpha),
            );
            this.renderer.line(
                win.x,
                win.y + sh + 0.5,
                win.x + win.w,
                win.y + sh + 0.5,
                this._col('border', alpha),
                1,
            );
            const ccx = win.x + 12,
                ccy = win.y + sh / 2;
            const cc = this._col(focused ? 'text' : 'textDisabled', alpha);
            if (win.collapsed)
                this.renderer.fillPolygon([ccx - 4, ccy - 4, ccx - 4, ccy + 4, ccx + 2, ccy], cc);
            else
                this.renderer.fillPolygon(
                    [ccx - 4, ccy - 3, ccx + 4, ccy - 3, ccx - 0, ccy + 3],
                    cc,
                );
            this._drawText(
                win.x + 24,
                win.y + (sh - lineH) / 2 + 1,
                win.title,
                this._col(focused ? 'text' : 'textDisabled', alpha),
                fo,
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
                    this._col('headerHovered', alpha),
                );
            // expand-style icon: small square + diagonal arrow
            this.renderer.strokeRoundedRect(
                ux - 4,
                uy - 1,
                7,
                5,
                1,
                this._col(hovU ? 'text' : 'textDisabled', alpha),
                1.2,
            );
            this.renderer.line(
                ux - 1,
                uy + 3,
                ux + 4,
                uy - 3,
                this._col(hovU ? 'text' : 'textDisabled', alpha),
                1.2,
            );
            this.renderer.polyline(
                [ux + 1, uy - 3, ux + 4, uy - 3, ux + 4, uy],
                this._col(hovU ? 'text' : 'textDisabled', alpha),
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
                !s.drag &&
                s.disabledCount === 0 &&
                !s.appBarGrab &&
                !this._popupAtPoint(mo.x, mo.y);
            const prev = win._dockPrevRect;
            const inPrevHeader =
                prev &&
                prev.h >= sh &&
                mo.x >= prev.x &&
                mo.x < prev.x + prev.w &&
                mo.y >= prev.y &&
                mo.y < prev.y + sh;
            if (inPrevHeader) {
                const pux = prev.x + prev.w - 13,
                    puy = prev.y + sh / 2;
                const inU = inRect(pux - 8, puy - 8, 16, 16);
                if (clicked && inU) this.undock(win);
                else if (clicked && !inU) {
                    s._memberDrag = {
                        win,
                        x: mo.x,
                        y: mo.y,
                        offX: mo.x - win.x,
                        offY: mo.y - win.y,
                    };
                    s.activeId = -1;
                } else if (!s.drag && !inU && !inRect(win.x + 4, win.y, 22, sh)) {
                    this._setCursor(this.flags.windowMove ? 'move' : 'default', 1);
                }
            }
            if (
                this.flags.windowContextMenu &&
                this.isMouseClicked(1) &&
                s.activeId === 0 &&
                s.disabledCount === 0 &&
                !s.drag &&
                !s.appBarGrab &&
                s.hoveredWindow === win &&
                inPrevHeader
            ) {
                this._memberContextMenu(win);
            }
            if (hovU) this._setCursor('pointer', 1);
        }

        beginWindow(title, opts) {
            opts = opts || {};
            const s = this.state;
            if (s.currentWindow && s.currentWindow.drawnFrame === s.frameId) return false; // re-entry guard

            let win = s.windows.get(title);
            if (!win) {
                win = new Window(title, 'window');
                win.owner = win;
                s.windows.set(title, win);
                win.createdFrame = s.frameId;
                const n = s.winCounter++;
                win.defaultX = 24 + (n % 6) * 36;
                win.defaultY = 24 + (n % 6) * 28;
                const st = s.windowStates.get(title);
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
            win.createdFrame = win.createdFrame || s.frameId;

            // options
            if (opts.open !== undefined) win.open = !!opts.open;
            if (opts.onClose) win.onClose = opts.onClose;
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
                    !(win.flags & WindowFlags.NoResize) && !win.fixedSize && !win.autoResize;
                win.collapsible = !(win.flags & WindowFlags.NoCollapse) && !win.noTitleBar;
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
            if (opts.collapsed !== undefined) win.collapsed = !!opts.collapsed;
            if (opts.size) {
                win.sizeW = opts.size[0];
                win.sizeH = opts.size[1];
            }
            if (opts.pos && !s.windowStates.has(title)) {
                win.x = opts.pos[0];
                win.y = opts.pos[1];
                win.defaultX = opts.pos[0];
                win.defaultY = opts.pos[1];
            }

            if (s.nextWindowPos) {
                win.x = s.nextWindowPos.x;
                win.y = s.nextWindowPos.y;
                s.nextWindowPos = null;
            }
            if (s.nextWindowSize) {
                if (s.nextWindowSize.w > 0) win.w = s.nextWindowSize.w;
                if (s.nextWindowSize.h > 0) win.h = s.nextWindowSize.h;
                s.nextWindowSize = null;
            }

            win.drawnFrame = s.frameId;
            if (s.zOrder.indexOf(win) < 0) s.zOrder.push(win);

            if (!win.open) return false;

            const stylePad = this._var('windowPadding');
            win.padX = stylePad[0];
            win.padY = stylePad[1];
            win.titleH = win.noTitleBar ? 0 : this._var('titleBarHeight');
            win.menuH = opts.menuBar ? this._var('menuBarHeight') : 0;

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

            const mo = s.mouse;

            // docked member: the dock layout drives this window's rect
            if (win._dockKey) {
                win._dockPrevRect = { x: win.x, y: win.y, w: win.w, h: win.h };
                const D = s.docks.get(win._dockKey);
                if (!D || (D.a !== win && D.b !== win)) {
                    win._dockKey = null;
                    win._dock = null;
                } else {
                    this._dockMemberLayout(win, D, s);
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
                !s.appBarGrab &&
                mo.x >= win.x &&
                mo.x < win.x + win.w &&
                mo.y >= win.y &&
                mo.y < win.y + claimH
            ) {
                if (
                    s.hoveredWindow === null ||
                    s.zOrder.indexOf(win) > s.zOrder.indexOf(s.hoveredWindow)
                ) {
                    s.hoveredWindow = win;
                }
            }

            // window dragging / resizing
            if (s.drag && s.drag.win === win) {
                const d = s.drag;
                if (d.type === 'win-move' && this.isMouseDown(0)) {
                    win.x = mo.x - d.offX;
                    win.y = mo.y - d.offY;
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
                    this._setCursor('grabbing', 2);
                } else if (d.type === 'win-resize' && this.isMouseDown(0)) {
                    // each claimed edge scales the window in its direction; left/top
                    // moves keep the opposite edge in place
                    if (d.edge & 2) win.w = clamp(d.w0 + (mo.x - d.mx), win.minW, win.maxW);
                    if (d.edge & 8) {
                        win.w = clamp(d.w0 + (d.mx - mo.x), win.minW, win.maxW);
                        win.x = d.x0 + d.w0 - win.w;
                    }
                    if (d.edge & 1) win.h = clamp(d.h0 + (mo.y - d.my), win.minH, win.maxH);
                    if (d.edge & 4) {
                        win.h = clamp(d.h0 + (d.my - mo.y), win.minH, win.maxH);
                        win.y = d.y0 + d.h0 - win.h;
                    }
                    const horiz = d.edge & 2 || d.edge & 8,
                        vert = d.edge & 1 || d.edge & 4;
                    this._setCursor(
                        horiz && vert ? 'nwse-resize' : horiz ? 'ew-resize' : 'ns-resize',
                        2,
                    );
                }
            }
            if (
                this.isMouseClicked(0) &&
                s.hoveredWindow === win &&
                s.activeId === 0 &&
                s.disabledCount === 0 &&
                !this._popupAtPoint(mo.x, mo.y)
            ) {
                s.focusedWindow = win; // focus marker only — a click never reorders the stack
                // double-click a screen-edge window's title bar to free it from the edge
                if (
                    win._edge &&
                    !win.noTitleBar &&
                    this.flags.windowDoubleReset &&
                    mo.x >= win.x &&
                    mo.x < win.x + win.w &&
                    mo.y >= win.y &&
                    mo.y < win.y + win.titleH &&
                    this.isMouseDoubleClicked(0)
                ) {
                    this.undockEdge(win.title);
                }
                if (
                    !win.noTitleBar &&
                    win.movable &&
                    this.flags.windowMove &&
                    mo.x >= win.x &&
                    mo.x < win.x + win.w &&
                    mo.y >= win.y &&
                    mo.y < win.y + win.titleH
                ) {
                    const inClose =
                        win.closable && mo.x >= win.x + win.w - 28 && mo.x <= win.x + win.w - 6;
                    const inCollapse = win.collapsible && mo.x >= win.x && mo.x <= win.x + 28;
                    if (!inClose && !inCollapse) {
                        if (this.isMouseDoubleClicked(0) && this.flags.windowDoubleReset) {
                            win.x = win.defaultX;
                            win.y = win.defaultY;
                            // undo the collapse toggle caused by the first click of this double-click
                            if (
                                win._collapseToggledAt &&
                                s.frameId - win._collapseToggledAt <= 30
                            ) {
                                win.collapsed = !win.collapsed;
                                win._collapseToggledAt = 0;
                            }
                        } else {
                            s.drag = {
                                type: 'win-move',
                                win,
                                button: 0,
                                offX: mo.x - win.x,
                                offY: mo.y - win.y,
                                x0: win.x,
                                y0: win.y,
                                moved: 0,
                                collapse: win.collapsible,
                            };
                            s.activeId = -1;
                        }
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
                    s.hoveredWindow === win &&
                    s.activeId === 0 &&
                    s.disabledCount === 0 &&
                    !s.drag &&
                    !s.appBarGrab &&
                    !this._popupAtPoint(mo.x, mo.y) &&
                    mo.x >= win.x &&
                    mo.x < win.x + win.w &&
                    mo.y >= win.y &&
                    mo.y < win.y + winH
                ) {
                    s.focusedWindow = win;
                }
            }
            // right-click the title bar: window context menu (topmost window only;
            // dock members have their slim-header menu in _drawDockChrome)
            if (
                this.flags.windowContextMenu &&
                this.isMouseClicked(1) &&
                s.hoveredWindow === win &&
                s.activeId === 0 &&
                s.disabledCount === 0 &&
                !s.drag &&
                !s.appBarGrab &&
                !win.noTitleBar &&
                !win._dockKey &&
                mo.x >= win.x &&
                mo.x < win.x + win.w &&
                mo.y >= win.y &&
                mo.y < win.y + win.titleH
            ) {
                this._windowContextMenu(win);
            }

            // per-frame resize-bar fade state: a small bar fades in on each side
            // of the window whose outline is within `resizeBarProximity` px of
            // the cursor (dock members / edge windows resize with their dock).
            // The topmost claim (cursor + click -> drag) is resolved in endFrame.
            if (!win._dockKey && !win._edge) {
                const rb = win._resizeBar || (win._resizeBar = { sides: 0, t: 0 });
                const draggingResize = s.drag && s.drag.type === 'win-resize' && s.drag.win === win;
                const edgeNow =
                    win.resizable && this.flags.windowResize && !win.autoResize && !win.collapsed
                        ? this._winResizeEdgeAt(win, mo.x, mo.y)
                        : 0;
                if (draggingResize) {
                    rb.sides = s.drag.edge;
                    rb.t = 1;
                } else if (edgeNow) {
                    rb.sides = edgeNow;
                    rb.t = this.flags.animations ? Math.min(1, rb.t + s.dt / 0.12) : 1;
                } else {
                    rb.t = this.flags.animations ? Math.max(0, rb.t - s.dt / 0.12) : 0;
                    if (!rb.t) rb.sides = 0;
                }
            }

            this.pushId(win.idHash);

            // fade-in
            if (this.flags.animations && win.createdFrame === s.frameId) win.alpha = 0;
            win.alpha = this.flags.animations
                ? Math.min(1, win.alpha + s.dt / Math.max(0.01, this._var('fadeDuration')))
                : 1;

            // ---- draw chrome (GUI layer)
            this.renderer.setLayer(Layers.GUI);
            this._applyStyleScope(win);

            const r = this._var('windowRounding');
            const alpha = win.alpha;
            if (win.modal) {
                this.renderer.fillRect(
                    0,
                    0,
                    s.displayW,
                    s.displayH,
                    withAlpha([0, 0, 0], 110 * alpha),
                );
            }
            if (win._dock) {
                // docked member: plain body; the dock chrome draws border/headers
                // (_drawDockChrome may undock this window mid-frame)
                const D = win._dock;
                this.renderer.fillRect(win.x, win.y, win.w, win.h, this._col('windowBg', alpha));
                this._drawDockChrome(win, alpha);
                if (D.collapsed || win.w <= 0 || win.h <= 0) {
                    this._popStyleScope();
                    this.popId();
                    return false;
                }
            } else {
                // a collapsed window renders its header only — no body behind it
                const bodyH = win.collapsed ? win.titleH : win.h;
                if (this._var('shadow') && alpha > 0.05 && !win.collapsed) {
                    const sa = this._var('shadowAlpha') * alpha;
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
                    this._col('windowBg', alpha),
                );
                if (this._var('windowBorder') > 0) {
                    this.renderer.strokeRoundedRect(
                        win.x + 0.5,
                        win.y + 0.5,
                        win.w - 1,
                        bodyH - 1,
                        r,
                        this._col('border', alpha),
                        this._var('windowBorder'),
                    );
                }
            }

            const focus = win === s.focusedWindow;
            if (!win.noTitleBar && !win._dock) {
                const tbY = win.y,
                    tbH = win.titleH;
                const tbColor =
                    (s.drag && s.drag.win === win && s.drag.type === 'win-move') || focus
                        ? this._col('titleBgActive', alpha)
                        : win.collapsed
                          ? this._col('titleBgCollapsed', alpha)
                          : this._col('titleBg', alpha);
                const tr = Math.min(this._var('titleRounding') || r, tbH / 2);
                this.renderer.fillRoundedRect(win.x, tbY, win.w, tbH, tr, tbColor);
                this.renderer.fillRect(win.x, tbY + tbH / 2, win.w, tbH / 2, tbColor);
                if (this._var('windowBorder') > 0 && !win.collapsed) {
                    this.renderer.line(
                        win.x + 1,
                        win.y + win.h - 0.5,
                        win.x + win.w - 1,
                        win.y + win.h - 0.5,
                        withAlpha(this._col('border', alpha), 153),
                        1,
                    );
                }

                if (win.collapsible) {
                    const cx = win.x + 14,
                        cy = tbY + tbH / 2;
                    const c = this._col(focus ? 'text' : 'textDisabled', alpha);
                    if (win.collapsed)
                        this.renderer.fillPolygon([cx - 3, cy - 5, cx - 3, cy + 5, cx + 4, cy], c);
                    else this.renderer.fillPolygon([cx - 5, cy - 3, cx + 5, cy - 3, cx, cy + 4], c);
                    // arrow button: strictly bounded hit area; pressing it toggles at once
                    // (blocked while the app menu bar covers this spot; only the
                    // topmost window under the mouse may toggle — a covered window's
                    // chevron must not fire when its area is overlapped)
                    if (
                        this.isMouseClicked(0) &&
                        s.hoveredWindow === win &&
                        s.activeId === 0 &&
                        s.disabledCount === 0 &&
                        !s.appBarGrab &&
                        !this._popupAtPoint(mo.x, mo.y) &&
                        mo.x >= win.x &&
                        mo.x <= win.x + 28 &&
                        mo.y >= tbY &&
                        mo.y < tbY + tbH
                    ) {
                        win.collapsed = !win.collapsed;
                        win._collapseToggledAt = s.frameId;
                    }
                }

                {
                    const fo = this._fo();
                    const pad = win.collapsible ? 26 : 10;
                    const maxW = win.w - pad - (win.closable ? 32 : 10) - 8;
                    let label = win.title;
                    while (label.length > 2 && this._measure(label + '…', fo).w > maxW)
                        label = label.slice(0, -1);
                    if (label !== win.title) label += '…';
                    this._drawText(
                        win.x + pad,
                        tbY + (tbH - this._measure(label, fo).h) / 2 + 1,
                        label,
                        this._col(focus ? 'text' : 'textDisabled', alpha),
                        fo,
                    );
                }

                if (win.closable) {
                    const bx = win.x + win.w - 26,
                        by = tbY + tbH / 2;
                    // s.hoveredWindow === win keeps the hover (and the press) from
                    // firing when this window's close button is overlapped by another
                    const hov =
                        mo.x >= bx &&
                        mo.x < bx + 18 &&
                        mo.y >= by - 7 &&
                        mo.y < by + 7 &&
                        s.disabledCount === 0 &&
                        !s.appBarGrab &&
                        s.hoveredWindow === win &&
                        !this._popupAtPoint(mo.x, mo.y);
                    if (hov) {
                        const c = this._col('text', alpha);
                        if (s.drag && s.drag.win === win && s.drag.type === 'closebtn') {
                            this.renderer.fillRoundedRect(
                                bx - 3,
                                by - 9,
                                21,
                                18,
                                4,
                                withAlpha(this._col('error', alpha), 0.35),
                            );
                        }
                        this.renderer.line(bx, by - 4, bx + 8, by + 4, c, 1.4);
                        this.renderer.line(bx + 8, by - 4, bx, by + 4, c, 1.4);
                        if (this.isMouseClicked(0) && s.activeId === 0) {
                            s.drag = {
                                type: 'closebtn',
                                win,
                                button: 0,
                                rect: { x: bx - 3, y: by - 9, w: 21, h: 18 },
                            };
                            s.activeId = -1;
                        }
                    } else {
                        this.renderer.line(
                            bx,
                            by - 4,
                            bx + 8,
                            by + 4,
                            this._col('textDisabled', alpha),
                            1.4,
                        );
                        this.renderer.line(
                            bx + 8,
                            by - 4,
                            bx,
                            by + 4,
                            this._col('textDisabled', alpha),
                            1.4,
                        );
                    }
                }

                // title bar hover: move cursor (only for the topmost window under the mouse)
                if (
                    s.hoveredWindow === win &&
                    win.movable &&
                    this.flags.windowMove &&
                    s.disabledCount === 0 &&
                    mo.x >= win.x &&
                    mo.x < win.x + win.w &&
                    mo.y >= tbY &&
                    mo.y < tbY + tbH
                ) {
                    const inClose =
                        win.closable && mo.x >= win.x + win.w - 28 && mo.x <= win.x + win.w - 6;
                    if (!inClose) this._setCursor('move', 1);
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
                    this._winResizeEdgeAt(win, mo.x, mo.y) === 3;
                const gc = gripHot
                    ? withAlpha(this._col('sliderGrab', alpha), 255)
                    : withAlpha(this._col('border', alpha), 217);
                this.renderer.line(gx - s, gy - 2, gx - 2, gy - s, gc, gripHot ? 2 : 1.2);
                this.renderer.line(gx - s - 6, gy - 2, gx - 2, gy - s - 6, gc, gripHot ? 2 : 1.2);
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
                    this._col('sliderGrab', alpha),
                    Math.round(230 * rb.t * alpha),
                );
                const lineC = withAlpha(this._col('border', alpha), Math.round(140 * rb.t * alpha));
                const bar = (x, y, w, h) => {
                    this.renderer.fillRoundedRect(x, y, w, h, 2, fill);
                    this.renderer.strokeRoundedRect(x + 0.5, y + 0.5, w - 1, h - 1, 2, lineC, 1);
                };
                if (rb.sides & 2) bar(gx - bw / 2, cyV - vLen / 2, bw, vLen); // right
                if (rb.sides & 8) bar(win.x - bw / 2, cyV - vLen / 2, bw, vLen); // left
                if (rb.sides & 1) bar(cxH - hLen / 2, gy - bw / 2, hLen, bw); // bottom
                if (rb.sides & 4) bar(cxH - hLen / 2, win.y - bw / 2, hLen, bw); // top
            }

            if (win.menuH > 0) {
                const mbY = win.y + win.titleH;
                this.renderer.fillRect(win.x, mbY, win.w, win.menuH, this._col('menubarBg', alpha));
                this.renderer.line(
                    win.x + 1,
                    mbY + win.menuH - 0.5,
                    win.x + win.w - 1,
                    mbY + win.menuH - 0.5,
                    withAlpha(this._col('border', alpha), 0.5),
                    1,
                );
                s.menuBar = {
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
            if (!win.noClip) this.renderer.pushClip(win.x, contentY, win.w, contentH);

            const sbv = win.hadScrollV ? this._var('scrollbarSize') : 0;
            const sbh = win.hadScrollH ? this._var('scrollbarSize') : 0;

            // resolve the scroll target before layout so this frame's positions
            // already reflect any wheel/scrollbar delta from beginFrame
            if (this.flags.animations) {
                win.scrollX = lerp(win.scrollX, win.scrollTargetX, clamp(s.dt * 18, 0, 1));
                win.scrollY = lerp(win.scrollY, win.scrollTargetY, clamp(s.dt * 18, 0, 1));
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

            if (!win.noScrollbar) {
                s.scrollStack.push({
                    win,
                    rect: {
                        x: win.x,
                        y: win.y + win.titleH,
                        w: win.w,
                        h: win.h - win.titleH,
                    },
                    frame: s.frameId,
                });
            }

            if (win.modal) s.modalWin = win;
            s.currentWindow = win;
            return true;
        }

        endWindow() {
            const s = this.state;
            const win = s.currentWindow;
            if (!win) return;
            const L = s.layout;

            win.contentW = L.contentRight;
            win.contentH = Math.max(L.y, 1);
            const visW = win.visibleContentW;
            const visH = win.visibleContentH;
            win.maxScrollX = win.allowScrollX ? Math.max(0, win.contentW + win.padX - visW) : 0;
            win.maxScrollY = Math.max(0, win.contentH + win.padY - visH);
            win.hadScrollV = win.maxScrollY > 0 && !win.noScrollbar && !win.autoResize;
            win.hadScrollH =
                win.maxScrollX > 0 && win.allowScrollX && !win.noScrollbar && !win.autoResize;

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

            if (s.treeLines.length) {
                const bottom = L.origin.y + L.y - L.scroll.y;
                for (const tl of s.treeLines) {
                    this.renderer.line(
                        tl.x + 0.5,
                        tl.y0 + 0.5,
                        tl.x + 0.5,
                        Math.max(tl.y0 + 4, bottom),
                        withAlpha(this._col('border'), 0.7),
                        1,
                    );
                }
            }

            if (!win.noScrollbar) {
                if (win.maxScrollY > 0) {
                    this._drawScrollBar(
                        win,
                        'v',
                        win.x + win.w - this._var('scrollbarSize') + 1,
                        win.y + win.titleH + 1,
                        win.h - win.titleH - 2,
                        this._var('scrollbarSize'),
                        win.contentH + win.padY,
                        visH,
                    );
                }
                if (win.maxScrollX > 0) {
                    this._drawScrollBar(
                        win,
                        'h',
                        win.x + 1,
                        win.y + win.h - this._var('scrollbarSize') + 1,
                        win.w - 2,
                        this._var('scrollbarSize'),
                        win.contentW + win.padX,
                        visW,
                    );
                }
            }

            if (!win.noClip) this.renderer.popClip();
            this._popStyleScope();
            this.popId();
            s.currentWindow = null;
        }

        _newLayout(container, ox, oy, availW, availH) {
            const L = {
                container,
                origin: { x: ox, y: oy },
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
                scroll: { x: container.scrollX || 0, y: container.scrollY || 0 },
                avail: { w: availW, h: availH },
                contentRight: 0,
                itemCount: 0,
            };
            this.state.layout = L;
            return L;
        }

        _drawScrollBar(win, axis, trackX, trackY, trackLen, trackThick, content, visible) {
            if (content <= visible + 0.5) return;
            const s = this.state;
            const sb = this._var('scrollbarSize');
            const rb = this._var('scrollbarRounding');
            const isV = axis === 'v';
            const range = content - visible;
            const grabLen = Math.max(this._var('grabMinSize'), (visible / content) * trackLen);
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
                    this._col('scrollbarBg'),
                );
            else
                this.renderer.fillRoundedRect(
                    trackX + 1,
                    trackY + 1,
                    trackLen - 2,
                    sb - 2,
                    rb,
                    this._col('scrollbarBg'),
                );

            const mo = s.mouse;
            const hov = pointInRect(mo.x, mo.y, grabRect);
            const dragging = s.drag && s.drag.type === 'scroll-' + axis && s.drag.win === win;
            const grabColor = dragging
                ? this._col('scrollbarGrabActive')
                : hov
                  ? this._col('scrollbarGrabHovered')
                  : this._col('scrollbarGrab');
            this.renderer.fillRoundedRect(
                grabRect.x,
                grabRect.y,
                grabRect.w,
                grabRect.h,
                rb,
                grabColor,
            );

            const trackRect = isV
                ? { x: trackX + 1, y: trackY + 1, w: sb - 2, h: trackLen - 2 }
                : { x: trackX + 1, y: trackY + 1, w: trackLen - 2, h: sb - 2 };
            // the corner grip zone takes click priority over the scrollbar
            if (
                this.isMouseClicked(0) &&
                this._canReceiveInput(win) &&
                s.hoveredWindow === (win.owner || win) &&
                !this._popupAtPoint(mo.x, mo.y) &&
                pointInRect(mo.x, mo.y, trackRect) &&
                !pointInRect(mo.x, mo.y, this._winGripRect(win))
            ) {
                const along = isV ? mo.y : mo.x;
                const grabCenter = grabStart + grabLen / 2;
                s.drag = {
                    type: 'scroll-' + axis,
                    win,
                    button: 0,
                    grabOffset: along - grabCenter,
                    grabLen,
                    range,
                    trackLen,
                };
                s.activeId = -1;
                if (!hov) {
                    const t = clamp(
                        (along - trackY - grabLen / 2) / Math.max(1, trackLen - grabLen),
                        0,
                        1,
                    );
                    win['scrollTarget' + (isV ? 'Y' : 'X')] = t * range;
                }
            }
            if (s.drag && s.drag.type === 'scroll-' + axis && s.drag.win === win) {
                if (this.isMouseDown(0)) {
                    const d = s.drag;
                    const along = isV ? mo.y : mo.x;
                    const t = clamp(
                        (along - d.grabOffset - trackY) / Math.max(1, trackLen - grabLen),
                        0,
                        1,
                    );
                    win['scrollTarget' + (isV ? 'Y' : 'X')] = t * range;
                } else {
                    s.drag = null;
                    s.activeId = 0;
                }
            }
        }

        /* ---------------------------- child regions ------------------------ */

        beginChild(label, opts) {
            opts = opts || {};
            const s = this.state;
            const parent = s.currentWindow;
            if (!parent) return false;
            const ids = this._id(String(label == null ? '##child' : label));
            const key = '\x01child\x01' + ids.stateKey;
            let win = s.windows.get(key);
            if (!win) {
                win = new Window(key, 'child');
                s.windows.set(key, win);
            }
            win.owner = parent.owner;
            win.open = true;

            const avail = this.getRegionAvail();
            const pos = this._nextPos();

            let w = opts.w == null ? 0 : opts.w;
            let h = opts.h == null ? 0 : opts.h;
            if (w === 0) w = avail.w;
            else if (w < 0) w = avail.w + w;
            if (h === 0) h = avail.h;
            else if (h < 0) h = avail.h + h;
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

            win.drawnFrame = s.frameId;
            this.pushId(ids.itemId);

            // draw child background
            const cr = this._var('childRounding');
            this.renderer.fillRoundedRect(win.x, win.y, win.w, win.h, cr, this._col('childBg'));
            if (opts.border !== false && this._var('childBorder') > 0) {
                this.renderer.strokeRoundedRect(
                    win.x + 0.5,
                    win.y + 0.5,
                    win.w - 1,
                    win.h - 1,
                    cr,
                    this._col('border'),
                    1,
                );
            }

            const cw = win.w - win.padX * 2;
            const ch = win.h - win.padY * 2;
            if (!win.noClip) this.renderer.pushClip(win.x, win.y, win.w, win.h);

            // resolve the scroll target before layout (endChild recomputes
            // maxScroll from the fresh content and clamps again)
            if (this.flags.animations) {
                win.scrollX = lerp(win.scrollX, win.scrollTargetX, clamp(s.dt * 18, 0, 1));
                win.scrollY = lerp(win.scrollY, win.scrollTargetY, clamp(s.dt * 18, 0, 1));
            } else {
                win.scrollX = win.scrollTargetX;
                win.scrollY = win.scrollTargetY;
            }
            win.scrollY = clamp(win.scrollY, 0, win.maxScrollY);
            win.scrollX = clamp(win.scrollX, 0, win.maxScrollX);

            const L0 = s.layout;
            this._newLayout(win, win.x + win.padX, win.y + win.padY, cw, ch);
            win.visibleContentW = cw;
            win.visibleContentH = ch;
            // fill (no advance) only when the child takes the WHOLE remaining
            // region — the default h=0 case. Smaller children advance normally.
            win._childFillH = Math.abs(h - avail.h) < 0.01;

            if (!win.noScrollbar) {
                s.scrollStack.push({
                    win,
                    rect: { x: win.x, y: win.y, w: win.w, h: win.h },
                    frame: s.frameId,
                });
            }
            s.savedLayout.push(L0);
            s._childReturn = { win, h };
            s.currentWindow = win;
            return true;
        }

        endChild() {
            const s = this.state;
            const win = s.currentWindow;
            if (!win) return;
            const L = s.layout;

            win.contentW = L.contentRight;
            win.contentH = Math.max(L.y, 1);
            const visH = win.visibleContentH;
            const visW = win.visibleContentW;
            win.maxScrollY = Math.max(0, win.contentH + win.padY - visH);
            win.maxScrollX = win.allowScrollX ? Math.max(0, win.contentW + win.padX - visW) : 0;
            // re-clamp after the fresh maxScroll (scroll was resolved in beginChild)
            win.scrollY = clamp(win.scrollY, 0, win.maxScrollY);
            win.scrollX = clamp(win.scrollX, 0, win.maxScrollX);
            win.hadScrollV = win.maxScrollY > 0 && !win.noScrollbar;

            if (win.maxScrollY > 0) {
                this._drawScrollBar(
                    win,
                    'v',
                    win.x + win.w - this._var('scrollbarSize') + 1,
                    win.y + 1,
                    win.h - 2,
                    this._var('scrollbarSize'),
                    win.contentH + win.padY,
                    visH,
                );
            }
            if (!win.noClip) this.renderer.popClip();
            this.popId();
            const prev = s.savedLayout.pop();
            s.layout = prev;
            const info = s._childReturn;
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
            s.currentWindow = prev ? prev.container : null;
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
            const s = this.state;
            if (s.popups.has(id)) return s.popups.get(id);
            const p = {
                id,
                kind: 'popup',
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
                    (s.currentWindow
                        ? s.currentWindow.owner || s.currentWindow
                        : s.hoveredWindow) ||
                    null,
                frame: s.frameId,
            };
            s.popups.set(id, p);
            s.popupList.push(p);
            return p;
        }
        openPopup(id, anchor, opts) {
            opts = opts || {};
            return this._openPopup(
                id,
                anchor,
                { type: opts.kind || 'custom' },
                opts.sourceId || 0,
                opts.owner || null,
            );
        }
        closePopup(id) {
            const p = this.state.popups.get(id);
            if (p) p.open = false;
        }
        isPopupOpen(id) {
            const p = this.state.popups.get(id);
            return !!(p && p.open);
        }

        beginPopup(id) {
            const s = this.state;
            const p = s.popups.get(id);
            if (!p || !p.open || s.popupLayoutActive) return false;
            const isTip = p.data.type === 'tooltip';
            if (isTip) {
                p.ox = s.mouse.x + 14;
                p.oy = s.mouse.y + 18;
            }
            if (p.w <= 0) {
                p.x = p.ox;
                p.y = p.oy;
                p.w = 150;
                p.h = 80;
            } // first-frame estimate
            this.renderer.setLayer(isTip ? Layers.Foreground : Layers.GUI);
            const bgc = isTip ? this._col('tooltipBg') : this._col('popupBg');
            this.renderer.fillRoundedRect(p.x, p.y, p.w, p.h, this._var('popupRounding'), bgc);
            this.renderer.strokeRoundedRect(
                p.x + 0.5,
                p.y + 0.5,
                p.w - 1,
                p.h - 1,
                this._var('popupRounding'),
                this._col('border'),
                this._var('popupBorder'),
            );
            this.renderer.pushClip(p.x + 1, p.y + 1, Math.max(1, p.w - 2), Math.max(1, p.h - 2));
            s.savedLayout.push(s.layout);
            this._newLayout(p, p.x + 8, p.y + 6, 4000, 4000);
            s.popupLayoutActive = p;
            s.currentWindow = p;
            return true;
        }
        /* Convert a declarative menu config (setAppMenuBar) into the row shape
         * that _drawMenuPopup renders. Nested `items` become data-driven submenus. */
        _appMenuRows(list, idSeed) {
            const rows = [];
            for (const m of list || []) {
                if (!m) continue;
                if (m.sep || m.type === 'sep') {
                    rows.push({ type: 'sep' });
                    continue;
                }
                const disabled = typeof m.disabled === 'function' ? m.disabled() : !!m.disabled;
                const label = String(m.label != null ? m.label : '');
                if (m.items && m.items.length) {
                    rows.push({
                        type: 'submenu',
                        label,
                        subId: '##appsub' + fnv1a(idSeed + '\x01' + label),
                        shortcut: m.shortcut || '',
                        disabled,
                        items: m.items,
                    });
                } else {
                    rows.push({
                        type: 'item',
                        label,
                        shortcut: m.shortcut || '',
                        selected: typeof m.selected === 'function' ? m.selected() : !!m.selected,
                        disabled,
                        onActivated: typeof m.onActivated === 'function' ? m.onActivated : null,
                    });
                }
            }
            return rows;
        }

        /* Draw the app menu bar strip (above all windows). Section geometry is
         * computed in beginFrame into state.appMenuSections; dropdowns are the
         * normal menu popups, drawn by the popup pass after this strip. */
        _drawAppMenuBar() {
            const s = this.state;
            const am = s.appMenu;
            if (!am || !s.appBarRect) return;
            const R = s.appBarRect;
            const fo = this._fo();
            const lineH = this._lineH();
            this.renderer.setLayer(Layers.GUI);
            this.renderer.fillRoundedRect(R.x, R.y, R.w, R.h, 0, this._col('menubarBg'));
            const bc = this._col('border');
            if (am.pos === 'top')
                this.renderer.line(R.x, R.y + R.h - 0.5, R.x + R.w, R.y + R.h - 0.5, bc, 1);
            else if (am.pos === 'bottom')
                this.renderer.line(R.x, R.y + 0.5, R.x + R.w, R.y + 0.5, bc, 1);
            else if (am.pos === 'left')
                this.renderer.line(R.x + R.w - 0.5, R.y, R.x + R.w - 0.5, R.y + R.h, bc, 1);
            else this.renderer.line(R.x + 0.5, R.y, R.x + 0.5, R.y + R.h, bc, 1);
            for (const sec of s.appMenuSections) {
                const hov =
                    s.mouse.x >= sec.rect.x &&
                    s.mouse.x < sec.rect.x + sec.rect.w &&
                    s.mouse.y >= sec.rect.y &&
                    s.mouse.y < sec.rect.y + sec.rect.h;
                if (sec.open || hov) {
                    this.renderer.fillRoundedRect(
                        sec.rect.x,
                        sec.rect.y,
                        sec.rect.w,
                        sec.rect.h,
                        4,
                        this._col(sec.open ? 'headerActive' : 'headerHovered'),
                    );
                }
                this._drawText(
                    sec.rect.x + 9,
                    sec.rect.y + (sec.rect.h - lineH) / 2 + 1,
                    sec.label,
                    this._col('text'),
                    fo,
                );
            }
        }

        endPopup() {
            const s = this.state;
            const p = s.popupLayoutActive;
            if (!p) return;
            const L = s.layout;
            const w = Math.max(40, L.contentRight + 16);
            const h = Math.max(30, L.y + 12);
            p.x = clamp(p.ox, 4, Math.max(4, s.displayW - w - 4));
            p.y = clamp(p.oy, 4, Math.max(4, s.displayH - h - 4));
            p.w = w;
            p.h = h;
            this.renderer.popClip();
            const prev = s.savedLayout.pop();
            s.layout = prev;
            s.popupLayoutActive = null;
            s.currentWindow = prev ? prev.container : null;
        }

        beginPopupContextWindow(id) {
            const s = this.state;
            const win = s.currentWindow;
            if (win && win.kind === 'window' && !s.popups.has(id)) {
                const mo = s.mouse;
                const contentRect = {
                    x: win.x,
                    y: win.y + win.titleH,
                    w: win.w,
                    h: win.h - win.titleH,
                };
                if (
                    this.isMouseClicked(1) &&
                    s.activeId === 0 &&
                    !s.drag &&
                    s.hoveredWindow === (win.owner || win) &&
                    pointInRect(mo.x, mo.y, contentRect)
                ) {
                    this._openPopup(
                        id,
                        { x: mo.x, y: mo.y },
                        { type: 'custom' },
                        0,
                        win.owner || win,
                    );
                }
            }
            return this.beginPopup(id);
        }
        beginPopupContextItem(id) {
            const s = this.state;
            const it = s.lastItem;
            if (
                it &&
                !s.popups.has(id) &&
                this.isMouseClicked(1) &&
                it.hovered &&
                s.activeId === 0 &&
                !s.drag
            ) {
                this._openPopup(
                    id,
                    { x: s.mouse.x, y: s.mouse.y + 4 },
                    { type: 'custom' },
                    it.itemId,
                    it.win ? it.win.owner || it.win : null,
                );
            }
            return this.beginPopup(id);
        }

        _popupPass() {
            const s = this.state;

            // dismiss on outside click (popups opened by this very click are exempt:
            // their rect is not laid out yet and the click point is the source)
            if (this.isMouseClicked(0) && s.popupList.length) {
                const mo = s.mouse;
                let inside = false;
                for (const p of s.popupList) {
                    if (!p.open || p.frame === s.frameId) continue;
                    if (p.w > 0 && pointInRect(mo.x, mo.y, { x: p.x, y: p.y, w: p.w, h: p.h }))
                        inside = true;
                }
                if (!inside) {
                    for (const p of s.popupList) {
                        if (p.open && p.frame !== s.frameId && p.sourceId !== s.clickedItemId)
                            p.open = false;
                    }
                }
            }
            if (s.popupList.length) {
                s.popupList = s.popupList.filter((p) => p.open);
                for (const [k, p] of s.popups) if (!p.open) s.popups.delete(k);
            }

            // app menu bar strip (under its dropdowns, above all windows)
            if (s.appMenu) this._drawAppMenuBar();

            // draw system popups (dynamic length: submenus may open mid-pass)
            this.renderer.setLayer(Layers.GUI);
            for (let i = 0; i < s.popupList.length; i++) {
                const p = s.popupList[i];
                if (!p.open) continue;
                if (p.data.type === 'menu') this._drawMenuPopup(p);
                else if (p.data.type === 'combo') this._drawComboPopup(p);
                else if (p.data.type === 'value') this._drawValuePopup(p);
            }
        }

        _popupLayout(p, x, y, w, h) {
            const s = this.state;
            const old = s.layout;
            const prevClaim = s.hoveredWindow;
            s.savedLayout.push(old);
            this._newLayout(p, x, y, w, h);
            if (p.owner) s.hoveredWindow = p.owner;
            return prevClaim;
        }
        _endPopupLayout(p, prevClaim) {
            const s = this.state;
            const prev = s.savedLayout.pop();
            s.layout = prev;
            s.hoveredWindow = prevClaim;
        }

        _drawMenuPopup(p) {
            const s = this.state;
            const rows = p.data.items || [];
            const fo = this._fo();
            const lineH = this._lineH();
            const rowH = lineH + 10;
            const pad = 6;
            let w = p.data.width || 140;
            for (const r of rows) {
                if (r.type === 'sep') continue;
                const lw = this._measure(r.label, fo).w;
                const sw = r.shortcut ? this._measure(r.shortcut, fo).w : 0;
                w = Math.max(
                    w,
                    lw + sw + (r.type === 'submenu' ? 20 : 0) + (r.selected ? 20 : 0) + 26,
                );
            }
            w = clamp(w, 120, 340);
            const h = rows.length * rowH + pad * 2;
            let x = clamp(p.ox, 4, Math.max(4, s.displayW - w - 4));
            let y = p.oy;
            if (y + h > s.displayH - 4) y = Math.max(4, p.oy - h - 4);
            p.x = x;
            p.y = y;
            p.w = w;
            p.h = h;

            this.renderer.fillRoundedRect(
                x,
                y,
                w,
                h,
                this._var('popupRounding'),
                this._col('popupBg'),
            );
            this.renderer.strokeRoundedRect(
                x + 0.5,
                y + 0.5,
                w - 1,
                h - 1,
                this._var('popupRounding'),
                this._col('border'),
                this._var('popupBorder'),
            );
            this.renderer.pushClip(x + 1, y + 1, w - 2, h - 2);
            const prevClaim = this._popupLayout(p, x + pad, y + pad, w - pad * 2, h - pad * 2);

            for (let i = 0; i < rows.length; i++) {
                const r = rows[i];
                const ry = y + pad + i * rowH;
                if (r.type === 'sep') {
                    this.renderer.line(
                        x + 4,
                        ry + rowH / 2 + 0.5,
                        x + w - 4,
                        ry + rowH / 2 + 0.5,
                        this._col('separator'),
                        1,
                    );
                    continue;
                }
                const itemId = hash3(fnv1a(p.id), 0x9e37, i);
                const it = this._item(x + 4, ry, w - 8, rowH - 2, itemId);
                if (it.hovered && this.isMouseClicked(0) && !r.disabled) {
                    if (typeof r.onActivated === 'function') r.onActivated();
                    for (const q of s.popupList) q.open = false;
                }
                if (it.visible) {
                    if (it.hovered && !r.disabled)
                        this.renderer.fillRoundedRect(
                            x + 4,
                            ry,
                            w - 8,
                            rowH - 2,
                            4,
                            this._col('headerHovered'),
                        );
                    else if (it.active && !r.disabled)
                        this.renderer.fillRoundedRect(
                            x + 4,
                            ry,
                            w - 8,
                            rowH - 2,
                            4,
                            this._col('headerActive'),
                        );
                    const tx = x + 10 + (r.selected ? 16 : 0);
                    if (r.selected) {
                        const cx = x + 12,
                            cy = ry + (rowH - 2) / 2;
                        this.renderer.polyline(
                            [cx - 3, cy, cx - 1, cy + 3, cx + 4, cy - 3],
                            this._col('checkMark'),
                            1.6,
                        );
                    }
                    const tc = r.disabled ? this._col('textDisabled') : this._col('text');
                    this._drawText(tx, ry + (rowH - 2 - lineH) / 2, r.label, tc, fo);
                    if (r.shortcut) {
                        const m = this._measure(r.shortcut, fo);
                        this._drawText(
                            x + w - 10 - m.w,
                            ry + (rowH - 2 - lineH) / 2,
                            r.shortcut,
                            this._col('textDisabled'),
                            fo,
                        );
                    }
                    if (r.type === 'submenu') {
                        const ax = x + w - 16,
                            ay = ry + (rowH - 2) / 2;
                        this.renderer.fillPolygon(
                            [ax, ay - 4, ax, ay + 4, ax + 5, ay],
                            this._col('textDisabled'),
                        );
                    }
                }
                if (r.type === 'submenu' && it.hovered && !r.disabled && !this.isMouseClicked(0)) {
                    const sub = s.popups.get(r.subId);
                    if (!sub || !sub.open) {
                        this._openPopup(
                            r.subId,
                            { x: x + w - 8, y: ry + 2 },
                            { type: 'menu', items: [] },
                            itemId,
                            p.owner,
                        );
                    }
                    // fully data-driven submenus (app menu bar): fill the rows once
                    const sub2 = s.popups.get(r.subId);
                    if (sub2 && sub2.open && sub2.data.items.length === 0 && r.items) {
                        sub2.data.items.push(...this._appMenuRows(r.items, r.subId));
                    }
                }
            }
            this._endPopupLayout(p, prevClaim);
            this.renderer.popClip();
        }

        _drawComboPopup(p) {
            const s = this.state;
            const items = p.data.items || [];
            const fo = this._fo();
            const lineH = this._lineH();
            const rowH = lineH + 10;
            const pad = 6;
            const maxVis = p.data.maxVisible || 8;
            const visRows = Math.min(items.length, maxVis);
            const w = clamp(p.data.width || 160, 80, 400);
            const h = visRows * rowH + pad * 2;
            const x = clamp(p.ox, 4, Math.max(4, s.displayW - w - 4));
            const y = clamp(p.oy, 4, Math.max(4, s.displayH - h - 4));
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
            if (!s.textConsumed && s.textInput && p.open) {
                s.textConsumed = true;
                p.typeChar = (p.typeChar || '') + s.textInput[0].toLowerCase();
                p.typeTime = s.now;
                for (let i = 0; i < items.length; i++) {
                    if (String(items[i]).toLowerCase().indexOf(p.typeChar) === 0) {
                        p.hi = i;
                        break;
                    }
                }
            }
            if (p.typeChar && s.now - p.typeTime > 800) {
                p.typeChar = null;
                p.hi = -1;
            }

            this.renderer.fillRoundedRect(
                x,
                y,
                w,
                h,
                this._var('popupRounding'),
                this._col('popupBg'),
            );
            this.renderer.strokeRoundedRect(
                x + 0.5,
                y + 0.5,
                w - 1,
                h - 1,
                this._var('popupRounding'),
                this._col('border'),
                this._var('popupBorder'),
            );
            this.renderer.pushClip(x + 1, y + 1, w - 2, h - 2);
            const prevClaim = this._popupLayout(p, x + pad, y + pad, w - pad * 2, h - pad * 2);

            const cur = p.data.value();
            const first = Math.floor(p.scrollY / rowH);
            for (let i = first; i < Math.min(items.length, first + visRows); i++) {
                const ry = y + pad + (i - first) * rowH;
                const itemId = hash3(fnv1a(p.id), 0x6c0b, i);
                const it = this._item(x + pad, ry, w - pad * 2, rowH - 2, itemId);
                if (it.hovered) p.hi = i;
                if (it.hovered && this.isMouseClicked(0)) {
                    p.data.set(i);
                    p.open = false;
                }
                if (it.visible) {
                    if (i === cur)
                        this.renderer.fillRoundedRect(
                            x + pad,
                            ry,
                            w - pad * 2,
                            rowH - 2,
                            4,
                            this._col('header'),
                        );
                    else if (it.hovered)
                        this.renderer.fillRoundedRect(
                            x + pad,
                            ry,
                            w - pad * 2,
                            rowH - 2,
                            4,
                            this._col('headerHovered'),
                        );
                    if (i === cur) {
                        const cx = x + pad + 8,
                            cy = ry + (rowH - 2) / 2;
                        this.renderer.polyline(
                            [cx - 3, cy, cx - 1, cy + 3, cx + 4, cy - 3],
                            this._col('checkMark'),
                            1.6,
                        );
                    }
                    let str = String(items[i]);
                    const maxW = w - pad * 2 - (i === cur ? 22 : 8);
                    while (str.length > 2 && this._measure(str + '…', fo).w > maxW)
                        str = str.slice(0, -1);
                    if (str !== String(items[i])) str += '…';
                    this._drawText(
                        x + pad + (i === cur ? 20 : 8),
                        ry + (rowH - 2 - lineH) / 2,
                        str,
                        this._col('text'),
                        fo,
                    );
                }
            }
            // enter selects the highlighted row
            if (p.hi >= 0 && this.isKeyPressed('enter')) {
                p.data.set(p.hi);
                p.open = false;
            }
            this._endPopupLayout(p, prevClaim);
            this.renderer.popClip();

            if (p.maxScroll > 0) {
                const sb = this._var('scrollbarSize');
                const grabH = Math.max(
                    this._var('grabMinSize'),
                    (visRows / items.length) * (h - 2),
                );
                const grabY = y + 1 + (p.scrollY / p.maxScroll) * (h - 2 - grabH);
                this.renderer.fillRoundedRect(
                    x + w - sb + 1,
                    y + 1,
                    sb - 2,
                    h - 2,
                    this._var('scrollbarRounding'),
                    this._col('scrollbarBg'),
                );
                this.renderer.fillRoundedRect(
                    x + w - sb + 2,
                    grabY,
                    sb - 4,
                    grabH,
                    this._var('scrollbarRounding'),
                    this._col('scrollbarGrab'),
                );
            }
        }

        _drawValuePopup(p) {
            const s = this.state;
            const d = p.data;
            const fo = this._fo();
            const lineH = this._lineH();
            const pad = 8;
            const fieldH = lineH + 10;
            const labelH = d.label ? lineH + 4 : 0;
            const w = 150;
            const h = pad * 2 + labelH + fieldH;
            const x = clamp(p.ox, 4, Math.max(4, s.displayW - w - 4));
            const y = clamp(p.oy, 4, Math.max(4, s.displayH - h - 4));
            p.x = x;
            p.y = y;
            p.w = w;
            p.h = h;

            this.renderer.fillRoundedRect(
                x,
                y,
                w,
                h,
                this._var('popupRounding'),
                this._col('popupBg'),
            );
            this.renderer.strokeRoundedRect(
                x + 0.5,
                y + 0.5,
                w - 1,
                h - 1,
                this._var('popupRounding'),
                this._col('border'),
                this._var('popupBorder'),
            );
            this.renderer.pushClip(x + 1, y + 1, w - 2, h - 2);
            const prevClaim = this._popupLayout(p, x + pad, y + pad, w - pad * 2, h - pad * 2);

            if (d.label) this._drawText(x + pad, y + pad, d.label, this._col('textDisabled'), fo);

            const fy = y + pad + labelH;
            const fw = w - pad * 2;
            const itemId = hash3(fnv1a(p.id), 0x745a, 1);
            const it = this._item(x + pad, fy, fw, fieldH, itemId);
            const step = (d.max - d.min) / 100;
            const k = (t) => this.isKeyPressed(t);

            if (it.hovered && this.isMouseClicked(0)) {
                s.focusedId = itemId;
                s.activeId = itemId;
                d.editing = true;
                d.buf = ''; // start with an empty buffer; typing replaces the value
                d.caret = 0;
            }
            if (d.editing) {
                if (k('enter')) {
                    const v = parseFloat(d.buf);
                    if (isFinite(v)) d.set(clamp(v, d.min, d.max));
                    p.open = false;
                } else if (k('escape')) {
                    p.open = false;
                    d.editing = false;
                } else if (k('left')) d.caret = Math.max(0, d.caret - 1);
                else if (k('right')) d.caret = Math.min(d.buf.length, d.caret + 1);
                else if (k('backspace') && d.caret > 0) {
                    d.buf = d.buf.slice(0, d.caret - 1) + d.buf.slice(d.caret);
                    d.caret = d.caret - 1;
                } else if ((k('up') || k('right')) && this.ctrl) {
                    d.set(clamp(d.value() + step * 10, d.min, d.max));
                    d.buf = fmtVal(d.value(), d.fmt || '%.3f');
                    d.caret = d.buf.length;
                } else if ((k('down') || k('left')) && this.ctrl) {
                    d.set(clamp(d.value() - step * 10, d.min, d.max));
                    d.buf = fmtVal(d.value(), d.fmt || '%.3f');
                    d.caret = d.buf.length;
                } else if (!s.textConsumed && s.textInput) {
                    s.textConsumed = true;
                    const t = s.textInput.replace(/[^0-9.eE+-]/g, '');
                    if (t) {
                        d.buf += t;
                        d.caret = d.buf.length;
                    }
                }
                if (s.focusedId !== itemId && s.activeId !== itemId && !it.hovered)
                    d.editing = false;
            }
            if (it.visible) {
                this._drawFrame(x + pad, fy, fw, fieldH, it);
                const str = d.editing ? d.buf : fmtVal(d.value(), d.fmt || '%.3f');
                const m = this._measure(str, fo);
                this._drawText(
                    x + pad + (fw - m.w) / 2,
                    fy + (fieldH - lineH) / 2 + 1,
                    str,
                    this._col('text'),
                    fo,
                );
                if (d.editing) {
                    const cx = this._measure(d.buf.slice(0, d.caret), fo).w;
                    this.renderer.line(
                        x + pad + (fw - this._measure(d.buf, fo).w) / 2 + cx,
                        fy + 2,
                        x + pad + (fw - this._measure(d.buf, fo).w) / 2 + cx,
                        fy + fieldH - 2,
                        this._col('text'),
                        1,
                    );
                }
            }
            this._endPopupLayout(p, prevClaim);
            this.renderer.popClip();
        }

        /* ---------------------------- tooltips ------------------------------ */

        setTooltip(text) {
            if (!this.flags.tooltips) return;
            const s = this.state;
            const it = s.lastItem;
            if (!it || !it.hovered || !it.enabled) return;
            if (s.tooltip && s.tooltip.id === it.itemId) return;
            s.tooltip = { id: it.itemId, text: String(text), since: s.now };
        }
        beginTooltip() {
            const s = this.state;
            if (!this.flags.tooltips) return false;
            const it = s.lastItem;
            if (!it || !it.hovered) return false;
            if (!s.tooltip || s.tooltip.id !== it.itemId)
                s.tooltip = { id: it.itemId, text: '', since: s.now };
            if (s.now - s.tooltip.since < this.flags.tooltipDelay) return false;
            if (!s.popups.has('##tooltip')) {
                this._openPopup(
                    '##tooltip',
                    { x: s.mouse.x + 14, y: s.mouse.y + 18 },
                    { type: 'tooltip' },
                    it.itemId,
                    it.win ? it.win.owner || it.win : s.hoveredWindow,
                );
            }
            return this.beginPopup('##tooltip');
        }
        endTooltip() {
            this.endPopup();
        }

        _tooltipPass() {
            const s = this.state;
            const tp = s.popups.get('##tooltip');
            if (tp && tp.open) {
                const it = s.items.get(tp.sourceId);
                if (!it || !it.hovered) tp.open = false;
            }
            if (!s.tooltip) return;
            const it = s.items.get(s.tooltip.id);
            if (!it || !it.hovered) {
                s.tooltip = null;
                return;
            }
            // only the topmost hovered element may own a tooltip: when windows
            // overlap, items behind the topmost window are not hovered, but guard
            // explicitly anyway (popup rows are exempt — they always float on top)
            if (it.win) {
                const top = it.win.owner || it.win;
                if (
                    (top.kind === 'window' || top.kind === 'child') &&
                    s.hoveredWindow &&
                    top !== s.hoveredWindow
                ) {
                    s.tooltip = null;
                    return;
                }
            }
            const age = s.now - s.tooltip.since;
            if (age < this.flags.tooltipDelay) return;
            const fo = this._fo();
            const maxW = 280;
            const lines = wrapText(s.tooltip.text, maxW, (t) => this._measure(t, fo));
            const pad = 8;
            let tw = 0;
            for (const l of lines) tw = Math.max(tw, this._measure(l, fo).w);
            const w = tw + pad * 2;
            const h = lines.length * this._lineH() + pad * 2;
            // pop up at the cursor, above it when there is room (else below),
            // clamped on-screen; drawn on the foreground layer (above all windows)
            const x = clamp(s.mouse.x + 14, 4, Math.max(4, s.displayW - w - 4));
            let y = s.mouse.y - h - 12;
            if (y < 4) y = s.mouse.y + 18;
            y = clamp(y, 4, Math.max(4, s.displayH - h - 4));
            const a = this.flags.animations
                ? clamp((age - this.flags.tooltipDelay) / 0.12, 0, 1)
                : 1;
            this.renderer.setLayer(Layers.Foreground);
            this.renderer.fillRoundedRect(
                x,
                y,
                w,
                h,
                this._var('popupRounding'),
                withAlpha(this._col('tooltipBg'), a),
            );
            this.renderer.strokeRoundedRect(
                x + 0.5,
                y + 0.5,
                w - 1,
                h - 1,
                this._var('popupRounding'),
                withAlpha(this._col('border'), a),
                1,
            );
            for (let i = 0; i < lines.length; i++) {
                this._drawText(
                    x + pad,
                    y + pad + i * this._lineH(),
                    lines[i],
                    withAlpha(this._col('text'), a),
                    fo,
                );
            }
        }

        /* ---------------------------- debug overlay ------------------------- */

        _drawDebugOverlay() {
            const s = this.state;
            const st = s.stats;
            const x = 8,
                y = 8,
                w = 220;
            const lines = [
                'Mim v' + VERSION,
                'FPS ' + (st.fps | 0) + '   (' + st.ms.toFixed(2) + ' ms)',
                'draw calls   ' + st.drawCalls,
                'items        ' + st.items,
                'windows      ' + st.windows,
                'states       ' + st.states,
                'mouse        ' + (s.mouse.x | 0) + ', ' + (s.mouse.y | 0),
                'active       ' + (s.activeId || '-') + '  hover ' + (s.hoveredId || '-'),
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
                this.renderer.drawText(x + 8, y + 7 + i * lh, lines[i], [222, 224, 230, 255], {
                    fontSize: fs,
                    fontId: this.style.font.id,
                });
            }
        }

        /* ---------------------------- state access -------------------------- */

        state(label) {
            const k = hashPair(this.state.idStackSeed, fnv1a(String(label == null ? '' : label)));
            const v = this.state.widgetStates.get(k);
            if (!v) return undefined;
            return v.value !== undefined ? v.value : v;
        }
        setState(label, value) {
            const k = hashPair(this.state.idStackSeed, fnv1a(String(label == null ? '' : label)));
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
            const s = this.state;
            const ids = this._id(label);
            const fo = this._fo();
            const fp = this._var('framePadding');
            const sp = this._var('itemSpacing');
            const lineH = this._lineH();
            const h = opts.h || lineH + fp[1] * 2;
            const lw = label ? this._measure(label, fo).w : 0;
            const pos = this._nextPos();
            const availW = this.getRegionAvail().w;
            let w = s.nextItemWidth > 0 ? s.nextItemWidth : opts.w || 0;
            s.nextItemWidth = 0;
            let labelAbove = false;
            let frameX = pos.x,
                frameY = pos.y;
            let rectY = pos.y,
                rectH = h;
            if (w <= 0) {
                if (lw > 0 && availW >= lw + sp[0] * 2 + 40) w = availW - lw - sp[0];
                else {
                    w = availW;
                    labelAbove = lw > 0;
                }
            }
            w = Math.max(20, w);
            if (labelAbove) {
                rectY = pos.y;
                rectH = h + lineH + 3;
                frameY = pos.y + lineH + 3;
            }
            const it = this._item(frameX, rectY, w, rectH, ids.itemId, {
                focusable: opts.focusable !== false,
            });
            const labelRect = labelAbove
                ? { x: frameX, y: pos.y, w: lw, h: lineH }
                : {
                      x: frameX + w + sp[0],
                      y: pos.y + (h - lineH) / 2,
                      w: lw,
                      h: lineH,
                  };
            this._advance(frameX, rectY, w, rectH);
            return { ids, it, x: frameX, y: frameY, w, h, labelRect, fo, fp, lineH };
        }

        _drawFrame(x, y, w, h, it) {
            const rr = this._var('frameRounding');
            const bg = !it.enabled
                ? this._col('frameBg')
                : it.active
                  ? this._col('frameBgActive')
                  : it.hovered
                    ? this._col('frameBgHovered')
                    : this._col('frameBg');
            this.renderer.fillRoundedRect(x, y, w, h, rr, bg);
            if (this._var('frameBorder') > 0) {
                this.renderer.strokeRoundedRect(
                    x + 0.5,
                    y + 0.5,
                    w - 1,
                    h - 1,
                    rr,
                    this._col('border'),
                    1,
                );
            }
        }
        _drawFocusRing(it) {
            if (this.state.focusedId !== it.itemId || !this.flags.keyboardNavigation) return;
            const rr = this._var('frameRounding') + 2;
            this.renderer.strokeRoundedRect(
                it.x - 1.5,
                it.y - 1.5,
                it.w + 3,
                it.h + 3,
                rr,
                this._col('focusRing'),
                1,
            );
        }

        _caretFromX(buf, mouse, textX, textW) {
            const fo = this._fo();
            const whole = this._measure(buf, fo).w;
            const rel = clamp(mouse - textX, 0, whole);
            let best = 0;
            for (let i = 0; i < buf.length; i++) {
                if (this._measure(buf.slice(0, i + 1), fo).w <= rel) best = i + 1;
                else break;
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

        text(str, color) {
            const pos = this._nextPos();
            const fo = this._fo();
            const m = this._measure(String(str), fo);
            const it = this._item(pos.x, pos.y, m.w, m.h, this._id(String(str)).itemId, {
                focusable: false,
            });
            if (it.visible) this._drawText(pos.x, pos.y, str, color || this._col('text'), fo);
            this._advance(pos.x, pos.y, m.w, m.h);
        }
        textColored(color, str) {
            this.text(str, color);
        }
        textWrapped(str, opts) {
            opts = opts || {};
            const pos = this._nextPos();
            const fo = this._fo();
            const lineH = this._lineH();
            const w = opts.maxWidth > 0 ? opts.maxWidth : this.getRegionAvail().w;
            const lines = wrapText(String(str), w, (t) => this._measure(t, fo));
            const h = lines.length * lineH;
            const it = this._item(pos.x, pos.y, w, h, this._id(String(str) + '##wrapped').itemId, {
                focusable: false,
            });
            if (it.visible) {
                for (let i = 0; i < lines.length; i++) {
                    this._drawText(
                        pos.x,
                        pos.y + i * lineH,
                        lines[i],
                        opts.color || this._col('text'),
                        fo,
                    );
                }
            }
            this._advance(pos.x, pos.y, w, h);
        }

        button(label, opts) {
            opts = opts || {};
            const fo = this._fo();
            const lineH = this._lineH();
            const fp = this._var('framePadding');
            const pos = this._nextPos();
            const tw = this._measure(label, fo).w;
            const w = opts.width > 0 ? opts.width : Math.max(24, tw + fp[0] * 2);
            const h = opts.height > 0 ? opts.height : lineH + fp[1] * 2;
            const it = this._item(pos.x, pos.y, w, h, this._id(label).itemId);
            const res = this._clickable(it);
            const kbd =
                this.flags.keyboardNavigation &&
                this.state.focusedId === it.itemId &&
                (this.isKeyPressed('enter') || this.isKeyPressed(' '));
            const clicked = res.clicked || kbd;
            if (clicked) this.state.changedId = it.itemId;
            if (it.visible) {
                this._drawFrame(pos.x, pos.y, w, h, it);
                const tc = it.enabled ? this._col('text') : this._col('textDisabled');
                this._drawText(pos.x + (w - tw) / 2, pos.y + (h - lineH) / 2 + 1, label, tc, fo);
            }
            this._drawFocusRing(it);
            this._advance(it.x, it.y, w, h);
            return clicked;
        }
        smallButton(label) {
            const fo = this._fo();
            const lineH = this._lineH();
            const pos = this._nextPos();
            const tw = this._measure(label, fo).w;
            const w = tw + 8;
            const h = lineH + 2;
            const it = this._item(pos.x, pos.y, w, h, this._id(label).itemId);
            const res = this._clickable(it);
            const kbd =
                this.flags.keyboardNavigation &&
                this.state.focusedId === it.itemId &&
                (this.isKeyPressed('enter') || this.isKeyPressed(' '));
            const clicked = res.clicked || kbd;
            if (it.visible) {
                this._drawFrame(pos.x, pos.y, w, h, it);
                const tc = it.enabled ? this._col('text') : this._col('textDisabled');
                this._drawText(pos.x + (w - tw) / 2, pos.y + (h - lineH) / 2 + 1, label, tc, fo);
            }
            this._drawFocusRing(it);
            this._advance(it.x, it.y, w, h);
            return clicked;
        }

        checkbox(label, value) {
            const s = this.state;
            const ids = this._id(label);
            const st = this._state(ids.stateKey);
            const stateful = value == null;
            if (stateful) value = !!st.value;
            const fo = this._fo();
            const lineH = this._lineH();
            const pos = this._nextPos();
            const box = Math.max(lineH, 16);
            const lw = this._measure(label, fo).w;
            const isp = this._var('itemInnerSpacing');
            const w = box + isp[0] + lw;
            const it = this._item(pos.x, pos.y, w, box, ids.itemId);
            const res = this._clickable(it);
            let changed = false;
            const kbd =
                this.flags.keyboardNavigation &&
                s.focusedId === it.itemId &&
                this.isKeyPressed(' ');
            if (res.clicked || kbd) {
                value = !value;
                changed = true;
            }
            if (stateful) st.value = value;
            if (changed) s.changedId = it.itemId;
            if (it.visible) {
                this._drawFrame(pos.x, pos.y, box, box, it);
                if (value) {
                    const bx = pos.x + box * 0.24,
                        by = pos.y + box * 0.54;
                    this.renderer.polyline(
                        [bx, by, bx + box * 0.16, by + box * 0.18, bx + box * 0.42, by - box * 0.2],
                        this._col('checkMark'),
                        2,
                    );
                }
                this._drawText(
                    pos.x + box + isp[0],
                    pos.y + (box - lineH) / 2 + 1,
                    label,
                    it.enabled ? this._col('text') : this._col('textDisabled'),
                    fo,
                );
            }
            this._drawFocusRing(it);
            this._advance(it.x, it.y, w, box);
            return value;
        }

        radioButton(label, value, index) {
            const s = this.state;
            const ids = this._id(label);
            const selected = value === index;
            const fo = this._fo();
            const lineH = this._lineH();
            const pos = this._nextPos();
            const box = Math.max(lineH, 14);
            const lw = this._measure(label, fo).w;
            const isp = this._var('itemInnerSpacing');
            const w = box + isp[0] + lw;
            const it = this._item(pos.x, pos.y, w, box, ids.itemId);
            const res = this._clickable(it);
            let changed = false;
            const kbd =
                this.flags.keyboardNavigation &&
                s.focusedId === it.itemId &&
                this.isKeyPressed(' ');
            if ((res.clicked || kbd) && !selected) {
                value = index;
                changed = true;
            }
            if (changed) s.changedId = it.itemId;
            if (it.visible) {
                this._drawFrame(pos.x, pos.y, box, box, it);
                if (selected) {
                    this.renderer.fillCircle(
                        pos.x + box / 2,
                        pos.y + box / 2,
                        box * 0.26,
                        it.enabled ? this._col('checkMark') : this._col('textDisabled'),
                    );
                }
                this._drawText(
                    pos.x + box + isp[0],
                    pos.y + (box - lineH) / 2 + 1,
                    label,
                    it.enabled ? this._col('text') : this._col('textDisabled'),
                    fo,
                );
            }
            this._drawFocusRing(it);
            this._advance(it.x, it.y, w, box);
            return value;
        }

        sliderFloat(label, value, vmin, vmax, fmt) {
            const ids = this._id(label);
            const st = this._state(ids.stateKey);
            const stateful = value == null;
            // consume a direct-entry commit that landed in the previous endFrame
            if (st.pending != null) {
                value = st.pending;
                st.pending = null;
            }
            if (stateful) value = value != null ? value : st.value != null ? st.value : vmin;
            if (!isFinite(value)) value = vmin;
            value = clamp(value, vmin, vmax);
            const range = vmax - vmin;
            const fw = this._frameWidget(label);
            const it = fw.it;
            let changed = false;
            if (!isFinite(range) || range <= 0) {
                if (it.visible) {
                    this._drawFrame(fw.x, fw.y, fw.w, fw.h, it);
                    if (fw.labelRect.w > 0)
                        this._drawText(
                            fw.labelRect.x,
                            fw.labelRect.y,
                            label,
                            this._col('textDisabled'),
                            fw.fo,
                        );
                }
                return value;
            }
            const res = this._clickable(it);
            const s = this.state;

            const openValuePopup = () => {
                this._openPopup(
                    '##val' + it.itemId,
                    { x: fw.x, y: fw.y + fw.h + 2 },
                    {
                        type: 'value',
                        min: vmin,
                        max: vmax,
                        fmt: fmt || '%.3f',
                        label: String(label),
                        value: () => (stateful ? (st.value != null ? st.value : vmin) : value),
                        // commits happen in endFrame (after this frame's return), so route
                        // the result through st.pending; the widget consumes it next frame
                        set: (v) => {
                            st.pending = v;
                            if (stateful) st.value = v;
                        },
                    },
                    it.itemId,
                );
            };
            if (this.flags.rightClickNumeric && it.hovered && this.isMouseClicked(1))
                openValuePopup();
            else if (this.flags.doubleClick && it.hovered && this.isMouseDoubleClicked(0))
                openValuePopup();

            if (res.active) {
                const innerW = Math.max(1, fw.w - 6);
                // drag bookkeeping lives on the item (per visible instance), not st,
                // because duplicate labels share st across frames
                if (!it.dragInit) {
                    it.dragInit = true;
                    st.dragX0 = s.mouse.x;
                    // click-to-set: the value jumps to where the slider was clicked;
                    // dragging then continues from that exact point
                    value = vmin + clamp01((s.mouse.x - fw.x - 3) / innerW) * range;
                    st.dragV0 = value;
                }
                value = st.dragV0 + ((s.mouse.x - st.dragX0) / innerW) * range;
                changed = true;
            }
            value = clamp(value, vmin, vmax);

            if (
                it.hovered &&
                s.mouse.wheel[1] &&
                (s.focusedId === it.itemId || res.active) &&
                this.flags.wheelScroll
            ) {
                value = clamp(value + ((s.mouse.wheel[1] > 0 ? -1 : 1) * range) / 50, vmin, vmax);
                changed = true;
            }

            if (s.focusedId === it.itemId && this.flags.keyboardNavigation) {
                const step = range / 100;
                if (this.isKeyPressed('left') || this.isKeyPressed('down')) {
                    value = clamp(value - step, vmin, vmax);
                    changed = true;
                }
                if (this.isKeyPressed('right') || this.isKeyPressed('up')) {
                    value = clamp(value + step, vmin, vmax);
                    changed = true;
                }
                if (this.isKeyPressed('pageup')) {
                    value = clamp(value + step * 10, vmin, vmax);
                    changed = true;
                }
                if (this.isKeyPressed('pagedown')) {
                    value = clamp(value - step * 10, vmin, vmax);
                    changed = true;
                }
                if (this.isKeyPressed('home')) {
                    value = vmin;
                    changed = true;
                }
                if (this.isKeyPressed('end')) {
                    value = vmax;
                    changed = true;
                }
            }

            if (stateful) st.value = value;
            if (changed) s.changedId = it.itemId;

            if (it.visible) {
                this._drawFrame(fw.x, fw.y, fw.w, fw.h, it);
                const frac = clamp01((value - vmin) / range);
                const grabW = clamp(fw.w * 0.09, 8, 22);
                const innerW = Math.max(1, fw.w - 6);
                const gx = fw.x + 3 + (innerW - grabW) * frac;
                const gc = !it.enabled
                    ? this._col('textDisabled')
                    : res.active
                      ? this._col('sliderGrabActive')
                      : it.hovered
                        ? this._col('sliderGrabHovered')
                        : this._col('sliderGrab');
                this.renderer.fillRoundedRect(gx, fw.y + 3, grabW, fw.h - 6, 3, gc);
                const vstr = fmtVal(value, fmt || '%.3f');
                const vm = this._measure(vstr, fw.fo);
                if (vm.w < fw.w - 10) {
                    this._drawText(
                        fw.x + (fw.w - vm.w) / 2,
                        fw.y + (fw.h - vm.h) / 2 + 1,
                        vstr,
                        it.enabled ? this._col('text') : this._col('textDisabled'),
                        fw.fo,
                    );
                }
                if (fw.labelRect.w > 0)
                    this._drawText(
                        fw.labelRect.x,
                        fw.labelRect.y,
                        label,
                        it.enabled ? this._col('text') : this._col('textDisabled'),
                        fw.fo,
                    );
            }
            this._drawFocusRing(it);
            if (it.hovered) this.setTooltip(fmtVal(value, fmt || '%.3f'));
            return value;
        }

        sliderInt(label, value, vmin, vmax, fmt) {
            value = this.sliderFloat(label, value, vmin, vmax, fmt || '%d');
            return Math.round(value);
        }

        slider(label, value, min, max, opts) {
            opts = opts || {};
            const intLike =
                opts.int ||
                (Number.isInteger(min) &&
                    Number.isInteger(max) &&
                    (value == null || Number.isInteger(value)));
            return intLike
                ? this.sliderInt(label, value, min, max, opts.fmt)
                : this.sliderFloat(label, value, min, max, opts.fmt);
        }

        dragFloat(label, value, speed, vmin, vmax) {
            const ids = this._id(label);
            const st = this._state(ids.stateKey);
            const stateful = value == null;
            if (st.pending != null) {
                value = st.pending;
                st.pending = null;
            }
            if (stateful) value = value != null ? value : st.value != null ? st.value : vmin;
            if (!isFinite(value)) value = vmin;
            value = clamp(value, vmin, vmax);
            const fw = this._frameWidget(label);
            const it = fw.it;
            let changed = false;
            const s = this.state;
            const res = this._clickable(it);

            const openValuePopup = () => {
                this._openPopup(
                    '##val' + it.itemId,
                    { x: fw.x, y: fw.y + fw.h + 2 },
                    {
                        type: 'value',
                        min: vmin,
                        max: vmax,
                        fmt: '%.3f',
                        label: String(label),
                        value: () => (stateful ? (st.value != null ? st.value : vmin) : value),
                        set: (v) => {
                            value = v;
                            changed = true;
                            if (stateful) st.value = v;
                        },
                    },
                    it.itemId,
                );
            };
            if (this.flags.rightClickNumeric && it.hovered && this.isMouseClicked(1))
                openValuePopup();
            else if (this.flags.doubleClick && it.hovered && this.isMouseDoubleClicked(0))
                openValuePopup();

            if (res.active) {
                const mult = this.shift ? 0.1 : this.ctrl ? 10 : 1;
                value = clamp(value + s.mouse.dx * speed * mult, vmin, vmax);
                changed = true;
            }
            if (
                it.hovered &&
                s.mouse.wheel[1] &&
                (s.focusedId === it.itemId || res.active) &&
                this.flags.wheelScroll
            ) {
                value = clamp(value + (s.mouse.wheel[1] > 0 ? -1 : 1) * speed, vmin, vmax);
                changed = true;
            }
            if (s.focusedId === it.itemId && this.flags.keyboardNavigation) {
                if (this.isKeyPressed('left') || this.isKeyPressed('down')) {
                    value = clamp(value - speed, vmin, vmax);
                    changed = true;
                }
                if (this.isKeyPressed('right') || this.isKeyPressed('up')) {
                    value = clamp(value + speed, vmin, vmax);
                    changed = true;
                }
                if (this.isKeyPressed('home')) {
                    value = vmin;
                    changed = true;
                }
                if (this.isKeyPressed('end')) {
                    value = vmax;
                    changed = true;
                }
            }

            if (stateful) st.value = value;
            if (changed) s.changedId = it.itemId;

            if (it.visible) {
                this._drawFrame(fw.x, fw.y, fw.w, fw.h, it);
                const vstr = fmtVal(value, '%.3f');
                const vm = this._measure(vstr, fw.fo);
                this._drawText(
                    fw.x + (fw.w - vm.w) / 2,
                    fw.y + (fw.h - vm.h) / 2 + 1,
                    vstr,
                    it.enabled ? this._col('text') : this._col('textDisabled'),
                    fw.fo,
                );
                if (fw.labelRect.w > 0)
                    this._drawText(
                        fw.labelRect.x,
                        fw.labelRect.y,
                        label,
                        it.enabled ? this._col('text') : this._col('textDisabled'),
                        fw.fo,
                    );
            }
            this._drawFocusRing(it);
            return value;
        }
        dragInt(label, value, speed, vmin, vmax) {
            return Math.round(this.dragFloat(label, value, speed, vmin, vmax));
        }

        inputInt(label, value, opts) {
            opts = opts || {};
            const min = opts.min != null ? opts.min : -Infinity;
            const max = opts.max != null ? opts.max : Infinity;
            const step = opts.step != null ? opts.step : 1;
            const stepFast = opts.stepFast != null ? opts.stepFast : 10;
            return this._input(label, value, {
                parse: (b) => (/^[+-]?\d+$/.test(String(b).trim()) ? parseInt(b, 10) : NaN),
                invalid: (v) => !isFinite(v),
                clamp: (v) => clamp(Math.round(v), min, max),
                fmt: (v) => fmtVal(v, '%d'),
                step: (v, dir, fast) =>
                    clamp(Math.round(v) + dir * (fast ? stepFast : step), min, max),
                sanitize: (t) => t.replace(/[^0-9+-]/g, ''),
                live: true,
                init: 0,
            });
        }
        inputFloat(label, value, opts) {
            opts = opts || {};
            const min = opts.min != null ? opts.min : -Infinity;
            const max = opts.max != null ? opts.max : Infinity;
            const step = opts.step != null ? opts.step : 0.1;
            const stepFast = opts.stepFast != null ? opts.stepFast : 1;
            const fmt = opts.fmt || '%.3f';
            return this._input(label, value, {
                parse: (b) => {
                    const v = parseFloat(b);
                    return isFinite(v) ? v : NaN;
                },
                invalid: (v) => !isFinite(v),
                clamp: (v) => clamp(v, min, max),
                fmt: (v) => fmtVal(v, fmt),
                step: (v, dir, fast) => clamp(v + dir * (fast ? stepFast : step), min, max),
                sanitize: (t) => {
                    let out = t.replace(/[^0-9.eE+-]/g, '');
                    const dot = out.indexOf('.');
                    if (dot >= 0)
                        out = out.slice(0, dot + 1) + out.slice(dot + 1).replace(/\./g, '');
                    return out;
                },
                live: true,
                init: 0,
            });
        }

        inputText(label, value, opts) {
            opts = opts || {};
            return this._input(label, value, {
                parse: (b) => b,
                invalid: () => false,
                clamp: null,
                fmt: (v) => String(v == null ? '' : v),
                step: null,
                sanitize: (t) => t.replace(/[\r\n]+/g, ' '),
                live: true,
                init: '',
                maxLength: opts.maxLength,
                onSubmit: opts.onSubmit,
            });
        }

        _input(label, value, cfg) {
            const s = this.state;
            const ids = this._id(label);
            const st = this._state(ids.stateKey);
            const stateful = value == null;
            if (stateful)
                value = st.value !== undefined ? st.value : cfg.init != null ? cfg.init : '';
            if (typeof value !== 'string' && typeof value !== 'number')
                value = cfg.init != null ? cfg.init : '';
            const fw = this._frameWidget(label);
            const it = fw.it;
            const res = this._clickable(it);
            let changed = false;
            const fp = fw.fp;
            const textX = fw.x + fp[0];
            const textW = Math.max(4, fw.w - fp[0] * 2);
            const textY = fw.y + fp[1];
            const editing = st.edit === true && s.focusedId === it.itemId;

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
                    st.flash = s.now;
                }
                st.buf = null;
                st.edit = false;
                st.sel = null;
            };

            if (!editing) {
                if (it.hovered && this.isMouseClicked(0)) {
                    st.edit = true;
                    st.buf = cfg.fmt(value);
                    st.base = st.buf;
                    st.caret = this._caretFromX(st.buf, s.mouse.x, textX, textW);
                    st.sel = null;
                    st.caretT = 0;
                    st.undo = [];
                    st.redo = [];
                    s.focusedId = it.itemId;
                    s.activeId = it.itemId;
                } else if (it.hovered && this.isMouseClicked(1)) {
                    st.edit = true;
                    st.buf = cfg.fmt(value);
                    st.base = st.buf;
                    st.caret = st.buf.length;
                    st.sel = [0, st.buf.length];
                    st.caretT = 0;
                    st.undo = [];
                    st.redo = [];
                    s.focusedId = it.itemId;
                    s.activeId = it.itemId;
                }
            }

            if (editing) {
                st.buf = st.buf != null ? st.buf : cfg.fmt(value);
                const L = st.buf.length;
                // self-heal a caret that ever drifted past the buffer end
                if (st.caret > L) st.caret = L;
                if (it.hovered) this._setCursor('text', 2);
                const mo = s.mouse;
                const k = (t) => this.isKeyPressed(t);
                // undo = past snapshots (state before each edit); redo = states
                // displaced by undo. A new edit clears redo.
                const pushUndo = () => {
                    if (!this.flags.undoRedo) return;
                    if (!st.undo) {
                        st.undo = [];
                        st.redo = [];
                    }
                    const last = st.undo[st.undo.length - 1];
                    if (last && last.buf === st.buf && last.caret === st.caret) return;
                    st.undo.push({ buf: st.buf, caret: st.caret });
                    if (st.undo.length > 32) st.undo.shift();
                    st.redo = [];
                };
                const doUndo = () => {
                    if (!st.undo || !st.undo.length) return;
                    if (!st.redo) st.redo = [];
                    st.redo.push({ buf: st.buf, caret: st.caret });
                    const snap = st.undo.pop();
                    st.buf = snap.buf;
                    st.caret = snap.caret;
                    st.sel = null;
                };
                const doRedo = () => {
                    if (!st.redo || !st.redo.length) return;
                    if (!st.undo) st.undo = [];
                    st.undo.push({ buf: st.buf, caret: st.caret });
                    const snap = st.redo.pop();
                    st.buf = snap.buf;
                    st.caret = snap.caret;
                    st.sel = null;
                };

                // mouse interactions
                if (it.hovered && this.isMouseClicked(0)) {
                    if (this.isMouseDoubleClicked(0) && this.flags.doubleClick) {
                        st.sel = this._wordSelect(st.buf, st.caret);
                    } else {
                        st.caret = this._caretFromX(st.buf, mo.x, textX, textW);
                        st.sel = null;
                    }
                    st.caretT = 0;
                }
                if (
                    mo.wheel[1] &&
                    this.flags.wheelScroll &&
                    cfg.step &&
                    (s.focusedId === it.itemId || res.active)
                ) {
                    const dir = mo.wheel[1] > 0 ? -1 : 1;
                    value = cfg.step(value, dir, this.shift);
                    changed = true;
                    st.buf = cfg.fmt(value);
                    st.caret = st.buf.length;
                    st.sel = null;
                }

                if (k('escape')) {
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
                } else if (k('enter')) {
                    commit();
                    if (cfg.onSubmit) cfg.onSubmit(value);
                } else if (k('tab')) {
                    commit();
                    if (this.flags.keyboardNavigation) {
                        const list = s.lastFocusList.length ? s.lastFocusList : s.focusList;
                        const i = list.indexOf(it.itemId);
                        if (i >= 0 && list.length > 1) s.focusedId = list[(i + 1) % list.length];
                    }
                } else if (k('backspace')) {
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
                } else if (k('delete')) {
                    pushUndo();
                    if (st.sel) {
                        st.buf = st.buf.slice(0, st.sel[0]) + st.buf.slice(st.sel[1]);
                        st.caret = st.sel[0];
                        st.sel = null;
                    } else if (st.caret < L)
                        st.buf = st.buf.slice(0, st.caret) + st.buf.slice(st.caret + 1);
                    st.caretT = 0;
                } else if (k('left')) {
                    const c = Math.max(0, st.caret - 1);
                    if (this.shift && st.sel)
                        st.sel = [Math.min(st.sel[0], c), Math.max(st.sel[1], c)];
                    else if (this.shift) st.sel = [c, st.caret];
                    else {
                        st.caret = c;
                        st.sel = null;
                    }
                    st.caretT = 0;
                } else if (k('right')) {
                    const c = Math.min(L, st.caret + 1);
                    if (this.shift && st.sel)
                        st.sel = [Math.min(st.sel[0], c), Math.max(st.sel[1], c)];
                    else if (this.shift) st.sel = [st.caret, c];
                    else {
                        st.caret = c;
                        st.sel = null;
                    }
                    st.caretT = 0;
                } else if (k('home')) {
                    if (this.shift) st.sel = [0, st.caret];
                    st.caret = 0;
                    if (!this.shift) st.sel = null;
                } else if (k('end')) {
                    if (this.shift) st.sel = [st.caret, L];
                    st.caret = L;
                    if (!this.shift) st.sel = null;
                } else if (k('pageup') || k('pagedown')) {
                    if (cfg.step) {
                        value = cfg.step(value, k('pageup') ? 1 : -1, true);
                        changed = true;
                        st.buf = cfg.fmt(value);
                        st.caret = st.buf.length;
                    } else {
                        st.caret = clamp(st.caret + (k('pageup') ? -12 : 12), 0, L);
                    }
                } else if (cfg.step && k('up')) {
                    value = cfg.step(value, 1, this.shift);
                    changed = true;
                    st.buf = cfg.fmt(value);
                    st.caret = st.buf.length;
                    st.sel = null;
                } else if (cfg.step && k('down')) {
                    value = cfg.step(value, -1, this.shift);
                    changed = true;
                    st.buf = cfg.fmt(value);
                    st.caret = st.buf.length;
                    st.sel = null;
                } else if (this.ctrl && this.flags.keyboardShortcuts) {
                    if (k('a')) {
                        st.sel = [0, L];
                    } else if (k('c') && st.sel) {
                        if (this.flags.clipboard)
                            this.clipboard.write(st.buf.slice(st.sel[0], st.sel[1]));
                    } else if (k('x') && st.sel) {
                        if (this.flags.clipboard)
                            this.clipboard.write(st.buf.slice(st.sel[0], st.sel[1]));
                        pushUndo();
                        st.buf = st.buf.slice(0, st.sel[0]) + st.buf.slice(st.sel[1]);
                        st.caret = st.sel[0];
                        st.sel = null;
                    } else if (k('v')) {
                        if (this.flags.clipboard) {
                            let t = String(this.clipboard.read() || '');
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
                    } else if (k('z') && !this.shift) {
                        doUndo();
                    } else if (k('y') || (k('z') && this.shift)) {
                        doRedo();
                    }
                }
                if (this.flags.mouseBackForward && this.flags.undoRedo) {
                    if (this.isMouseClicked(3)) {
                        doUndo();
                        s.backForwardHandled = true;
                    }
                    if (this.isMouseClicked(4)) {
                        doRedo();
                        s.backForwardHandled = true;
                    }
                }
                // commit() (enter/escape above) may have ended the edit this frame;
                // the remaining blocks must not run on a cleared buffer
                if (st.edit === true) {
                    if (!s.textConsumed && s.textInput) {
                        s.textConsumed = true;
                        let t = s.textInput;
                        if (cfg.sanitize) t = cfg.sanitize(t);
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
                st.caretT = (st.caretT || 0) + s.dt;
                if (s.focusedId !== it.itemId && !this.isMouseDown(0)) {
                    commit();
                }
            }

            if (it.visible) {
                this._drawFrame(fw.x, fw.y, fw.w, fw.h, it);
                this.renderer.pushClip(fw.x, fw.y, fw.w, fw.h);
                // re-check live state: commit() may have run this frame and cleared st.buf
                if (st.edit === true && st.buf != null) {
                    const drawStr = st.buf;
                    const wholeW = this._measure(drawStr, fw.fo).w;
                    let textScroll = st.textScroll || 0;
                    const caretX = this._measure(drawStr.slice(0, st.caret), fw.fo).w;
                    if (caretX + 4 > textScroll + textW) textScroll = caretX + 4 - textW;
                    if (caretX - 4 < textScroll) textScroll = Math.max(0, caretX - 4);
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
                            this._col('textSelectedBg'),
                        );
                    }
                    this._drawText(
                        textX - textScroll,
                        textY,
                        drawStr,
                        it.enabled ? this._col('text') : this._col('textDisabled'),
                        fw.fo,
                    );
                    const blink = this.flags.animations
                        ? Math.floor((st.caretT || 0) / this._var('caretBlinkRate')) % 2 === 0
                        : true;
                    if (blink || st.sel) {
                        const cx = this._measure(drawStr.slice(0, st.caret), fw.fo).w - textScroll;
                        this.renderer.line(
                            textX + cx,
                            textY + 1,
                            textX + cx,
                            textY + fw.lineH - 1,
                            this._col('text'),
                            1,
                        );
                    }
                    if (st.flash && s.now - st.flash < 400) {
                        this.renderer.strokeRoundedRect(
                            fw.x + 0.5,
                            fw.y + 0.5,
                            fw.w - 1,
                            fw.h - 1,
                            this._var('frameRounding'),
                            this._col('error'),
                            1.5,
                        );
                    }
                } else {
                    const display = cfg.fmt(value);
                    this._drawText(
                        textX,
                        textY,
                        display,
                        it.enabled ? this._col('text') : this._col('textDisabled'),
                        fw.fo,
                    );
                    if (s.focusedId === it.itemId && it.enabled) {
                        const m = this._measure(display, fw.fo).w;
                        this.renderer.line(
                            textX + m + 2,
                            textY + 1,
                            textX + m + 2,
                            textY + fw.lineH - 1,
                            this._col('text'),
                            1,
                        );
                    }
                }
                this.renderer.popClip();
                if (fw.labelRect.w > 0) {
                    this._drawText(
                        fw.labelRect.x,
                        fw.labelRect.y,
                        label,
                        it.enabled ? this._col('text') : this._col('textDisabled'),
                        fw.fo,
                    );
                }
            }
            this._drawFocusRing(it);
            if (stateful) st.value = value;
            if (changed) s.changedId = it.itemId;
            return value;
        }

        combo(label, value, items, opts) {
            opts = opts || {};
            const s = this.state;
            const ids = this._id(label);
            const st = this._state(ids.stateKey);
            const stateful = value == null;
            // consume a selection committed in the previous endFrame (popup pass)
            if (st.pending != null) {
                value = st.pending;
                st.pending = null;
            }
            if (stateful) value = value != null ? value : st.value != null ? st.value : 0;
            value = clamp(Math.round(value), 0, Math.max(0, items.length - 1));
            const fw = this._frameWidget(label);
            const it = fw.it;
            const res = this._clickable(it);
            let changed = false;
            const pid = '##combo' + it.itemId;
            const p = s.popups.get(pid);

            const openIt = () =>
                this._openPopup(
                    pid,
                    { x: fw.x, y: fw.y + fw.h + 2 },
                    {
                        type: 'combo',
                        items,
                        maxVisible: opts.maxVisible || 8,
                        width: fw.w,
                        value: () => (stateful ? (st.value != null ? st.value : 0) : value),
                        set: (i) => {
                            st.pending = i;
                            if (stateful) st.value = i;
                        },
                    },
                    it.itemId,
                );

            if (res.clicked) {
                if (p && p.open) p.open = false;
                else openIt();
            }
            if (s.focusedId === it.itemId && this.flags.keyboardNavigation) {
                if (this.isKeyPressed('up')) {
                    value = (value - 1 + items.length) % items.length;
                    changed = true;
                    if (stateful) st.value = value;
                }
                if (this.isKeyPressed('down')) {
                    value = (value + 1) % items.length;
                    changed = true;
                    if (stateful) st.value = value;
                }
                if (this.isKeyPressed('enter') || this.isKeyPressed(' ')) {
                    if (p && p.open) p.open = false;
                    else openIt();
                }
            }

            if (it.visible) {
                this._drawFrame(fw.x, fw.y, fw.w, fw.h, it);
                let preview = items[value] != null ? String(items[value]) : '';
                const arrowW = 18;
                const maxW = fw.w - arrowW - fpPad(this);
                while (preview.length > 2 && this._measure(preview + '…', fw.fo).w > maxW)
                    preview = preview.slice(0, -1);
                if (preview !== String(items[value])) preview += '…';
                this._drawText(
                    fw.x + 8,
                    fw.y + (fw.h - fw.lineH) / 2 + 1,
                    preview,
                    it.enabled ? this._col('text') : this._col('textDisabled'),
                    fw.fo,
                );
                const ax = fw.x + fw.w - 14,
                    ay = fw.y + fw.h / 2;
                this.renderer.fillPolygon(
                    [ax - 4, ay - 2.5, ax + 4, ay - 2.5, ax, ay + 3],
                    it.enabled ? this._col('text') : this._col('textDisabled'),
                );
                if (fw.labelRect.w > 0)
                    this._drawText(
                        fw.labelRect.x,
                        fw.labelRect.y,
                        label,
                        it.enabled ? this._col('text') : this._col('textDisabled'),
                        fw.fo,
                    );
            }
            this._drawFocusRing(it);
            if (stateful) st.value = value;
            if (changed) s.changedId = it.itemId;
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
        listBox(label, value, items, opts) {
            opts = opts || {};
            const s = this.state;
            const ids = this._id(label);
            const st = this._state(ids.stateKey);
            const stateful = value == null;
            if (stateful) value = st.value != null ? st.value : 0;
            items = items || [];
            const fo = this._fo();
            const lineH = this._lineH();
            const sp = this._var('itemSpacing');
            const rowH = opts.rowH || lineH + 10;
            const avail = this.getRegionAvail();
            const w = opts.w > 0 ? opts.w : avail.w;
            const maxRows = Math.max(1, opts.rows || 8);
            const visible = Math.min(items.length || 1, maxRows);
            const boxH = opts.h > 0 ? opts.h : visible * (rowH + sp[1]) + sp[1];

            const pos = this._nextPos();
            let boxTop = pos.y;
            if (opts.label !== false && label) {
                this._drawText(pos.x, pos.y, label, this._col('textDisabled'), fo);
                this._advance(pos.x, pos.y, w, lineH);
                const p2 = this._nextPos();
                boxTop = p2.y;
            }

            let changed = false;
            if (this.beginChild('##listbox' + ids.itemId, { w: w, h: boxH, padding: 4 })) {
                const boxAvail = this.getRegionAvail();
                for (let i = 0; i < items.length; i++) {
                    const p = this._nextPos();
                    const rw = boxAvail.w;
                    const itemId = hash3(fnv1a(ids.itemId), 0x1b33, i);
                    const it = this._item(p.x, p.y, rw, rowH, itemId, {
                        focusable: false,
                    });
                    const res = this._clickable(it);
                    if (it.visible) {
                        if (i === value || it.hovered) {
                            this.renderer.fillRoundedRect(
                                p.x + 2,
                                p.y + 2,
                                rw - 4,
                                rowH - 4,
                                this._var('frameRounding'),
                                i === value
                                    ? this._col('headerActive')
                                    : this._col('headerHovered'),
                            );
                        }
                        this._drawText(
                            p.x + 10,
                            p.y + (rowH - lineH) / 2 + 1,
                            String(items[i]),
                            it.enabled ? this._col('text') : this._col('textDisabled'),
                            fo,
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
                const L = s.layout;
                if (L) L.y = boxTop - L.origin.y + L.scroll.y + boxH;
                // keep the selected row in view
                const cr = s._childReturn;
                if (cr && cr.win) {
                    const cw = cr.win;
                    const pitch = rowH + sp[1];
                    const top = value * pitch;
                    const bot = top + rowH;
                    const vh = cw.visibleContentH || 0;
                    if (top < cw.scrollY) cw.scrollTargetY = top;
                    else if (bot > cw.scrollY + vh) cw.scrollTargetY = bot - vh;
                }
            }
            this._advance(pos.x, boxTop, w, boxH);
            if (stateful) st.value = value;
            if (changed) s.changedId = ids.itemId;
            return value;
        }

        selectable(label, selected, opts) {
            opts = opts || {};
            const fo = this._fo();
            const lineH = this._lineH();
            const pos = this._nextPos();
            const L = this.state.layout;
            const w = opts.width > 0 ? opts.width : Math.max(10, L.avail.w - L.x - L.indent);
            const it = this._item(pos.x, pos.y, w, lineH + 6, this._id(label).itemId);
            const res = this._clickable(it);
            const kbd =
                this.flags.keyboardNavigation &&
                this.state.focusedId === it.itemId &&
                this.isKeyPressed(' ');
            const clicked = res.clicked || kbd;
            if (it.visible) {
                if (selected || it.hovered) {
                    this.renderer.fillRoundedRect(
                        pos.x,
                        pos.y,
                        w,
                        lineH + 6,
                        this._var('frameRounding'),
                        selected ? this._col('headerActive') : this._col('headerHovered'),
                    );
                }
                this._drawText(
                    pos.x + 8,
                    pos.y + (lineH + 6 - lineH) / 2,
                    label,
                    it.enabled ? this._col('text') : this._col('textDisabled'),
                    fo,
                );
                if (opts.callback && clicked) opts.callback();
            }
            this._drawFocusRing(it);
            this._advance(it.x, it.y, w, lineH + 6);
            return clicked;
        }

        progressBar(fraction, opts) {
            opts = opts || {};
            const fo = this._fo();
            const lineH = this._lineH();
            const pos = this._nextPos();
            const L = this.state.layout;
            const w = opts.width > 0 ? opts.width : Math.max(10, L.avail.w - L.x - L.indent);
            const h = opts.height > 0 ? opts.height : Math.max(12, lineH + 4);
            const it = this._item(
                pos.x,
                pos.y,
                w,
                h,
                this._id('##progress' + (opts.id || 'x')).itemId,
                { focusable: false },
            );
            const frac = clamp01(isFinite(fraction) ? fraction : 0);
            if (it.visible) {
                this.renderer.fillRoundedRect(
                    pos.x,
                    pos.y,
                    w,
                    h,
                    this._var('frameRounding'),
                    this._col('frameBg'),
                );
                if (frac > 0) {
                    this.renderer.fillRoundedRect(
                        pos.x + 2,
                        pos.y + 2,
                        Math.max(2, (w - 4) * frac),
                        h - 4,
                        this._var('frameRounding') - 1,
                        this._col('sliderGrab'),
                    );
                }
                const overlay =
                    opts.overlay != null ? String(opts.overlay) : Math.round(frac * 100) + '%';
                const m = this._measure(overlay, fo);
                if (m.w < w - 12) {
                    this._drawText(
                        pos.x + (w - m.w) / 2,
                        pos.y + (h - lineH) / 2 + 1,
                        overlay,
                        this._col('text'),
                        fo,
                    );
                }
            }
            this._advance(it.x, it.y, w, h);
            return it.hovered;
        }

        collapsingHeader(label, opts) {
            opts = opts || {};
            const s = this.state;
            const ids = this._id(label);
            const st = this._state(ids.stateKey);
            const stateful = opts.open == null;
            let open = stateful ? !!st.open : !!opts.open;
            const fo = this._fo();
            const lineH = this._lineH();
            const pos = this._nextPos();
            const L = s.layout;
            const w = Math.max(10, L.avail.w - L.x - L.indent);
            const h = lineH + 8;
            const it = this._item(pos.x, pos.y, w, h, ids.itemId);
            const res = this._clickable(it);
            let changed = false;
            const kbd =
                this.flags.keyboardNavigation &&
                s.focusedId === it.itemId &&
                (this.isKeyPressed(' ') || this.isKeyPressed('enter'));
            if (res.clicked || kbd) {
                open = !open;
                changed = true;
            }
            if (stateful) st.open = open;
            if (changed) s.changedId = it.itemId;
            if (it.visible) {
                const bg = !it.enabled
                    ? this._col('header')
                    : it.active
                      ? this._col('headerActive')
                      : it.hovered
                        ? this._col('headerHovered')
                        : this._col('header');
                this.renderer.fillRoundedRect(pos.x, pos.y, w, h, this._var('frameRounding'), bg);
                const cx = pos.x + 12,
                    cy = pos.y + h / 2;
                const c = it.enabled ? this._col('text') : this._col('textDisabled');
                if (open)
                    this.renderer.fillPolygon([cx - 5, cy - 3, cx + 5, cy - 3, cx, cy + 4], c);
                else this.renderer.fillPolygon([cx - 3, cy - 5, cx - 3, cy + 5, cx + 4, cy], c);
                this._drawText(pos.x + 24, pos.y + (h - lineH) / 2 + 1, label, c, fo);
            }
            this._drawFocusRing(it);
            this._advance(it.x, it.y, w, h);
            return open;
        }

        treeNode(label) {
            const s = this.state;
            const ids = this._id(label);
            const st = this._state(ids.stateKey);
            let open = !!st.open;
            const fo = this._fo();
            const lineH = this._lineH();
            const pos = this._nextPos();
            const L = s.layout;
            const w = Math.max(10, L.avail.w - L.x - L.indent);
            const h = lineH + 6;
            const it = this._item(pos.x, pos.y, w, h, ids.itemId);
            const res = this._clickable(it);
            let changed = false;
            const kbd =
                this.flags.keyboardNavigation &&
                s.focusedId === it.itemId &&
                (this.isKeyPressed(' ') || this.isKeyPressed('enter'));
            if (res.clicked || kbd) {
                open = !open;
                changed = true;
            }
            st.open = open;
            if (changed) s.changedId = it.itemId;
            if (it.visible) {
                if (it.hovered)
                    this.renderer.fillRoundedRect(
                        pos.x,
                        pos.y,
                        w,
                        h,
                        this._var('frameRounding'),
                        this._col('headerHovered'),
                    );
                const cx = pos.x + 10,
                    cy = pos.y + h / 2;
                if (open)
                    this.renderer.fillPolygon(
                        [cx - 4, cy - 2.5, cx + 4, cy - 2.5, cx, cy + 3.5],
                        this._col('text'),
                    );
                else
                    this.renderer.fillPolygon(
                        [cx - 2.5, cy - 4, cx - 2.5, cy + 4, cx + 3.5, cy],
                        this._col('textDisabled'),
                    );
                this._drawText(
                    pos.x + 20,
                    pos.y + (h - lineH) / 2 + 1,
                    label,
                    this._col('text'),
                    fo,
                );
            }
            if (open) {
                s.treeLines.push({ x: pos.x + 10, y0: pos.y + h });
                this.pushId(ids.itemId);
                this.indent(24); // child content aligns right of the parent label
            }
            this._advance(it.x, it.y, w, h);
            return open;
        }
        treePop() {
            const s = this.state;
            if (s.treeLines.length) {
                s.treeLines.pop();
                this.popId();
                this.unindent(24);
            }
        }
        treePopToLevel(n) {
            while (this.state.treeLines.length > n) this.treePop();
        }

        /* ---------------------------- tabs ---------------------------------- */

        beginTabBar(id) {
            const s = this.state;
            const ids = this._id(id || '##tabbar');
            const st = this._state(ids.stateKey);
            if (st.tab == null) st.tab = 0;
            const pos = this._nextPos();
            const L = s.layout;
            const lineH = this._lineH();
            const barH = lineH + 12;
            const w = Math.max(10, L.avail.w - L.x - L.indent);
            s.tabStack.push({
                st,
                x: pos.x,
                y: pos.y,
                w,
                barH,
                count: 0,
                prevCount: st.count || 1,
                cursor: 0,
                origOriginY: L.origin.y,
                origAvailH: L.avail.h,
                active: false,
            });
            return true;
        }
        beginTabItem(label, opts) {
            opts = opts || {};
            const s = this.state;
            const bar = s.tabStack[s.tabStack.length - 1];
            if (!bar) return false;
            const idx = bar.count++;
            const st = bar.st;
            const fo = this._fo();
            const lineH = this._lineH();
            const ids = this._id(label);
            const lw = this._measure(label, fo).w;
            const tw = lw + 22 + (opts.closable ? 14 : 0);
            bar.cursor = bar.cursor || 0;
            const x = bar.x + bar.cursor;
            bar.cursor += tw + 4;
            const y = bar.y;
            const h = bar.barH;
            const active = st.tab === idx;
            const it = this._item(x, y, tw, h, ids.itemId);
            const res = this._clickable(it);
            if (res.clicked) {
                if (opts.closable && s.mouse.x >= x + tw - 16) {
                    if (typeof opts.onClose === 'function') opts.onClose();
                } else if (!active) {
                    st.tab = idx;
                    s.changedId = it.itemId;
                }
            }
            if (it.visible) {
                const rr = this._var('tabRounding');
                const bg = active
                    ? this._col('tabActive')
                    : it.hovered
                      ? this._col('tabHovered')
                      : this._col('tab');
                this.renderer.fillRoundedRect(x, y, tw, h, rr, bg);
                if (active) {
                    this.renderer.fillRect(x + rr, y + h - 2, tw - rr * 2, 2, bg);
                }
                this._drawText(
                    x + 11,
                    y + (h - lineH) / 2,
                    label,
                    active ? this._col('text') : this._col('textDisabled'),
                    fo,
                );
                if (opts.closable && (it.hovered || active)) {
                    const bx = x + tw - 12,
                        by = y + h / 2;
                    this.renderer.line(
                        bx - 3,
                        by - 3,
                        bx + 3,
                        by + 3,
                        this._col('textDisabled'),
                        1.2,
                    );
                    this.renderer.line(
                        bx + 3,
                        by - 3,
                        bx - 3,
                        by + 3,
                        this._col('textDisabled'),
                        1.2,
                    );
                }
            }
            if (s.focusedId === it.itemId && this.flags.keyboardNavigation) {
                const n = Math.max(1, bar.prevCount);
                if (this.isKeyPressed('left')) st.tab = (st.tab - 1 + n) % n;
                if (this.isKeyPressed('right')) st.tab = (st.tab + 1) % n;
            }
            if (active) {
                const L = s.layout;
                bar.active = true;
                L.origin.y = y + h + 2;
                L.avail.h = bar.origOriginY + bar.origAvailH - (y + h + 2);
                L.x = 0;
                L.y = 0;
                L.lineActive = false;
                L.lineBottom = 0;
                L.contentRight = 0;
                L._same = false;
            }
            return active;
        }
        endTabItem() {
            const s = this.state;
            const bar = s.tabStack[s.tabStack.length - 1];
            if (!bar || !bar.active) return;
            const L = s.layout;
            L.lineActive = false;
            L.x = 0;
            L.y = L.avail.h;
            bar.active = false;
        }
        endTabBar() {
            const s = this.state;
            const bar = s.tabStack.pop();
            if (!bar) return;
            bar.st.count = bar.count;
            const L = s.layout;
            L.origin.y = bar.origOriginY;
            L.avail.h = bar.origAvailH;
            L.x = 0;
            L.y = L.avail.h;
            L.lineActive = false;
        }

        /* ---------------------------- menu bar ------------------------------ */

        beginMenuBar() {
            const s = this.state;
            return !!s.menuBar;
        }
        endMenuBar() {
            this.state.menuBar = null;
        }

        beginMenu(label) {
            const s = this.state;
            if (s.currentMenu) {
                // nested menu inside an open menu
                const parent = s.currentMenu.popup;
                const subId = '##sub' + fnv1a(label + '\x01' + parent.id);
                s.currentMenu.rows.push({ type: 'submenu', label, subId });
                const sub = s.popups.get(subId);
                if (sub && sub.open) {
                    s.currentMenu = {
                        popup: sub,
                        rows: sub.data.items,
                        _parent: s.currentMenu,
                    };
                    sub.data.items.length = 0;
                    return true;
                }
                return false;
            }
            if (!s.menuBar) return false;
            const mb = s.menuBar;
            const fo = this._fo();
            const lineH = this._lineH();
            const lw = this._measure(label, fo).w;
            const w = lw + 20;
            const x = mb.x,
                y = mb.y - 4;
            mb.x += w + 6;
            const pid = '##menu' + fnv1a(label + '\x01' + mb.win.idHash);
            const p = s.popups.get(pid);
            const itemId = hash3(fnv1a(pid), 0x42a1, 0);
            const it = this._item(x, y, w, lineH + 8, itemId, { focusable: false });
            let opened = false;
            if (p && p.open) {
                if (it.hovered && this.isMouseClicked(0)) {
                    p.open = false;
                } else {
                    opened = true;
                    p.data.items.length = 0;
                    s.currentMenu = { popup: p, rows: p.data.items, _parent: null };
                }
                if (it.visible && it.hovered)
                    this.renderer.fillRoundedRect(
                        x,
                        y,
                        w,
                        lineH + 8,
                        4,
                        this._col('headerHovered'),
                    );
            } else {
                if (it.hovered && this.isMouseClicked(0)) {
                    s.clickedItemId = itemId; // protect the popup from same-frame/next-frame dismissal
                    this._openPopup(
                        pid,
                        { x, y: y + lineH + 12 },
                        { type: 'menu', items: [] },
                        itemId,
                        mb.win,
                    );
                }
                if (it.visible && it.hovered)
                    this.renderer.fillRoundedRect(
                        x,
                        y,
                        w,
                        lineH + 8,
                        4,
                        this._col('headerHovered'),
                    );
            }
            if (it.visible) this._drawText(x + 10, y + 4, label, this._col('text'), fo);
            return opened;
        }
        endMenu() {
            const s = this.state;
            if (s.currentMenu) s.currentMenu = s.currentMenu._parent || null;
        }

        menuItem(label, shortcut, opts) {
            opts = opts || {};
            const s = this.state;
            if (s.currentMenu) {
                s.currentMenu.rows.push({
                    type: 'item',
                    label,
                    shortcut: shortcut || '',
                    selected: !!opts.selected,
                    disabled: !!opts.disabled,
                    onActivated: opts.onActivated || null,
                });
                return false;
            }
            if (s.popupLayoutActive) {
                const fo = this._fo();
                const lineH = this._lineH();
                const pos = this._nextPos();
                // natural width (label + shortcut + padding) so the popup sizes to content
                const labelW = this._measure(label, fo).w;
                const scW = shortcut ? this._measure(shortcut, fo).w + 16 : 0;
                const w = Math.max(40, labelW + scW + (opts.selected ? 26 : 20));
                const it = this._item(pos.x, pos.y, w, lineH + 6, this._id('##mi' + label).itemId);
                const res = this._clickable(it);
                if (res.clicked && typeof opts.onActivated === 'function') opts.onActivated();
                if (res.clicked) {
                    for (const p of s.popupList) p.open = false;
                }
                if (it.visible) {
                    if (it.hovered)
                        this.renderer.fillRoundedRect(
                            pos.x,
                            pos.y,
                            w,
                            lineH + 6,
                            4,
                            this._col('headerHovered'),
                        );
                    const tx = pos.x + 10 + (opts.selected ? 16 : 0);
                    if (opts.selected) {
                        const cx = pos.x + 14,
                            cy = pos.y + (lineH + 6) / 2;
                        this.renderer.polyline(
                            [cx - 3, cy, cx - 1, cy + 3, cx + 4, cy - 3],
                            this._col('checkMark'),
                            1.6,
                        );
                    }
                    this._drawText(tx, pos.y + 3, label, this._col('text'), fo);
                    if (shortcut) {
                        const m = this._measure(shortcut, fo);
                        this._drawText(
                            pos.x + w - 8 - m.w,
                            pos.y + 3,
                            shortcut,
                            this._col('textDisabled'),
                            fo,
                        );
                    }
                }
                this._advance(pos.x, pos.y, w, lineH + 6);
                return res.clicked;
            }
            return false;
        }

        /* ---------------------------- tables -------------------------------- */

        beginTable(label, cols, opts) {
            opts = opts || {};
            const s = this.state;
            const ids = this._id(label);
            const pos = this._nextPos();
            const L = s.layout;
            const availW = Math.max(10, L.avail.w - L.x - L.indent);
            const widths = opts.colWidths && opts.colWidths.length === cols ? opts.colWidths : null;
            const fixedTotal = widths ? widths.reduce((a, b) => a + (b > 0 ? b : 0), 0) : 0;
            const flexCount = widths ? widths.filter((b) => b <= 0).length : cols;
            const flexW = flexCount > 0 ? (availW - fixedTotal) / flexCount : 0;
            const colW = [];
            for (let i = 0; i < cols; i++) colW.push(widths && widths[i] > 0 ? widths[i] : flexW);
            s.table = {
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
                _availW0: L.avail.w,
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
            if (!t) return;
            const L = this.state.layout;
            L.x = t.x0 - L.origin.x + L.scroll.x;
            L.y = t.y - L.origin.y + L.scroll.y;
            L.lineActive = false;
            L.avail.w = t._availW0;
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
                    withAlpha(this._col('separator'), 0.5),
                    1,
                );
            }
        }
        tableHeader(labels) {
            const t = this.state.table;
            if (!t) return;
            const fo = this._fo();
            const lineH = this._lineH();
            const y = t.y;
            const totalW = t.colW.reduce((a, b) => a + b, 0);
            this.renderer.fillRoundedRect(t.x0, y, totalW, t.rowH, 4, this._col('tableHeader'));
            for (let i = 0; i < t.cols; i++) {
                const x = this._tableCellX(i);
                const str = labels && labels[i] != null ? String(labels[i]) : '';
                this._drawText(x + 8, y + (t.rowH - lineH) / 2, str, this._col('text'), fo);
            }
            this.renderer.line(
                t.x0,
                y + t.rowH - 0.5,
                t.x0 + totalW,
                y + t.rowH - 0.5,
                this._col('separator'),
                1,
            );
            this._tableVLines(y, y + t.rowH);
            t.rowBottom = y + t.rowH;
            t.y = t.rowBottom;
            this._tableSyncLayout();
        }
        tableRow(values) {
            const t = this.state.table;
            if (!t) return;
            const fo = this._fo();
            const lineH = this._lineH();
            const y = t.y;
            const totalW = t.colW.reduce((a, b) => a + b, 0);
            if (t.rowIndex % 2 === 1)
                this.renderer.fillRoundedRect(t.x0, y, totalW, t.rowH, 2, this._col('tableBgAlt'));
            for (let i = 0; i < t.cols; i++) {
                const x = this._tableCellX(i);
                let str = values && values[i] != null ? String(values[i]) : '';
                if (this._measure(str, fo).w > t.colW[i] - 14) {
                    while (str.length > 1 && this._measure(str + '…', fo).w > t.colW[i] - 14)
                        str = str.slice(0, -1);
                    str += '…';
                }
                this._drawText(x + 8, y + (t.rowH - lineH) / 2, str, this._col('text'), fo);
            }
            this.renderer.line(
                t.x0,
                y + t.rowH - 0.5,
                t.x0 + totalW,
                y + t.rowH - 0.5,
                withAlpha(this._col('separator'), 0.6),
                1,
            );
            this._tableVLines(y, y + t.rowH);
            t.rowBottom = y + t.rowH;
            t.y = t.rowBottom;
            t.rowIndex++;
            this._tableSyncLayout();
        }
        tableCell(i) {
            const t = this.state.table;
            if (!t) return null;
            i = clamp(Math.floor(i), 0, t.cols - 1);
            if (i <= t.cell) {
                t.y = t.rowBottom;
                t.cell = -1;
            }
            t.cell = i;
            const x = this._tableCellX(i) + 8;
            const y = t.y + (t.rowH - this._lineH()) / 2;
            const L = this.state.layout;
            L.x = x - L.origin.x + L.scroll.x;
            L.y = y - L.origin.y + L.scroll.y;
            L.lineActive = false;
            L.avail.w = Math.max(4, t.colW[i] - 16);
            return { x, y: t.y, w: t.colW[i] - 8, h: t.rowH };
        }
        tableEndRow() {
            const t = this.state.table;
            if (!t) return;
            const L = this.state.layout;
            t.rowBottom = Math.max(t.rowBottom, L.origin.y + L.y - L.scroll.y);
            const totalW = t.colW.reduce((a, b) => a + b, 0);
            this.renderer.line(
                t.x0,
                t.rowBottom - 0.5,
                t.x0 + totalW,
                t.rowBottom - 0.5,
                withAlpha(this._col('separator'), 0.6),
                1,
            );
            this._tableVLines(t.y, t.rowBottom);
            t.y = t.rowBottom;
            t.rowIndex++;
            t.cell = -1;
            this._tableSyncLayout();
        }
        endTable() {
            const t = this.state.table;
            if (!t) return;
            const totalW = t.colW.reduce((a, b) => a + b, 0);
            const h = Math.max(1, t.y - t.startY);
            this.renderer.strokeRoundedRect(
                t.x0 + 0.5,
                t.startY + 0.5,
                totalW - 1,
                h - 1,
                4,
                this._col('separator'),
                1,
            );
            this._tableSyncLayout();
            const L = this.state.layout;
            L.lineActive = false;
            this.state.table = null;
        }

        /* ---------------------------- plots / images ------------------------ */

        /* Height for plot widgets: explicit opts.h wins; opts.share: n splits the
       region evenly among n sibling plots; otherwise the plot FILLS the
       remaining region (ImGui-style default). Siblings share via per-frame
       groups keyed by container + n, so each gets exactly avail/n (minus the
       spacing between members). */
        plotHeight(opts, minH, extra) {
            opts = opts || {};
            extra = extra || 0;
            const s = this.state;
            const sp = this._var('itemSpacing');
            const avail = this.getRegionAvail().h;
            if (opts.share > 0) {
                if (s._shareFrame !== s.frameId) {
                    s._shareFrame = s.frameId;
                    s._shareGroups = {};
                }
                const cont = s.layout && s.layout.container;
                const key = ((cont && (cont.title || cont.label)) || '') + ':' + opts.share;
                let g = s._shareGroups[key];
                if (!g) {
                    g = { n: opts.share, avail0: avail };
                    s._shareGroups[key] = g;
                }
                // safety margin: content bookkeeping (trailing spacing + padding
                // rounding) exceeds the raw avail by ~one spacing — stay clear of
                // the scrollbar rather than overflow it
                const ideal = (g.avail0 - g.n * (extra + sp[1]) - sp[1] - 20) / g.n;
                return Math.max(minH, Math.min(ideal, avail));
            }
            return Math.max(minH, avail);
        }

        plotLines(label, values, opts) {
            opts = opts || {};
            if (opts.h == null) opts = Object.assign({}, opts, { h: this.plotHeight(opts, 60) });
            const fw = this._frameWidget(label, { focusable: false, h: opts.h });
            const it = fw.it;
            values = (values || []).filter((v) => isFinite(v));
            if (it.visible && values.length > 1) {
                this._drawFrame(fw.x, fw.y, fw.w, fw.h, it);
                let vmin = opts.min != null ? opts.min : Infinity;
                let vmax = opts.max != null ? opts.max : -Infinity;
                if (opts.min == null || opts.max == null) {
                    for (const v of values) {
                        if (v < vmin) vmin = v;
                        if (v > vmax) vmax = v;
                    }
                }
                if (vmax <= vmin) vmax = vmin + 1;
                const px = fw.x + 4,
                    py = fw.y + 4;
                const pw = Math.max(1, fw.w - 8),
                    ph = Math.max(1, fw.h - 8);
                const pts = new Array(values.length * 2);
                for (let i = 0; i < values.length; i++) {
                    pts[i * 2] = px + (i / (values.length - 1)) * pw;
                    pts[i * 2 + 1] = py + ph - ((values[i] - vmin) / (vmax - vmin)) * ph;
                }
                this.renderer.polyline(pts, this._col('plotLine'), 1.5);
                if (it.hovered) {
                    const frac = clamp01((this.state.mouse.x - px) / pw);
                    const vi = clamp(Math.round(frac * (values.length - 1)), 0, values.length - 1);
                    const vx = px + (vi / (values.length - 1)) * pw;
                    this.renderer.line(vx, py, vx, py + ph, withAlpha(this._col('text'), 110), 1);
                    const overlay = fmtVal(values[vi], '%.2f');
                    const m = this._measure(overlay, fw.fo);
                    this._drawText(
                        fw.x + fw.w - m.w - 5,
                        fw.y + 2,
                        overlay,
                        this._col('text'),
                        fw.fo,
                    );
                } else if (opts.overlay != null) {
                    const m = this._measure(String(opts.overlay), fw.fo);
                    this._drawText(
                        fw.x + fw.w - m.w - 5,
                        fw.y + 2,
                        opts.overlay,
                        this._col('textDisabled'),
                        fw.fo,
                    );
                }
                if (fw.labelRect.w > 0)
                    this._drawText(
                        fw.labelRect.x,
                        fw.labelRect.y,
                        label,
                        this._col('textDisabled'),
                        fw.fo,
                    );
            } else if (it.visible) {
                this._drawFrame(fw.x, fw.y, fw.w, fw.h, it);
                if (fw.labelRect.w > 0)
                    this._drawText(
                        fw.labelRect.x,
                        fw.labelRect.y,
                        label,
                        this._col('textDisabled'),
                        fw.fo,
                    );
            }
            this._advance(it.x, it.y, it.w, it.h);
            return it.hovered;
        }

        image(imageId, w, h, opts) {
            opts = opts || {};
            const pos = this._nextPos();
            const it = this._item(
                pos.x,
                pos.y,
                w,
                h,
                this._id('##img' + (opts.id || imageId)).itemId,
                { focusable: false },
            );
            if (it.visible) {
                this.renderer.drawImage(
                    imageId,
                    pos.x,
                    pos.y,
                    w,
                    h,
                    opts.tint ? normColor(opts.tint) : null,
                );
            }
            this._advance(it.x, it.y, w, h);
            return it.hovered;
        }
    }

    /* Small local helper for combo preview padding */
    function fpPad(gui) {
        return 8;
    }

    /* ------------------------------------------------------------------------
     * Exports — a single global symbol.
     * -------------------------------------------------------------------- */

    const Mim = {
        GUI,
        Style,
        Layers,
        Key,
        MouseButton,
        WindowFlags,
        Color: { rgba, hex: hexToColor, mix: mixColor, withAlpha },
        version: VERSION,
        /* Addons ----------------------------------------------------------
         * registerAddon(name, factory)
         *   factory(gui, Mim) -> { methodName: fn, ... }
         * The returned object's methods are installed on every GUI instance as
         * `gui.addons[name].methodName(...)` (existing GUIs pick addons up on
         * their next call to gui.reloadAddons()). Addons are plain functions of
         * the gui instance: they may use the full public API plus the documented
         * "_internal" surface (gui._col, gui._var, gui._fo, gui._lineH,
         * gui._measure, gui._nextPos, gui._advance, gui._id, gui._state,
         * gui._item, gui._clickable, gui._drawText, gui.beginChild/endChild,
         * gui.renderer). Keep addon files dependency-free and self-contained. */
        registerAddon(name, factory) {
            MIM_ADDONS[String(name)] = factory;
            return Mim;
        },
        unregisterAddon(name) {
            delete MIM_ADDONS[String(name)];
            return Mim;
        },
        addonNames() {
            return Object.keys(MIM_ADDONS);
        },
    };
    GUI.prototype.reloadAddons = function (list) {
        this.addons = {};
        this._installAddons(list === undefined ? true : list);
        return this.addons;
    };
    if (global) global.Mim = Mim;
    return Mim;
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
