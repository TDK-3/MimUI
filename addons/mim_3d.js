/* mim_3d.js — 3D graphing addon for Mim (wireframe surfaces & point clouds).
 * ------------------------------------------------------------------------
 * Load after mim.js, then use `gui.addons.t3d`:
 *
 *   gui.addons.t3d.plot3D('surface', (x, y) => Math.sin(3 * x) * Math.cos(3 * y), { h: 240 });
 *       fn(x, y) with x, y in [-1, 1]; drag inside the box to rotate,
 *       scroll the wheel over it to zoom (zoom resets to 1).
 *   gui.addons.t3d.plot3DPoints('points', [[x, y, z], ...], { h: 240 });
 *       z is auto-scaled to [-1, 1]; same rotation interaction.
 */
(function (root) {
    'use strict';
    const Mim = root.Mim;
    if (!Mim) return;

    Mim.registerAddon('t3d', function (gui, M) {
        const r = gui.renderer;

        function col(name, a) {
            const c = gui._col(name);
            return a == null ? c : M.Color.withAlpha(c, Math.round(a * 255));
        }

        /* Even share/fill heights (same algorithm as the plots addon). */
        function shareHeight(opts, minH, avail, extra) {
            extra = extra || 0;
            const s = gui.state;
            const sp = gui._var('itemSpacing');
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

        function frame3D(label, opts) {
            opts = opts || {};
            const fo = gui._fo();
            const lineH = gui._lineH();
            const pos = gui._nextPos();
            const avail = gui.getRegionAvail();
            const w = opts.w > 0 ? opts.w : Math.max(80, avail.w);
            // height: explicit px wins; share: n -> 1/n of remaining space (the view
            // projector scales with the box, so the 3D graph rescales with the window)
            let h;
            if (opts.h > 0) h = opts.h;
            else h = shareHeight(opts, 80, avail.h, opts.label !== false ? lineH : 0);
            let top = pos.y;
            if (opts.label !== false) {
                gui._drawText(pos.x, pos.y, label, col('textDisabled'), fo);
                gui._advance(pos.x, pos.y, w, lineH);
                top = gui._nextPos().y;
            }
            const box = { x: pos.x, y: top, w, h };
            r.fillRect(box.x, box.y, w, h, col('childBg'));
            r.strokeRoundedRect(box.x + 0.5, box.y + 0.5, w - 1, h - 1, 4, col('border'), 1);
            gui._advance(pos.x, top, w, h);
            return box;
        }

        /* Project a world point (x, y, z in roughly [-1, 1]) to screen. */
        function makeProjector(box, rotX, rotY, zoom) {
            const cx = box.x + box.w / 2,
                cy = box.y + box.h / 2;
            const scale = Math.min(box.w, box.h) * 0.36 * zoom;
            const cy1 = Math.cos(rotY),
                sy1 = Math.sin(rotY);
            const cx2 = Math.cos(rotX),
                sx2 = Math.sin(rotX);
            return function (x, y, z) {
                const x1 = x * cy1 + z * sy1;
                const z1 = -x * sy1 + z * cy1;
                const y2 = y * cx2 - z1 * sx2;
                const z2 = y * sx2 + z1 * cx2;
                const f = 3.2 / (3.2 + z2);
                return [cx + x1 * scale * f, cy - y2 * scale * f, z2];
            };
        }

        /* Shared interaction: drag = rotate, wheel = zoom. Returns {rotX, rotY, zoom}. */
        function interact3D(st, box, opts) {
            opts = opts || {};
            const s = gui.state;
            const mo = s.mouse;
            if (st.rotX == null) {
                st.rotX = -0.5;
                st.rotY = 0.7;
                st.zoom = 1;
            }
            const inBox =
                mo.x >= box.x && mo.x < box.x + box.w && mo.y >= box.y && mo.y < box.y + box.h;
            if (s.drag && s.drag.type === '3d-rot' && s.drag.st === st && gui.isMouseDown(0)) {
                st.rotY += mo.dx * 0.011;
                st.rotX = clamp(st.rotX + mo.dy * 0.011, -1.5, 1.5);
                gui._setCursor('grabbing', 2);
            }
            if (
                gui.isMouseClicked(0) &&
                s.activeId === 0 &&
                !s.drag &&
                inBox &&
                s.disabledCount === 0
            ) {
                s.drag = { type: '3d-rot', st };
                s.activeId = -1;
            }
            if (opts && opts.spin) st.rotY += gui.state.dt * opts.spin; // gentle auto-rotation
            if (inBox && s.mouse.wheel[1] !== 0) {
                st.zoom = clamp(st.zoom * (1 - s.mouse.wheel[1] * 0.001), 0.4, 3);
            }
            if (inBox && !s.drag) gui._setCursor('grab', 1);
            return { rotX: st.rotX, rotY: st.rotY, zoom: st.zoom };
        }

        function clamp(v, a, b) {
            return v < a ? a : v > b ? b : v;
        }

        /* Axes helper (drawn in world space). */
        function drawAxes(proj) {
            const seg = (a, b, c) => {
                const p1 = proj(a[0], a[1], a[2]),
                    p2 = proj(b[0], b[1], b[2]);
                r.line(p1[0], p1[1], p2[0], p2[1], c, 1.2);
            };
            seg([-1, 0, 0], [1, 0, 0], col('textDisabled', 0.55));
            seg([0, -1, 0], [0, 1, 0], col('textDisabled', 0.55));
            seg([0, 0, -1], [0, 0, 1], col('textDisabled', 0.55));
        }

        return {
            /** Wireframe surface z = fn(x, y), x, y in [-1, 1]. */
            plot3D(label, fn, opts) {
                opts = opts || {};
                const box = frame3D(label, opts);
                const st = gui._state('##t3d' + label);
                const v = interact3D(st, box, opts);
                const proj = makeProjector(box, v.rotX, v.rotY, v.zoom);
                const N = opts.grid || 18;
                drawAxes(proj);
                // back-to-front-ish: draw far rows first (simple depth sort by z)
                const lines = [];
                const at = (ix, iy) => {
                    const x = -1 + (2 * ix) / N;
                    const y = -1 + (2 * iy) / N;
                    let z = fn(x, y);
                    if (!isFinite(z)) z = 0;
                    z = clamp(z, -1, 1);
                    return proj(x, z, y);
                };
                for (let iy = 0; iy <= N; iy++) {
                    for (let ix = 0; ix < N; ix++) {
                        const a = at(ix, iy),
                            b = at(ix + 1, iy);
                        lines.push({
                            d: a[2] + b[2],
                            draw: () =>
                                r.line(a[0], a[1], b[0], b[1], col('sliderGrab', 0.85), 1.1),
                        });
                        if (ix < N && iy < N) {
                            const c2 = at(ix, iy + 1);
                            lines.push({
                                d: a[2] + c2[2],
                                draw: () =>
                                    r.line(a[0], a[1], c2[0], c2[1], col('sliderGrab', 0.5), 1),
                            });
                        }
                    }
                }
                lines.sort((p, q) => p.d - q.d);
                for (const l of lines) l.draw();
                return box;
            },

            /** Point cloud of [x, y, z] triples (z auto-scaled). */
            plot3DPoints(label, pts, opts) {
                opts = opts || {};
                const box = frame3D(label, opts);
                const st = gui._state('##t3dp' + label);
                const v = interact3D(st, box, opts);
                const proj = makeProjector(box, v.rotX, v.rotY, v.zoom);
                drawAxes(proj);
                // sanitize: accept [x,y,z] or {x,y,z}; drop non-finite coords
                const good = (pts || [])
                    .map((p) =>
                        Array.isArray(p) ? [p[0], p[1], p[2]] : p ? [p.x, p.y, p.z] : null,
                    )
                    .filter((p) => p && isFinite(p[0]) && isFinite(p[1]) && isFinite(p[2]));
                let mx = 0;
                for (const p of good) mx = Math.max(mx, Math.abs(p[2]));
                if (mx === 0) mx = 1;
                const rad = opts.pointRadius || 2.2;
                for (const p of good) {
                    const q = proj(p[0], p[2] / mx, p[1]);
                    r.fillCircle(q[0], q[1], rad, col(opts.color || 'sliderGrab', 0.9));
                }
                if (!good.length) {
                    const fo = gui._fo();
                    gui._drawText(
                        box.x + 8,
                        box.y + box.h / 2 - gui._lineH() / 2,
                        'no points',
                        col('textDisabled', 0.7),
                        fo,
                    );
                }
                return box;
            },
        };
    });
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this);
