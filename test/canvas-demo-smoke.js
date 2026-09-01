// Canvas demo smoke: real sketch + canvas backend, pumps the RAF loop manually.
const fs = require('fs');
const path = require('path');
require('../mim.js');
require('../addons/mim_plots.js');
require('../addons/mim_3d.js');
require('../addons/mim_tables.js');
require('../addons/mim_color.js');
require('../addons/mim_notifications.js');
global.MimCanvas = require('../demo-canvas/canvas-backend.js');

const canvasL = {}, winL = {};
const calls = [];
const canvasEl = {
  width: 1280, height: 720, clientWidth: 1280, clientHeight: 720,
  getContext: () => new Proxy({ save(){}, restore(){}, beginPath(){}, rect(){}, clip(){},
    measureText: (s) => ({ width: String(s == null ? '' : s).length * 7.8 }) },
    { get: (t, k) => (t[k] !== undefined ? t[k] : (...a) => { calls.push(['ctx.' + k, ...a]); }), set: (t, k, v) => { t[k] = v; return true; } }),
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 }),
  addEventListener: (ev, fn) => { canvasL[ev] = fn; },
  style: {},
};
const makeCanvas = () => ({
  width: 128, height: 128, clientWidth: 128, clientHeight: 128,
  getContext: () => new Proxy({ save(){}, restore(){}, beginPath(){}, rect(){}, clip(){},
    measureText: (s) => ({ width: String(s == null ? '' : s).length * 7.8 }) },
    { get: (t, k) => (t[k] !== undefined ? t[k] : () => {}), set: (t, k, v) => { t[k] = v; return true; } }),
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 128, height: 128 }),
  addEventListener: () => {},
  style: {},
});
global.document = {
  getElementById: (id) => (id === 'gui-canvas' ? canvasEl : null),
  createElement: (tag) => (tag === 'canvas' ? makeCanvas() : {}),
  addEventListener: () => {},
  body: { appendChild: () => {} },
  documentElement: { style: {} },
};
global.window = {
  addEventListener: (ev, fn) => { winL[ev] = fn; },
  removeEventListener: () => {},
  devicePixelRatio: 1,
};
let rafCb = null;
global.requestAnimationFrame = (cb) => { rafCb = cb; return 1; };

let guiRef = null;
const origBegin = global.Mim.GUI.prototype.beginWindow;
global.Mim.GUI.prototype.beginWindow = function(...a) { guiRef = this; return origBegin.apply(this, a); };

eval(fs.readFileSync(path.join(__dirname, '../demo-canvas/sketch.js'), 'utf8'));
let ok = 0, bad = 0;
const check = (c, m) => { if (c) ok++; else { bad++; console.error('  FAIL: ' + m); } };
const frame = () => { const cb = rafCb; cb(0); };
const move = (x, y) => { if (winL.mousemove) winL.mousemove({ clientX: x, clientY: y }); };
const down = (x, y, b = 0) => { canvasL.mousedown({ clientX: x, clientY: y, button: b, preventDefault() {} }); };
const up = (x, y, b = 0) => { winL.mouseup({ clientX: x, clientY: y, button: b, preventDefault() {} }); };

check(typeof rafCb === 'function', 'sketch registered its RAF loop');
for (let i = 0; i < 30; i++) frame();
const gui = guiRef;
check(!!gui, 'gui created');
const W = (t) => gui.getWindow(t);
check(!!W('Playground') && !!W('Settings'), 'demo windows exist');
// the Settings window surfaces the round-2 interaction tour (scroll it into view)
{
  const S = W('Settings');
  S.scrollY = S.scrollTargetY = S.maxScrollY * 0.5;   // tour text sits mid-content
  frame();
  check(calls.some((c) => c[0] === 'ctx.fillText' && /apex/.test(String(c[1]))), 'demo shows the new-interactions tour text');
  S.scrollY = S.scrollTargetY = 0;
  frame();
}

// 1) right-click title -> context menu -> Collapse
const P = W('Playground');
move(P.x + P.w / 2, P.y + 12); frame();
down(P.x + P.w / 2, P.y + 12, 2); frame();
up(P.x + P.w / 2, P.y + 12, 2); frame();
const pm = gui.state.popups.get('winctx:' + P.idHash);
check(!!pm && pm.open, 'context menu opened');
const rowH = gui._lineH() + 10;
const ci = pm.data.items.findIndex(r => r.label === 'Collapse');
move(pm.x + pm.w / 2, pm.y + 6 + ci * rowH + rowH / 2); frame();
down(pm.x + pm.w / 2, pm.y + 6 + ci * rowH + rowH / 2, 0); frame();
up(pm.x + pm.w / 2, pm.y + 6 + ci * rowH + rowH / 2, 0); frame(); frame();
check(P.collapsed === true, 'menu Collapse collapsed the window');

// 2) drag Settings onto the right pad of the screen-center icon
// (first move Layout, which covers the right pad)
const L0 = W('Layout');
move(L0.x + L0.w / 2, L0.y + 12); frame();
down(L0.x + L0.w / 2, L0.y + 12, 0); frame();
move(L0.x + 500, L0.y + 250); frame(); frame();
up(L0.x + 500, L0.y + 250, 0); frame(); frame();
const S = W('Settings');
move(S.x + S.w / 2, S.y + 12); frame();
down(S.x + S.w / 2, S.y + 12, 0); frame();
move(664, 360); frame();
check(gui.state._dockHint && gui.state._dockHint.kind === 'screen' && gui.state._dockHint.side === 'r', 'right triangle active');
up(664, 360, 0); frame(); frame();
check(S._edge === 'right', 'Settings edge-docked right, got ' + S._edge);

// 3) drag Addons over the Inspector+Console dock -> grid over pre-docked dock
const Ad = W('Addons'), In = W('Inspector');
move(Ad.x + 30, Ad.y + 12); frame();
down(Ad.x + 30, Ad.y + 12, 0); frame();
move(In.x + In.w / 2, In.y + In.h / 2); frame();
check(!!gui.state._dockHint && gui.state._dockHint.kind === 'window' && gui.state._dockHint.target === In, 'grid over pre-docked Inspector');
up(In.x + In.w / 2, In.y + In.h / 2, 0); frame(); frame();

for (let i = 0; i < 20; i++) frame();
console.log('canvas smoke: ' + ok + ' checks passed, ' + bad + ' failed');
if (bad) process.exit(1);
console.log('CANVAS SMOKE OK');
