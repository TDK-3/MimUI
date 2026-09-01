/* mim_color.js — color widgets for Mim (swatch button + inline picker).
 * ------------------------------------------------------------------
 * STB-style, dependency-free. Load after mim.js, then use `gui.addons.color`:
 *
 *   gui.addons.color.colorButton('window bg', color, { presets: true });
 *       color: [r, g, b(, a)] (0..255) or '#rrggbb' / '#rgb'.
 *       Returns the current color as [r, g, b, a] (alpha is preserved from
 *       the input; the picker edits H / S / V only). Write the return value
 *       back to your state each frame (immediate mode). Clicking the swatch
 *       opens an inline picker (H / S / V sliders, hex field, presets) and
 *       closes it again. Invalid input (bad hex, non-numeric) falls back
 *       gracefully and never corrupts the last valid color.
 *   gui.addons.color.norm(color)  -> [r, g, b, a]  (sanitized)
 *   gui.addons.color.toHex(color) -> '#rrggbb'
 *   gui.addons.color.fromHex(str) -> [r, g, b] | null
 *
 * Uses the documented addon surface: gui._col, gui._fo, gui._lineH,
 * gui._nextPos, gui._advance, gui._drawText, gui._item, gui.getRegionAvail,
 * gui.sliderFloat, gui.inputText, gui.beginChild, gui.endChild, gui.state,
 * gui.renderer.
 */
(function (root) {
  'use strict';
  const Mim = root.Mim;
  if (!Mim) return;

  function clamp255(v) { return v < 0 ? 0 : v > 255 ? 255 : Math.round(v); }

  function fromHex(str) {
    if (typeof str !== 'string') return null;
    let s = str.trim().replace(/^#/, '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (s.length !== 6 || /[^\da-fA-F]/.test(s)) return null;
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }

  function toHex(c) {
    const h = (v) => ('0' + clamp255(v).toString(16)).slice(-2);
    return '#' + h(c[0]) + h(c[1]) + h(c[2]);
  }

  function norm(color) {
    if (Array.isArray(color) && color.length >= 3) {
      const a = color.length > 3 ? clamp255(color[3]) : 255;
      return [clamp255(+color[0] || 0), clamp255(+color[1] || 0), clamp255(+color[2] || 0), a];
    }
    if (typeof color === 'string') {
      const h = fromHex(color);
      if (h) return [h[0], h[1], h[2], 255];
    }
    return [128, 128, 128, 255]; // anything invalid -> neutral gray
  }

  function rgb2hsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let h = 0;
    if (d) {
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    return [h, mx ? d / mx : 0, mx];
  }

  function hsv2rgb(h, s, v) {
    h = (((h % 360) + 360) % 360) / 60;
    const i = Math.floor(h), f = h - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    let r, g, b;
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break;
      case 1: r = q; g = v; b = p; break;
      case 2: r = p; g = v; b = t; break;
      case 3: r = p; g = q; b = v; break;
      case 4: r = t; g = p; b = v; break;
      default: r = v; g = p; b = q; break;
    }
    return [clamp255(r * 255), clamp255(g * 255), clamp255(b * 255)];
  }

  const PRESETS = ['#1e1f24', '#2b4a8b', '#c8503c', '#67d47e', '#ffb454', '#b07fe8', '#54c8d0', '#e8e8e8'];

  Mim.registerAddon('color', function (gui, M) {
    const r = gui.renderer;

    return {
      norm, toHex, fromHex,

      /** Color swatch button + inline picker. Returns [r, g, b, a]. */
      colorButton(label, color, opts) {
        opts = opts || {};
        const fo = gui._fo();
        const lineH = gui._lineH();
        const pos = gui._nextPos();
        const avail = gui.getRegionAvail();
        const w = opts.w > 0 ? opts.w : Math.max(60, avail.w);
        const st = gui._state('##colorbtn' + label);
        const cur = norm(color);
        if (!st.hsv) st.hsv = rgb2hsv(cur[0], cur[1], cur[2]);
        if (!st.hex) st.hex = toHex(cur);

        const s = gui.state;

        // ---- swatch row (label + clickable swatch) ----
        const rowH = Math.max(20, lineH + 6);
        const sw = 14;
        const lx = pos.x, ly = pos.y;
        const it = gui._item(lx, ly, w, rowH, gui._id('##cb' + label).itemId, { focusable: false });
        if (it.visible) {
          const swX = lx + w - sw - 2;
          r.fillRoundedRect(swX, ly + (rowH - sw) / 2, sw, sw, 3, cur); // 4-component color (alpha required by the renderer)
          r.strokeRoundedRect(swX + 0.5, ly + (rowH - sw) / 2 + 0.5, sw - 1, sw - 1, 3, gui._col('border'), 1);
          const tx = lx + 2;
          const maxW = swX - tx - 8;
          let shown = String(label);
          while (shown.length > 4 && gui._measure(shown + '\u2026', fo).w > maxW) shown = shown.slice(0, -1);
          if (shown !== String(label)) shown += '\u2026';
          gui._drawText(tx, ly + (rowH - lineH) / 2 + 1, shown, gui._col('textDisabled'), fo);
          if (it.hovered) r.strokeRoundedRect(lx + 0.5, ly + 0.5, w - 1, rowH - 1, 4, gui._col('border', 0.8), 1);
        }
        const clicked = gui.isMouseClicked(0) && s.activeId === 0 && !s.drag && s.disabledCount === 0;
        if (clicked && it.hovered) { st.open = !st.open; s.activeId = -1; }
        gui._advance(lx, ly, w, rowH);

        // ---- inline picker (bordered child region) ----
        if (st.open) {
          const hasPresets = opts.presets !== false;
          const ch = (lineH + 8) * 4 + (hasPresets ? 26 : 0) + 10;
          if (gui.beginChild('##colorpick' + label, { w: -4, h: ch, padding: 6 })) {
            const hn = gui.sliderFloat('H', st.hsv[0], 0, 360);
            const sn = gui.sliderFloat('S', st.hsv[1], 0, 1, 0.001);
            const vn = gui.sliderFloat('V', st.hsv[2], 0, 1, 0.001);
            const rgb = hsv2rgb(hn, sn, vn);
            st.hsv = rgb2hsv(rgb[0], rgb[1], rgb[2]);
            st.hex = toHex(rgb);

            // hex field: raw text is kept while typing; the color only
            // updates once the text parses as valid hex (never corrupts)
            const hex = gui.inputText('hex', st.hex);
            st.hex = hex;
            const parsed = fromHex(hex);
            if (parsed) st.hsv = rgb2hsv(parsed[0], parsed[1], parsed[2]);

            if (hasPresets) {
              const cell = 18, gap = 4;
              let cx = pos.x + 8;
              const cy = gui.getCursorScreenPos().y;
              for (const p of PRESETS) {
                if (cx + cell > pos.x + avail.w) break;
                r.fillRoundedRect(cx, cy, cell, cell, 3, M.Color.hex(p));
                r.strokeRoundedRect(cx + 0.5, cy + 0.5, cell - 1, cell - 1, 3, gui._col('border', 0.8), 1);
                const cellIt = gui._item(cx, cy, cell, cell, gui._id('##cpre' + label + p).itemId, { focusable: false });
                if (cellIt.visible && cellIt.hovered) r.strokeRoundedRect(cx + 0.5, cy + 0.5, cell - 1, cell - 1, 3, gui._col('text', 0.9), 1.4);
                if (clicked && cellIt.hovered) {
                  const pr = M.Color.hex(p);
                  st.hsv = rgb2hsv(pr[0], pr[1], pr[2]);
                  st.hex = p;
                  s.activeId = -1;
                }
                cx += cell + gap;
              }
              gui.dummy(avail.w, cell + 6);
            }
            gui.endChild();
          }
        }

        const rgb = hsv2rgb(st.hsv[0], st.hsv[1], st.hsv[2]);
        return [rgb[0], rgb[1], rgb[2], cur[3] != null ? cur[3] : 255];
      },
    };
  });
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
