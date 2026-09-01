/* Headless tests for the Mim addon system + the bundled addons
 * (plots / t3d / tables). Drives the real GUI through the mock renderer. */
'use strict';

require('../mim.js');
require('../addons/mim_plots.js');
require('../addons/mim_3d.js');
require('../addons/mim_tables.js');
require('../addons/mim_color.js');
require('../addons/mim_notifications.js');
const { GUI } = global.Mim;

let passed = 0,
    failed = 0;
const failures = [];
function check(cond, msg) {
    if (cond) passed++;
    else {
        failed++;
        failures.push(msg);
        console.error('  FAIL: ' + msg);
    }
}

/* --------------------------- mock renderer ------------------------------ */

class MockRenderer {
    constructor() {
        this.calls = [];
        this.clip = null;
        this.lastCursor = 'default';
        this.features = { cursor: true, clip: true };
    }
    record(m, a) {
        this.calls.push([m, ...a]);
    }
    beginFrame() {
        this.calls = [];
    }
    endFrame() {}
    setLayer() {}
    setCursor(c) {
        this.lastCursor = c;
    }
    textSize(s) {
        return { w: Math.round(String(s).length * 7.8), h: 19 };
    }
    drawText(...a) {
        this.record('drawText', a);
    }
    fillRect(...a) {
        this.record('fillRect', a);
    }
    fillRoundedRect(...a) {
        this.record('fillRoundedRect', a);
    }
    strokeRect(...a) {
        this.record('strokeRect', a);
    }
    strokeRoundedRect(...a) {
        this.record('strokeRoundedRect', a);
    }
    line(...a) {
        this.record('line', a);
    }
    fillCircle(...a) {
        this.record('fillCircle', a);
    }
    fillEllipse(...a) {
        this.record('fillEllipse', a);
    }
    polyline(...a) {
        this.record('polyline', a);
    }
    fillPolygon(...a) {
        this.record('fillPolygon', a);
    }
    drawImage(...a) {
        this.record('drawImage', a);
    }
    pushClip() {}
    popClip() {}
    drawnText() {
        return this.calls.filter((c) => c[0] === 'drawText').map((c) => c[3]);
    }
}

class Env {
    constructor(opts) {
        this.renderer = new MockRenderer();
        this.gui = new GUI(
            this.renderer,
            Object.assign({ flags: { animations: false } }, opts || {}),
        );
        this.mouse = { x: -100, y: -100 };
        this.keys = new Set();
        this.text = '';
        this.time = null; // ms clock; null = frozen at 0
    }
    input() {
        return {
            width: 1000,
            height: 800,
            mouse: {
                x: this.mouse.x,
                y: this.mouse.y,
                buttons: [!!this.downB],
                wheelX: 0,
                wheelY: 0,
            },
            keys: this.keys,
            text: this.text,
            dpr: 1,
            time: this.time != null ? this.time : 0,
        };
    }
    frame(draw) {
        if (draw) this._draw = draw;
        this.gui.beginFrame(this.input());
        if (this._draw) this._draw();
        this.gui.endFrame();
    }
    hover(x, y) {
        this.mouse.x = x;
        this.mouse.y = y;
    }
    press(x, y) {
        this.mouse.x = x;
        this.mouse.y = y;
        this.downB = true;
        this.frame();
    }
    release() {
        this.downB = false;
        this.frame();
    }
    click(x, y) {
        this.mouse.x = x;
        this.mouse.y = y;
        this.downB = true;
        this.frame();
        this.downB = false;
        this.frame();
    }
    dragTo(x1, y1, x2, y2, steps) {
        this.mouse.x = x1;
        this.mouse.y = y1;
        this.downB = true;
        this.frame();
        for (let i = 1; i <= steps; i++) {
            this.mouse.x = x1 + ((x2 - x1) * i) / steps;
            this.mouse.y = y1 + ((y2 - y1) * i) / steps;
            this.frame();
        }
        this.downB = false;
        this.frame();
    }
}

/* ------------------------------ registry -------------------------------- */

console.log('• addon registry: register/uninstall/opt-in');
{
    check(global.Mim.addonNames().includes('plots'), 'plots registered');
    check(global.Mim.addonNames().includes('t3d'), 't3d registered');
    check(global.Mim.addonNames().includes('tables'), 'tables registered');
    // opt-in subset
    const e = new Env({ addons: ['plots'] });
    check(!!e.gui.addons.plots && !e.gui.addons.t3d, 'subset install: plots only');
    // all off
    const e2 = new Env({ addons: false });
    check(Object.keys(e2.gui.addons).length === 0, 'addons:false installs none');
    // default: everything installed
    const e3 = new Env();
    check(
        !!e3.gui.addons.plots && !!e3.gui.addons.t3d && !!e3.gui.addons.tables,
        'default installs all registered',
    );
    check(
        !!e3.gui.addons.color && !!e3.gui.addons.notifs,
        'color + notifications registered by default',
    );
    // runtime registration + reload
    global.Mim.registerAddon('myaddon', (gui) => ({ hello: () => 42 }));
    const e4 = new Env();
    check(
        e4.gui.addons.myaddon && e4.gui.addons.myaddon.hello() === 42,
        'runtime-registered addon visible on new GUI',
    );
    const e5 = new Env({ addons: false });
    e5.gui.reloadAddons();
    check(!!e5.gui.addons.myaddon, 'reloadAddons picks up new addons');
    global.Mim.unregisterAddon('myaddon');
    check(!global.Mim.addonNames().includes('myaddon'), 'unregister removes addon');
}

/* ------------------------------ plots ----------------------------------- */

console.log('• plots: bezier draggable (normalized points), polar + heatmap draw');
{
    const e = new Env();
    let size = [420, 300];
    let curve = null;
    const draw = () => {
        if (e.gui.beginWindow('P', { size, pos: [40, 40] })) {
            curve = e.gui.addons.plots.plotBezier('curve', null, { h: 120 });
            e.gui.endWindow();
        }
    };
    e.frame(draw);
    const st = e.gui.state.widgetStates.get('##beziercurve');
    check(!!st && st.ptsN && st.ptsN.length === 4, 'bezier default 4 control points (normalized)');
    check(Array.isArray(curve) && curve.length === 4, 'plotBezier returns point list');
    // find the plot background rect (childBg) — that is the box; inner is inset 3px
    const bgCall = e.renderer.calls.find(
        (c) => c[0] === 'fillRect' && Array.isArray(c[5]) && c[5][0] === 40 && c[5][1] === 41,
    );
    const box = { x: bgCall[1], y: bgCall[2], w: bgCall[3], h: bgCall[4] };
    const p0 = curve[0];
    check(
        Math.abs(p0[0] - (box.x + 3 + st.ptsN[0][0] * (box.w - 6))) < 1,
        'returned points are screen coords in the inner rect',
    );
    e.dragTo(p0[0], p0[1], p0[0] + 30, p0[1] + 20, 5);
    const nAfter = st.ptsN[0];
    const ex = (p0[0] + 30 - box.x - 3) / (box.w - 6);
    const ey = (p0[1] + 20 - box.y - 3) / (box.h - 6);
    check(
        Math.abs(nAfter[0] - ex) < 0.01 && Math.abs(nAfter[1] - ey) < 0.01,
        'bezier point dragged with mouse (normalized), got ' +
            nAfter.map((v) => v.toFixed(3)).join(',') +
            ' want ' +
            ex.toFixed(3) +
            ',' +
            ey.toFixed(3),
    );
    // resize the window: stored points are normalized, so dots must follow the box
    size = [220, 200];
    e.frame(draw);
    const bg2 = e.renderer.calls.find(
        (c) => c[0] === 'fillRect' && Array.isArray(c[5]) && c[5][0] === 40 && c[5][1] === 41,
    );
    const box2 = { x: bg2[1], y: bg2[2], w: bg2[3], h: bg2[4] };
    const dot2 = curve[0];
    const wantX = box2.x + 3 + nAfter[0] * (box2.w - 6);
    check(
        Math.abs(dot2[0] - wantX) < 1,
        'bezier dots rescale with the window, got x=' +
            Math.round(dot2[0]) +
            ' want ' +
            Math.round(wantX),
    );
    // polar + heatmap render
    const e2 = new Env();
    const data = [];
    for (let i = 0; i < 6; i++) {
        const r2 = [];
        for (let j = 0; j < 10; j++) r2.push(i * 10 + j);
        data.push(r2);
    }
    const draw2 = () => {
        if (e2.gui.beginWindow('P2', { size: [420, 560], pos: [40, 40] })) {
            e2.gui.addons.plots.plotPolar('rose', (t) => 0.5 + 0.5 * Math.sin(4 * t), { h: 200 });
            e2.gui.addons.plots.plotHeatmap('field', data, { h: 160 });
            e2.gui.endWindow();
        }
    };
    e2.frame(draw2);
    const polylines = e2.renderer.calls.filter((c) => c[0] === 'polyline');
    check(polylines.length >= 2, 'polar draws polyline rings/curve');
    const fills = e2.renderer.calls.filter((c) => c[0] === 'fillRect');
    check(fills.length >= 60, 'heatmap fills 60 cells, got ' + fills.length);
}

/* ------------------------------ 3d -------------------------------------- */

console.log('• 3d: surface draws, drag rotates, wheel zooms');
{
    const e = new Env();
    const draw = () => {
        if (e.gui.beginWindow('S', { size: [420, 300], pos: [40, 40] })) {
            e.gui.addons.t3d.plot3D('surf', (x, y) => Math.sin(2 * x) * Math.cos(2 * y), {
                h: 160,
            });
            e.gui.endWindow();
        }
    };
    e.frame(draw);
    const st = e.gui.state.widgetStates.get('##t3dsurf');
    check(!!st && st.rotX != null, '3d interaction state created');
    const rot0 = [st.rotX, st.rotY];
    // box: y = 40+28+10 (content) + 19 (label) + 6 = 103, h = 160
    const box = { x: 50, y: 103, w: 400, h: 160 };
    e.dragTo(box.x + 200, box.y + 80, box.x + 300, box.y + 120, 8);
    check(
        Math.abs(st.rotY - rot0[1]) > 0.2 || Math.abs(st.rotX - rot0[0]) > 0.2,
        '3d drag rotates view (dX=' +
            (st.rotX - rot0[0]).toFixed(2) +
            ' dY=' +
            (st.rotY - rot0[1]).toFixed(2) +
            ')',
    );
    // surface lines were drawn
    const lines = e.renderer.calls.filter((c) => c[0] === 'line');
    check(lines.length > 100, 'surface wireframe draws many lines, got ' + lines.length);
}

/* ------------------------------ tables ---------------------------------- */

console.log('• tables: sort, select, column resize');
{
    const rows = [
        { id: 1, name: 'banana', size: 120 },
        { id: 2, name: 'apple', size: 340 },
        { id: 3, name: 'cherry', size: 45 },
    ];
    const cols = [
        { id: 'name', label: 'Name', width: 120 },
        { id: 'size', label: 'Size', width: 80, align: 'right' },
    ];
    const e = new Env();
    let res = null;
    const draw = () => {
        if (e.gui.beginWindow('T', { size: [420, 340], pos: [40, 40] })) {
            res = e.gui.addons.tables.advancedTable('fruit', cols, rows, { h: 160 });
            e.gui.endWindow();
        }
    };
    e.frame(draw);
    const st = e.gui.state.widgetStates.get('##xtabfruit');
    check(!!st, 'table state created');
    // box: y = 40+28+10 + 19 + 6 = 103; header at 103..131
    const box = { x: 50, y: 103 };
    // click 'Name' header -> sort asc
    e.click(box.x + 60, box.y + 14);
    e.frame(draw);
    check(st.sortCol === 'name' && st.sortDir === 1, 'header click sorts ascending');
    check(res.sorted[0].name === 'apple' && res.sorted[2].name === 'cherry', 'rows sorted by name');
    // click again -> desc
    e.click(box.x + 60, box.y + 14);
    e.frame(draw);
    check(st.sortDir === -1 && res.sorted[0].name === 'cherry', 'second click reverses sort');
    // select a row (body starts at box.y + headH(28) + 4 pad)
    const rowY = box.y + 28 + 4 + 10;
    e.click(box.x + 100, rowY);
    e.frame(draw);
    check(
        st.selected.length === 1,
        'row click selects one row, got ' + JSON.stringify(st.selected),
    );
    // ctrl+click another row -> multi select (row pitch = rowH + spacing)
    e.keys.add('ctrl');
    e.click(box.x + 100, rowY + 34);
    e.keys.delete('ctrl');
    e.frame(draw);
    check(st.selected.length === 2, 'ctrl+click multi-selects, got ' + JSON.stringify(st.selected));
    // column resize: drag the right edge of the 'Name' header
    const w0 = st.colWidths[0];
    const edgeX = box.x + 4 + w0; // header starts at box.x+4
    e.dragTo(edgeX - 2, box.y + 14, edgeX + 40, box.y + 14, 5);
    e.frame(draw);
    check(
        st.colWidths[0] > w0 + 20,
        'dragging header edge widens column, got ' + Math.round(st.colWidths[0]),
    );
    // text drawn
    check(e.renderer.drawnText().includes('apple'), 'table cell text drawn');
}

/* ------------------------------ scaling --------------------------------- */

console.log('• scaling: share/fill heights + widths follow the window');
{
    const e = new Env();
    let bars = null,
        surf = null,
        tbl = null;
    const draw = () => {
        if (e.gui.beginWindow('P', { size: [400, 400], pos: [40, 40] })) {
            bars = e.gui.addons.plots.plotBars('bars', [3, 8, -2, 5], { share: 3 });
            surf = e.gui.addons.t3d.plot3D('surf', (x, y) => x * y, { share: 3 });
            tbl = e.gui.addons.tables.advancedTable(
                't',
                [{ id: 'a', label: 'A', width: 60 }],
                [{ a: 1 }],
                { share: 3 },
            );
            e.gui.endWindow();
        }
    };
    e.frame(draw);
    check(
        bars && bars.w === 380 && bars.h > 80 && bars.h < 130,
        'share:3 boxes split the region, got ' +
            (bars && bars.w) +
            'x' +
            Math.round(bars && bars.h),
    );
    check(
        Math.abs(surf.h - bars.h) < 1 && Math.abs(tbl.box.h - bars.h) < 1,
        'plots/3d/tables share the same height, got ' +
            [Math.round(bars.h), Math.round(surf.h), Math.round(tbl.box.h)].join(','),
    );
    // resize the window directly (opts.size is only an initial hint): two
    // share:2 plots in a smaller window must stay even and fit (no scrollbar)
    const win = e.gui.getWindow('P');
    const drawResize = () => {
        if (e.gui.beginWindow('P', { size: [400, 400], pos: [40, 40] })) {
            bars = e.gui.addons.plots.plotBars('bars', [3, 8, -2, 5], { share: 2 });
            surf = e.gui.addons.t3d.plot3D('surf', (x, y) => x * y, { share: 2 });
            e.gui.endWindow();
        }
    };
    e.frame(drawResize); // baseline with the same 2-widget layout
    const h0 = bars.h;
    win.w = 220;
    win.h = 300;
    e.frame(drawResize);
    check(bars.w === 200, 'plot width follows window width (no overflow scrollbar), got ' + bars.w);
    check(
        bars.h < h0 && bars.h > 48,
        'share height follows window height, got ' + Math.round(bars.h) + ' from ' + Math.round(h0),
    );
    check(Math.abs(surf.h - bars.h) < 1, '3d follows the resize too');
    // fill (share omitted) uses the whole available height — core plotLines
    const e2 = new Env();
    let big = null;
    const draw2 = () => {
        if (e2.gui.beginWindow('Q', { size: [300, 380], pos: [40, 40] })) {
            e2.gui.plotLines('fill', [0.2, 0.6, 0.4], {});
            const it = e2.gui.lastItemRect();
            if (it) big = { h: it.h };
            e2.gui.endWindow();
        }
    };
    e2.frame(draw2);
    check(
        big && big.h > 250,
        'no-share core plotLines fills the available height, got ' + (big && Math.round(big.h)),
    );
}
/* --------------------------- bars + series ------------------------------ */

console.log('• plots: bars (negatives, hover, NaN) + multi-series legend/gaps');
{
    const e = new Env();
    let barBox = null,
        serBox = null;
    const draw = () => {
        if (e.gui.beginWindow('P', { size: [420, 360], pos: [40, 40] })) {
            barBox = e.gui.addons.plots.plotBars('bars', [10, -4, NaN, 22], { h: 100 });
            serBox = e.gui.addons.plots.plotSeries(
                'series',
                [
                    { name: 'a', values: [0.1, 0.5, NaN, 0.9] },
                    { name: 'b', values: [0.8, 0.2, 0.6] },
                ],
                { h: 140 },
            );
            e.gui.endWindow();
        }
    };
    e.frame(draw);
    const fills = e.renderer.calls.filter((c) => c[0] === 'fillRect');
    check(fills.length >= 4, 'bars draw one rect per value (NaN dropped), got ' + fills.length);
    check(
        e.renderer.drawnText().includes('a') && e.renderer.drawnText().includes('b'),
        'series legend shows series names',
    );
    e.hover(barBox.x + barBox.w * 0.15, barBox.y + barBox.h * 0.5);
    e.frame(draw);
    check(
        e.renderer.drawnText().some((t) => /^10(\.0+)?$/.test(t)),
        'bar hover shows its value, got ' +
            e.renderer
                .drawnText()
                .filter((t) => t.length < 8)
                .join(','),
    );
    e.hover(serBox.x + serBox.w * 0.5, serBox.y + serBox.h * 0.5);
    e.frame(draw);
    check(
        e.renderer.drawnText().some((t) => /\d+\.\d+/.test(t)),
        'series hover shows numeric values',
    );
}

/* ------------------------------- color ---------------------------------- */

console.log('• color: colorButton picker (swatch, hsv, hex, presets)');
{
    const e = new Env();
    let col = [255, 0, 0, 255];
    const draw = () => {
        if (e.gui.beginWindow('C', { size: [320, 340], pos: [40, 40] })) {
            col = e.gui.addons.color.colorButton('col', col, {});
            e.gui.endWindow();
        }
    };
    e.frame(draw);
    const C = e.gui.addons.color;
    check(JSON.stringify(C.norm('#2b4a8b')) === '[43,74,139,255]', 'norm hex -> rgba');
    check(C.toHex([43, 74, 139]) === '#2b4a8b', 'toHex round trip');
    check(C.fromHex('zz') == null && C.fromHex('#abc') != null, 'fromHex validates input');
    let sw = null;
    for (const c of e.renderer.calls)
        if (c[0] === 'fillRoundedRect' && c[3] === 14 && c[4] === 14)
            sw = { x: c[1] + 7, y: c[2] + 7 };
    check(!!sw, 'swatch drawn');
    e.click(sw.x, sw.y);
    e.frame(draw);
    check(e.gui._state('##colorbtncol').open === true, 'clicking the swatch opens the picker');
    check(
        e.renderer.drawnText().includes('H') && e.renderer.drawnText().includes('hex'),
        'picker shows H/S/V rows + hex field',
    );
    e.gui._state('##colorbtncol').hsv = [120, 1, 1];
    e.frame(draw);
    check(
        col[1] > 200 && col[0] < 60,
        'hsv change updates the color (green), got ' + JSON.stringify(col),
    );
    // hex field: find its frame (frameBg rect on the row whose label is 'hex'),
    // click to focus, replace the buffer, commit with enter
    const fb = e.gui._col('frameBg');
    const hexLabel = e.renderer.calls.find((c) => c[0] === 'drawText' && c[3] === 'hex');
    const frame = e.renderer.calls.find(
        (c) =>
            c[0] === 'fillRoundedRect' &&
            Array.isArray(c[6]) &&
            c[6][0] === fb[0] &&
            c[6][1] === fb[1] &&
            Math.abs(c[2] + c[4] / 2 - (hexLabel[2] + 8)) < 12,
    );
    check(
        !!frame,
        'hex field frame found (label at ' +
            JSON.stringify(hexLabel && [hexLabel[1], hexLabel[2]]) +
            ')',
    );
    e.click(frame[1] + frame[3] / 2, frame[2] + frame[4] / 2);
    e.frame(draw);
    let hexSt = null;
    for (const st2 of e.gui.state.widgetStates.values()) {
        if (st2 && st2.edit === true && typeof st2.buf === 'string') hexSt = st2;
    }
    check(!!hexSt, 'hex field focused and editing');
    hexSt.buf = '#ff8800';
    hexSt.caret = 7;
    e.keys.add('enter');
    e.frame(draw);
    e.keys.delete('enter');
    e.frame(draw);
    check(
        col[0] === 255 && col[1] === 136 && col[2] === 0,
        'hex field updates the color, got ' + JSON.stringify(col),
    );
}

/* --------------------------- notifications ------------------------------ */

console.log('• notifications: toasts stack top-right and expire after ttl');
{
    const e = new Env();
    const NF = e.gui.addons.notifs;
    e.frame(() => {});
    NF.toast('hello');
    NF.toast('world', { type: 'success' });
    e.gui._timeOffset += 50; // age > 0 so the fade-in has started
    e.frame(() => {});
    e.gui.layer(global.Mim.Layers.Foreground, () => NF.draw());
    const rects = e.renderer.calls.filter(
        (c) => c[0] === 'fillRoundedRect' && c[4] > 20 && c[4] < 40 && c[3] > 100,
    );
    check(NF.count === 2 && rects.length === 2, 'two toasts drawn, got ' + rects.length);
    check(
        rects.length > 0 && rects[0][1] > 700,
        'toasts sit at the right edge, x=' + (rects[0] && Math.round(rects[0][1])),
    );
    for (let i = 0; i < 20; i++) {
        e.gui._timeOffset += 200; // 4s total > ttl(2.5) + fade(0.18)
        e.frame(() => {});
        e.gui.layer(global.Mim.Layers.Foreground, () => NF.draw());
    }
    check(NF.count === 0, 'toasts expire after their ttl, got ' + NF.count);
}

/* --------------------------- tables hardening --------------------------- */

console.log('• tables: null-safe sort, missing cells, id-based selection');
{
    const rows = [
        { id: 'a', name: 'zeta', size: null },
        { id: 'b', name: 'alpha', size: 5 },
        { id: 'c', size: 9 },
    ];
    const cols = [
        { id: 'name', label: 'Name', width: 100 },
        { id: 'size', label: 'Size', width: 60, align: 'right' },
    ];
    const e = new Env();
    let res = null;
    const draw = () => {
        if (e.gui.beginWindow('T', { size: [420, 340], pos: [40, 40] })) {
            res = e.gui.addons.tables.advancedTable('fruit', cols, rows, { h: 160 });
            e.gui.endWindow();
        }
    };
    e.frame(draw);
    const st = e.gui.state.widgetStates.get('##xtabfruit');
    const box = { x: 50, y: 103 };
    e.click(box.x + 50, box.y + 14);
    e.frame(draw);
    check(
        res.sorted[2].name == null,
        'missing/null values sort last, got ' + JSON.stringify(res.sorted.map((r) => r.name)),
    );
    check(e.renderer.drawnText().includes('\u2014'), 'missing cell renders an em dash');
    e.click(box.x + 50, box.y + 28 + 4 + 10);
    e.frame(draw);
    const selCount = st.selected.length;
    check(selCount === 1, 'row click selects one row (id key), got ' + JSON.stringify(st.selected));
    e.click(box.x + 130, box.y + 14); // sort by size
    e.frame(draw);
    check(st.selected.length === selCount, 'selection survives re-sorting (id-based)');
}

/* ---------------------------- 3d hardening ------------------------------ */

console.log('• 3d: spin option + points sanitized');
{
    const e = new Env();
    const draw = () => {
        if (e.gui.beginWindow('S', { size: [420, 300], pos: [40, 40] })) {
            e.gui.addons.t3d.plot3D('spin', (x, y) => x * y, { h: 140, spin: 1.0 });
            e.gui.endWindow();
        }
    };
    e.frame(draw);
    const st = e.gui.state.widgetStates.get('##t3dspin');
    const r0 = st.rotY;
    e.gui._timeOffset += 200; // +0.2s of animation time
    e.frame(draw);
    check(
        Math.abs(st.rotY - (r0 + 0.2)) < 0.05,
        'spin rotates the view over time, got ' + st.rotY.toFixed(3) + ' from ' + r0.toFixed(3),
    );
    const e2 = new Env();
    const draw2 = () => {
        if (e2.gui.beginWindow('S2', { size: [420, 300], pos: [40, 40] })) {
            e2.gui.addons.t3d.plot3DPoints(
                'pts',
                [
                    { x: 0, y: 0, z: 1 },
                    { x: NaN, y: 0, z: 0 },
                    { x: 1, y: 1 },
                ],
                { h: 140 },
            );
            e2.gui.endWindow();
        }
    };
    e2.frame(draw2);
    const circles = e2.renderer.calls.filter((c) => c[0] === 'fillCircle').length;
    check(circles === 1, 'non-finite/missing points are dropped, got ' + circles + ' dots');
    const e3 = new Env();
    const draw3 = () => {
        if (e3.gui.beginWindow('S3', { size: [420, 300], pos: [40, 40] })) {
            e3.gui.addons.t3d.plot3DPoints('empty', [], { h: 140 });
            e3.gui.endWindow();
        }
    };
    e3.frame(draw3);
    check(e3.renderer.drawnText().includes('no points'), 'empty point set shows a placeholder');
}

/* ------------------------------ results --------------------------------- */

console.log('\n========================================');
console.log('passed: ' + passed + '   failed: ' + failed);
if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
} else {
    console.log('ALL ADDON TESTS PASSED');
}
