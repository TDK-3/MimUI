/* ============================================================================
 * Mim canvas-2d renderer + input adapter
 * ---------------------------------------------------------------------------
 * Implements the Mim renderer interface on a raw HTML5 2D canvas context and
 * turns DOM mouse/keyboard events into the normalized input object the core
 * expects. No dependencies; works in Node with any ctx-like object.
 *
 *   const renderer = new MimCanvas.CanvasRenderer(ctx, {
 *     dpr: window.devicePixelRatio || 1,          // optional DPR scaling
 *     images: { checker: someCanvasOrImageEl },   // id -> drawable source
 *   });
 *   const input = new MimCanvas.CanvasInput(canvas); // self-attaching
 *
 *   const gui = new Mim.GUI(renderer, { ... });
 *   function loop() {
 *     gui.beginFrame(input.snapshot());
 *     if (gui.beginWindow('Hello')) { ... gui.endWindow(); }
 *     gui.endFrame();
 *     requestAnimationFrame(loop);
 *   }
 *
 * Notes
 *   - Colors are [r, g, b, a] arrays with a in 0..255 (Mim convention).
 *   - The renderer assumes the canvas's transform maps 1 unit == 1 CSS pixel
 *     (DPR is handled by setting the transform in beginFrame when `dpr` is
 *     given). Draw coordinates are CSS pixels.
 *   - Clipping uses the context save/clip stack (always balanced).
 *   - Text is drawn with textBaseline 'top' so (x, y) is the text's top-left,
 *     which is what the core's layout expects.
 *   - Wheel deltas are normalized: ~100px of deltaY == 1 wheel unit, same
 *     sign as the Mim convention (wheelY > 0 = scroll down).
 *   - Mouse events: left=0, right=1, middle=2, back=3, forward=4 (DOM button
 *     codes 0/2/1/3/4 mapped accordingly). contextmenu is suppressed so
 *     right-click works (e.g. right-click numeric entry).
 *
 * UMD-lite: exposes module.exports under Node, otherwise a global `MimCanvas`.
 * ========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    root.MimCanvas = factory();
  }
})(typeof self !== 'undefined' ? self : typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ------------------------------------------------------------------------
   * Renderer
   * ---------------------------------------------------------------------- */

  /**
   * @typedef {Object} CanvasRendererOptions
   * @property {number} [dpr=1]    device pixel ratio; beginFrame sets the
   *                               context transform to scale by it.
   * @property {Object} [images]   Map of imageId -> Image/Canvas/ImageBitmap
   *                               used by gui.image().
   * @property {Object} [fonts]    Map of fontId -> CSS font-family string.
   */

  /**
   * Mim renderer backed by an HTML5 2D canvas context.
   * @param {CanvasRenderingContext2D} ctx
   * @param {CanvasRendererOptions} [opts]
   */
  class CanvasRenderer {
    constructor(ctx, opts) {
      this.ctx = ctx;
      opts = opts || {};
      this.dpr = opts.dpr || 1;
      this.images = opts.images || {};
      this.fonts = opts.fonts || {};
      this.canvas = opts.canvas || null; // optional <canvas> element for cursor styling
      this._layer = 'gui';
      this._tintCache = null;
      // capabilities the core may rely on (see the renderer interface docs)
      this.features = {
        cursor: !!this.canvas, // setCursor styles the canvas element
        clip: true,
        tint: typeof document !== 'undefined',
      };
    }

    _c(c) {
      const a = (c[3] == null ? 255 : c[3]) / 255;
      return 'rgba(' + ((c[0] | 0) | 0) + ',' + ((c[1] | 0) | 0) + ',' + ((c[2] | 0) | 0) + ',' + a.toFixed(3) + ')';
    }

    _round(x, y, w, h, r) {
      const ctx = this.ctx;
      r = Math.max(0, Math.min(r, w / 2, h / 2));
      ctx.beginPath();
      if (typeof ctx.roundRect === 'function' && r > 0) {
        ctx.roundRect(x, y, w, h, r);
        return;
      }
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    _font(o) {
      o = o || {};
      const fam = this.fonts[o.fontId] || 'sans-serif';
      return (o.fontSize || 13) + 'px ' + fam;
    }

    beginFrame(w, h) {
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
    endFrame() { /* context state is re-established every draw call */ }
    setLayer(l) { this._layer = l; }
    /** CSS cursor values map 1:1 to the styles the core requests. */
    setCursor(style) {
      if (this.canvas && this.canvas.style) this.canvas.style.cursor = style || 'default';
    }

    pushClip(x, y, w, h) {
      const ctx = this.ctx;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
    }
    popClip() { this.ctx.restore(); }

    fillRect(x, y, w, h, c) {
      this.ctx.fillStyle = this._c(c);
      this.ctx.fillRect(x, y, w, h);
    }
    fillRoundedRect(x, y, w, h, r, c) {
      this._round(x, y, w, h, r);
      this.ctx.fillStyle = this._c(c);
      this.ctx.fill();
    }
    strokeRect(x, y, w, h, c, t) {
      t = t || 1;
      this.ctx.lineWidth = t;
      this.ctx.strokeStyle = this._c(c);
      this.ctx.strokeRect(x + t / 2, y + t / 2, w - t, h - t);
    }
    strokeRoundedRect(x, y, w, h, r, c, t) {
      t = t || 1;
      this._round(x + t / 2, y + t / 2, w - t, h - t, Math.max(0, r - t / 2));
      this.ctx.lineWidth = t;
      this.ctx.strokeStyle = this._c(c);
      this.ctx.stroke();
    }
    line(x1, y1, x2, y2, c, t) {
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.lineWidth = t || 1;
      ctx.strokeStyle = this._c(c);
      ctx.stroke();
    }
    polyline(pts, c, t) {
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.lineWidth = t || 1;
      ctx.strokeStyle = this._c(c);
      ctx.stroke();
    }
    fillPolygon(pts, c) {
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
      ctx.closePath();
      ctx.fillStyle = this._c(c);
      ctx.fill();
    }
    fillCircle(cx, cy, r, c) {
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = this._c(c);
      ctx.fill();
    }
    fillEllipse(cx, cy, rx, ry, c) {
      const ctx = this.ctx;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.fillStyle = this._c(c);
      ctx.fill();
    }
    drawImage(id, x, y, w, h, tint) {
      const img = this.images[id];
      if (!img) {
        // no image registered: draw a placeholder so layout stays visible
        this.ctx.fillStyle = 'rgb(70,72,84)';
        this.ctx.fillRect(x, y, w, h);
        return;
      }
      if (tint) {
        if (typeof document !== 'undefined') {
          let tc = this._tintCache;
          if (!tc) tc = this._tintCache = document.createElement('canvas');
          if (tc.width !== w || tc.height !== h) { tc.width = w; tc.height = h; }
          const tctx = tc.getContext('2d');
          tctx.clearRect(0, 0, w, h);
          tctx.drawImage(img, 0, 0, w, h);
          tctx.globalCompositeOperation = 'source-atop';
          tctx.fillStyle = 'rgba(' + tint[0] + ',' + tint[1] + ',' + tint[2] + ',' + ((tint[3] == null ? 255 : tint[3]) / 255) + ')';
          tctx.fillRect(0, 0, w, h);
          tctx.globalCompositeOperation = 'source-over';
          this.ctx.drawImage(tc, x, y, w, h);
          return;
        }
        // no DOM available: fall through and draw untinted
      }
      this.ctx.drawImage(img, x, y, w, h);
    }
    drawText(x, y, str, c, o) {
      const ctx = this.ctx;
      ctx.font = this._font(o);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = this._c(c);
      ctx.fillText(String(str == null ? '' : str), x, y);
    }
    textSize(str, o) {
      const ctx = this.ctx;
      ctx.font = this._font(o);
      const w = ctx.measureText(String(str == null ? '' : str)).width;
      return { w: w, h: (o && o.fontSize || 13) * 1.25 };
    }
  }

  /* ------------------------------------------------------------------------
   * Input
   * ---------------------------------------------------------------------- */

  const KEY_TOKENS = {
    Enter: 'enter', Tab: 'tab', Escape: 'escape', Backspace: 'backspace',
    Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end',
    PageUp: 'pageup', PageDown: 'pagedown',
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    Shift: 'shift', Control: 'ctrl', Alt: 'alt', Meta: 'meta',
  };

  // DOM MouseEvent.button -> Mim MouseButton (0 left, 1 right, 2 mid, 3 back, 4 fwd)
  const DOM_BUTTON = [0, 2, 1, 3, 4];

  /**
   * Normalizes DOM mouse/keyboard events into Mim's input object.
   * Self-attaches to the canvas (mouse down) and window (move/up/keys),
   * so dragging outside the canvas still works.
   * @param {HTMLCanvasElement} canvas
   * @param {Object} [opts]
   * @param {Object} [opts.win]  window-like object for global listeners
   *                             (defaults to globalThis).
   */
  class CanvasInput {
    constructor(canvas, opts) {
      opts = opts || {};
      this.canvas = canvas;
      this.win = opts.win || (typeof window !== 'undefined' ? window : globalThis);
      this._buttons = [false, false, false, false, false];
      this._keys = new Set();
      this._x = -1e9;
      this._y = -1e9;
      this._inside = false;
      this._wheelX = 0;
      this._wheelY = 0;
      this._text = '';
      this._listeners = { canvas: {}, win: {} };

      const on = (el, bag, ev, fn) => {
        bag[ev] = fn;
        if (el && typeof el.addEventListener === 'function') el.addEventListener(ev, fn, { passive: false });
      };

      on(canvas, this._listeners.canvas, 'mousedown', (e) => {
        const i = DOM_BUTTON[e.button];
        if (i != null) this._buttons[i] = true;
        this._pos(e);
        if (typeof e.preventDefault === 'function') e.preventDefault();
      });
      on(this.win, this._listeners.win, 'mousemove', (e) => { this._pos(e); });
      on(this.win, this._listeners.win, 'mouseup', (e) => {
        const i = DOM_BUTTON[e.button];
        if (i != null) this._buttons[i] = false;
      });
      on(canvas, this._listeners.canvas, 'wheel', (e) => {
        let dy = e.deltaY || 0;
        let dx = e.deltaX || 0;
        if (e.deltaMode === 1) { dy *= 32; dx *= 32; }   // lines -> px
        // Mim convention: positive wheelY = scroll down (DOM deltaY agrees)
        this._wheelY += dy * 0.01;
        this._wheelX += dx * 0.01;
        if (typeof e.preventDefault === 'function') e.preventDefault();
      });
      on(canvas, this._listeners.canvas, 'contextmenu', (e) => {
        if (typeof e.preventDefault === 'function') e.preventDefault();
      });
      on(this.win, this._listeners.win, 'keydown', (e) => {
        if (this._editable(e.target)) return;
        const t = this._token(e.key);
        if (t == null) return;
        this._keys.add(t);
        if (e.key && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          this._text += e.key;
        }
        if (t === 'tab' || t === ' ' || t === 'enter' || t === 'left' ||
            t === 'right' || t === 'up' || t === 'down') {
          if (typeof e.preventDefault === 'function') e.preventDefault();
        }
      });
      on(this.win, this._listeners.win, 'keyup', (e) => {
        const t = this._token(e.key);
        if (t != null) this._keys.delete(t);
      });
      on(this.win, this._listeners.win, 'blur', () => {
        this._keys.clear();
        this._buttons = [false, false, false, false, false];
      });
    }

    _editable(t) {
      return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
    }

    _token(key) {
      if (key == null) return null;
      if (key === ' ') return ' ';
      if (KEY_TOKENS[key]) return KEY_TOKENS[key];
      if (key.length === 1) return key.toLowerCase();
      if (/^f([1-9]|1[0-2])$/i.test(key)) return key.toLowerCase();
      return null;
    }

    _pos(e) {
      const r = this.canvas.getBoundingClientRect();
      const x = e.clientX - r.left;
      const y = e.clientY - r.top;
      this._x = x;
      this._y = y;
      this._inside = x >= 0 && y >= 0 && x < r.width && y < r.height;
    }

    /**
     * Returns the input snapshot for gui.beginFrame(). Consumes the
     * accumulated wheel/text so the next frame starts clean.
     */
    snapshot() {
      const c = this.canvas;
      const inp = {
        width: c.clientWidth || c.width,
        height: c.clientHeight || c.height,
        mouse: {
          x: this._inside ? this._x : -1e9,
          y: this._inside ? this._y : -1e9,
          buttons: this._buttons.slice(),
          wheelX: this._wheelX,
          wheelY: this._wheelY,
        },
        keys: new Set(this._keys),
        text: this._text,
      };
      this._wheelX = 0;
      this._wheelY = 0;
      this._text = '';
      return inp;
    }
  }

  return { CanvasRenderer: CanvasRenderer, CanvasInput: CanvasInput };
});
