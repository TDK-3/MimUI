/**
 * A color picker: swatch button + inline picker with a 2D saturation/value
 * pad, a hue bar, an optional alpha slider, a validating hex field and a
 * preset palette. Colors are [r, g, b, a] arrays (0..255); a semi-
 * transparent swatch is drawn over a checkerboard.
 * @namespace gui.addons.color
 */
/**
 * Color swatch button; clicking it opens the inline picker below. The
 * picker sizes itself to fit its rows exactly (no internal scrollbar).
 * @function gui.addons.color.colorButton
 * @param {string} label
 * @param {number[]} color current [r, g, b, a] (alpha optional)
 * @param {Object} [opts]
 * @param {boolean} [opts.presets] draw the preset palette
 * @param {boolean} [opts.alpha] add the alpha slider (also enabled by a
 *   transparent input color)
 * @param {number} [opts.w] swatch width
 * @returns {number[]} the (possibly new) [r, g, b, a] — the returned alpha
 *   is the picked one with { alpha: true }, otherwise the input alpha
 */

/**
 * Normalizes a color to [r, g, b, a]: accepts [r,g,b(,a)], '#hex' strings
 * and {r, g, b, a} objects (a in 0..1 or 0..255).
 * @function gui.addons.color.norm
 * @param {*} c
 * @returns {number[]}
 */

/**
 * Formats [r, g, b, a] as '#rrggbbaa' (alpha omitted when fully opaque).
 * @function gui.addons.color.toHex
 * @param {number[]} c
 * @returns {string}
 */

/**
 * Parses '#rgb'/'#rrggbb'/'#rgba'/'#rrggbbaa' into [r, g, b, a]
 * (null for invalid input).
 * @function gui.addons.color.fromHex
 * @param {string} str
 * @returns {number[]|null}
 */

/* mim_color.js — color widgets for Mim (swatch button + inline picker).
 * ------------------------------------------------------------------
 * STB-style, dependency-free. Load after mim.js, then use `gui.addons.color`:
 *
 *   gui.addons.color.colorButton('window bg', color, opts);
 *       color: [r, g, b(, a)] (0..255) or '#rrggbb' / '#rgb'.
 *       Returns the current color as [r, g, b, a]. Write the return value
 *       back to your state each frame (immediate mode). Clicking the swatch
 *       opens an inline picker and closes it again. Invalid input (bad hex,
 *       non-numeric) falls back gracefully and never corrupts the last
 *       valid color.
 *       opts:
 *         presets (bool, default true) — row of preset swatches.
 *         alpha   (bool, default false) — adds an alpha slider; the return
 *                 value then carries the picked alpha (before that it is
 *                 taken from the input color). The swatch is drawn over a
 *                 checkerboard whenever the alpha is not fully opaque.
 *       The picker itself is a classic square: a 2D saturation/value pad
 *       (drag inside it), a hue bar (drag on it), an optional alpha slider,
 *       a hex field and the presets. Everything is drawn through the
 *       renderer (gradients are approximated with thin strips, so any
 *       backend works).
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
  "use strict";
  const Mim = root.Mim;
  if (!Mim) return;

  function clamp255(v) {
    return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
  function clamp01c(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  function fromHex(str) {
    if (typeof str !== "string") return null;
    let s = str.trim().replace(/^#/, "");
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (s.length !== 6 || /[^\da-fA-F]/.test(s)) return null;
    return [
      parseInt(s.slice(0, 2), 16),
      parseInt(s.slice(2, 4), 16),
      parseInt(s.slice(4, 6), 16),
    ];
  }

  function toHex(c) {
    const h = (v) => ("0" + clamp255(v).toString(16)).slice(-2);
    return "#" + h(c[0]) + h(c[1]) + h(c[2]);
  }

  function norm(color) {
    if (Array.isArray(color) && color.length >= 3) {
      const a = color.length > 3 ? clamp255(color[3]) : 255;
      return [
        clamp255(+color[0] || 0),
        clamp255(+color[1] || 0),
        clamp255(+color[2] || 0),
        a,
      ];
    }
    if (typeof color === "string") {
      const h = fromHex(color);
      if (h) return [h[0], h[1], h[2], 255];
    }
    return [128, 128, 128, 255]; // anything invalid -> neutral gray
  }

  function rgb2hsv(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;
    const mx = Math.max(r, g, b),
      mn = Math.min(r, g, b),
      d = mx - mn;
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
    const i = Math.floor(h),
      f = h - i;
    const p = v * (1 - s),
      q = v * (1 - f * s),
      t = v * (1 - (1 - f) * s);
    let r, g, b;
    switch (i % 6) {
      case 0:
        r = v;
        g = t;
        b = p;
        break;
      case 1:
        r = q;
        g = v;
        b = p;
        break;
      case 2:
        r = p;
        g = v;
        b = t;
        break;
      case 3:
        r = p;
        g = q;
        b = v;
        break;
      case 4:
        r = t;
        g = p;
        b = v;
        break;
      default:
        r = v;
        g = p;
        b = q;
        break;
    }
    return [clamp255(r * 255), clamp255(g * 255), clamp255(b * 255)];
  }

  const PRESETS = [
    "#1e1f24",
    "#2b4a8b",
    "#c8503c",
    "#67d47e",
    "#ffb454",
    "#b07fe8",
    "#54c8d0",
    "#e8e8e8",
  ];

  Mim.registerAddon("color", function (gui, M) {
    const r = gui.renderer;

    return {
      norm,
      toHex,
      fromHex,

      /** Color swatch button + inline picker. Returns [r, g, b, a]. */
      colorButton(label, color, opts) {
        opts = opts || {};
        const fo = gui._fo();
        const lineH = gui._lineH();
        const pos = gui._nextPos();
        const avail = gui.getRegionAvail();
        const w = opts.w > 0 ? opts.w : Math.max(60, avail.w);
        const st = gui._state("##colorbtn" + label);
        const cur = norm(color);
        if (!st.hsv) st.hsv = rgb2hsv(cur[0], cur[1], cur[2]);
        if (!st.hex) st.hex = toHex(cur);

        const s = gui.state;
        const hasAlpha = opts.alpha === true;

        // the pad/hue drags write straight into st.hsv while the mouse
        // is held (mirrors the plotBezier drag pattern)
        if (
          s.drag &&
          s.drag.type === "color-sv" &&
          s.drag.st === st &&
          gui.isMouseDown(0)
        ) {
          const rel = {
            x: (s.mouse.x - s.drag.px) / s.drag.pw,
            y: (s.mouse.y - s.drag.py) / s.drag.ph,
          };
          st.hsv[1] = rel.x < 0 ? 0 : rel.x > 1 ? 1 : rel.x;
          st.hsv[2] = rel.y < 0 ? 0 : rel.y > 1 ? 1 : 1 - rel.y;
          st.hex = toHex(hsv2rgb(st.hsv[0], st.hsv[1], st.hsv[2]));
          gui._setCursor("grabbing", 2);
        }
        if (
          s.drag &&
          s.drag.type === "color-hue" &&
          s.drag.st === st &&
          gui.isMouseDown(0)
        ) {
          st.hsv[0] =
            (s.mouse.x - s.drag.px) / s.drag.pw < 0
              ? 0
              : (s.mouse.x - s.drag.px) / s.drag.pw > 1
                ? 359.9
                : ((s.mouse.x - s.drag.px) / s.drag.pw) * 360;
          st.hex = toHex(hsv2rgb(st.hsv[0], st.hsv[1], st.hsv[2]));
          gui._setCursor("ew-resize", 2);
        }

        // ---- swatch row (label + clickable swatch) ----
        const rowH = Math.max(20, lineH + 6);
        const sw = 14;
        const lx = pos.x,
          ly = pos.y;
        const it = gui._item(lx, ly, w, rowH, gui._id("##cb" + label).itemId, {
          focusable: false,
        });
        if (it.visible) {
          const swX = lx + w - sw - 2;
          const swY = ly + (rowH - sw) / 2;
          if (hasAlpha || cur[3] < 255) {
            // checkerboard behind the swatch so transparency is visible
            for (let cy2 = 0; cy2 < 2; cy2++) {
              for (let cx2 = 0; cx2 < 2; cx2++) {
                const dark = (cx2 + cy2) % 2 === 0;
                r.fillRect(
                  swX + cx2 * 7,
                  swY + cy2 * 7,
                  Math.min(7, sw - cx2 * 7),
                  Math.min(7, sw - cy2 * 7),
                  dark ? [96, 96, 96, 255] : [200, 200, 200, 255],
                );
              }
            }
          }
          r.fillRoundedRect(swX, swY, sw, sw, 3, cur); // 4-component color (alpha required by the renderer)
          r.strokeRoundedRect(
            swX + 0.5,
            swY + 0.5,
            sw - 1,
            sw - 1,
            3,
            gui._col("border"),
            1,
          );
          const tx = lx + 2;
          const maxW = swX - tx - 8;
          let shown = String(label);
          while (
            shown.length > 4 &&
            gui._measure(shown + "\u2026", fo).w > maxW
          )
            shown = shown.slice(0, -1);
          if (shown !== String(label)) shown += "\u2026";
          gui._drawText(
            tx,
            ly + (rowH - lineH) / 2 + 1,
            shown,
            gui._col("textDisabled"),
            fo,
          );
          if (it.hovered)
            r.strokeRoundedRect(
              lx + 0.5,
              ly + 0.5,
              w - 1,
              rowH - 1,
              4,
              gui._col("border", 0.8),
              1,
            );
        }
        const clicked =
          gui.isMouseClicked(0) &&
          s.activeId === 0 &&
          !s.drag &&
          s.disabledCount === 0;
        if (clicked && it.hovered) {
          st.open = !st.open;
          s.activeId = -1;
        }
        gui._advance(lx, ly, w, rowH);

        // ---- inline picker (bordered child region) ----
        if (st.open) {
          const hasPresets = opts.presets !== false;
          const PAD_H = 110; // saturation/value pad height
          const HUE_H = 12; // hue bar height
          const PRESET_CELL = 18;
          // Auto-size the child to fit its rows exactly (pad, hue, optional
          // alpha, hex, optional presets): no scrollbar, no clipping.
          const frameH = lineH + gui._var("framePadding")[1] * 2;
          const sp1 = gui._var("itemSpacing")[1];
          let innerH = PAD_H + sp1 + HUE_H + sp1 + frameH; // pad, hue, hex
          if (hasAlpha) innerH += sp1 + frameH;
          if (hasPresets) innerH += sp1 + PRESET_CELL + 6;
          // + 2*padding for the child frame, + one padding for endChild's
          // bottom-padding scroll allowance (maxScrollY = contentH + padY - visH)
          const ch = innerH + 18;
          if (
            gui.beginChild("##colorpick" + label, { w: -4, h: ch, padding: 6 })
          ) {
            const padW = gui.getRegionAvail().w;
            const strips = 24; // gradients are thin strips: any backend works

            // -- saturation/value pad (the "picker square") --
            const pp = gui._nextPos();
            const hueFull = hsv2rgb(st.hsv[0], 1, 1);
            r.fillRect(pp.x, pp.y, padW, PAD_H, [
              hueFull[0],
              hueFull[1],
              hueFull[2],
              255,
            ]);
            for (let i = 0; i < strips; i++) {
              r.fillRect(
                pp.x + (i * padW) / strips,
                pp.y,
                padW / strips + 1,
                PAD_H,
                [255, 255, 255, Math.round(255 * (1 - i / strips))],
              );
            }
            for (let i = 0; i < strips; i++) {
              r.fillRect(
                pp.x,
                pp.y + (i * PAD_H) / strips,
                padW,
                PAD_H / strips + 1,
                [0, 0, 0, Math.round(255 * (i / strips))],
              );
            }
            const curX = pp.x + st.hsv[1] * padW;
            const curY = pp.y + (1 - st.hsv[2]) * PAD_H;
            r.strokeRoundedRect(
              curX - 5.5,
              curY - 5.5,
              11,
              11,
              5.5,
              [0, 0, 0, 190],
              1.4,
            );
            r.strokeRoundedRect(
              curX - 4,
              curY - 4,
              8,
              8,
              4,
              [255, 255, 255, 255],
              1.6,
            );
            const inPad =
              s.mouse.x >= pp.x &&
              s.mouse.x < pp.x + padW &&
              s.mouse.y >= pp.y &&
              s.mouse.y < pp.y + PAD_H;
            if (clicked && inPad && !s.drag) {
              st.hsv[1] = clamp01c((s.mouse.x - pp.x) / padW);
              st.hsv[2] = 1 - clamp01c((s.mouse.y - pp.y) / PAD_H);
              st.hex = toHex(hsv2rgb(st.hsv[0], st.hsv[1], st.hsv[2]));
              s.drag = {
                type: "color-sv",
                st,
                px: pp.x,
                py: pp.y,
                pw: padW,
                ph: PAD_H,
              };
              s.activeId = -1;
            }
            gui._advance(pp.x, pp.y, padW, PAD_H);

            // -- hue bar --
            const hp = gui._nextPos();
            for (let i = 0; i < strips; i++) {
              const hueC = hsv2rgb((i / (strips - 1)) * 360, 1, 1);
              r.fillRect(
                hp.x + (i * padW) / strips,
                hp.y,
                padW / strips + 1,
                HUE_H,
                [hueC[0], hueC[1], hueC[2], 255],
              );
            }
            const hueX = hp.x + (st.hsv[0] / 360) * padW;
            r.strokeRoundedRect(
              hueX - 2.5,
              hp.y - 2,
              5,
              HUE_H + 4,
              2.5,
              [255, 255, 255, 255],
              1.6,
            );
            const inHue =
              s.mouse.x >= hp.x &&
              s.mouse.x < hp.x + padW &&
              s.mouse.y >= hp.y - 4 &&
              s.mouse.y < hp.y + HUE_H + 4;
            if (clicked && inHue && !s.drag) {
              st.hsv[0] = clamp01c((s.mouse.x - hp.x) / padW) * 360;
              st.hex = toHex(hsv2rgb(st.hsv[0], st.hsv[1], st.hsv[2]));
              s.drag = { type: "color-hue", st, px: hp.x, pw: padW };
              s.activeId = -1;
            }
            gui._advance(hp.x, hp.y, padW, HUE_H);

            // -- optional alpha slider --
            if (hasAlpha) {
              if (st.a == null) st.a = cur[3] / 255;
              st.a = gui.sliderFloat("alpha", st.a, 0, 1, 0.001);
            }

            // hex field: raw text is kept while typing; the color only
            // updates once the text parses as valid hex (never corrupts).
            // Only re-parse when the user actually changed the text —
            // otherwise the pad's own rounded value would feed back into
            // HSV and quantize the drag.
            const hexGiven = st.hex;
            const hex = gui.inputText("hex", hexGiven);
            if (hex !== hexGiven) {
              st.hex = hex;
              const parsed = fromHex(hex);
              if (parsed) st.hsv = rgb2hsv(parsed[0], parsed[1], parsed[2]);
            }

            if (hasPresets) {
              const gap = 4;
              let cx = pos.x + 8;
              const cy = gui.getCursorScreenPos().y;
              for (const p of PRESETS) {
                if (cx + PRESET_CELL > pos.x + avail.w) break;
                r.fillRoundedRect(
                  cx,
                  cy,
                  PRESET_CELL,
                  PRESET_CELL,
                  3,
                  M.Color.hex(p),
                );
                r.strokeRoundedRect(
                  cx + 0.5,
                  cy + 0.5,
                  PRESET_CELL - 1,
                  PRESET_CELL - 1,
                  3,
                  gui._col("border", 0.8),
                  1,
                );
                const cellIt = gui._item(
                  cx,
                  cy,
                  PRESET_CELL,
                  PRESET_CELL,
                  gui._id("##cpre" + label + p).itemId,
                  { focusable: false },
                );
                if (cellIt.visible && cellIt.hovered)
                  r.strokeRoundedRect(
                    cx + 0.5,
                    cy + 0.5,
                    PRESET_CELL - 1,
                    PRESET_CELL - 1,
                    3,
                    gui._col("text", 0.9),
                    1.4,
                  );
                if (clicked && cellIt.hovered) {
                  const pr = M.Color.hex(p);
                  st.hsv = rgb2hsv(pr[0], pr[1], pr[2]);
                  st.hex = p;
                  s.activeId = -1;
                }
                cx += PRESET_CELL + gap;
              }
              gui.dummy(avail.w, PRESET_CELL + 6);
            }
            gui.endChild();
          }
        }

        const rgb = hsv2rgb(st.hsv[0], st.hsv[1], st.hsv[2]);
        // alpha: the picked value when the alpha slider is enabled;
        // otherwise the input color's alpha is preserved (never silently
        // changed)
        const outA = hasAlpha
          ? st.a == null
            ? cur[3]
            : clamp255(st.a * 255)
          : cur[3] != null
            ? cur[3]
            : 255;
        return [rgb[0], rgb[1], rgb[2], outA];
      },
    };
  });
})(
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof self !== "undefined"
      ? self
      : this,
);
