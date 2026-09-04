/**
 * Lightweight markdown text: **bold**, *italic*, `code` chips and word
 * wrapping. Measured before drawing, so the layout below the block is
 * stable.
 * @namespace gui.addons.markdown
 */
/**
 * Renders a mini-markdown block and returns the number of drawn lines.
 * @function gui.addons.markdown.md
 * @param {string} text the markdown source
 * @param {Object} [opts]
 * @param {number} [opts.w] wrap width (default: the full available width)
 * @param {number} [opts.lineHeight] line-height multiplier (default 1.22)
 * @param {Object} [opts.fonts] { bold, italic, mono } — real font ids for
 *   the backend; without them bold is a double-draw and italic a lighter
 *   tint
 * @param {string} [opts.codeColor] hex color for the code chips
 * @returns {number} the number of drawn lines
 */

/* mim_markdown.js — lightweight markdown rendering for Mim.
 * ------------------------------------------------------------------
 * STB-style, dependency-free. Load after mim.js, then use
 * `gui.addons.markdown`:
 *
 *   gui.addons.markdown.md('**bold**, *italic* and `code` inline', {});
 *   gui.addons.markdown.md(lines, { w: 240, lineHeight: 1.3 });
 *
 * Supports the subset most UI text actually uses:
 *   **bold**        — drawn double-stroked (fake bold) unless opts.fonts
 *                     registers a bold fontId with your backend
 *   *italic* / _x_  — drawn with a lighter tint unless opts.fonts
 *                     registers an italic fontId
 *   `code`          — drawn on a subtle background chip; monospace if
 *                     opts.fonts.mono is registered
 *   plain lines wrap to the available width; blank lines add a half-line
 *   of space. Line breaks in the source are hard breaks.
 *
 * The whole block reserves its exact height (measured first), so layout
 * below it is stable. Returns the number of rendered lines.
 *
 * Uses the documented addon surface: gui._col, gui._fo, gui._lineH,
 * gui._measure, gui._nextPos, gui._advance, gui._drawText, gui.getRegionAvail,
 * gui.renderer.
 */
(function (root) {
  "use strict";
  const Mim = root.Mim;
  if (!Mim) return;

  /* Split a line into styled runs: { text, style: 'plain'|'bold'|'italic'|'code' } */
  function parseLine(line) {
    const runs = [];
    let i = 0;
    let plain = "";
    const flush = (style) => {
      if (plain) {
        runs.push({ text: plain, style: style || "plain" });
        plain = "";
      }
    };
    while (i < line.length) {
      const rest = line.slice(i);
      let m = rest.match(/^\*\*([^*]+)\*\*/);
      if (m) {
        flush();
        runs.push({ text: m[1], style: "bold" });
        i += m[0].length;
        continue;
      }
      m = rest.match(/^\`([^\`]+)\`/);
      if (m) {
        flush();
        runs.push({ text: m[1], style: "code" });
        i += m[0].length;
        continue;
      }
      m = rest.match(/^\*([^*\s][^*]*)\*/); // *word* (word must not start with space)
      if (m) {
        flush();
        runs.push({ text: m[1], style: "italic" });
        i += m[0].length;
        continue;
      }
      m = rest.match(/^_([^_\s][^_]*)_/);
      if (m) {
        flush();
        runs.push({ text: m[1], style: "italic" });
        i += m[0].length;
        continue;
      }
      plain += line[i];
      i++;
    }
    flush();
    return runs;
  }

  Mim.registerAddon("markdown", function (gui, M) {
    const r = gui.renderer;

    function col(name, a) {
      const c = gui._col(name);
      return a == null ? c : M.Color.withAlpha(c, Math.round(a * 255));
    }

    return {
      parseLine,

      /** Render a mini-markdown block. Returns the number of drawn lines. */
      md(text, opts) {
        opts = opts || {};
        const fo = gui._fo();
        const lineH = gui._lineH() * (opts.lineHeight || 1.22);
        const pos = gui._nextPos();
        const avail = gui.getRegionAvail();
        const w = opts.w > 0 ? opts.w : Math.max(60, avail.w);

        const fonts = opts.fonts || {};
        // font options per style (fontId lets a backend swap families)
        const foFor = (style) => {
          const f = Object.assign({}, fo);
          const id =
            fonts[
              style === "italic" ? "italic" : style === "bold" ? "bold" : "mono"
            ];
          if (id) f.fontId = id;
          return f;
        };

        const src = String(text == null ? "" : text)
          .replace(/\r\n?/g, "\n")
          .split("\n");

        /* ---- measure: wrap each line into visual rows ------------------
           Word-based greedy wrap. Runs are flattened into styled words;
           the row width is probed with the row's dominant font (style
           differences are a few pixels at most, which is fine for layout). */
        const wrapRuns = (runs) => {
          const words = [];
          for (const run of runs) {
            for (const p of run.text.split(/(\s+)/)) {
              if (!p) continue;
              if (/^\s+$/.test(p)) continue; // single spaces only
              words.push({ text: p, style: run.style });
            }
          }
          if (!words.length) return [[{ text: " ", style: "plain" }]];
          const rows = [];
          let row = [];
          let rowText = "";
          for (const word of words) {
            const probe = rowText ? rowText + " " + word.text : word.text;
            if (row.length && gui._measure(probe, foFor(word.style)).w > w) {
              rows.push(row);
              row = [word];
              rowText = word.text; // start the new row with this word
            } else {
              row.push(word);
              rowText = probe;
            }
          }
          rows.push(row);
          return rows;
        };

        let totalH = 0;
        const blocks = src.map((line) => {
          if (!line.trim()) return { blank: true, h: lineH * 0.5 };
          const rows = wrapRuns(parseLine(line));
          totalH += rows.length * lineH;
          return { rows };
        });
        totalH += blocks.filter((b) => b.blank).length * lineH * 0.5;

        /* ---- draw ------------------------------------------------------ */
        let y = pos.y;
        for (const block of blocks) {
          if (block.blank) {
            y += lineH * 0.5;
            continue;
          }
          for (const row of block.rows) {
            let x = pos.x;
            row.forEach((piece, i) => {
              const f = foFor(piece.style);
              if (i > 0) x += gui._measure(" ", f).w;
              const tw = gui._measure(piece.text, f).w;
              if (piece.style === "code") {
                r.fillRect(
                  x - 2,
                  y + 1,
                  tw + 4,
                  lineH - 2,
                  col("childBg", 0.9),
                );
                r.strokeRoundedRect(
                  x - 2,
                  y + 1,
                  tw + 4,
                  lineH - 2,
                  3,
                  col("border", 0.5),
                  1,
                );
              }
              let c = col("text");
              if (piece.style === "italic") c = col("text", 0.72);
              if (piece.style === "code")
                c = col(opts.codeColor || "text", 0.95);
              gui._drawText(x, y, piece.text, c, f);
              if (piece.style === "bold" && !fonts.bold) {
                // fake bold: a second pass offset by half a pixel
                gui._drawText(x + 0.5, y, piece.text, c, f);
              }
              x += tw;
            });
            y += lineH;
          }
        }
        gui._advance(pos.x, pos.y, w, totalH);
        return blocks
          .filter((b) => !b.blank)
          .reduce((n, b) => n + b.rows.length, 0);
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
