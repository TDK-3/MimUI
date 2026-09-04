/**
 * Dear-ImGui-style extras: a horizontal grabber (drag bar), an animated
 * spinner, and a bullet (circle + inline text).
 * @namespace gui.addons.widgets
 */
/**
 * A horizontal drag bar: drag the knob (or click the track) to set the
 * value.
 * @function gui.addons.widgets.grabber
 * @param {string} label
 * @param {number} value
 * @param {Object} [opts] { min (default 0), max (default 1), w, h }
 * @returns {number} the (possibly updated) value
 */

/**
 * An animated arc spinner with a label.
 * @function gui.addons.widgets.spinner
 * @param {string} label
 * @param {Object} [opts] { size (default 14) }
 */

/**
 * A bullet: a small circle followed by inline text (full line width
 * unless opts.w is set).
 * @function gui.addons.widgets.bullet
 * @param {string} text
 * @param {Object} [opts] { color, w }
 */

/* mim_widgets.js — extra imgui-style widgets for Mim.
 * ------------------------------------------------------------------
 * STB-style, dependency-free. Load after mim.js, then use
 * `gui.addons.widgets`:
 *
 *   const W = gui.addons.widgets;
 *
 *   W.grabber('volume', vol, { min: 0, max: 1 });
 *       A horizontal drag bar (like imgui's Grab). Drag the bar, or click
 *       on the track to jump. Returns the value.
 *       opts: { min = 0, max = 1, speed (pixels per unit, default auto) }
 *
 *   W.spinner('working…', { size = 14 });
 *       An animated arc that rotates while drawn (uses the gui clock, so
 *       it works in any backend). Draws label + arc on the current line.
 *
 *   W.bullet('first point', { color });
 *       A small filled circle followed by inline text — imgui's Bullet.
 *       The text continues on the same line (follow with gui.dummy or
 *       more content). Returns nothing; purely presentational.
 *
 * Uses the documented addon surface: gui._col, gui._fo, gui._lineH,
 * gui._measure, gui._nextPos, gui._advance, gui._drawText, gui._item,
 * gui.getRegionAvail, gui.isMouseDown/Clicked, gui.state, gui.renderer.
 */
(function (root) {
  'use strict';
  const Mim = root.Mim;
  if (!Mim) return;

  Mim.registerAddon('widgets', function (gui, M) {
    const r = gui.renderer;

    function col(name, a) {
      const c = gui._col(name);
      return a == null ? c : M.Color.withAlpha(c, Math.round(a * 255));
    }

    function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

    return {
      /** Horizontal drag bar. Returns the (possibly updated) value. */
      grabber(label, value, opts) {
        opts = opts || {};
        const min = opts.min != null ? opts.min : 0;
        const max = opts.max != null ? opts.max : 1;
        if (max <= min) max = min + 1;
        const fo = gui._fo();
        const lineH = gui._lineH();
        const pos = gui._nextPos();
        const avail = gui.getRegionAvail();
        const w = opts.w > 0 ? opts.w : Math.max(80, avail.w);
        const h = opts.h > 0 ? opts.h : 18;
        const s = gui.state;
        const st = gui._state('##grab' + label);
        const v = clamp(value, min, max);
        const t = (v - min) / (max - min); // 0..1 along the track

        const it = gui._item(pos.x, pos.y, w, h, gui._id('##gr' + label).itemId, { focusable: false });
        if (it.visible) {
          // track
          r.fillRoundedRect(pos.x, pos.y + h / 2 - 3, w, 6, 3, col('childBg'));
          // fill up to the knob
          if (t > 0.004) r.fillRoundedRect(pos.x, pos.y + h / 2 - 3, w * t, 6, 3, col('sliderGrab'));
          // knob
          const kx = pos.x + w * t;
          r.fillRoundedRect(kx - 5, pos.y + 1, 10, h - 2, 3, col(it.hovered ? 'headerActive' : 'sliderGrab'));
          r.strokeRoundedRect(pos.x + 0.5, pos.y + 0.5, w - 1, h - 1, 4, col('border', 0.7), 1);
          // label on the right (imgui puts it left; right keeps the track clean)
          const label2 = String(label);
          const lw = gui._measure(label2, fo).w;
          if (w + lw + 10 < avail.w) {
            gui._drawText(pos.x + w + 8, pos.y + (h - lineH) / 2 + 1, label2, col('textDisabled'), fo);
          }
        }
        const clicked = gui.isMouseClicked(0) && s.activeId === 0 && !s.drag && s.disabledCount === 0;
        if (s.drag && s.drag.type === 'grab' && s.drag.st === st && gui.isMouseDown(0)) {
          // dragging: the mouse owns the value
          st.v = min + clamp((s.mouse.x - s.drag.px) / s.drag.pw, 0, 1) * (max - min);
          st._dragging = true;
          gui._setCursor('ew-resize', 2);
        } else if (clicked && it.hovered) {
          // press on the track: jump, then keep dragging
          st.v = min + clamp((s.mouse.x - pos.x) / w, 0, 1) * (max - min);
          st._dragging = true;
          s.drag = { type: 'grab', st, px: pos.x, pw: w };
          s.activeId = -1;
        } else if (st._dragging) {
          // release frame: the core already cleared s.drag at frame start,
          // so keep the value the drag produced (the caller writes the
          // return value back and owns it from the next frame)
          st._dragging = false;
        } else {
          // idle: follow the value the caller passed in
          st.v = v;
        }
        gui._advance(pos.x, pos.y, w, h);
        return clamp(st.v, min, max);
      },

      /** Animated arc + label. Advances one line of layout. */
      spinner(label, opts) {
        opts = opts || {};
        const size = opts.size > 0 ? opts.size : 14;
        const fo = gui._fo();
        const lineH = gui._lineH();
        const pos = gui._nextPos();
        const avail = gui.getRegionAvail();
        const h = Math.max(size + 4, lineH);
        // angle from the gui clock: two full turns per second
        const now = gui.state.now / 1000;
        const ang = (now * 4 * Math.PI) % (Math.PI * 2);
        const cx = pos.x + size / 2 + 2;
        const cy = pos.y + h / 2;
        const rad = size / 2;
        // arc as a polyline (12 segments of a 3/4 turn)
        const pts = [];
        for (let i = 0; i <= 12; i++) {
          const a = ang + (i / 12) * Math.PI * 1.5;
          pts.push(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
        }
        r.polyline(pts, col(opts.color || 'sliderGrab'), 2);
        const label2 = String(label == null ? '' : label);
        if (label2) gui._drawText(pos.x + size + 10, pos.y + (h - lineH) / 2 + 1, label2, col('textDisabled'), fo);
        const w = opts.w > 0 ? opts.w : Math.max(size + 10 + (label2 ? gui._measure(label2, fo).w : 0), avail.w);
        gui._advance(pos.x, pos.y, w, h);
      },

      /** Small filled circle + inline text (imgui Bullet). */
      bullet(text, opts) {
        opts = opts || {};
        const fo = gui._fo();
        const lineH = gui._lineH();
        const pos = gui._nextPos();
        const rad = 2.5;
        const cx = pos.x + rad + 2;
        const cy = pos.y + lineH / 2 - 1;
        r.fillCircle(cx, cy, rad, col(opts.color || 'text', 0.9));
        const label2 = String(text == null ? '' : text);
        if (label2) gui._drawText(pos.x + rad * 2 + 8, pos.y + 1, label2, col('text'), fo);
        // the bullet is a full-width line unless the caller opts out with w
        const w = opts.w > 0 ? opts.w : gui.getRegionAvail().w;
        gui._advance(pos.x, pos.y, w, lineH);
      },
    };
  });
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
