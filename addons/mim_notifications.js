/* mim_notifications.js — toast notifications for Mim.
 * ------------------------------------------------------------------
 * STB-style, dependency-free. Load after mim.js, then use `gui.addons.notifs`:
 *
 *   const N = gui.addons.notifs;
 *   N.toast('Saved 3 nodes', { type: 'success', ttl: 2.5 });
 *   ...
 *   gui.layer(Mim.Layers.Foreground, () => N.draw());   // once per frame
 *
 * Toasts stack in the top-right corner, fade in, linger `ttl` seconds,
 * fade out and are removed automatically. Types: 'info' (default),
 * 'success', 'error' — each draws a colored accent bar. At most 5 live
 * toasts (the oldest is dropped); long messages are ellipsized.
 *
 * Uses the documented addon surface: gui._col, gui._fo, gui._measure,
 * gui._drawText, gui.state (now / displayW/H), gui.renderer.
 */
(function (root) {
  'use strict';
  const Mim = root.Mim;
  if (!Mim) return;

  const TYPES = {
    info: 'sliderGrab',
    success: '#67d47e',
    error: '#e46264',
  };

  Mim.registerAddon('notifs', function (gui, M) {
    const r = gui.renderer;
    const queue = [];
    const FADE = 0.18;
    const MAX = 5;

    return {
      /** Queue a toast. opts: { type: 'info'|'success'|'error', ttl (sec) } */
      toast(msg, opts) {
        opts = opts || {};
        queue.push({ msg: String(msg == null ? '' : msg), type: opts.type || 'info', t0: gui.state.now / 1000, ttl: opts.ttl || 2.5 });
        if (queue.length > MAX) queue.shift();
        return queue.length - 1;
      },

      get count() { return queue.length; },

      /** Draw the queue (call from the Foreground layer, once per frame). */
      draw(opts) {
        opts = opts || {};
        const s = gui.state;
        const now = s.now / 1000; // seconds — matches ttl and FADE units
        for (let i = queue.length - 1; i >= 0; i--) {
          if (now - queue[i].t0 > queue[i].ttl + FADE) queue.splice(i, 1);
        }
        if (!queue.length) return;
        const fo = gui._fo();
        const lineH = gui._lineH();
        const maxW = opts.maxWidth || 280;
        const pad = 10;
        const gap = 6;
        const x = opts.x != null ? opts.x : s.displayW - maxW - 12;
        let y = opts.y != null ? opts.y : 10;
        for (let i = queue.length - 1; i >= 0; i--) {
          const q = queue[i];
          const age = now - q.t0;
          let a = 1;
          if (age < FADE) a = age / FADE;
          else if (age > q.ttl) a = Math.max(0, 1 - (age - q.ttl) / FADE);
          if (a <= 0) continue;
          // width from the text (ellipsized to maxW)
          let msg = q.msg;
          while (msg.length > 6 && gui._measure(msg + '\u2026', fo).w > maxW - pad * 2 - 6) msg = msg.slice(0, -1);
          if (msg !== q.msg) msg += '\u2026';
          const tw = gui._measure(msg, fo).w;
          const w = Math.min(maxW, Math.max(120, tw + pad * 2 + 6));
          const h = lineH + pad;
          const c = gui._col('windowBg');
          r.fillRoundedRect(x, y, w, h, 6, M.Color.withAlpha(c, Math.round(248 * a)));
          r.strokeRoundedRect(x + 0.5, y + 0.5, w - 1, h - 1, 6, M.Color.withAlpha(c, Math.round(210 * a)), 1);
          const accName = TYPES[q.type] || 'sliderGrab';
          const acc = accName.startsWith('#') ? M.Color.hex(accName) : gui._col(accName);
          r.fillRoundedRect(x + 3, y + 3, 3, h - 6, 1.5, M.Color.withAlpha(acc, Math.round(255 * a)));
          gui._drawText(x + pad + 3, y + pad / 2 - 1, msg, M.Color.withAlpha(gui._col('text'), Math.round(255 * a)), fo);
          y += h + gap;
        }
      },
    };
  });
})(typeof globalThis !== 'undefined' ? globalThis : (typeof self !== 'undefined' ? self : this));
