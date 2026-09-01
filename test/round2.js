/* Round-2 feature tests: header context menus, covered-element hover gating,
 * drag-a-member-out-to-undock, dock top-edge (vertical) scaling, dock hints
 * over docked/edge windows, and the screen-center dock grid — a square of
 * four direction triangles (one per screen edge, apexes meeting at the
 * center). */
'use strict';

require('../mim.js');
const { GUI, WindowFlags } = global.Mim;

class MockRenderer {
  constructor() {
    this.calls = [];
    this.clipStack = [];
    this.clip = null;
    this.layer = 'gui';
    this.lastCursor = 'default';
    this.features = { cursor: true, clip: true };
  }
  record(m, args) { this.calls.push([m, ...args]); }
  beginFrame(w, h) { this.calls = []; this.clip = null; this.clipStack = []; this.record('beginFrame', [w, h]); }
  endFrame() { this.record('endFrame', []); }
  setLayer(l) { this.layer = l; this.record('setLayer', [l]); }
  setCursor(c) { this.lastCursor = c; this.record('setCursor', [c]); }
  pushClip(x, y, w, h) {
    const c = this.clip;
    this.clipStack.push(this.clip);
    this.clip = {
      x: Math.max(x, c ? c.x : -1e9), y: Math.max(y, c ? c.y : -1e9),
      w: Math.min(x + w, c ? c.x + c.w : 1e9) - Math.max(x, c ? c.x : -1e9),
      h: Math.min(y + h, c ? c.y + c.h : 1e9) - Math.max(y, c ? c.y : -1e9),
    };
    if (this.clip.w <= 0 || this.clip.h <= 0) this.clip = null;
    this.record('pushClip', [x, y, w, h]);
  }
  popClip() { this.clip = this.clipStack.pop() || null; this.record('popClip', []); }
  fillRect(x, y, w, h, c) { this.record('fillRect', [x, y, w, h, c]); }
  fillRoundedRect(x, y, w, h, r, c) { this.record('fillRoundedRect', [x, y, w, h, r, c]); }
  strokeRect(x, y, w, h, c, t) { this.record('strokeRect', [x, y, w, h, c, t]); }
  strokeRoundedRect(x, y, w, h, r, c, t) { this.record('strokeRoundedRect', [x, y, w, h, r, c, t]); }
  line(x1, y1, x2, y2, c, t) { this.record('line', [x1, y1, x2, y2, c, t]); }
  polyline(pts, c, t) { this.record('polyline', [pts, c, t]); }
  fillPolygon(pts, c) { this.record('fillPolygon', [pts, c]); }
  fillCircle(cx, cy, r, c) { this.record('fillCircle', [cx, cy, r, c]); }
  fillEllipse(cx, cy, rx, ry, c) { this.record('fillEllipse', [cx, cy, rx, ry, c]); }
  drawText(x, y, str, c, o) { this.record('drawText', [x, y, str, c, o]); }
  drawImage(id, x, y, w, h, tint) { this.record('drawImage', [id, x, y, w, h, tint]); }
  textSize(str, o) {
    const fs = (o && o.fontSize) || 13;
    return { w: String(str == null ? '' : str).length * fs * 0.6, h: fs * 1.25 };
  }
  drawnText() { return this.calls.filter((c) => c[0] === 'drawText').map((c) => c[3]); }
}

let passed = 0;
let failed = 0;
const failures = [];
function check(cond, msg) {
  if (cond) { passed++; }
  else {
    failed++;
    failures.push(msg);
    console.error('  FAIL: ' + msg);
  }
}

class Env {
  constructor(opts = {}) {
    this.renderer = new MockRenderer();
    this.gui = new GUI(this.renderer, Object.assign({
      flags: { animations: false },
      clipboard: { read: () => '', write: () => {} },
    }, opts));
    this.input = {
      width: 1280, height: 720,
      mouse: { x: -1000, y: -1000, buttons: [false, false, false, false, false], wheelX: 0, wheelY: 0 },
      keys: new Set(), text: '',
    };
  }
  frame(draw) {
    if (draw) this._draw = draw;
    this.gui.beginFrame(this.input);
    if (this._draw) this._draw();
    this.gui.endFrame();
  }
  frames(n, draw) { for (let i = 0; i < n; i++) this.frame(draw); }
  hover(x, y) { this.input.mouse.x = x; this.input.mouse.y = y; }
  down(b = 0) { this.input.mouse.buttons[b] = true; }
  up(b = 0) { this.input.mouse.buttons[b] = false; }
  press(x, y, b = 0) { this.hover(x, y); this.down(b); this.frame(); }
  release(b = 0) { this.up(b); this.frame(); }
  click(x, y, b = 0) { this.press(x, y, b); this.release(b); }
  dragTo(x1, y1, x2, y2, steps = 10, b = 0) {
    this.hover(x1, y1);
    this.down(b);
    this.frame();
    for (let i = 1; i <= steps; i++) {
      this.hover(x1 + ((x2 - x1) * i) / steps, y1 + ((y2 - y1) * i) / steps);
      this.frame();
    }
    this.up(b);
    this.frame();
  }
}

function test(name, fn) {
  console.log('• ' + name);
  try { fn(); }
  catch (e) {
    failed++;
    failures.push(name + ' threw: ' + (e && e.stack || e));
    console.error('  THREW: ' + (e && e.stack || e));
  }
}

/* ---------------------------------------------------------------------- *
 * 1. window header context menus
 * ---------------------------------------------------------------------- */

test('right-click a title bar: menu with only allowed options', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('M', { pos: [200, 100], size: [300, 200], flags: WindowFlags.Closable })) e.gui.endWindow();
  };
  e.frames(2, draw);
  const M = e.gui.getWindow('M');
  check(!!M, 'window exists');
  // hover the title bar, right-click
  e.press(300, 112, 1);
  e.release(1);
  const p = e.gui.state.popups.get('winctx:' + M.idHash);
  check(!!p && p.open, 'context menu popup opened');
  const labels = (p.data.items || []).map((r) => r.label).filter((l) => l);
  check(labels.includes('Collapse'), 'has Collapse, got ' + labels);
  check(labels.includes('Reset position'), 'has Reset position, got ' + labels);
  check(labels.includes('Close'), 'has Close, got ' + labels);
  check(!labels.includes('Undock'), 'no Undock for a free window');
  // click the Close row -> window closes
  e.frame(draw); // let the menu lay out
  const rowH = e.gui._lineH() + 10;
  const closeIdx = p.data.items.findIndex((r) => r.label === 'Close');
  e.click(p.x + p.w / 2, p.y + 6 + closeIdx * rowH + rowH / 2);
  e.frames(1, draw);
  check(M.open === false, 'Close row closed the window');
  check(!p.open, 'menu closed after selection');
});

test('context menu respects window flags/state', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('Plain', {
      pos: [200, 100], size: [300, 200],
      flags: WindowFlags.NoCollapse | WindowFlags.Closable,
    })) e.gui.endWindow();
  };
  e.frames(2, draw);
  const P = e.gui.getWindow('Plain');
  e.press(260, 112, 1);
  e.release(1);
  const p = e.gui.state.popups.get('winctx:' + P.idHash);
  const labels = (p.data.items || []).map((r) => r.label).filter((l) => l);
  check(!labels.includes('Collapse'), 'NoCollapse window has no Collapse, got ' + labels);
  check(labels.includes('Close'), 'still closable');
});

test('context menu: Collapse toggles; flag off disables the menu', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('M', { pos: [200, 100], size: [300, 200] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  const M = e.gui.getWindow('M');
  e.press(300, 112, 1);
  e.release(1);
  const p = e.gui.state.popups.get('winctx:' + M.idHash);
  e.frame(draw);
  const rowH = e.gui._lineH() + 10;
  const i = p.data.items.findIndex((r) => r.label === 'Collapse');
  e.click(p.x + p.w / 2, p.y + 6 + i * rowH + rowH / 2);
  e.frames(1, draw);
  check(M.collapsed === true, 'Collapse row collapsed the window');
  // second right-click on the (collapsed) title toggles the menu closed
  e.press(260, 112, 1);
  e.release(1);
  e.press(260, 112, 1);
  e.release(1);
  check(!p.open, 'second right-click closes the menu');

  const e2 = new Env({ flags: { animations: false, windowContextMenu: false } });
  const draw2 = () => {
    if (e2.gui.beginWindow('N', { pos: [200, 100], size: [300, 200] })) e2.gui.endWindow();
  };
  e2.frames(2, draw2);
  e2.press(300, 112, 1);
  e2.release(1);
  check(e2.gui.state.popupList.length === 0, 'windowContextMenu flag off: no menu');
});

test('covered window: right-click opens the TOP window\'s menu only', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { pos: [100, 100], size: [400, 200] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { pos: [150, 120], size: [300, 200], flags: WindowFlags.NoTitleBar })) e.gui.endWindow();
  };
  e.frames(2, draw);
  // point (200,132): inside A's title bar, covered by B's body (B has no title)
  e.press(200, 132, 1);
  e.release(1);
  const A = e.gui.getWindow('A'), B = e.gui.getWindow('B');
  check(!e.gui.state.popups.get('winctx:' + A.idHash), 'covered A got no menu');
  check(!e.gui.state.popups.get('winctx:' + B.idHash), 'no-title B got no menu either');
  e.frames(2, draw);
});

/* ---------------------------------------------------------------------- *
 * 2. covered elements: no hover / no chrome effects
 * ---------------------------------------------------------------------- */

test('covered window: chevron click toggles only the top window', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { pos: [100, 100], size: [400, 200] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { pos: [110, 120], size: [300, 150] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  const A = e.gui.getWindow('A'), B = e.gui.getWindow('B');
  // chevron overlap: A x100-128 y100-134, B x110-138 y120-154 -> (120,127)
  e.click(120, 127);
  e.frames(1, draw);
  check(B.collapsed === true, 'top window B collapsed');
  check(A.collapsed === false, 'covered window A untouched');
});

test('covered window: close button press closes only the top window', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { pos: [100, 100], size: [400, 200], flags: WindowFlags.Closable })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { pos: [120, 110], size: [380, 180], flags: WindowFlags.Closable })) e.gui.endWindow();
  };
  e.frames(2, draw);
  const A = e.gui.getWindow('A'), B = e.gui.getWindow('B');
  // both close buttons overlap at x474-492, y120-124 -> click (480,122)
  e.click(480, 122);
  e.frames(1, draw);
  check(B.open === false, 'top window B closed');
  check(A.open === true, 'covered window A still open');
});

test('item hidden under an open popup does not hover or take clicks', () => {
  const e = new Env();
  let clicks = 0;
  let btnRect = null, btnHover = null;
  const draw = () => {
    if (e.gui.beginWindow('M', { pos: [200, 100], size: [300, 200] })) {
      e.gui.text('filler');
      if (e.gui.button('Target')) clicks++;
      btnRect = e.gui.lastItemRect();
      btnHover = e.gui.lastItem().hovered;
      e.gui.endWindow();
    }
  };
  e.frames(2, draw);
  const M = e.gui.getWindow('M');
  e.hover(btnRect.x + btnRect.w / 2, btnRect.y + btnRect.h / 2);
  e.frame(draw);
  check(btnHover === true, 'button hovers normally before popup');
  // right-click the title bar -> context menu anchored at (360,117), covering
  // the button area below
  e.press(240, 117, 1);
  e.release(1);
  e.frame(draw);
  const p = e.gui.state.popups.get('winctx:' + M.idHash);
  check(!!p && p.open && p.w > 0, 'menu open with layout');
  const under = btnRect.x + btnRect.w / 2 >= p.x && btnRect.x + btnRect.w / 2 < p.x + p.w &&
    btnRect.y + btnRect.h / 2 >= p.y && btnRect.y + btnRect.h / 2 < p.y + p.h;
  check(under, 'button really sits under the popup (test setup)');
  e.hover(btnRect.x + btnRect.w / 2, btnRect.y + btnRect.h / 2);
  e.frame(draw);
  check(btnHover === false, 'button under the popup is NOT hovered');
  e.click(btnRect.x + btnRect.w / 2, btnRect.y + btnRect.h / 2);
  e.frames(2, draw);
  check(clicks === 0, 'click under the popup did not activate the button');
  // dismiss the popup, button hovers again
  e.click(10, 650);
  e.hover(btnRect.x + btnRect.w / 2, btnRect.y + btnRect.h / 2);
  e.frame(draw);
  check(btnHover === true, 'button hovers again after the popup is gone');
});

/* ---------------------------------------------------------------------- *
 * 3. drag a member's slim header out to undock; click still toggles
 * ---------------------------------------------------------------------- */

function vDockEnv(e) {
  const draw = () => {
    if (e.gui.beginWindow('A', { pos: [100, 100], size: [240, 200] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { pos: [100, 340], size: [240, 200] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  e.gui.dock('A', 'B', { dir: 'v', ratio: 0.5, pos: [100, 100], size: [240, 300] });
  e.frames(2, draw);
  return draw;
}

test('dragging a member header undocks it (sibling stays free)', () => {
  const e = new Env();
  const draw = vDockEnv(e);
  const A = e.gui.getWindow('A'), B = e.gui.getWindow('B');
  // B sub-rect: (100, 273, 234, 133); slim header y 273..299
  check(Math.abs(B.x - 100) < 1 && Math.abs(B.y - 273) < 1, 'B sub-rect as expected, got ' + B.x + ',' + B.y);
  // press B's header and drag far away
  e.hover(150, 285);
  e.down(0);
  e.frame(draw);
  e.hover(151, 285); e.frame(draw);   // still below threshold (1px < 3px)
  check(B._dockKey != null, 'no undock before the drag threshold');
  e.hover(400, 480); e.frame(draw);   // past threshold -> undock + win-move
  e.frame(draw);
  check(B._dockKey == null && B.movable === true, 'B undocked while dragging');
  check(e.gui.getDocks().length === 0, 'dock removed');
  check(A._dockKey == null && A.movable === true, 'sibling A freed too');
  check(Math.abs(A.x - 100) < 1 && Math.abs(A.y - 134) < 1, 'A kept its sub-rect, got ' + A.x + ',' + A.y);
  check(Math.abs(B.x - (400 - 50)) < 1, 'B follows the cursor, got x=' + B.x);
  e.up(0); e.frame(draw);
  e.frames(1, draw);
  check(Math.abs(B.x - 350) < 1 && Math.abs(B.y - (480 - 12)) < 1, 'B dropped at cursor, got ' + B.x + ',' + B.y);
  check(B.titleH === 34, 'B has a full title bar again');
});

test('a pure click on a member header still toggles collapse', () => {
  const e = new Env();
  const draw = vDockEnv(e);
  const B = e.gui.getWindow('B');
  e.click(150, 285);
  e.frames(1, draw);
  check(B.collapsed === true, 'click collapsed the member');
  e.frames(1, draw);
  // a collapsed member's header moves to the top strip of the dock content
  check(Math.abs(B.y - 134) < 1, 'collapsed header at top strip, got y=' + B.y);
  e.click(150, B.y + 10);
  e.frames(1, draw);
  check(B.collapsed === false, 'second click expanded it');
  // UI not stuck: a normal window click still works afterwards
  check(e.gui.state.activeId === 0, 'activeId reset after header click, got ' + e.gui.state.activeId);
});

test('drag-undock feeds the dock hints (drop onto another window joins it)', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { pos: [100, 100], size: [240, 200] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { pos: [100, 340], size: [240, 200] })) e.gui.endWindow();
    if (e.gui.beginWindow('C', { pos: [600, 400], size: [240, 160] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  e.gui.dock('A', 'B', { dir: 'v', ratio: 0.5, pos: [100, 100], size: [240, 300] });
  e.frames(2, draw);
  const B = e.gui.getWindow('B');
  // drag B out and over C's center (720, 470)
  e.hover(150, 285); e.down(0); e.frame(draw);
  e.hover(400, 480); e.frame(draw);
  e.hover(720, 480); e.frame(draw);
  const h = e.gui.state._dockHint;
  check(!!h && h.kind === 'window' && h.target === e.gui.getWindow('C'), 'grid shown over C during drag-undock');
  // drop on C's right triangle (the center apex has no direction)
  const [px, py] = e.gui._dockGridPoint(h.parts, 'r');
  e.hover(px, py); e.frame(draw);
  e.up(0); e.frame(draw);
  e.frames(1, draw);
  check(e.gui.isDocked('B', 'C'), 'B docked with C after the drag-undock drop');
});

/* ---------------------------------------------------------------------- *
 * 4. dock scaling: all edges incl. the new top edge (dir v)
 * ---------------------------------------------------------------------- */

function dockRect(e, title) {
  const D = e.gui.state.docks.get(e.gui.getDocks()[0].id);
  return D;
}

test('v-dock: top edge resize scales it vertically', () => {
  const e = new Env();
  const draw = vDockEnv(e);
  const D = dockRect(e);
  const y0 = D.y, h0 = D.h;
  // hover the top edge: ns-resize cursor
  e.hover(200, y0 + 2);
  e.frame(draw);
  check(e.renderer.lastCursor === 'ns-resize', 'top edge shows ns-resize, got ' + e.renderer.lastCursor);
  e.dragTo(200, y0, 200, y0 - 40);
  const D2 = dockRect(e);
  check(Math.abs(D2.y - (y0 - 40)) < 1, 'D.y moved up, got ' + D2.y);
  check(Math.abs(D2.h - (h0 + 40)) < 1, 'D.h grew by 40, got ' + D2.h);
  const A = e.gui.getWindow('A');
  check(Math.abs(A.y - (D2.y + 34)) < 1, 'member A followed the top edge, got y=' + A.y);
  const B = e.gui.getWindow('B');
  check(B.h > A.h - 60, 'members re-laid out sensibly, A.h=' + A.h + ' B.h=' + B.h);
});

test('v-dock: bottom edge + divider + move still work', () => {
  const e = new Env();
  const draw = vDockEnv(e);
  const D = dockRect(e);
  const h0 = D.h;   // numbers: the dock object is mutated in place
  e.dragTo(200, D.y + D.h, 200, D.y + D.h + 60);
  let D2 = dockRect(e);
  check(Math.abs(D2.h - (h0 + 60)) < 1, 'bottom resize worked, h=' + D2.h);
  // divider at y = D.y + 34 + (h-34-6)*0.5 + 3
  const divY = D2.y + 34 + Math.round((D2.h - 34 - 6) * 0.5) + 3;
  e.dragTo(200, divY, 200, divY + 40);
  D2 = dockRect(e);
  check(D2.ratio > 0.5, 'divider drag changed the ratio, got ' + D2.ratio.toFixed(2));
  const x0 = D2.x, y0 = D2.y;
  e.dragTo(x0 + 100, y0 + 8, x0 + 160, y0 + 58);
  D2 = dockRect(e);
  check(D2.x - x0 === 60 && D2.y - y0 === 50, 'dock moved by its title');
  const A = e.gui.getWindow('A'), B = e.gui.getWindow('B');
  check(A.x === B.x && A.x === D2.x, 'members moved with the dock');
});

test('h-dock: vertical scaling (bottom edge) and top edge both work', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { pos: [100, 100], size: [240, 200] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { pos: [360, 100], size: [240, 200] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  e.gui.dock('A', 'B', { dir: 'h', ratio: 0.5, pos: [100, 100], size: [500, 200] });
  e.frames(2, draw);
  const D = dockRect(e);
  const h0 = D.h;
  e.dragTo(300, D.y + D.h, 300, D.y + D.h + 80);
  let D2 = dockRect(e);
  check(Math.abs(D2.h - (h0 + 80)) < 1, 'h-dock bottom (vertical) resize, h=' + D2.h);
  e.dragTo(300, D2.y, 300, D2.y - 30);
  D2 = dockRect(e);
  check(Math.abs(D2.h - (h0 + 110)) < 1, 'h-dock top resize, h=' + D2.h);
});

/* ---------------------------------------------------------------------- *
 * 5. the join grid pops up over ANY dockable window (docked / edge targets)
 * ---------------------------------------------------------------------- */

test('grid pops up over a docked member; dropping splits the old dock', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { pos: [100, 100], size: [240, 200] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { pos: [100, 340], size: [240, 200] })) e.gui.endWindow();
    if (e.gui.beginWindow('C', { pos: [600, 400], size: [200, 150] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  e.gui.dock('A', 'B', { dir: 'v', ratio: 0.5, pos: [100, 100], size: [240, 300] });
  e.frames(2, draw);
  const A = e.gui.getWindow('A'), B = e.gui.getWindow('B'), C = e.gui.getWindow('C');
  // drag C over A's sub-rect center (217, ~200)
  e.hover(700, 412); e.down(0); e.frame(draw);
  e.hover(217, 200); e.frame(draw);
  const h = e.gui.state._dockHint;
  check(!!h && h.kind === 'window' && h.target === A, 'grid over docked member A (was skipped before)');
  // grid is centered on the target window
  const cx = A.x + A.w / 2, cy = A.y + A.h / 2;
  const box = h.parts.box;
  check(Math.abs(box.x + box.w / 2 - cx) < 1 && Math.abs(box.y + box.h / 2 - cy) < 1, 'grid centered on A');
  // drop on A's right triangle -> C joins A (h dir); B is freed at its sub-rect
  const [px, py] = e.gui._dockGridPoint(h.parts, 'r');
  e.hover(px, py); e.frame(draw);
  check(e.gui.state._dockHint.side === 'r', 'right triangle active');
  e.up(0); e.frame(draw);
  e.frames(1, draw);
  check(e.gui.isDocked('C', 'A'), 'C docked with A');
  check(B._dockKey == null && B._edge == null, 'B freed from the old dock');
  check(Math.abs(B.x - 100) < 1 && Math.abs(B.y - 273) < 1, 'B kept its sub-rect, got ' + B.x + ',' + B.y);
  // and the grid pops up again on the very next drag (no "once only"):
  // B is free now — drag it over the new C+A dock (A's pane; hover its upper
  // area so the cursor is over A, not over B which overlaps the dock's lower
  // part after the span-join moved the dock down)
  const A2 = e.gui.getWindow('A');
  e.hover(200, 285); e.down(0); e.frame(draw);
  e.hover(A2.x + 30, A2.y + 20); e.frame(draw);
  check(!!e.gui.state._dockHint && e.gui.state._dockHint.kind === 'window' && e.gui.state._dockHint.target === A2,
    'grid reappears on a later drag');
  e.up(0); e.frame(draw);
});

test('grid pops up over a screen-edge window; dropping joins it', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('E1', { pos: [700, 100], size: [200, 150] })) e.gui.endWindow();
    if (e.gui.beginWindow('F', { pos: [900, 400], size: [200, 150] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  e.gui.dockToEdge('E1', 'left');
  e.frames(2, draw);
  const E1 = e.gui.getWindow('E1'), F = e.gui.getWindow('F');
  check(E1._edge === 'left', 'E1 edge-docked');
  // drag F over the left band
  e.hover(1000, 412); e.down(0); e.frame(draw);
  e.hover(60, 300); e.frame(draw);
  const h = e.gui.state._dockHint;
  check(!!h && h.kind === 'window' && h.target === E1, 'grid over edge-docked E1');
  const [px, py] = e.gui._dockGridPoint(h.parts, 'r');
  e.hover(px, py); e.frame(draw);
  e.up(0); e.frame(draw);
  e.frames(1, draw);
  check(e.gui.isDocked('F', 'E1'), 'F docked with E1');
  check(E1._edge === 'left' && F._edge === 'left', 'both stay in the edge stack (combined in place)');
  const D = [...e.gui.state.docks.values()][0];
  check(!!D && D._edge === 'left', 'the combined window is itself edge-docked, got ' + (D && D._edge));
  check(D && D.dir === 'v', 'column join is forced vertical so both keep the full docked width, got ' + (D && D.dir));
  check(D && Math.abs(D.w - (e.gui.state.edgeDocks.left.size - 12)) <= 1,
    'combined width = the docked width (' + (D && D.w) + '), not the sum of both');
});

test('grid is drawn (topmost) while the cursor is over the target', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('T', { pos: [500, 100], size: [240, 200] })) e.gui.endWindow();
    if (e.gui.beginWindow('S', { pos: [900, 400], size: [200, 150] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  const T = e.gui.getWindow('T');
  let delta = 0;
  const orig = e.gui._drawDockHints.bind(e.gui);
  e.gui._drawDockHints = function () {
    const before = e.renderer.calls.length;
    orig();
    delta = e.renderer.calls.length - before;
  };
  e.hover(990, 412); e.down(0); e.frame(draw);
  e.hover(620, 200); e.frame(draw);
  check(delta >= 11, 'join grid drawn on the hint frame (5 pads x2 + box), got ' + delta);
  check(T.y === 100, 'target untouched during hover');
  e.up(0); e.frame(draw);
  e.frame(draw);
  check(delta === 0, 'no hint after release');
});

/* ---------------------------------------------------------------------- *
 * 6. the screen-center dock grid: square of four direction triangles
 * ---------------------------------------------------------------------- */

test('screen grid: four triangles always drawn; hovering one highlights it', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('W', { pos: [600, 400], size: [200, 150] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  const W = e.gui.getWindow('W');
  let delta = 0, polys = 0;
  const orig = e.gui._drawDockHints.bind(e.gui);
  e.gui._drawDockHints = function () {
    const before = e.renderer.calls.length;
    orig();
    const calls = e.renderer.calls.slice(before);
    delta = calls.length;
    polys = calls.filter((c) => c[0] === 'fillPolygon').length;
  };
  e.hover(700, 412); e.down(0); e.frame(draw);
  // move over empty space (not over any window, not an edge band)
  e.hover(664, 360); e.frame(draw);   // the RIGHT triangle of the center grid
  const h = e.gui.state._dockHint;
  check(!!h && h.kind === 'screen' && h.side === 'r', 'right triangle active, got ' + JSON.stringify(h && { k: h.kind, s: h.side }));
  check(polys === 4, 'square of four direction triangles drawn, got ' + polys + ' fillPolygon calls');
  check(delta >= 8, 'grid drawn (4 fills + 4 outlines), got ' + delta);
  // drop on the right triangle -> edge dock right
  e.up(0); e.frame(draw);
  e.frames(1, draw);
  check(W._edge === 'right', 'drop on right triangle docked the window to the right edge, got ' + W._edge);
});

test('screen grid: top triangle docks top; center apex is a plain drop; triangles stack with existing edge docks', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('X', { pos: [100, 100], size: [200, 150] })) e.gui.endWindow();
    if (e.gui.beginWindow('Y', { pos: [400, 100], size: [200, 150] })) e.gui.endWindow();
    if (e.gui.beginWindow('Z', { pos: [700, 400], size: [200, 150] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  e.gui.dockToEdge('X', 'left');
  e.frames(2, draw);
  const Y = e.gui.getWindow('Y'), Z = e.gui.getWindow('Z');
  // Y -> top triangle (centroid 640, 336)
  e.hover(500, 112); e.down(0); e.frame(draw);
  e.hover(640, 336); e.frame(draw);
  check(e.gui.state._dockHint.side === 't', 'top triangle active');
  e.up(0); e.frame(draw);
  e.frames(1, draw);
  check(Y._edge === 'top', 'Y docked to the top edge, got ' + Y._edge);
  // Z -> center apex (640, 360): no direction — a plain drop, no dock
  e.hover(800, 412); e.down(0); e.frame(draw);
  e.hover(640, 360); e.frame(draw);
  check(e.gui.state._dockHint.side === null, 'center apex has no direction');
  e.up(0); e.frame(draw);
  e.frames(1, draw);
  check(Z._edge == null && Z._dockKey == null, 'center apex drop kept the window free');
  // Z -> left triangle (centroid 616, 360): must JOIN the existing left stack
  // with X. Z moved to the drop point after the plain drop — press its
  // current title bar.
  e.hover(Z.x + 100, Z.y + 12); e.down(0); e.frame(draw);
  e.hover(616, 360); e.frame(draw);
  check(e.gui.state._dockHint.side === 'l', 'left triangle active');
  e.up(0); e.frame(draw);
  e.frames(1, draw);
  const E = e.gui.state.edgeDocks.left;
  check(!!E && E.wins.length === 2 && E.wins.includes('X') && E.wins.includes('Z'),
    'Z joined the existing left edge stack with X, got ' + JSON.stringify(E && E.wins));
});

/* ---------------------------------------------------------------------- *
 * round-3: NoDock suppresses the drag UI, combined sizes, relative scaling
 * ---------------------------------------------------------------------- */

test('NoDock source: dragging it draws NO docking UI (no screen grid, no join grid)', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('N', { pos: [400, 300], size: [200, 150], flags: WindowFlags.NoDock })) e.gui.endWindow();
    if (e.gui.beginWindow('O', { pos: [700, 100], size: [200, 150] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  let polys = 0, outlines = 0;
  const orig = e.gui._drawDockHints.bind(e.gui);
  e.gui._drawDockHints = function () {
    const before = e.renderer.calls.length;
    orig();
    const calls = e.renderer.calls.slice(before);
    polys = calls.filter((c) => c[0] === 'fillPolygon').length;
    outlines = calls.filter((c) => c[0] === 'polyline').length;
  };
  const N = e.gui.getWindow('N');
  e.hover(N.x + 100, N.y + 12); e.down(0); e.frame(draw);
  e.hover(640, 360); e.frame(draw);   // over the screen-center grid position
  check(!e.gui.state._dockHint, 'no hint at all while dragging a NoDock window');
  check(polys === 0 && outlines === 0, 'no grid triangles drawn (got ' + polys + ' fills / ' + outlines + ' outlines)');
  e.up(0); e.frame(draw);
  // sanity: a normal window still gets the four-triangle screen grid
  const O = e.gui.getWindow('O');
  e.hover(O.x + 100, O.y + 12); e.down(0); e.frame(draw);
  e.hover(640, 360); e.frame(draw);
  check(polys === 4 && outlines === 4, 'normal drag draws the four-triangle grid, got ' + polys + '/' + outlines);
  e.up(0); e.frame(draw);
  e.gui._drawDockHints = orig;
});

test('combined size without pos/size: sum of both windows in the dock direction, cross dim = the max', () => {
  const make = (dir) => {
    const e = new Env();
    const draw = () => {
      if (e.gui.beginWindow('A', { pos: [100, 100], size: [240, 200] })) e.gui.endWindow();
      if (e.gui.beginWindow('B', { pos: [400, 150], size: [180, 120] })) e.gui.endWindow();
    };
    e.frames(2, draw);
    const D = e.gui.dock('A', 'B', { dir });
    e.frames(2, draw);
    return D;
  };
  // horizontal join: width = 240 + 180, height = the taller window (200)
  let D = make('h');
  check(D && D.x === 100 && D.y === 100 && D.w === 420 && D.h === 200,
    'h-dock width is the sum of both widths, got ' + (D && JSON.stringify({ x: D.x, y: D.y, w: D.w, h: D.h })));
  // vertical join: height = 200 + 120, width = the wider window (240)
  D = make('v');
  check(D && D.x === 100 && D.y === 100 && D.w === 240 && D.h === 320,
    'v-dock height is the sum of both heights, got ' + (D && JSON.stringify({ x: D.x, y: D.y, w: D.w, h: D.h })));
});

test('resizing a combined window scales the members relatively (ratios preserved)', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { pos: [100, 100], size: [240, 200] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { pos: [340, 100], size: [360, 200] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  e.gui.dock('A', 'B', { dir: 'h', ratio: 0.4, pos: [100, 100], size: [600, 200] });
  e.frames(2, draw);
  const D = e.gui.getDocks()[0]; // a snapshot — re-read after the drag
  const A0 = e.gui.getWindow('A').w / D.w;
  check(Math.abs(A0 - 0.4) < 0.03, 'A starts at ~40% of the dock width, got ' + A0.toFixed(3));
  const w0 = D.w;
  // drag the dock's right edge 200px out
  e.dragTo(D.x + D.w, 200, D.x + D.w + 200, 200);
  const D2 = e.gui.getDocks()[0];
  const A2 = e.gui.getWindow('A'), B2 = e.gui.getWindow('B');
  check(Math.abs(D2.w - (w0 + 200)) < 1, 'dock resized wider, w=' + D2.w);
  check(Math.abs(A2.w / D2.w - 0.4) < 0.02, 'A still ~40% of the new width, got ' + (A2.w / D2.w).toFixed(3));
  check(Math.abs(B2.w / D2.w - 0.6) < 0.02, 'B still ~60% of the new width, got ' + (B2.w / D2.w).toFixed(3));
  check(A2.w > A0 * w0 * 0.9 && B2.w > (1 - A0) * w0 * 0.9, 'both members grew with the dock');
});

/* ---------------------------------------------------------------------- *
 * round-5: edge stacks never cover each other; inner-side resize bars
 * ---------------------------------------------------------------------- */

test('edge stacks never cover each other (columns own the height, rows fit between)', () => {
  const make = (order) => {
    const e = new Env();
    const draw = () => {
      if (e.gui.beginWindow('L', { pos: [500, 100], size: [200, 150] })) e.gui.endWindow();
      if (e.gui.beginWindow('T', { pos: [500, 300], size: [240, 150] })) e.gui.endWindow();
      if (e.gui.beginWindow('R', { pos: [500, 500], size: [200, 150] })) e.gui.endWindow();
      if (e.gui.beginWindow('B', { pos: [500, 640], size: [240, 150] })) e.gui.endWindow();
    };
    e.frames(2, draw);
    for (const [title, edge] of order) e.gui.dockToEdge(title, edge);
    e.frames(2, draw);
    return e;
  };
  const overlap = (e) => {
    const wins = ['L', 'T', 'R', 'B'].filter((t) => e.gui.getWindow(t) && e.gui.getWindow(t)._edge)
      .map((t) => e.gui.getWindow(t));
    for (let i = 0; i < wins.length; i++)
      for (let j = i + 1; j < wins.length; j++) {
        const a = wins[i], b = wins[j];
        if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h)
          return a.title + ' covers ' + b.title;
      }
    return null;
  };
  // left column + top row, in either dock order
  let e = make([['L', 'left'], ['T', 'top']]);
  check(!overlap(e), 'left + top do not overlap, got ' + overlap(e));
  const L = e.gui.getWindow('L'), T = e.gui.getWindow('T');
  check(T.x >= L.x + L.w, 'top row starts after the left column, T.x=' + T.x + ' vs ' + (L.x + L.w));
  e = make([['T', 'top'], ['L', 'left']]);
  check(!overlap(e), 'top + left (reversed dock order) do not overlap, got ' + overlap(e));
  // all four edges: columns full height, rows between them
  e = make([['L', 'left'], ['T', 'top'], ['R', 'right'], ['B', 'bottom']]);
  check(!overlap(e), 'all four stacks do not overlap, got ' + overlap(e));
  const L2 = e.gui.getWindow('L'), R2 = e.gui.getWindow('R'),
        T2 = e.gui.getWindow('T'), B2 = e.gui.getWindow('B');
  check(L2.y + L2.h > T2.y + T2.h - 2 && L2.y < T2.y + 2, 'left column spans past the top row');
  check(T2.x >= L2.x + L2.w && T2.x + T2.w <= R2.x + R2.w, 'top row fits between the columns');
  check(B2.x >= L2.x + L2.w && B2.x + B2.w <= R2.x + R2.w, 'bottom row fits between the columns');
});

test('edge stacks scale from the inner side only (resize bar method, dock direction only)', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('L', { pos: [500, 100], size: [200, 150] })) e.gui.endWindow();
    if (e.gui.beginWindow('T', { pos: [500, 300], size: [240, 150] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  e.gui.dockToEdge('L', 'left');
  e.frames(2, draw);
  const L = e.gui.getWindow('L');
  const innerX = () => { const R = e.gui.state.edgeDocks.left._rect; return R.x0 + R.colW; };
  // left column: inner (right) side is the only scalable side, ew-resize
  e.hover(innerX() - 3, 300); e.frame(draw);
  check(e.renderer.lastCursor === 'ew-resize', 'left column inner side shows ew-resize, got ' + e.renderer.lastCursor);
  const bar = e.renderer.calls.filter((c) => c[0] === 'fillRoundedRect' && c[3] === 4 &&
    c[4] >= 24 && c[1] >= innerX() - 4 && c[1] <= innerX() + 1);
  check(bar.length >= 1, 'resize bar drawn over the inner edge, got ' + bar.length);
  e.hover(2, 300); e.frame(draw);
  check(e.renderer.lastCursor !== 'ew-resize', 'screen-docked side is not scalable, got ' + e.renderer.lastCursor);
  const w0 = L.w, h0 = L.h;
  e.dragTo(innerX() - 3, 300, innerX() + 50, 300);
  const L2 = e.gui.getWindow('L');
  check(L2.w > w0 + 30 && Math.abs(L2.h - h0) < 2,
    'inner drag scaled the column width only, got ' + L2.w + 'x' + L2.h);
  // top row: only its inner (bottom) side, ns-resize, height only
  e.gui.dockToEdge('T', 'top');
  e.frames(2, draw);
  const innerY = () => { const R = e.gui.state.edgeDocks.top._rect; return R.y0 + R.colH; };
  e.hover(600, innerY() + 3); e.frame(draw);
  check(e.renderer.lastCursor === 'ns-resize', 'top row inner side shows ns-resize, got ' + e.renderer.lastCursor);
  e.hover(600, 2); e.frame(draw);
  check(e.renderer.lastCursor !== 'ns-resize', 'top row screen side is not scalable, got ' + e.renderer.lastCursor);
  const T = e.gui.getWindow('T');
  const tw0 = T.w, th0 = T.h;
  e.dragTo(600, innerY() + 3, 600, innerY() + 40);
  const T2 = e.gui.getWindow('T');
  check(T2.h > th0 + 20 && Math.abs(T2.w - tw0) < 2,
    'inner drag scaled the row height only, got ' + T2.w + 'x' + T2.h);
  // the proximity distance is configurable
  e.gui.flags.resizeBarProximity = 3;
  e.hover(innerX() + 4, 300); e.frame(draw);
  check(e.renderer.lastCursor !== 'ew-resize', '4px out is outside N=3, got ' + e.renderer.lastCursor);
  e.hover(innerX() + 2, 300); e.frame(draw);
  check(e.renderer.lastCursor === 'ew-resize', '2px out is inside N=3, got ' + e.renderer.lastCursor);
});

/* ---------------------------------------------------------------------- *
 * round-6: edge-split stability, global dock UI priority, topmost input
 * ---------------------------------------------------------------------- */

test('edge-split: boundary follows the mouse 1:1 and stays while held', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { pos: [500, 100], size: [200, 150] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { pos: [500, 300], size: [200, 150] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  e.gui.dockToEdge('A', 'left');
  e.gui.dockToEdge('B', 'left');
  e.frames(2, draw);
  const h0 = e.gui.getWindow('A').h;
  const gapY = e.gui.getWindow('A').y + h0 + 2;
  // press the gap, move +60, then hold 10 frames without moving
  e.hover(100, gapY); e.down(0); e.frame();
  e.hover(100, gapY + 60); e.frame();
  const h1 = e.gui.getWindow('A').h;
  for (let i = 0; i < 10; i++) e.frame();
  const h2 = e.gui.getWindow('A').h;
  check(Math.abs(h2 - h1) < 2, 'held stationary: A.h stable (' + h1 + ' -> ' + h2 + ')');
  check(Math.abs((h1 - h0) - 60) <= 2, 'boundary moved 1:1 with the mouse (+' + (h1 - h0) + ' for +60)');
  e.up(0); e.frame();
  check(Math.abs(e.gui.getWindow('A').h - h1) < 2, 'stays where released');
  // second drag in the other direction
  const hB0 = e.gui.getWindow('B').h;
  const gapY2 = e.gui.getWindow('A').y + e.gui.getWindow('A').h + 2;
  e.hover(100, gapY2); e.down(0); e.frame();
  e.hover(100, gapY2 - 30); e.frame();
  const b1 = e.gui.getWindow('B').h;
  for (let i = 0; i < 10; i++) e.frame();
  check(Math.abs(e.gui.getWindow('B').h - b1) < 2, 'second drag held: B.h stable');
  check(Math.abs((b1 - hB0) - 30) <= 2, 'second drag 1:1 (mouse -30 -> B.h +' + (b1 - hB0) + ')');
  e.up(0); e.frame();
});

test('global dock UI takes input priority over windows under the cursor', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { pos: [100, 400], size: [200, 150] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { pos: [560, 280], size: [200, 160] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  const B = e.gui.getWindow('B');
  // screen-center grid box (604..676, 324..396) overlaps B: hover the right
  // triangle while the cursor is over B
  e.hover(200, 412); e.down(0); e.frame();
  e.hover(664, 360); e.frame();
  const h = e.gui.state._dockHint;
  check(!!h && h.kind === 'screen' && h.side === 'r',
    'center grid active over a window, got ' + JSON.stringify(h && { k: h.kind, s: h.side }));
  e.up(0); e.frame(); e.frame();
  check(e.gui.getWindow('A')._edge === 'right', 'drop on the center grid over B docked A to the right edge');
  check(!e.gui.isDocked('A', 'B'), 'A did not join B');
  // 44px screen-edge band over a window
  e.gui.undockEdge('A');
  e.frames(2, draw);
  B.x = 0; B.y = 400; B.w = 200; B.h = 100;
  e.frames(2, draw);
  const Aw = e.gui.getWindow('A');
  e.hover(Aw.x + 50, Aw.y + 12); e.down(0); e.frame();
  check(!!e.gui.state.drag && e.gui.state.drag.type === 'win-move', 'A drag started');
  e.hover(20, 450); e.frame();  // inside the left 44px band AND over B
  const h3 = e.gui.state._dockHint;
  check(!!h3 && h3.kind === 'edge' && h3.edge === 'left',
    'edge band wins over the window under the cursor, got ' + JSON.stringify(h3 && { k: h3.kind, e: h3.edge }));
  e.up(0); e.frame(); e.frame();
  check(e.gui.getWindow('A')._edge === 'left', 'drop on the band over B docked A to the left edge');
  check(!e.gui.isDocked('A', 'B'), 'A did not join B via the band');
  // the join grid still works over plain windows outside the global UI
  e.gui.undockEdge('A');
  e.frames(2, draw);
  const Aw2 = e.gui.getWindow('A');
  e.hover(Aw2.x + 50, Aw2.y + 12); e.down(0); e.frame();
  e.hover(100, 440); e.frame();  // inside B, over the join grid's top triangle
  const h4 = e.gui.state._dockHint;
  check(!!h4 && h4.kind === 'window' && h4.target === B && h4.side === 't',
    'join grid still works over a plain window, got ' + JSON.stringify(h4 && { k: h4.kind, s: h4.side }));
  e.up(0); e.frame(); e.frame();
  check(e.gui.isDocked('A', 'B'), 'drop on the join grid joined A+B');
});

test('input only reaches the topmost element (dock chrome, edge band, modal)', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('L', { pos: [700, 100], size: [200, 150] })) e.gui.endWindow();
    if (e.gui.beginWindow('P', { pos: [900, 300], size: [200, 150] })) e.gui.endWindow();
    if (e.gui.beginWindow('W', { pos: [700, 400], size: [300, 200] })) e.gui.endWindow(); // topmost
  };
  e.frames(2, draw);
  e.gui.dock('L', 'P');
  e.frames(2, draw);
  const D = [...e.gui.state.docks.values()][0];
  const divX = D.x + Math.round((D.w - 6) * D.ratio) + 3;
  const W = e.gui.getWindow('W');
  // (a) dock divider: covered by W's body -> W owns the point
  W.x = divX - 40; W.y = D.y + D.h - 60; W.w = 120; W.h = 60;
  e.frames(2, draw);
  const cY = W.y + 40;
  e.hover(divX, cY); e.frame();
  check(e.renderer.lastCursor !== 'ew-resize', 'no divider cursor through W, got ' + e.renderer.lastCursor);
  e.down(0); e.frame();
  check(!(e.gui.state.drag && e.gui.state.drag.type === 'dock-split'),
    'click through W did not start dock-split, got ' + (e.gui.state.drag && e.gui.state.drag.type));
  e.up(0); e.frame();
  // the uncovered part of the same divider still works
  e.hover(divX, D.y + 50); e.frame();
  check(e.renderer.lastCursor === 'ew-resize', 'divider cursor where uncovered, got ' + e.renderer.lastCursor);
  e.down(0); e.frame();
  check(!!e.gui.state.drag && e.gui.state.drag.type === 'dock-split',
    'uncovered divider starts dock-split, got ' + (e.gui.state.drag && e.gui.state.drag.type));
  e.up(0); e.frame();
  // (b) edge-stack inner band under W
  e.gui.undock('L', 'P');
  e.frames(2, draw);
  check(!!e.gui.dockToEdge('L', 'left'), 'dockToEdge accepted after undock');
  e.frames(2, draw);
  const L2 = e.gui.getWindow('L');
  const innerX = L2.x + L2.w + 3;
  W.x = innerX - 30; W.y = 100; W.w = 60; W.h = 100;
  e.frames(2, draw);
  e.hover(innerX, 150); e.frame();
  check(e.gui.state.hoveredWindow === W, 'W is the topmost window at the point');
  check(e.renderer.lastCursor !== 'ew-resize', 'no edge-bar cursor through W, got ' + e.renderer.lastCursor);
  e.down(0); e.frame();
  check(!(e.gui.state.drag && e.gui.state.drag.type === 'edge-resize'),
    'click through W did not start edge-resize, got ' + (e.gui.state.drag && e.gui.state.drag.type));
  e.up(0); e.frame();
  W.y = 600; e.frames(2, draw);
  e.hover(innerX, 150); e.frame();
  check(e.renderer.lastCursor === 'ew-resize', 'edge-bar cursor where uncovered, got ' + e.renderer.lastCursor);
  e.down(0); e.frame();
  check(!!e.gui.state.drag && e.gui.state.drag.type === 'edge-resize',
    'uncovered band starts edge-resize, got ' + (e.gui.state.drag && e.gui.state.drag.type));
  e.up(0); e.frame();
  // (c) an open modal kills the lower window's resize band (its own stays)
  const e2 = new Env();
  const draw2 = () => {
    if (e2.gui.beginWindow('N', { pos: [100, 100], size: [200, 150] })) e2.gui.endWindow();
    if (e2.gui.beginWindow('M', { pos: [500, 300], size: [200, 150], flags: WindowFlags.Modal })) e2.gui.endWindow();
  };
  e2.frames(2, draw2);
  check(!!e2.gui.getWindow('M').modal, 'sanity: M is modal');
  const N = e2.gui.getWindow('N'), M = e2.gui.getWindow('M');
  e2.hover(N.x + N.w + 3, N.y + 75); e2.frame();
  e2.down(0); e2.frame();
  check(!(e2.gui.state.drag && e2.gui.state.drag.type === 'win-resize'),
    'modal open: lower window resize band is dead, drag=' + (e2.gui.state.drag && e2.gui.state.drag.type));
  e2.up(0); e2.frame();
  e2.hover(M.x + M.w + 3, M.y + 75); e2.frame();
  check(e2.renderer.lastCursor === 'ew-resize', "the modal's own band still works, got " + e2.renderer.lastCursor);
});

/* ---------------------------------------------------------------------- *
 * round-7: combined windows (docks) are dockable; combining into a
 * globally docked window keeps the docked width (not the sum)
 * ---------------------------------------------------------------------- */

test('a dock can be globally docked (dockToEdge on a member docks the whole dock)', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { pos: [500, 100], size: [200, 150] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { pos: [500, 300], size: [200, 150] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  e.gui.dock('A', 'B');
  e.frames(2, draw);
  const r = e.gui.dockToEdge('A', 'left');
  e.frames(2, draw);
  const D = e.gui.state.docks.get('A\x01B');
  const L = e.gui.getWindow('A'), R = e.gui.getWindow('B');
  check(!!r && !!D && D._edge === 'left', 'dock is edge-docked, got ' + (D && D._edge));
  check(L._edge === 'left' && R._edge === 'left', 'both members flagged _edge');
  const E = e.gui.state.edgeDocks.left;
  check(E && E.wins.length === 1 && E.wins[0] === 'A', 'stack has ONE unit (member A), got ' + JSON.stringify(E && E.wins));
  check(D && Math.abs(D.w - (E.size - 12)) <= 1, 'dock width = the column width, not the sum, got ' + (D && D.w));
  // undockEdge frees the dock as a FREE dock (the combination survives)
  e.gui.undockEdge('B');
  e.frames(2, draw);
  check(e.gui.isDocked('A', 'B') && D && !D._edge, 'undockEdge: the dock survives as a free dock');
  check(L._edge == null && R._edge == null, 'members no longer edge-flagged');
});

test('dragging a dock to the screen grid / edge band globally docks it', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { pos: [100, 100], size: [200, 150] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { pos: [100, 300], size: [200, 150] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  e.gui.dock('A', 'B');
  e.frames(2, draw);
  const D = e.gui.state.docks.get('A\x01B');
  e.hover(D.x + 100, D.y + 12); e.down(0); e.frame(draw);
  check(!!e.gui.state.drag && e.gui.state.drag.type === 'dock-move', 'dock-move started, got ' + (e.gui.state.drag && e.gui.state.drag.type));
  e.hover(664, 360); e.frame(draw);  // right triangle of the center grid
  const h = e.gui.state._dockHint;
  check(!!h && h.kind === 'screen' && h.side === 'r', 'screen grid active while dragging a dock, got ' + JSON.stringify(h && { k: h.kind, s: h.side }));
  e.up(0); e.frame(draw); e.frame(draw);
  check(D._edge === 'right', 'dock edge-docked to the right, got ' + D._edge);
  // an edge-docked dock is not movable (the stack owns its geometry) — free
  // it first, then drag it onto the left edge band
  e.gui.undockEdge('A');
  e.frames(2, draw);
  e.hover(D.x + 100, D.y + 12); e.down(0); e.frame(draw);
  check(!!e.gui.state.drag && e.gui.state.drag.type === 'dock-move', 'dock movable again after undockEdge');
  e.hover(20, 360); e.frame(draw);   // inside the left 44px band
  const h2 = e.gui.state._dockHint;
  check(!!h2 && h2.kind === 'edge' && h2.edge === 'left', 'edge band active while dragging a dock, got ' + JSON.stringify(h2 && { k: h2.kind, e: h2.edge }));
  e.up(0); e.frame(draw); e.frame(draw);
  check(D._edge === 'left', 'dock moved to the left stack, got ' + D._edge);
});

test('dropping a window onto a globally docked window combines in place (docked width, not the sum)', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('W', { pos: [500, 100], size: [200, 150] })) e.gui.endWindow();
    if (e.gui.beginWindow('X', { pos: [700, 400], size: [300, 180] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  e.gui.dockToEdge('W', 'left');
  e.frames(2, draw);
  const W = e.gui.getWindow('W'), X = e.gui.getWindow('X');
  const wW = W.w;
  // drag X over W's join grid (top triangle)
  const cx = W.x + W.w / 2, cy = W.y + W.h / 2;
  e.hover(X.x + 100, X.y + 12); e.down(0); e.frame(draw);
  e.hover(cx, cy - 20); e.frame(draw);
  const h = e.gui.state._dockHint;
  check(!!h && h.kind === 'window' && h.target === W && h.side === 't', 'join grid over edge-docked W, got ' + JSON.stringify(h && { k: h.kind, s: h.side }));
  e.up(0); e.frame(draw); e.frame(draw);
  check(e.gui.isDocked('W', 'X'), 'W and X are now docked');
  const D = [...e.gui.state.docks.values()][0];
  check(!!D && D._edge === 'left', 'the combined window is itself edge-docked, got ' + (D && D._edge));
  check(e.gui.getWindow('W')._edge === 'left' && e.gui.getWindow('X')._edge === 'left', 'both members stay edge-docked');
  const E = e.gui.state.edgeDocks.left;
  check(E && E.wins.length === 1 && E.wins[0] === 'W', 'the stack holds ONE unit, got ' + JSON.stringify(E && E.wins));
  check(D && Math.abs(D.w - wW) <= 1, 'combined width = the docked width (' + (D && D.w) + '), NOT the sum (' + (wW + 300) + ')');
  check(D && D.dir === 'v', 'column join forced vertical so both keep the full width, got ' + (D && D.dir));
  // the unit scales with the stack's inner bar, members span the full width
  const innerX = e.gui.state.edgeDocks.left._rect.x0 + e.gui.state.edgeDocks.left._rect.colW;
  const w0 = D.w;
  e.hover(innerX - 3, 300); e.down(0); e.frame(draw);
  e.hover(innerX + 40, 300); e.frame(draw);
  e.up(0); e.frame(draw);
  const D2 = e.gui.state.docks.get('W\x01X');
  check(D2 && D2.w > w0 + 20, 'dock unit scaled with the column (' + w0 + ' -> ' + (D2 && D2.w) + ')');
  const Wa = e.gui.getWindow('W'), Xa = e.gui.getWindow('X');
  check(Math.abs(Wa.w - (D2.w - 6)) <= 1 && Math.abs(Xa.w - (D2.w - 6)) <= 1,
    'both members span the dock width (' + Wa.w + ',' + Xa.w + ' vs ' + (D2.w - 6) + ')');
});

test('dropping a window onto a docked dock splits the dock; the stack keeps the unit', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { pos: [500, 100], size: [200, 150] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { pos: [500, 300], size: [200, 150] })) e.gui.endWindow();
    if (e.gui.beginWindow('X', { pos: [700, 450], size: [300, 180] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  e.gui.dock('A', 'B');
  e.frames(2, draw);
  e.gui.dockToEdge('A', 'left');
  e.frames(2, draw);
  const D0 = e.gui.state.docks.get('A\x01B');
  const unit = e.gui.getWindow('A');
  const X = e.gui.getWindow('X');
  e.hover(X.x + 100, X.y + 12); e.down(0); e.frame(draw);
  e.hover(unit.x + unit.w / 2, unit.y + 30); e.frame(draw); // over member A
  const h = e.gui.state._dockHint;
  check(!!h && h.kind === 'window' && h.target === unit, 'join grid over the docked dock, got ' + JSON.stringify(h && { k: h.kind, t: h.target && h.target.title }));
  const [px, py] = e.gui._dockGridPoint(h.parts, 't'); // drop on the top triangle
  e.hover(px, py); e.frame(draw);
  e.up(0); e.frame(draw); e.frame(draw);
  check(e.gui.isDocked('A', 'X'), 'X combined with the unit member A, got ' + e.gui.getDocks().map((d) => d.a + '+' + d.b).join(','));
  const D = [...e.gui.state.docks.values()][0];
  check(!!D && D._edge === 'left' && D.b === e.gui.getWindow('X'), 'the new combined window is the stack unit');
  check(e.gui.state.edgeDocks.left && e.gui.state.edgeDocks.left.wins.length === 1, 'stack still has one unit');
  const B = e.gui.getWindow('B');
  check(B._edge == null && B._dockKey == null, 'the split-off member B is a free window');
  check(B.movable === true, 'the split-off member B is movable');
});

/* ---------------------------------------------------------------------- *
 * round-8: input follows visible (draw) order — the last-drawn element
 * under the cursor is the only one that receives hover/click/drag;
 * interacting with a window or dock raises it, so dragging one over
 * another can never softlock the dragged one's header
 * ---------------------------------------------------------------------- */

test('dock dragged over a window comes to front; header stays draggable (no softlock)', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { pos: [100, 100], size: [300, 200] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { pos: [450, 100], size: [300, 200] })) e.gui.endWindow();
    if (e.gui.beginWindow('C', { pos: [500, 300], size: [320, 220] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  e.gui.dock('A', 'B');
  const A = e.gui.getWindow('A');
  const D = e.gui.state.docks.get(A._dockKey);
  const C = e.gui.getWindow('C');
  check(!!D, 'dock exists');
  // drag the dock's combined title bar over window C
  e.dragTo(D.x + 80, D.y + 10, 560, 320);
  const z = e.gui.state.zOrder.map((w) => w.title);
  check(z.indexOf('A') > z.indexOf('C') && z.indexOf('B') > z.indexOf('C'),
    'both dock members are now drawn above C (z: ' + z.join(',') + ')');
  check(D.x === 480 && D.y === 310, 'dock moved to ' + D.x + ',' + D.y);
  // re-grab the dock's title bar — it now overlaps C
  const tX = D.x + 80, tY = D.y + 10;
  e.hover(tX, tY); e.frame(draw);
  const hv = e.gui.state.hoveredWindow;
  check(hv === A || hv === B, 'dock title strip hovers as the dock, got ' + (hv && hv.title));
  e.down(); e.frame(draw);
  check(e.gui.state.drag && e.gui.state.drag.type === 'dock-move',
    're-grab starts a dock-move, got ' + (e.gui.state.drag && e.gui.state.drag.type));
  e.release();
  e.frames(1, draw);
  // and it can be dragged a second time (away from the screen-center grid)
  e.dragTo(D.x + 60, D.y + 10, 300, 500);
  check(D.x === 240 && D.y === 490, 'dock can be dragged again: ' + D.x + ',' + D.y);
});

test('a window painted over a dock title strip still owns the point', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { pos: [100, 100], size: [300, 200] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { pos: [450, 100], size: [300, 200] })) e.gui.endWindow();
    if (e.gui.beginWindow('C', { pos: [150, 90], size: [200, 120] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  e.gui.dock('A', 'B');
  const A = e.gui.getWindow('A');
  const D = e.gui.state.docks.get(A._dockKey);
  const C = e.gui.getWindow('C');
  // C was created after the dock, so it is drawn LAST (on top); its title
  // bar overlaps the dock's combined title strip
  const sx = C.x + 50, sy = C.y + 20;
  check(sy >= D.y && sy < D.y + 34 && sx >= D.x && sx < D.x + D.w, 'point lies on the dock strip too');
  e.hover(sx, sy); e.frame(draw);
  check(e.gui.state.hoveredWindow === C, 'topmost window owns the point, got ' + (e.gui.state.hoveredWindow && e.gui.state.hoveredWindow.title));
  e.down(); e.frame(draw);
  const d = e.gui.state.drag;
  check(d && d.type === 'win-move' && d.win === C, 'grab starts the window move, not a dock move, got ' + (d && d.type));
  e.release();
});

test('a dock title strip over a lower window is still grabbable', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('C', { pos: [150, 120], size: [300, 120] })) e.gui.endWindow();
    if (e.gui.beginWindow('A', { pos: [100, 100], size: [300, 200] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { pos: [450, 100], size: [300, 200] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  e.gui.dock('A', 'B');
  const A = e.gui.getWindow('A');
  const D = e.gui.state.docks.get(A._dockKey);
  // the dock (created after C) is drawn above C; this point is on the dock
  // strip AND inside C's title bar
  const sx = 300, sy = 127;
  check(sy >= D.y && sy < D.y + 34 && sx >= D.x && sx < D.x + D.w, 'point on the dock strip over C');
  e.hover(sx, sy); e.frame(draw);
  check(e.gui.state.hoveredWindow === A, 'dock owns the strip point, got ' + (e.gui.state.hoveredWindow && e.gui.state.hoveredWindow.title));
  e.down(); e.frame(draw);
  check(e.gui.state.drag && e.gui.state.drag.type === 'dock-move', 'dock grab works over the lower window, got ' + (e.gui.state.drag && e.gui.state.drag.type));
  e.release();
});

test('plain window dragged over another window stays grabbable and ends on top', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { pos: [100, 100], size: [300, 200] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { pos: [300, 150], size: [400, 300] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  const A = e.gui.getWindow('A');
  // drag A over B, releasing at B's exact center (the center apex is a
  // plain drop — no join), so A stays free while overlapping B
  e.dragTo(150, 112, 500, 300);
  const z = e.gui.state.zOrder.map((w) => w.title);
  check(z[z.length - 1] === 'A', 'dragged window A is now drawn last (on top), z: ' + z.join(','));
  check(!A._dockKey, 'A is still a free window (plain drop)');
  // re-grab A's title bar (overlapping B's rect)
  e.hover(A.x + 50, A.y + 12); e.frame(draw);
  check(e.gui.state.hoveredWindow === A, 'A\u2019s title still hovers, got ' + (e.gui.state.hoveredWindow && e.gui.state.hoveredWindow.title));
  e.down(); e.frame(draw);
  check(e.gui.state.drag && e.gui.state.drag.type === 'win-move' && e.gui.state.drag.win === A,
    'A is still draggable inside B, got ' + (e.gui.state.drag && e.gui.state.drag.type));
  e.release();
});

test('resize band does not claim a point covered by a topmost window', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { pos: [200, 200], size: [300, 200], resizable: true })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { pos: [480, 250], size: [300, 200], resizable: true })) e.gui.endWindow();
  };
  e.frames(2, draw);
  const A = e.gui.getWindow('A');
  const B = e.gui.getWindow('B');
  // A's right edge is at x=500 (band ~495..505); B covers from x=480, so
  // (502,300) is on A's band but B is painted over that point
  e.hover(502, 300); e.frame(draw);
  check(e.gui.state.hoveredWindow === B, 'point belongs to B (topmost), got ' + (e.gui.state.hoveredWindow && e.gui.state.hoveredWindow.title));
  check(e.renderer.lastCursor !== 'ew-resize' && e.renderer.lastCursor !== 'nwse-resize',
    'no resize cursor where B covers A\u2019s band, got ' + e.renderer.lastCursor);
  e.down(); e.frame(draw);
  const d = e.gui.state.drag;
  check(!d || (d.type !== 'win-resize' || d.win !== A), 'no win-resize of A from a point covered by B, got ' + (d && d.type));
  e.release();
  // move B away: A's band claims again and resizes
  e.dragTo(B.x + 150, B.y + 10, 900, 300);
  e.hover(502, 300); e.frame(draw);
  check(e.renderer.lastCursor === 'ew-resize', 'A\u2019s band claims once B is gone, got ' + e.renderer.lastCursor);
  const w0 = A.w;
  e.down(); e.frame(draw);
  check(e.gui.state.drag && e.gui.state.drag.type === 'win-resize' && e.gui.state.drag.win === A, 'win-resize of A starts');
  e.hover(522, 300); e.frame(draw);
  check(A.w > w0, 'A widens, got ' + A.w);
  e.release();
});

/* ---------------------------------------------------------------------- *
 * round-9: generous dock-grid hit areas — the triangle selection area
 * extends beyond the drawn 72x72 square: the join grid covers the whole
 * target window, the screen-center grid grows ~24px per side
 * ---------------------------------------------------------------------- */

test('join grid: the whole target window selects the side (dockJoinHitGenerous: true)', () => {
  const e = new Env({ flags: { dockJoinHitGenerous: true } });
  const draw = () => {
    if (e.gui.beginWindow('A', { pos: [100, 200], size: [300, 200] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { pos: [400, 200], size: [340, 260] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  // B: 400..740 x 200..460, center (570,330); drawn grid 534..606 x 294..366.
  // Release at (420,330): inside B, near its left edge, OUTSIDE the drawn
  // square — the generous join area still selects the left side.
  e.dragTo(150, 212, 420, 330);
  check(e.gui.isDocked('A', 'B'), 'drop near B\u2019s left edge combines A with B');
  const D = e.gui.getWindow('A')._dockKey && e.gui.state.docks.get(e.gui.getWindow('A')._dockKey);
  check(!!D && D.dir === 'h' && D.a === e.gui.getWindow('A'), 'combined side by side with A left of B (dir h), got ' + (D && D.dir) + ' / ' + (D && D.a && D.a.title));
});

test('screen-center grid selects a bit beyond the drawn square (default: dockScreenHitGenerous)', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { pos: [100, 100], size: [300, 200] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  const A = e.gui.getWindow('A');
  // screen 1280x720: drawn grid 604..676 x 324..396; generous box 580..760
  // x 276..444. Release at (590,360): 50px left of center — outside the
  // drawn square, inside the generous box -> left screen edge.
  e.dragTo(150, 112, 590, 360);
  check(A._edge === 'left', 'drop beyond the drawn grid still edge-docks, got ' + A._edge);
});

test('default join hit area is tight: only directly over a drawn triangle docks', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { pos: [100, 200], size: [300, 200] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { pos: [400, 200], size: [340, 260] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  // (420,330) is inside B but OUTSIDE its drawn grid square (534..606 x
  // 294..366) -> default: no side selected -> plain drop, no join
  e.dragTo(150, 212, 420, 330);
  check(!e.gui.isDocked('A', 'B'), 'default join: point over the window but not over a triangle is a plain drop');
  // directly over a drawn triangle still docks: B's left triangle centroid
  const A = e.gui.getWindow('A');
  const B = e.gui.getWindow('B');
  e.dragTo(A.x + 50, A.y + 12, 534 + 20, 330);
  check(e.gui.isDocked('A', 'B'), 'default join: point directly over the left triangle combines');
});

test('dockScreenHitGenerous: false restores the tight (drawn-square) screen grid', () => {
  const e = new Env({ flags: { dockScreenHitGenerous: false } });
  const draw = () => {
    if (e.gui.beginWindow('A', { pos: [100, 100], size: [300, 200] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  const A = e.gui.getWindow('A');
  // (590,360) is outside the drawn screen grid square (604..676 x 324..396)
  e.dragTo(150, 112, 590, 360);
  check(A._edge == null, 'tight screen grid: point outside the drawn square does not edge-dock, got ' + A._edge);
});

/* ---------------------------------------------------------------------- *
 * round-10/11: a click anywhere on a window (body included) is handled
 * by that window — input never passes through the topmost window to the
 * one beneath it. A click only marks the focused window (bright title);
 * it NEVER reorders the draw stack, so a "focused" window can never
 * steal clicks from a window drawn above it. Only a MOVE drag reorders.
 * ---------------------------------------------------------------------- */

test('body click is handled by the topmost window without reordering the stack', () => {
  const e = new Env();
  let closedA = false;
  const draw = () => {
    if (e.gui.beginWindow('A', { pos: [150, 200], size: [300, 200], closable: true, onClose: () => { closedA = true; } })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { pos: [300, 140], size: [300, 200] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  const A = e.gui.getWindow('A');
  const B = e.gui.getWindow('B');
  const z0 = e.gui.state.zOrder.map((w) => w.title);
  // A's close button (424..442 x 210..224) sits under B's BODY at
  // (433,217): the click is handled by B (topmost there) — the close
  // button does NOT fire
  e.click(433, 217);
  check(A.open && !closedA, 'click over the top window did not reach the bottom window\u2019s close button');
  check(e.gui.state.focusedWindow === B, 'the click focused the topmost window (B)');
  check(e.gui.state.zOrder.map((w) => w.title).join(',') === z0.join(','), 'click did not reorder the stack');
  check(B.collapsed === false, 'top window untouched (no collapse)');
  // click A's visible body: A becomes the focused window, but it stays
  // where it is in the draw order
  e.click(200, 300);
  check(e.gui.state.focusedWindow === A, 'body click focused A');
  check(e.gui.state.zOrder.map((w) => w.title).join(',') === z0.join(','), 'focusing A did not reorder the stack');
  // THE regression: A is now the "focused" window, but B is still drawn
  // on top — a click on the overlap must go to B, not to focused A
  e.click(433, 217);
  check(A.open && !closedA, 'focused window below does not steal the click (close button not hit)');
  check(e.gui.state.focusedWindow === B, 'the overlap click was handled by the topmost window (B)');
  check(e.gui.state.zOrder.map((w) => w.title).join(',') === z0.join(','), 'still no reordering');
});

test('clicking a dock member body focuses it without reordering; a move raises the dock', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('C', { pos: [200, 250], size: [300, 200] })) e.gui.endWindow();
    if (e.gui.beginWindow('A', { pos: [100, 100], size: [300, 200] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { pos: [450, 100], size: [300, 200] })) e.gui.endWindow();
  };
  e.frames(2, draw);
  const A = e.gui.getWindow('A');
  e.gui.dock('A', 'B');
  const z0 = e.gui.state.zOrder.map((w) => w.title);
  check(z0[0] === 'C', 'C starts beneath the dock (z: ' + z0.join(',') + ')');
  // click member A's body where C does not cover: it is handled by the
  // dock, focused, but the draw order does not change
  e.click(A.x + 50, A.y + 60);
  const z1 = e.gui.state.zOrder.map((w) => w.title);
  check(z1.join(',') === z0.join(','), 'dock member body click did not reorder the stack (z: ' + z1.join(',') + ')');
  check(e.gui.state.focusedWindow === A, 'dock member click focused member A');
  // click a point that is over C but outside the dock: C handles it
  e.click(300, 350);
  const z2 = e.gui.state.zOrder.map((w) => w.title);
  check(z2.join(',') === z0.join(','), 'click over C (outside the dock) did not reorder the stack');
  check(e.gui.state.focusedWindow === e.gui.getWindow('C'), 'click over C (outside the dock) focused C');
  // moving the dock still raises the whole dock as a unit (move reorders,
  // clicks do not)
  const dy = A.y;
  e.dragTo(A.x + 50, dy + 17, A.x + 50, dy + 57, 10, 0);
  const z3 = e.gui.state.zOrder.map((w) => w.title);
  check(z3.indexOf('A') > z3.indexOf('C') && z3.indexOf('B') > z3.indexOf('C'),
    'moving the dock raised both members above C (z: ' + z3.join(',') + ')');
});

/* ============================ summary ================================= */

console.log('');
console.log('========================================');
console.log('passed: ' + passed + '   failed: ' + failed);
if (failed) {
  console.error('FAILURES:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('ALL ROUND-2 TESTS PASSED');
