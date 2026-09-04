/**
 * An advanced data table: column sorting (null-safe, click the header),
 * row selection, column resize, and an optional row filter.
 * @namespace gui.addons.tables
 */
/**
 * The advanced table.
 * @function gui.addons.tables.advancedTable
 * @param {string} label
 * @param {Array} cols [{ id, label, width?, align? ('left'|'right') }, ...]
 *   — the header row comes from these (clicking a header sorts by its id)
 * @param {Array} rows [{ id, ...cellValues }, ...] — row.id keys the
 *   selection, so it survives re-sorting and filtering
 * @param {Object} [opts]
 * @param {number} [opts.h] explicit height
 * @param {number} [opts.share] split the remaining height with siblings
 * @param {boolean} [opts.selectable] rows toggle a selection on click
 * @param {boolean} [opts.sortable] headers sort on click (default true)
 * @param {boolean} [opts.zebra] striped rows
 * @param {boolean} [opts.filter] draw a search line: rows whose cells do
 *   not contain the text (case-insensitive) are hidden
 * @returns {Object} { box, sorted (visible rows), selected (row ids),
 *   sortCol, sortDir, shown, total }
 */

/* mim_tables.js — advanced table addon for Mim.
 * ------------------------------------------------
 * STB-style, dependency-free. Load after mim.js, then use `gui.addons.tables`:
 *
 *   gui.addons.tables.advancedTable('files', cols, rows, { h: 240 });
 *     cols: [{ id, label, width, align: 'left'|'right'|'center',
 *              fmt: (v, row) => string, sort: (row) => sortableKey }]
 *     rows: array of objects; cell value = row[col.id] (or fmt's result).
 *
 * Features: sortable columns (click header, click again to reverse),
 *           row selection (click; ctrl/cmd+click for multi-select),
 *           draggable column widths, sticky header, vertical scroll,
 *           zebra striping, row filter ({ filter: true } draws a search
 *           line above the table and hides rows whose cells do not match).
 *           Returns { sorted, selected, sortCol, sortDir, shown, total }.
 *
 * Uses the documented addon surface: gui._col, gui._fo, gui._lineH,
 * gui._measure, gui._nextPos, gui._advance, gui._drawText, gui._item,
 * gui.beginChild/endChild, gui.getRegionAvail, gui.state, gui.renderer.
 */
(function (root) {
  "use strict";
  const Mim = root.Mim;
  if (!Mim) return;

  Mim.registerAddon("tables", function (gui, M) {
    const r = gui.renderer;

    function col(name, a) {
      const c = gui._col(name);
      return a == null ? c : M.Color.withAlpha(c, Math.round(a * 255));
    }

    /* Even share heights (same algorithm as the plots addon). */
    function shareHeight(opts, minH, avail, extra) {
      extra = extra || 0;
      const s = gui.state;
      const sp = gui._var("itemSpacing");
      if (opts.share > 0) {
        if (s._shareFrame !== s.frameId) {
          s._shareFrame = s.frameId;
          s._shareGroups = {};
        }
        const cont = s.layout && s.layout.container;
        const key =
          ((cont && (cont.title || cont.label)) || "") + ":" + opts.share;
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

    return {
      advancedTable(label, cols, rows, opts) {
        opts = opts || {};
        rows = rows || [];
        const s = gui.state;
        const mo = s.mouse;
        const fo = gui._fo();
        const lineH = gui._lineH();
        const rowH = lineH + 8;
        const st = gui._state("##xtab" + label);
        if (!st.colWidths) st.colWidths = cols.map((c) => c.width || 100);
        else if (st.colWidths.length !== cols.length)
          // columns changed: keep known widths
          st.colWidths = cols.map((c, i) => st.colWidths[i] || c.width || 100);
        if (st.sortCol == null) st.sortCol = null;
        if (st.sortDir == null) st.sortDir = 1;
        if (!st.selected) st.selected = [];

        const pos = gui._nextPos();
        const avail = gui.getRegionAvail();
        const w = opts.w > 0 ? opts.w : Math.max(120, avail.w);
        // height: explicit px wins; share: n -> 1/n of the remaining space
        // (scales live with window resizes); default: capped fill
        const extraFilter = opts.filter ? lineH : 0;
        let h;
        if (opts.h > 0) h = opts.h;
        else if (opts.share > 0)
          h = shareHeight(
            opts,
            rowH * 2,
            avail.h,
            (opts.label !== false ? lineH : 0) + extraFilter,
          );
        else h = Math.min(300, Math.max(rowH * 3, avail.h));
        let top = pos.y;
        if (opts.label !== false) {
          gui._drawText(pos.x, pos.y, label, col("textDisabled"), fo);
          gui._advance(pos.x, pos.y, w, lineH);
        }
        // optional filter line: a row is shown when any of its cells
        // contains the text (case-insensitive)
        if (opts.filter) {
          const fpos = gui._nextPos();
          st.filterText = gui.inputText(
            "##filter" + label,
            st.filterText || "",
            { w },
          );
          gui._advance(fpos.x, fpos.y, w, lineH);
        }
        top = gui._nextPos().y;
        const box = { x: pos.x, y: top, w, h };
        const headH = rowH + 2;
        const bodyH = h - headH;

        /* ---- filtering (before sorting, so the sort applies to visible rows) ---- */
        const needle = (st.filterText || "").trim().toLowerCase();
        const visibleRows = needle
          ? rows.filter((row) =>
              cols.some((c) =>
                String(row[c.id] == null ? "" : row[c.id])
                  .toLowerCase()
                  .includes(needle),
              ),
            )
          : rows;

        /* ---- sorting ---- */
        const sorted = visibleRows.slice();
        if (opts.sortable !== false && st.sortCol != null) {
          const c = cols.find((c) => c.id === st.sortCol);
          if (c) {
            const key = c.sort || ((row) => row[c.id]);
            sorted.sort((a, b) => {
              const av = key(a),
                bv = key(b);
              if (av == null && bv == null) return 0;
              if (av == null) return 1; // missing values always sort last
              if (bv == null) return -1;
              if (typeof av === "number" && typeof bv === "number")
                return (av < bv ? -1 : av > bv ? 1 : 0) * st.sortDir;
              return String(av).localeCompare(String(bv)) * st.sortDir;
            });
          }
        }

        /* ---- column resize drag (started on a header edge) ---- */
        if (
          s.drag &&
          s.drag.type === "xtab-col" &&
          s.drag.st === st &&
          gui.isMouseDown(0)
        ) {
          st.colWidths[s.drag.ci] = clamp(mo.x - s.drag.hx, 30, 480);
          gui._setCursor("ew-resize", 2);
        }

        /* ---- box background + sticky header ---- */
        r.fillRect(box.x, box.y, w, h, col("childBg"));
        r.fillRect(box.x, box.y, w, headH, col("menubarBg"));
        let hx = box.x + 4;
        const widths = st.colWidths.slice();
        // last column absorbs slack so the table always spans its width
        let total = widths.reduce((a, b) => a + b, 0) + 4 * (cols.length - 1);
        if (total < w - 8) widths[widths.length - 1] += w - 8 - total;

        cols.forEach((c, ci) => {
          const cw = widths[ci];
          const cell = { x: hx, y: box.y, w: cw, h: headH };
          const it = gui._item(
            cell.x,
            cell.y,
            cw,
            headH,
            hashRow(label + "\x01" + c.id + "\x01h", 0),
            { focusable: false },
          );
          const isSorted = st.sortCol === c.id;
          const hovEdge =
            mo.x >= cell.x + cw - 5 &&
            mo.x <= cell.x + cw + 2 &&
            mo.y >= cell.y &&
            mo.y <= cell.y + headH;
          if (it.visible) {
            if (it.hovered && !hovEdge)
              r.fillRect(cell.x, cell.y, cw, headH, col("headerHovered", 0.45));
            const txt = String(c.label);
            const tw = gui._measure(txt, fo).w;
            let tx = cell.x + 8;
            if (c.align === "right") tx = cell.x + cw - 8 - tw;
            if (c.align === "center") tx = cell.x + (cw - tw) / 2;
            gui._drawText(
              tx,
              cell.y + (headH - lineH) / 2 + 1,
              txt,
              col(isSorted ? "text" : "textDisabled"),
              fo,
            );
            if (isSorted) {
              const ax = tx + tw + 8,
                ay = cell.y + headH / 2;
              r.polyline(
                [
                  ax,
                  ay + (st.sortDir > 0 ? 2 : -2),
                  ax + 5,
                  ay + (st.sortDir > 0 ? -2 : 2),
                  ax + 10,
                  ay + (st.sortDir > 0 ? 2 : -2),
                ],
                col("textDisabled"),
                1.4,
              );
            }
            // right-edge resize handle
            if (hovEdge) {
              r.fillRect(
                cell.x + cw - 1.5,
                cell.y + 2,
                3,
                headH - 4,
                col("sliderGrab"),
              );
              if (!s.drag) gui._setCursor("ew-resize", 1);
            }
          }
          const clicked =
            gui.isMouseClicked(0) &&
            s.activeId === 0 &&
            !s.drag &&
            s.disabledCount === 0;
          if (clicked) {
            if (hovEdge) {
              s.drag = { type: "xtab-col", st, ci, hx: cell.x };
              s.activeId = -1;
            } else if (it.hovered && opts.sortable !== false) {
              if (isSorted) st.sortDir = -st.sortDir;
              else {
                st.sortCol = c.id;
                st.sortDir = 1;
              }
            }
          }
          hx += cw + 4;
        });
        r.line(
          box.x,
          box.y + headH + 0.5,
          box.x + w,
          box.y + headH + 0.5,
          col("border"),
          1,
        );
        // header consumes layout space (minus the spacing the next _nextPos
        // adds, so the body child starts exactly at the header's bottom edge)
        gui._advance(pos.x, box.y, w, headH - gui._var("itemSpacing")[1]);

        /* ---- body (scrollable child, below the sticky header) ---- */
        if (
          bodyH > 4 &&
          gui.beginChild("##xtabbody" + label, { w: w, h: bodyH, padding: 4 })
        ) {
          const bw = gui.getRegionAvail().w;
          if (!sorted.length) {
            const p0 = gui._nextPos();
            gui._drawText(
              p0.x + 8,
              p0.y + 2,
              needle ? "no matching rows" : "no rows",
              col("textDisabled", 0.7),
              fo,
            );
            gui._advance(p0.x, p0.y, bw, rowH);
          }
          sorted.forEach((row, ri) => {
            const p = gui._nextPos();
            const rkey = row.id != null ? "i" + row.id : "r" + ri; // selection survives row reordering
            const itemId = hashRow(label + "\x01" + rkey, 1);
            const it = gui._item(p.x, p.y, bw, rowH, itemId, {
              focusable: false,
            });
            const selected = st.selected.includes(rkey);
            if (it.visible) {
              if (selected)
                r.fillRect(p.x, p.y, bw, rowH, col("headerActive", 0.55));
              else if (ri % 2 === 1 && opts.zebra !== false)
                r.fillRect(p.x, p.y, bw, rowH, col("border", 0.07));
              if (it.hovered && !selected)
                r.fillRect(p.x, p.y, bw, rowH, col("headerHovered", 0.35));
              let cx = p.x + 4;
              cols.forEach((c, ci) => {
                const cw = widths[ci];
                const v = row[c.id];
                const txt = c.fmt
                  ? String(c.fmt(v, row))
                  : v == null || v === ""
                    ? "\u2014"
                    : String(v);
                const tw = gui._measure(txt, fo).w;
                let tx = cx + 4;
                if (c.align === "right") tx = cx + cw - 4 - tw;
                if (c.align === "center") tx = cx + (cw - tw) / 2;
                gui._drawText(
                  tx,
                  p.y + (rowH - lineH) / 2 + 1,
                  txt,
                  col("text"),
                  fo,
                );
                cx += cw + 4;
              });
            }
            gui._advance(p.x, p.y, bw, rowH);
            if (
              opts.selectable !== false &&
              it.hovered &&
              gui.isMouseClicked(0) &&
              s.activeId === 0 &&
              !s.drag
            ) {
              const mod =
                s.keys.has("ctrl") || s.keys.has("meta") || s.keys.has("shift");
              if (mod) {
                const i = st.selected.indexOf(rkey);
                if (i >= 0) st.selected.splice(i, 1);
                else st.selected.push(rkey);
              } else {
                st.selected.length = 0;
                st.selected.push(rkey);
              }
              s.activeId = -1;
            }
          });
          gui.endChild();
        }
        r.strokeRoundedRect(
          box.x + 0.5,
          box.y + 0.5,
          w - 1,
          h - 1,
          4,
          col("border"),
          1,
        );
        if (bodyH <= 4) gui._advance(pos.x, top, w, h); // no child region: advance the full box
        return {
          box,
          sorted,
          selected: st.selected.slice(),
          sortCol: st.sortCol,
          sortDir: st.sortDir,
          shown: sorted.length,
          total: rows.length,
        };
      },
    };
  });

  /* small stable numeric hash (FNV-1a) for row item ids */
  function hashRow(str, salt) {
    let h = 0x811c9dc5 ^ (salt || 0);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }
  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }
})(
  typeof globalThis !== "undefined"
    ? globalThis
    : typeof self !== "undefined"
      ? self
      : this,
);
