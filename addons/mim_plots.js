/* mim_plots.js — plotting addon for Mim (2D: bezier, polar, heatmap).
 * ------------------------------------------------------------------
 * STB-style, dependency-free. Load after mim.js (same scope rules), then
 * use the methods on `gui.addons.plots`. Everything is drawn through the
 * renderer interface; call these inside an open window.
 *
 *   gui.addons.plots.plotBezier('curve', null, { h: 220 });
 *       pts argument: [[x, y], ...] in pixels relative to the plot box,
 *       or null for a persistent, user-editable curve (drag the dots).
 *       Returns the current point list.
 *   gui.addons.plots.plotPolar('rose', (t) => 0.5 + 0.5 * Math.sin(4 * t), { h: 200 });
 *   gui.addons.plots.plotHeatmap('field', data2D, { h: 160 });
 *       data2D: number[][] (rows x cols)
 *
 * Supported internal API used here: gui._col, gui._fo, gui._lineH,
 * gui._nextPos, gui._advance, gui._drawText, gui._item, gui.getRegionAvail,
 * gui.state (mouse), gui.renderer. See the "Addons" README section.
 */
(function (root) {
  'use strict';
  const Mim = root.Mim;
  if (!Mim) return;

  Mim.registerAddon('plots', function (gui, M) {
    const r = gui.renderer;

    function col(name, a) {
      const c = gui._col(name);
      return a == null ? c : M.Color.withAlpha(c, Math.round(a * 255));
    }

    const PALETTE = ['#4f8cff', '#ffb454', '#67d47e', '#e46264', '#b07fe8', '#54c8d0'];

    function fmtNum(v) {
      if (v == null || !isFinite(v)) return '\u2014';
      const a = Math.abs(v);
      if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
      if (a >= 1e3) return (v / 1e3).toFixed(1) + 'k';
      if (a >= 100) return v.toFixed(0);
      if (a >= 1) return v.toFixed(1);
      return v.toFixed(2);
    }

    /* Reserve (and frame) a plot box; returns { x, y, w, h, inner }. */
    /* Even share/fill heights: opts.h wins; opts.share: n splits the region
       among n sibling plots (tracked per window per frame so every member
       gets exactly its share); otherwise fill the rest. */
    function shareHeight(opts, minH, avail, extra) {
      extra = extra || 0;
      const s = gui.state;
      const sp = gui._var('itemSpacing');
      if (opts.share > 0) {
        if (s._shareFrame !== s.frameId) { s._shareFrame = s.frameId; s._shareGroups = {}; }
        const cont = s.layout && s.layout.container;
        const key = (cont && (cont.title || cont.label) || '') + ':' + opts.share;
        let g = s._shareGroups[key];
        if (!g) { g = { n: opts.share, avail0: avail }; s._shareGroups[key] = g; }
        // safety margin: content bookkeeping (trailing spacing + padding
        // rounding) exceeds the raw avail by ~one spacing — stay clear of
        // the scrollbar rather than overflow it
        const ideal = (g.avail0 - g.n * (extra + sp[1]) - sp[1] - 20) / g.n;
        return Math.max(minH, Math.min(ideal, avail));
      }
      return Math.max(minH, avail);
    }

    function plotFrame(label, opts) {
      opts = opts || {};
      const fo = gui._fo();
      const lineH = gui._lineH();
      const pos = gui._nextPos();
      const avail = gui.getRegionAvail();
      const w = opts.w > 0 ? opts.w : Math.max(60, avail.w);
      // height: explicit px wins; otherwise the plot SCALES with the window:
      // share: n  -> 1/n of the remaining space (split among siblings)
      // no h/share -> fill all remaining space
      let h;
      if (opts.h > 0) h = opts.h;
      else h = shareHeight(opts, 48, avail.h, opts.label !== false ? lineH : 0);
      let top = pos.y;
      if (opts.label !== false) {
        gui._drawText(pos.x, pos.y, label, col('textDisabled'), fo);
        gui._advance(pos.x, pos.y, w, lineH);
        top = gui._nextPos().y;
      }
      const box = { x: pos.x, y: top, w, h };
      r.fillRect(box.x, box.y, w, h, col('childBg'));
      // 5x5 grid
      for (let i = 1; i < 5; i++) {
        r.line(box.x + 3, box.y + (h * i) / 5, box.x + w - 3, box.y + (h * i) / 5, col('border', 0.25), 1);
        r.line(box.x + (w * i) / 5, box.y + 3, box.x + (w * i) / 5, box.y + h - 3, col('border', 0.25), 1);
      }
      r.strokeRoundedRect(box.x + 0.5, box.y + 0.5, w - 1, h - 1, 4, col('border'), 1);
      gui._advance(pos.x, top, w, h);
      box.inner = { x: box.x + 3, y: box.y + 3, w: box.w - 6, h: box.h - 6 };
      return box;
    }

    /* Catmull-Rom through all points, sampled to bezier-style polyline. */
    function sampleCurve(pts, perSeg) {
      perSeg = perSeg || 16;
      const out = [];
      const n = pts.length;
      if (n < 2) return out;
      if (n === 2) {
        for (let i = 0; i <= perSeg; i++) {
          const t = i / perSeg;
          out.push([pts[0][0] + (pts[1][0] - pts[0][0]) * t, pts[0][1] + (pts[1][1] - pts[0][1]) * t]);
        }
        return out;
      }
      for (let i = 0; i < n - 1; i++) {
        const p0 = pts[Math.max(0, i - 1)];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[Math.min(n - 1, i + 2)];
        for (let j = 0; j < perSeg; j++) {
          const t = j / perSeg, t2 = t * t, t3 = t2 * t;
          out.push([
            0.5 * (2 * p1[0] + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3),
            0.5 * (2 * p1[1] + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3),
          ]);
        }
      }
      out.push([pts[n - 1][0], pts[n - 1][1]]);
      return out;
    }

    return {
      plotFrame,

      /** Bar chart. values: number[] or [label, value][] — non-finite entries
       *  are dropped, zero is drawn as the baseline, negative values hang
       *  below it. Hovering a bar shows its value. Scales with the window
       *  (see plotFrame h/share). */
      plotBars(label, values, opts) {
        opts = opts || {};
        const box = plotFrame(label, opts);
        const I = box.inner;
        const data = (values || [])
          .map((v, i) => (Array.isArray(v) ? [v[0], v[1]] : [i, v]))
          .filter((d) => isFinite(d[1]));
        if (!data.length) return box;
        let mn = Math.min(0, ...data.map((d) => d[1]));
        let mx = Math.max(0, ...data.map((d) => d[1]));
        if (opts.min != null) mn = opts.min;
        if (opts.max != null) mx = opts.max;
        if (mx <= mn) mx = mn + 1;
        const n = data.length;
        const gap = Math.min(6, I.w / (n * 2));
        const bw = Math.max(1, (I.w - gap * (n + 1)) / n);
        const baseY = I.y + I.h * (mx - 0) / (mx - mn);
        const mo = gui.state.mouse;
        let hov = -1;
        data.forEach((d, i) => {
          const x = I.x + gap + i * (bw + gap);
          const yv = I.y + I.h * (mx - d[1]) / (mx - mn);
          const y0 = Math.max(I.y, Math.min(I.y + I.h, baseY));
          const top = Math.min(yv, y0), hgt = Math.max(0.5, Math.abs(yv - y0));
          const inBar = mo.x >= x && mo.x < x + bw && mo.y >= top && mo.y <= top + hgt;
          r.fillRect(x, top, bw, hgt, col(opts.color || (inBar ? 'headerActive' : 'sliderGrab')));
          if (inBar) hov = i;
        });
        if (baseY > I.y + 0.5 && baseY < I.y + I.h - 0.5) r.line(I.x, baseY, I.x + I.w, baseY, col('border', 0.6), 1);
        if (hov >= 0) {
          const t = (typeof data[hov][0] === 'string' ? data[hov][0] + ': ' : '') + fmtNum(data[hov][1]);
          const fo = gui._fo();
          const m = gui._measure(t, fo);
          gui._drawText(box.x + box.w - m.w - 5, box.y + 2, t, col('text'), fo);
        }
        return box;
      },

      /** Multi-series line chart. series: [{ name, values: number[], color? }]
       *  — shared auto min/max, series may differ in length, non-finite gaps
       *  break the line, a legend is drawn when 2+ series. Hovering shows the
       *  nearest sample of every series. Scales with the window. */
      plotSeries(label, series, opts) {
        opts = opts || {};
        const clean = (series || [])
          .filter((s0) => s0 && s0.values)
          .map((s0, i) => ({ name: s0.name || ('s' + (i + 1)), color: s0.color || null, v: s0.values }));
        let mn = Infinity, mx = -Infinity;
        for (const s0 of clean) for (const v of s0.v) if (isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; }
        if (!isFinite(mn)) { mn = 0; mx = 1; }
        if (opts.min != null) mn = opts.min;
        if (opts.max != null) mx = opts.max;
        if (mx <= mn) mx = mn + 1;
        const box = plotFrame(label, opts);
        const fo = gui._fo();
        const I0 = box.inner;
        const legendH = clean.length > 1 ? gui._lineH() + 2 : 0;
        const I = { x: I0.x, y: I0.y + legendH, w: I0.w, h: Math.max(1, I0.h - legendH) };
        let lx = I0.x;
        clean.forEach((s0, i) => {
          const c = s0.color ? M.Color.hex(s0.color) : M.Color.hex(PALETTE[i % PALETTE.length]);
          r.line(lx, I0.y + 4, lx + 10, I0.y + 4, c, 2);
          const t = String(s0.name);
          gui._drawText(lx + 13, I0.y - gui._lineH() + 4, t, col('textDisabled'), fo);
          lx += 13 + gui._measure(t, fo).w + 10;
        });
        const maxLen = Math.max(1, ...clean.map((s0) => s0.v.length));
        const X = (i) => I.x + (maxLen <= 1 ? I.w / 2 : (i / (maxLen - 1)) * I.w);
        const Y = (v) => I.y + I.h - ((v - mn) / (mx - mn)) * I.h;
        clean.forEach((s0, i) => {
          const c = s0.color ? M.Color.hex(s0.color) : M.Color.hex(PALETTE[i % PALETTE.length]);
          let run = [];
          const flush = () => { if (run.length >= 4) r.polyline(run, c, 1.5); run = []; };
          s0.v.forEach((v, i2) => {
            if (!isFinite(v)) { flush(); return; }
            run.push(X(i2), Y(v));
            if (s0.v.length <= 24) r.fillCircle(X(i2), Y(v), 2, c);
          });
          flush();
        });
        // hover: nearest sample of every series
        const mo = gui.state.mouse;
        if (mo.x >= I.x && mo.x < I.x + I.w && mo.y >= I.y && mo.y < I.y + I.h && clean.some((s0) => s0.v.length > 1)) {
          const idx = Math.round(((mo.x - I.x) / I.w) * (maxLen - 1));
          const vx = X(idx);
          r.line(vx, I.y, vx, I.y + I.h, col('text', 0.4), 1);
          let t = '';
          for (const s0 of clean) {
            const v = s0.v[idx];
            if (isFinite(v)) t += (t ? '  ' : '') + s0.name + ' ' + fmtNum(v);
          }
          if (t) {
            const m = gui._measure(t, fo);
            gui._drawText(box.x + box.w - m.w - 5, box.y + 2, t, col('text'), fo);
          }
        }
        return box;
      },

      /** Interactive bezier curve. pts == null -> persistent draggable dots. */
      plotBezier(label, pts, opts) {
        opts = opts || {};
        const box = plotFrame(label, opts);
        const st = gui._state('##bezier' + label);
        const I = box.inner;
        // persistent points are stored NORMALIZED (0..1 inside the inner
        // rect) so the curve rescales with the window; the drag writes
        // normalized coords. (v1 state stored box-relative pixels: migrate.)
        if (st.ptsN) { /* current format */ }
        else if (st.pts) {
          st.ptsN = st.pts.map((p) => [clampXY(p[0] / I.w, 0, 1), clampXY(p[1] / I.h, 0, 1)]);
          delete st.pts;
        } else if (opts.defaultPts) {
          st.ptsN = opts.defaultPts.map((p) => [clampXY(p[0], 0, 1), clampXY(p[1], 0, 1)]);
        } else {
          st.ptsN = [[0.12, 0.75], [0.38, 0.15], [0.62, 0.85], [0.88, 0.25]];
        }
        const stored = st.ptsN;
        const toPx = (p) => [I.x + p[0] * I.w, I.y + p[1] * I.h];
        let pts2 = pts ? pts.map((p) => [box.x + p[0], box.y + p[1]]) : stored.map(toPx); // screen coords

        const s = gui.state;
        const mo = s.mouse;
        // drag a control point
        if (s.drag && s.drag.type === 'bezier-pt' && s.drag.st === st && gui.isMouseDown(0)) {
          stored[s.drag.i][0] = clampXY((mo.x - I.x) / I.w, 0, 1);
          stored[s.drag.i][1] = clampXY((mo.y - I.y) / I.h, 0, 1);
          pts2 = stored.map(toPx);
          gui._setCursor('grabbing', 2);
        }
        const clicked = gui.isMouseClicked(0) && s.activeId === 0 && !s.drag && gui.state.disabledCount === 0;
        if (clicked && !pts) {
          for (let i = 0; i < stored.length; i++) {
            const p = toPx(stored[i]);
            if (mo.x >= p[0] - 7 && mo.x <= p[0] + 7 && mo.y >= p[1] - 7 && mo.y <= p[1] + 7) {
              s.drag = { type: 'bezier-pt', st, i };
              s.activeId = -1;
              break;
            }
          }
        }
        // curve
        const samples = sampleCurve(pts2.map((p) => [p[0] - box.x, p[1] - box.y]));
        const poly = [];
        for (const p of samples) poly.push(box.x + p[0], box.y + p[1]);
        r.polyline(poly, col(opts.color || 'sliderGrab', 1), 2);
        // control points
        pts2.forEach((p) => {
          const px = p[0], py = p[1];
          const hov = Math.abs(mo.x - px) < 8 && Math.abs(mo.y - py) < 8;
          r.fillCircle(px, py, hov ? 6 : 4.5, col(hov ? 'headerActive' : 'sliderGrab'));
          r.strokeRoundedRect(px - 4.5, py - 4.5, 9, 9, 3, col('text', 0.8), 1);
          if (hov && !s.drag) gui._setCursor('grab', 1);
        });
        return pts2;
      },

      /** Polar plot of fn(theta) -> radius (0..1). */
      plotPolar(label, fn, opts) {
        opts = opts || {};
        const box = plotFrame(label, opts);
        const I = box.inner;
        const cx = I.x + I.w / 2, cy = I.y + I.h / 2;
        const R = Math.min(I.w, I.h) / 2 * 0.92;
        for (const k of [0.5, 1]) {
          const ring = [];
          for (let i = 0; i <= 64; i++) {
            const t = (i / 64) * Math.PI * 2;
            ring.push(cx + Math.cos(t) * R * k, cy + Math.sin(t) * R * k);
          }
          r.polyline(ring, col('border', 0.35), 1);
        }
        r.line(cx, cy - R, cx, cy + R, col('border', 0.35), 1);
        r.line(cx - R, cy, cx + R, cy, col('border', 0.35), 1);
        const N = 160;
        const poly = [];
        for (let i = 0; i <= N; i++) {
          const t = (i / N) * Math.PI * 2;
          const rad = Math.max(-1, Math.min(1, fn(t))) * R;
          poly.push(cx + Math.cos(t) * rad, cy + Math.sin(t) * rad);
        }
        r.polyline(poly, col(opts.color || 'sliderGrab'), 2);
        return box;
      },

      /** Heatmap of a number[][] (values auto-scaled to the color ramp). */
      plotHeatmap(label, data, opts) {
        opts = opts || {};
        const box = plotFrame(label, opts, true);
        const I = box.inner;
        if (!data || !data.length) return box;
        const rows = data.length;
        const colsN = Math.max(1, ...data.map((row) => (row ? row.length : 0)));
        let mn = Infinity, mx = -Infinity;
        for (const row of data) for (const v of row || []) if (isFinite(v)) { if (v < mn) mn = v; if (v > mx) mx = v; }
        if (!isFinite(mn)) mn = 0; if (!isFinite(mx)) mx = 1;
        if (mn === mx) mx = mn + 1;
        const c1 = M.Color.hex(opts.c1 || '#2b4a8b');
        const c2 = M.Color.hex(opts.c2 || '#c8503c');
        const cw = I.w / colsN, ch = I.h / rows;
        for (let iy = 0; iy < rows; iy++) {
          const row = data[iy] || [];
          for (let ix = 0; ix < colsN; ix++) {
            const v = row[ix];
            if (v == null || !isFinite(v)) continue; // ragged/missing cells stay empty
            const t = (v - mn) / (mx - mn);
            r.fillRect(I.x + ix * cw, I.y + (rows - 1 - iy) * ch, Math.ceil(cw), Math.ceil(ch),
              M.Color.mix(c1, c2, t));
          }
        }
        return box;
      },
    };

    function clampXY(v, a, b) { return v < a ? a : v > b ? b : v; }
  });
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
