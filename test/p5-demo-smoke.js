// Demo smoke (p5 path): exercises all six round-2 features in the real demo.
const fs = require('fs');
const path = require('path');
require('../mim.js');
require('../addons/mim_plots.js');
require('../addons/mim_3d.js');
require('../addons/mim_tables.js');
require('../addons/mim_color.js');
require('../addons/mim_notifications.js');
global.MimP5 = require('../demo/p5-backend.js');
const calls = [];
const rec = (name) => (...a) => { calls.push([name, ...a]); };
const drawingContext = new Proxy({ save(){}, restore(){}, beginPath(){}, rect(){}, clip(){},
  measureText: (s) => ({ width: String(s == null ? '' : s).length * 7.8 }) },
  { get: (t, k) => (t[k] !== undefined ? t[k] : rec('ctx.' + k)), set: (t, k, v) => { t[k] = v; return true; } });
const p5 = new Proxy({
  windowWidth: 1280, windowHeight: 720, frameCount: 0,
  mouseX: -100, mouseY: -100, mouseIsDown: false, mouseButton: 0,
  width: 1280, height: 720, drawingContext,
  createCanvas: () => {}, resizeCanvas: () => {}, textFont: rec('textFont'), pixelDensity: rec('pixelDensity'),
  textWidth: (str) => String(str == null ? '' : str).length * 7.8,   // faithful: real p5 returns px
  createGraphics: () => new Proxy({}, { get: (t, k) => (t[k] !== undefined ? t[k] : rec('g.' + k)), set: (t,k,v)=>{t[k]=v;return true;} }),
  isKeyDown: () => false,
  color: (a, b, c, d) => [a, b, c, d],
  TAB: 9, ENTER: 13, ESCAPE: 27, BACKSPACE: 8, DELETE: 46, HOME: 36, END: 35,
  PAGE_UP: 33, PAGE_DOWN: 34, LEFT_ARROW: 37, RIGHT_ARROW: 39, UP_ARROW: 38, DOWN_ARROW: 40,
  SHIFT: 16, CONTROL: 17, ALT: 18, LEFT: 0, RIGHT: 2, CENTER: 1,
}, { get: (t, k) => (k in t ? t[k] : rec(k)), set: (t, k, v) => { t[k] = v; return true; } });
let guiRef = null;
const origBegin = global.Mim.GUI.prototype.beginWindow;
global.Mim.GUI.prototype.beginWindow = function(...a) { guiRef = this; return origBegin.apply(this, a); };
eval(fs.readFileSync(path.join(__dirname, '../demo/sketch.js'), 'utf8'));
mimSketch(p5);
p5.setup();
let ok = 0, bad = 0;
const check = (c, m) => { if (c) ok++; else { bad++; console.error('  FAIL: ' + m); } };
const frame = () => { p5.frameCount++; p5.draw(); };
for (let i = 0; i < 30; i++) frame();
const gui = guiRef;
const W = (t) => gui.getWindow(t);
console.log('demo smoke: p5 backend, real sketch');

// 1) idle frames drew windows
check(W('Playground') && W('Inspector'), 'demo windows exist');
// the Settings window surfaces the round-2 interaction tour (scroll it into view)
{
  const S = W('Settings');
  S.scrollY = S.scrollTargetY = S.maxScrollY * 0.5;   // tour text sits mid-content
  frame();
  check(calls.some((c) => c[0] === 'text' && /apex/.test(String(c[1]))), 'demo shows the new-interactions tour text');
  S.scrollY = S.scrollTargetY = 0;
  frame();
}

// 2) screen-center dock grid (square of four direction triangles): drag
// Settings onto the RIGHT triangle -> edge right
// (first move Layout out of the screen center, which it covers)
const L0 = W('Layout');
p5.mouseX = L0.x + L0.w / 2; p5.mouseY = L0.y + 12; frame();
p5.mouseIsDown = true; frame();
p5.mouseX = L0.x + 500; p5.mouseY = L0.y + 250; frame(); frame();
p5.mouseIsDown = false; frame(); frame();
const S = W('Settings');
p5.mouseX = S.x + S.w / 2; p5.mouseY = S.y + 12; frame();
p5.mouseIsDown = true; frame();
p5.mouseX = 664; p5.mouseY = 360; frame();          // right triangle centroid
check(gui.state._dockHint && gui.state._dockHint.kind === 'screen' && gui.state._dockHint.side === 'r', 'right triangle active over screen center');
p5.mouseIsDown = false; frame(); frame();
check(S._edge === 'right', 'Settings edge-docked right via grid, got ' + S._edge);

// 3) grid pops up over the PRE-DOCKED Inspector+Console dock; drop splits it
const In = W('Inspector');
let Ix = 0, Iy = 0, Iw = 0, Ih = 0;
{ const D = gui.state.docks.get(gui.getDocks().find(d => d.a === 'Inspector').id);
  In.x; // member rect from layout:
  Ix = In.x; Iy = In.y; Iw = In.w; Ih = In.h; }
const C = W('Console');
p5.mouseX = In.x + In.w / 2; p5.mouseY = In.y + 10; frame();   // press Inspector slim header? no — use a free window instead
p5.mouseIsDown = false; frame();
// use "Addons" (free, at 764,40) dragged over Inspector's sub-rect
const Ad = W('Addons');
// press the left part of the title (the right part is covered by the Settings edge column)
p5.mouseX = Ad.x + 36; p5.mouseY = Ad.y + 12; frame();
p5.mouseIsDown = true; frame();
p5.mouseX = Ix + Iw / 2; p5.mouseY = Iy + Ih / 2; frame();
const h3 = gui.state._dockHint;
check(!!h3 && h3.kind === 'window' && h3.target === In, 'grid over pre-docked Inspector, got ' + JSON.stringify(h3 && h3.target && h3.target.title));
const [gx3, gy3] = gui._dockGridPoint(h3.parts, 'r');   // right triangle centroid
p5.mouseX = gx3; p5.mouseY = gy3; frame();
p5.mouseIsDown = false; frame(); frame();
check(gui.isDocked('Addons', 'Inspector'), 'Addons docked with Inspector');
check(C._dockKey == null, 'Console freed to its own window');

// 4) right-click title bar -> context menu; click Collapse
const P = W('Playground');
p5.mouseX = P.x + P.w / 2; p5.mouseY = P.y + 12; frame();
p5.mouseButton = 2; p5.mouseIsDown = true; frame(); p5.mouseIsDown = false; frame(); p5.mouseButton = 0;
const pm = gui.state.popups.get('winctx:' + P.idHash);
check(!!pm && pm.open, 'Playground context menu opened');
check(pm.data.items.some(r => r.label === 'Collapse'), 'menu has Collapse');
frame();
const rowH = gui._lineH() + 10;
const ci = pm.data.items.findIndex(r => r.label === 'Collapse');
p5.mouseX = pm.x + pm.w / 2; p5.mouseY = pm.y + 6 + ci * rowH + rowH / 2; frame();
p5.mouseIsDown = true; frame(); p5.mouseIsDown = false; frame(); frame();
check(P.collapsed === true, 'menu Collapse collapsed the window');
check(!pm.open, 'menu closed after selection');

// 5) drag a member's slim header out -> undock
const D5 = gui.state.docks.get(gui.getDocks().find(d => d.a === 'Addons' || d.b === 'Addons').id);
const M5 = D5.b;   // the member that is NOT the isA one
p5.mouseX = M5.x + M5.w / 2; p5.mouseY = M5.y + 10; frame();
p5.mouseIsDown = true; frame();
p5.mouseX = M5.x + M5.w / 2 + 10; p5.mouseY = M5.y + 40; frame();
frame();
check(M5._dockKey == null && M5.movable, 'slim-header drag undocked the member, got dockKey=' + M5._dockKey);
p5.mouseIsDown = false; frame(); frame();

// 6) dock top-edge resize (fresh dock: Playground + Layout)
gui.dock('Playground', 'Layout', { dir: 'h', ratio: 0.5, pos: [400, 100], size: [320, 200] });
frame(); frame();
let D6 = gui.state.docks.get(gui.getDocks()[0].id);
const y0 = D6.y, h0 = D6.h;
p5.mouseX = D6.x + D6.w / 2; p5.mouseY = y0; frame();
p5.mouseIsDown = true; frame();
p5.mouseY = y0 - 30; frame(); frame();
p5.mouseIsDown = false; frame();
D6 = gui.state.docks.get(gui.getDocks()[0].id);
check(Math.abs(D6.y - (y0 - 30)) < 1 && Math.abs(D6.h - (h0 + 30)) < 1, 'top-edge resize: y=' + D6.y + ' h=' + D6.h + ' (want ' + (y0 - 30) + ',' + (h0 + 30) + ')');

// 7) covered window: chevron of a covered window must not toggle
const A = W('Styled');
const cov = W('Addons');
// put the free 'Addons' window (created after Styled, so on top) over Styled's chevron area
cov.x = A.x + 8; cov.y = A.y + 6;
frame(); frame();
const aBefore = A.collapsed;
p5.mouseX = A.x + 20; p5.mouseY = A.y + 17; frame();
p5.mouseIsDown = true; frame(); p5.mouseIsDown = false; frame(); frame();
check(A.collapsed === aBefore, 'covered window chevron untouched, A=' + A.collapsed + ' (was ' + aBefore + ')');
check(cov.x === A.x + 8, 'cover window still where it was (press started its own interaction), x=' + cov.x);

// 8) settle
for (let i = 0; i < 20; i++) frame();
console.log('demo smoke: ' + ok + ' checks passed, ' + bad + ' failed');
if (bad) process.exit(1);
console.log('DEMO SMOKE OK');
