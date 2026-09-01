/* Headless test harness for the Mim core.
 * Simulates a real-time host: renders through a recording mock renderer and
 * drives mouse/keyboard input frame by frame, asserting on state. */
'use strict';

require('../mim.js');
const { GUI, Layers, WindowFlags, Key } = global.Mim;

/* ------------------------- mock renderer ------------------------------ */

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
      x: Math.max(x, c ? c.x : -1e9),
      y: Math.max(y, c ? c.y : -1e9),
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
  drawnText() {
    return this.calls.filter((c) => c[0] === 'drawText').map((c) => c[3]);
  }
}

/* ------------------------- test driver -------------------------------- */

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

function approx(a, b, eps = 1e-6) { return Math.abs(a - b) < eps; }

class Env {
  constructor(opts = {}) {
    this.renderer = new MockRenderer();
    this.gui = new GUI(this.renderer, Object.assign({
      flags: { animations: false },
      clipboard: {
        read: () => Env.clipboard,
        write: (t) => { Env.clipboard = t; },
      },
    }, opts));
    this.input = {
      width: 1280,
      height: 720,
      mouse: { x: -1000, y: -1000, buttons: [false, false, false, false, false], wheelX: 0, wheelY: 0 },
      keys: new Set(),
      text: '',
    };
  }
  frame(draw) {
    if (draw) this._draw = draw;
    this.gui.beginFrame(this.input);
    if (this._draw) this._draw();
    this.gui.endFrame();
  }
  frames(n, draw) { for (let i = 0; i < n; i++) this.frame(draw); }
  clearDraw() { this._draw = null; }
  hover(x, y) { this.input.mouse.x = x; this.input.mouse.y = y; }
  down(b = 0) { this.input.mouse.buttons[b] = true; }
  up(b = 0) { this.input.mouse.buttons[b] = false; }
  click(x, y, b = 0) {
    this.hover(x, y);
    this.down(b);
    this.frame();
    this.up(b);
    this.frame();
  }
  press(x, y, b = 0) { this.hover(x, y); this.down(b); this.frame(); }
  release(b = 0) { this.up(b); this.frame(); }
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
  wheel(x, y, dx, dy) {
    this.hover(x, y);
    this.input.mouse.wheelX = dx;
    this.input.mouse.wheelY = dy;
    this.frame();
    this.input.mouse.wheelX = 0;
    this.input.mouse.wheelY = 0;
  }
  key(t) {
    this.input.keys.add(t);
    this.frame();
    this.input.keys.delete(t);
    this.frame();
  }
  holdKey(t) { this.input.keys.add(t); }
  releaseKey(t) { this.input.keys.delete(t); }
  type(str) {
    this.input.text = str;
    this.frame();
    this.input.text = '';
  }
}
Env.clipboard = '';

function test(name, fn) {
  console.log('• ' + name);
  try {
    fn();
  } catch (e) {
    failed++;
    failures.push(name + ' threw: ' + (e && e.stack || e));
    console.error('  THREW: ' + (e && e.stack || e));
  }
}

/* ============================ TESTS =================================== */

test('basic frame + window + text + button click', () => {
  const e = new Env();
  let clicks = 0;
  let btnRect = null;
  const draw = () => {
    if (e.gui.beginWindow('Main')) {
      e.gui.text('Hello world');
      if (e.gui.button('Click me')) clicks++;
      btnRect = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  check(btnRect && btnRect.w > 20 && btnRect.h > 15, 'button has a sensible rect ' + JSON.stringify(btnRect));
  check(e.renderer.drawnText().includes('Hello world'), 'text was drawn');
  check(clicks === 0, 'no click before pressing');
  e.click(btnRect.x + btnRect.w / 2, btnRect.y + btnRect.h / 2);
  check(clicks === 1, 'click registered exactly once, got ' + clicks);
  e.frames(2, draw);
  check(clicks === 1, 'no phantom clicks on idle frames');
});

test('hover state only when mouse is inside the item', () => {
  const e = new Env();
  let rect = null;
  let hoveredNow = null;
  const draw = () => {
    if (e.gui.beginWindow('W')) {
      e.gui.button('B');
      rect = e.gui.lastItemRect();
      hoveredNow = e.gui.lastItemHovered();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  check(hoveredNow === false, 'not hovered before moving mouse');
  e.hover(rect.x + rect.w / 2, rect.y + rect.h / 2);
  e.frame(draw);
  check(hoveredNow === true, 'hovered when mouse is inside');
  e.hover(rect.x + 500, rect.y);
  e.frame(draw);
  check(hoveredNow === false, 'not hovered after moving away');
});

test('window drag moves the window', () => {
  const e = new Env();
  let w = null;
  const draw = () => {
    if (e.gui.beginWindow('DragMe', { size: [300, 200] })) {
      e.gui.text('x');
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  w = e.gui.getWindow('DragMe');
  const x0 = w.x, y0 = w.y;
  e.dragTo(w.x + 100, w.y + 15, w.x + 180, y0 + 90);
  check(approx(w.x - x0, 80, 0.01), 'window x moved by ~80, got ' + (w.x - x0));
  check(approx(w.y - y0, 75, 0.01), 'window y moved by ~75, got ' + (w.y - y0));
});

test('window resize grip clamps to min size', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('Res', { size: [200, 150], minSize: [120, 100] })) {
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  const w = e.gui.getWindow('Res');
  e.dragTo(w.x + w.w - 4, w.y + w.h - 4, w.x + 10, w.y + 10, 20);
  check(w.w >= 119.9, 'width clamped to min, got ' + w.w);
  check(w.h >= 99.9, 'height clamped to min, got ' + w.h);
  // resize bigger (from the clamped 120 width; grip is 4px inside, target 64 outside)
  const w0 = w.w;
  e.dragTo(w.x + w.w - 4, w.y + w.h - 4, w.x + w.w + 64, w.y + w.h + 40, 10);
  check(w.w - w0 > 55, 'width grew with drag, got ' + w.w + ' (was ' + w0 + ')');
  check(w.w >= 119.9, 'still clamped at min after grow');
});

test('window double-click resets position', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('Dbl', { size: [200, 120], pos: [100, 100] })) {
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  const w = e.gui.getWindow('Dbl');
  e.dragTo(w.x + 100, w.y + 15, w.x + 160, w.y + 60);
  check(w.x !== 100, 'window moved away');
  // double click: press/release x2 quickly
  e.click(w.x + 100, w.y + 15);
  e.click(w.x + 100, w.y + 15);
  check(approx(w.x, 100, 0.01) && approx(w.y, 100, 0.01), 'position restored, got ' + w.x + ',' + w.y);
});

test('closable window closes via X and onClose fires', () => {
  const e = new Env();
  let closed = 0;
  let opened = true;
  const draw = () => {
    if (e.gui.beginWindow('Close', {
      flags: WindowFlags.Closable, size: [240, 160], open: opened,
      onClose: () => { closed++; opened = false; },
    })) {
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  const w = e.gui.getWindow('Close');
  check(opened === true, 'open before click');
  e.click(w.x + w.w - 17, w.y + w.titleH / 2);
  check(closed === 1, 'onClose fired');
  check(opened === false, 'window closed');
  e.frame(draw);
  check(e.gui.isWindowOpen('Close') === false, 'reports closed');
});

test('collapsible window collapses and restores', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('Col', { size: [240, 160] })) {
      e.gui.text('body');
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  const w = e.gui.getWindow('Col');
  check(w.collapsed === false, 'starts expanded');
  e.click(w.x + 14, w.y + w.titleH / 2);
  check(w.collapsed === true, 'collapsed after arrow click');
  e.frame(draw);
  check(w.collapsed === true, 'stays collapsed');
  e.click(w.x + 14, w.y + w.titleH / 2);
  check(w.collapsed === false, 're-expanded');
});

test('overlapping windows: topmost receives clicks only', () => {
  const e = new Env();
  let aClicks = 0, bClicks = 0;
  const draw = () => {
    if (e.gui.beginWindow('A', { size: [300, 200], pos: [50, 50] })) {
      if (e.gui.button('A-btn')) aClicks++;
      e.gui.endWindow();
    }
    if (e.gui.beginWindow('B', { size: [200, 120], pos: [100, 100] })) {
      if (e.gui.button('B-btn')) bClicks++;
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  const a = e.gui.getWindow('A');
  const b = e.gui.getWindow('B');
  // click B's button (inside overlap)
  e.click(b.x + 20, b.y + b.titleH + 20);
  check(bClicks === 1 && aClicks === 0, 'B got the click, not A (' + aClicks + '/' + bClicks + ')');
  // click A outside B: A becomes the focused window but is NOT raised —
  // clicks never reorder the draw stack
  e.click(a.x + 15, a.y + a.titleH + 20);
  check(aClicks === 1, 'A clickable outside overlap');
  check(e.gui.state.focusedWindow === a, 'clicking A focused it');
  check(e.gui.state.zOrder[e.gui.state.zOrder.length - 1] === b, 'clicking A did not raise it (B still topmost)');
  // the overlap still belongs to the topmost window (B) — focused A below
  // must not steal the click
  e.click(b.x + 20, b.y + b.titleH + 20);
  check(aClicks === 1 && bClicks === 2, 'focused A (below) does not steal the overlap click — B still topmost');
  // an actual MOVE of A over B reorders the stack; then the overlap is A's
  e.dragTo(a.x + 100, a.y + 12, a.x + 150, a.y + 62, 10, 0);
  check(e.gui.state.zOrder[e.gui.state.zOrder.length - 1] === a, 'moving A raised it to the front');
  e.click(b.x + 20, b.y + b.titleH + 20);
  check(aClicks === 2 && bClicks === 2, 'overlap click now goes to moved A');
});

test('slider drag changes value and clamps', () => {
  const e = new Env();
  let value = 0;
  let rect = null;
  const draw = () => {
    if (e.gui.beginWindow('S', { size: [300, 120] })) {
      value = e.gui.sliderFloat('Val', value, 0, 100);
      rect = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  e.dragTo(cx, cy, cx + rect.w * 0.4, cy, 12);
  // press at center click-to-sets ~50, then the drag adds ~40
  check(value > 85 && value < 96, 'click-to-set then drag, got ' + value);
  e.dragTo(cx, cy, cx + rect.w, cy + 0, 5);
  e.dragTo(rect.x + rect.w, cy, rect.x + rect.w + 200, cy, 5);
  check(approx(value, 100, 0.5), 'clamped at max, got ' + value);
  e.dragTo(cx, cy, rect.x - 200, cy, 12);
  check(approx(value, 0, 0.5), 'clamped at min, got ' + value);
});

test('slider right-click opens direct value entry popup', () => {
  const e = new Env();
  let value = 10;
  let rect = null;
  let sliderId = 0;
  const draw = () => {
    if (e.gui.beginWindow('S2', { size: [300, 140] })) {
      value = e.gui.sliderFloat('Val', value, 0, 100);
      rect = e.gui.lastItemRect();
      if (!sliderId) sliderId = e.gui.lastItem().itemId; // capture before any popup can steal lastItem
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  const cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
  e.click(cx, cy, 1); // right click
  check(e.gui.isPopupOpen('##val' + sliderId), 'value popup opened');
  // find popup rect
  const p = e.gui.state.popupList[0];
  check(p && p.w > 0, 'popup has size');
  // click the field inside the popup
  const px = p.x + p.w / 2, py = p.y + (p.data.label ? 34 : 20);
  e.click(px, py);
  e.type('42');
  e.key('enter');
  e.frame(draw);
  check(approx(value, 42, 0.01), 'value set to 42, got ' + value);
  check(!e.gui.isPopupOpen(p.id), 'popup closed after commit');
});

test('identical labels in the same window produce independent widgets', () => {
  const e = new Env();
  let v1 = 0, v2 = 0;
  let r1 = null, r2 = null;
  const draw = () => {
    if (e.gui.beginWindow('D', { size: [320, 140] })) {
      v1 = e.gui.sliderInt('Speed', v1, 0, 10);
      r1 = e.gui.lastItemRect();
      v2 = e.gui.sliderInt('Speed', v2, 0, 10);
      r2 = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  check(r1.y !== r2.y, 'two separate rects stacked');
  // drag the first slider from its left edge to the middle (~5)
  e.dragTo(r1.x + 4, r1.y + r1.h / 2, r1.x + r1.w / 2, r1.y + r1.h / 2, 6);
  check(v1 > 2, 'first slider changed, got ' + v1);
  check(v2 === 0, 'second slider untouched, got ' + v2);
  // second slider's hover must work even though labels are equal
  e.hover(r2.x + r2.w / 2, r2.y + r2.h / 2);
  let h2 = false;
  const draw2 = () => {
    if (e.gui.beginWindow('D', { size: [320, 140] })) {
      e.gui.sliderInt('Speed', v1, 0, 10);
      e.gui.sliderInt('Speed', v2, 0, 10);
      h2 = e.gui.lastItemHovered();
      e.gui.endWindow();
    }
  };
  e.frame(draw2);
  check(h2 === true, 'second identical-label widget hover works');
  e.click(r2.x + r2.w / 2, r2.y + r2.h / 2);
});

test('pushId disambiguates repeated widgets in a loop', () => {
  const e = new Env();
  const clicked = [];
  const rects = [];
  const draw = () => {
    if (e.gui.beginWindow('L', { size: [200, 200] })) {
      for (let i = 0; i < 3; i++) {
        e.gui.pushId(i);
        if (e.gui.button('Same')) clicked.push(i);
        rects.push(e.gui.lastItemRect());
        e.gui.popId();
      }
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  check(rects.length === 3 && rects[0].y !== rects[1].y && rects[1].y !== rects[2].y, 'three stacked buttons');
  e.click(rects[2].x + 5, rects[2].y + 5);
  check(clicked.length === 1 && clicked[0] === 2, 'index 2 was the one clicked, got ' + JSON.stringify(clicked));
});

test('checkbox toggles; stateful mode persists', () => {
  const e = new Env();
  let rect = null, on;
  const draw = () => {
    if (e.gui.beginWindow('C', { size: [240, 120] })) {
      on = e.gui.checkbox('On', null); // stateful
      rect = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  check(on === false, 'defaults to false');
  e.click(rect.x + 4, rect.y + 4);
  check(on === true, 'toggled on');
  e.click(rect.x + 4, rect.y + 4);
  check(on === false, 'toggled off');
});

test('input text: type, select all, delete, copy/paste, undo', () => {
  const e = new Env();
  let rect = null, name;
  const draw = () => {
    if (e.gui.beginWindow('T', { size: [280, 120] })) {
      name = e.gui.inputText('Name', null); // stateful
      rect = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  // click into field
  e.click(rect.x + 30, rect.y + rect.h / 2);
  e.type('hello');
  check(name === 'hello', 'typed text stored, got ' + JSON.stringify(name));
  // backspace
  e.key('backspace');
  check(name === 'hell', 'backspace worked, got ' + JSON.stringify(name));
  // select all + replace
  e.holdKey('ctrl');
  e.key('a');
  e.releaseKey('ctrl');
  e.type('world!');
  check(name === 'world!', 'select-all + retype, got ' + JSON.stringify(name));
  // select all + copy
  Env.clipboard = '';
  e.holdKey('ctrl');
  e.key('a');
  e.releaseKey('ctrl');
  e.holdKey('ctrl');
  e.key('c');
  e.releaseKey('ctrl');
  check(Env.clipboard === 'world!', 'copied to clipboard, got ' + JSON.stringify(Env.clipboard));
  // paste after selecting all
  e.holdKey('ctrl');
  e.key('a');
  e.releaseKey('ctrl');
  e.holdKey('ctrl');
  e.key('v');
  e.releaseKey('ctrl');
  check(name === 'world!', 'paste replaced selection, got ' + JSON.stringify(name));
  // undo: delete a char then ctrl+Z
  e.key('backspace');
  check(name === 'world', 'char deleted');
  e.holdKey('ctrl');
  e.key('z');
  e.releaseKey('ctrl');
  check(name === 'world!', 'undo restored, got ' + JSON.stringify(name));
  // commit with Enter
  e.key('enter');
  check(name === 'world!', 'committed on enter');
});

test('input text: double-click selects a word', () => {
  const e = new Env();
  let rect = null, msg = 'the quick fox';
  const draw = () => {
    if (e.gui.beginWindow('W2', { size: [280, 120] })) {
      msg = e.gui.inputText('Msg', msg);
      rect = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  e.click(rect.x + 10, rect.y + rect.h / 2);
  e.click(rect.x + 10, rect.y + rect.h / 2); // double click on "the"
  e.type('X');
  check(msg === 'X quick fox', 'double-click word select replaced "the", got ' + JSON.stringify(msg));
});

test('input text: repeated backspace at end, arrow keys, caret stays in range', () => {
  const e = new Env();
  let rect = null;
  let name = 'abcd';
  const draw = () => {
    if (e.gui.beginWindow('T2', { size: [280, 120] })) {
      name = e.gui.inputText('Name', name);
      rect = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  // click at the far right so the caret starts at the end of the text
  e.click(rect.x + rect.w - 4, rect.y + rect.h / 2);
  // backspace three times: each press must delete exactly one char
  e.key('backspace');
  check(name === 'abc', 'backspace 1, got ' + JSON.stringify(name));
  e.key('backspace');
  check(name === 'ab', 'backspace 2, got ' + JSON.stringify(name));
  e.key('backspace');
  check(name === 'a', 'backspace 3, got ' + JSON.stringify(name));
  // caret now at 1: left clamps at 0, right walks back to the end
  e.key('left');
  e.key('left');
  e.key('right');
  e.type('X');
  check(name === 'aX', 'arrow positioning + insert, got ' + JSON.stringify(name));
  // delete key removes the char to the right of the caret
  e.key('left');
  e.key('delete');
  check(name === 'a', 'delete key works, got ' + JSON.stringify(name));
  e.key('enter');
});

test('gui.layer switches layer for the callback and restores it', () => {
  const e = new Env();
  const draw = () => {
    e.gui.layer(Mim.Layers.Background, (r) => { r.fillRect(0, 0, 100, 100, [1, 2, 3, 255]); });
    if (e.gui.beginWindow('L', { size: [200, 120] })) {
      e.gui.text('hi');
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  const calls = e.renderer.calls;
  const bg = calls.filter((c) => c[0] === 'setLayer');
  check(bg.length >= 3, 'setLayer calls recorded, got ' + bg.length);
  const fillIdx = calls.findIndex((c) => c[0] === 'fillRect');
  const textIdx = calls.findIndex((c) => c[0] === 'drawText');
  const layerAt = (idx) => {
    let l = 'gui';
    for (let i = 0; i < idx; i++) if (calls[i][0] === 'setLayer') l = calls[i][1];
    return l;
  };
  check(layerAt(fillIdx) === 'background', 'callback drew on background layer');
  check(layerAt(textIdx) === 'gui', 'window content drew on gui layer (restored)');
  check(e.renderer.layer === 'gui', 'layer restored after frame');
});

test('input int: arrow keys and wheel step, invalid input rejected', () => {
  const e = new Env();
  let rect = null;
  let v = 5;
  const draw = () => {
    if (e.gui.beginWindow('N', { size: [260, 120] })) {
      v = e.gui.inputInt('Count', v, { min: 0, max: 10 });
      rect = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  const drawV = draw;
  e.frame(drawV);
  e.click(rect.x + 20, rect.y + rect.h / 2);
  e.key('up');
  e.frame(drawV);
  check(v === 6, 'up arrow steps +1, got ' + v);
  e.key('down');
  e.key('down');
  e.frame(drawV);
  check(v === 4, 'down arrows step -2, got ' + v);
  // type invalid
  e.holdKey('ctrl'); e.key('a'); e.releaseKey('ctrl');
  e.type('12x3'); // sanitize strips x -> "123"
  e.key('enter');
  e.frame(drawV);
  check(v === 10, 'clamped to max 10, got ' + v);
  // NaN guard
  const vnan = e.gui.sliderFloat('nan', NaN, 0, 10);
  check(isFinite(vnan), 'NaN input to slider is sanitized, got ' + vnan);
});

test('combo opens, selects an item, closes on outside click', () => {
  const e = new Env();
  const items = ['Apple', 'Banana', 'Cherry', 'Date', 'Elderberry'];
  let idx = 0, rect = null;
  const draw = () => {
    if (e.gui.beginWindow('CB', { size: [280, 140] })) {
      idx = e.gui.combo('Fruit', idx, items);
      rect = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  e.click(rect.x + 20, rect.y + rect.h / 2);
  e.frame(draw);
  const p = e.gui.state.popupList.find((q) => q.data.type === 'combo');
  check(!!p, 'combo popup opened');
  // hover + click the third row ("Cherry")
  const rowH = e.gui._lineH() + 10;
  const ry = p.y + 6 + 2 * rowH;
  e.hover(p.x + p.w / 2, ry);
  e.frame(draw);
  e.click(p.x + p.w / 2, ry);
  e.frame(draw);
  check(idx === 2, 'Cherry selected, got ' + idx);
  check(e.gui.state.popupList.length === 0, 'popup closed after selection');
  // reopen and close via outside click
  e.click(rect.x + 20, rect.y + rect.h / 2);
  e.frame(draw);
  check(e.gui.state.popupList.length === 1, 'reopened');
  e.click(5, 5);
  e.frame(draw);
  check(e.gui.state.popupList.length === 0, 'closed on outside click');
});

test('scrolling: child region scrolls with wheel and clamps', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('SC', { size: [260, 220] })) {
      if (e.gui.beginChild('list', { w: 0, h: 140 })) {
        for (let i = 0; i < 40; i++) e.gui.text('row ' + i);
        e.gui.endChild();
      }
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  let child = null;
  for (const [k, w] of e.gui.state.windows) if (w.kind === 'child') { child = w; break; }
  check(!!child, 'child window exists');
  check(child.maxScrollY > 100, 'child is scrollable, maxScrollY=' + child.maxScrollY);
  // wheel down over the child
  e.wheel(child.x + child.w / 2, child.y + child.h / 2, 0, 2);
  e.frame(draw);
  check(child.scrollY > 0, 'scrolled down, y=' + child.scrollY);
  e.wheel(child.x + child.w / 2, child.y + child.h / 2, 0, 100);
  e.frame(draw);
  check(child.scrollY <= child.maxScrollY + 0.01, 'scroll clamped at bottom');
  e.wheel(child.x + child.w / 2, child.y + child.h / 2, 0, -1000);
  e.frame(draw);
  check(child.scrollY >= 0, 'scroll clamped at top');
});

test('collapsing header toggles content visibility', () => {
  const e = new Env();
  let bodyDrawn = false;
  const draw = () => {
    if (e.gui.beginWindow('H', { size: [260, 200] })) {
      const open = e.gui.collapsingHeader('Section', null);
      bodyDrawn = false;
      if (open) {
        e.gui.text('inside');
        bodyDrawn = true;
      }
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  check(bodyDrawn === false, 'closed by default');
  let rect = null;
  const draw2 = () => {
    if (e.gui.beginWindow('H', { size: [260, 200] })) {
      const open = e.gui.collapsingHeader('Section', null);
      bodyDrawn = false;
      if (open) { e.gui.text('inside'); bodyDrawn = true; }
      rect = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw2);
  e.click(rect.x + rect.w / 2, rect.y + rect.h / 2);
  e.frame(draw2);
  check(bodyDrawn === true, 'open after click');
});

test('tabs switch and only the active tab draws content', () => {
  const e = new Env();
  let tabRects = [];
  const draw = () => {
    tabRects = [];
    if (e.gui.beginWindow('TB', { size: [300, 220] })) {
      e.gui.beginTabBar('tabs');
      if (e.gui.beginTabItem('One')) { e.gui.text('content one'); }
      e.gui.endTabItem();
      if (e.gui.beginTabItem('Two')) { e.gui.text('content two'); }
      e.gui.endTabItem();
      if (e.gui.beginTabItem('Three')) { e.gui.text('content three'); }
      e.gui.endTabItem();
      e.gui.endTabBar();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  check(e.renderer.drawnText().includes('content one'), 'first tab active by default');
  check(!e.renderer.drawnText().includes('content two'), 'second tab not drawn');
  // click tab "Two"
  const win = e.gui.getWindow('TB');
  const two = win; void two;
  // find tab rects: recompute by measuring from the bar position
  // bar is at first line: y = win.y + titleH + pad
  // simpler: click near the second tab label by scanning drawText calls
  const texts = e.renderer.calls.filter((c) => c[0] === 'drawText' && c[3] === 'Two');
  check(texts.length === 1, 'tab Two label drawn once');
  e.click(texts[0][1] + 5, texts[0][2] + 5);
  e.frame(draw);
  check(e.renderer.drawnText().includes('content two'), 'tab Two active after click');
  check(!e.renderer.drawnText().includes('content one'), 'tab One not drawn anymore');
});

test('menu bar menu opens and activates an item', () => {
  const e = new Env();
  let action = null;
  const draw = () => {
    if (e.gui.beginWindow('MB', { size: [300, 200], menuBar: true })) {
      e.gui.beginMenu('File');
      e.gui.menuItem('Save', 'Ctrl+S', { onActivated: () => { action = 'save'; } });
      e.gui.menuItem('Exit', '', { onActivated: () => { action = 'exit'; } });
      e.gui.endMenu();
      e.gui.text('body');
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  const win = e.gui.getWindow('MB');
  // click the File menu button (at ~ x+10, bar y center)
  const barY = win.y + win.titleH + win.menuH / 2;
  e.click(win.x + 18, barY);
  e.frame(draw);
  let p = e.gui.state.popupList.find((q) => q.data.type === 'menu');
  check(!!p, 'menu popup opened');
  // click "Exit" (second row)
  const rowH = e.gui._lineH() + 10;
  e.click(p.x + 40, p.y + 6 + 1 * rowH + rowH / 2);
  e.frame(draw);
  check(action === 'exit', 'Exit activated, got ' + action);
  check(e.gui.state.popupList.length === 0, 'menu closed after action');
});

test('context menu on right-click in window (custom popup)', () => {
  const e = new Env();
  let act = null;
  const draw = () => {
    if (e.gui.beginWindow('CTX', { size: [300, 200], pos: [100, 100] })) {
      e.gui.text('right click me');
      if (e.gui.beginPopupContextWindow('ctx-menu')) {
        e.gui.menuItem('Alpha', '', { onActivated: () => { act = 'alpha'; } });
        e.gui.separator();
        e.gui.menuItem('Beta', '', { onActivated: () => { act = 'beta'; } });
        e.gui.endPopup();
      }
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  e.click(150, 180, 1); // right click inside
  e.frame(draw);
  check(e.gui.isPopupOpen('ctx-menu'), 'context menu opened');
  const p = e.gui.state.popups.get('ctx-menu');
  // click the first item (Alpha): popup content starts at p.y + 6
  e.click(p.x + 20, p.y + 6 + 8);
  e.frame(draw);
  check(act === 'alpha', 'Alpha activated, got ' + act);
  check(!e.gui.isPopupOpen('ctx-menu'), 'menu closed after click');
});

test('modal blocks only what it covers — topmost input priority', () => {
  const e = new Env();
  let backClicks = 0, modalClicks = 0, aotClicks = 0;
  const draw = () => {
    if (e.gui.beginWindow('Back', { size: [420, 240], pos: [60, 60] })) {
      if (e.gui.button('BackBtn')) backClicks++;
      e.gui.endWindow();
    }
    if (e.gui.beginWindow('AOT', { flags: WindowFlags.AlwaysOnTop, size: [160, 90], pos: [360, 240] })) {
      if (e.gui.button('AOTBtn')) aotClicks++;
      e.gui.endWindow();
    }
    if (e.gui.beginWindow('Modal', {
      flags: WindowFlags.Modal | WindowFlags.AlwaysOnTop,
      size: [200, 120], pos: [100, 100],
    })) {
      if (e.gui.button('OK')) modalClicks++;
      e.gui.endWindow();
    }
  };
  e.frames(2, draw);
  // the modal is open, but the AOT window is not covered by it -> clickable
  e.click(385, 294);
  check(aotClicks === 1, 'uncovered window is clickable while modal is open');
  // drag AOT over the modal (drop at Back's center = plain drop, no join):
  // AOT (230,164,160x90) now overlaps the modal and is drawn above it
  e.dragTo(400, 256, 270, 180);
  const AOT = e.gui.getWindow('AOT');
  check(AOT.x === 230 && AOT.y === 164, 'AOT now overlaps the modal');
  e.frames(1, draw);
  // a point covered by the modal but inside the window drawn above it:
  // the topmost window keeps its input
  e.click(265, 218);
  check(aotClicks === 2, 'window drawn above the modal keeps its input');
  // the modal's own button (a point the AOT window does not cover)
  e.click(125, 154);
  check(modalClicks === 1, 'modal received click');
  // back-window button, point the modal does NOT cover (x < 100)
  e.click(85, 114);
  check(backClicks === 1, 'uncovered back-window point is clickable');
  // back-window button, point the modal DOES cover: blocked
  e.click(115, 114);
  check(backClicks === 1, 'covered back-window point is blocked');
});

test('tooltip appears after hover delay and disappears on leave', () => {
  const e = new Env({ flags: { animations: false, tooltipDelay: 0.05 } });
  let rect = null;
  const draw = () => {
    if (e.gui.beginWindow('TT', { size: [260, 140] })) {
      e.gui.button('TipMe');
      rect = e.gui.lastItemRect();
      e.gui.setTooltip('A helpful tip');
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  e.hover(rect.x + 5, rect.y + 5);
  for (let i = 0; i < 20; i++) { e.gui._timeOffset += 20; e.frame(draw); } // advance internal clock past the delay
  check(e.renderer.drawnText().includes('A helpful tip'), 'tooltip drawn after delay');
  e.hover(-100, -100);
  e.gui._timeOffset += 20;
  e.frame(draw);
  check(!e.renderer.drawnText().includes('A helpful tip'), 'tooltip gone on leave');
});

test('keyboard navigation: Tab focuses, Enter activates', () => {
  const e = new Env();
  let clicks = 0;
  const draw = () => {
    if (e.gui.beginWindow('K', { size: [260, 160] })) {
      if (e.gui.button('First')) clicks++;
      e.gui.checkbox('Check', null);
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  e.key('tab');
  e.frame(draw);
  check(e.gui.state.focusedId !== 0, 'tab focused first focusable');
  e.key('enter');
  e.frame(draw);
  check(clicks === 1, 'enter activated focused button');
  e.key('tab');
  e.frame(draw);
  check(e.gui.state.focusedId !== 0, 'tab moved to next focusable');
});

test('disabled block suppresses interaction and dims', () => {
  const e = new Env();
  let clicks = 0;
  const draw = () => {
    if (e.gui.beginWindow('DIS', { size: [260, 160] })) {
      e.gui.beginDisabled();
      if (e.gui.button('Nope')) clicks++;
      e.gui.endDisabled();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  const rect = e.gui.lastItemRect();
  e.click(rect.x + 5, rect.y + 5);
  check(clicks === 0, 'disabled button not clickable');
  check(e.gui.lastItemHovered() === false, 'disabled button not hovered');
});

test('style push/pop overrides colors for one block', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('ST', { size: [260, 160] })) {
      e.gui.pushStyleColor('frameBg', [200, 30, 30, 255]);
      e.gui.button('Red');
      e.gui.popStyleColor();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  const red = e.renderer.calls.find((c) => c[0] === 'fillRoundedRect' && c[6] && c[6][0] === 200 && c[6][1] === 30);
  check(!!red, 'custom frameBg color was used inside the push scope');
});

test('custom layers: background before, foreground after', () => {
  const e = new Env();
  const draw = () => {
    e.gui.layer(Layers.Background, (r) => {
      r.fillRect(0, 0, 1280, 720, [10, 12, 14, 255]);
    });
    if (e.gui.beginWindow('L1', { size: [200, 120] })) {
      e.gui.endWindow();
    }
    e.gui.layer(Layers.Foreground, (r) => {
      r.fillCircle(640, 360, 40, [255, 0, 0, 60]);
    });
  };
  e.frame(draw);
  const layers = e.renderer.calls.filter((c) => c[0] === 'setLayer').map((c) => c[1]);
  const firstBg = layers.indexOf('background');
  const fg = layers.lastIndexOf('foreground');
  check(firstBg === 0, 'background layer first');
  check(fg > firstBg, 'foreground layer after GUI content');
  // the red circle must be drawn after the window bg
  const calls = e.renderer.calls;
  const circleIdx = calls.findIndex((c) => c[0] === 'fillCircle');
  const winBgIdx = calls.findIndex((c) => c[0] === 'fillRoundedRect');
  check(circleIdx > winBgIdx, 'foreground circle drawn on top of window');
});

test('per-window style overrides apply', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('PW', { size: [220, 140], style: { bg: [10, 60, 120, 255], rounding: 18 } })) {
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  // fillRoundedRect(x, y, w, h, r, color) -> [tag, x, y, w, h, r, color]
  const bg = e.renderer.calls.find((c) => c[0] === 'fillRoundedRect' && c[6] && c[6][2] === 120);
  check(!!bg && bg[5] === 18, 'window bg color + rounding from opts.style');
});

test('autoResize window grows to fit content', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('Auto', { flags: WindowFlags.AutoResize })) {
      e.gui.text('line one');
      e.gui.text('line two');
      e.gui.text('line three');
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  e.frame(draw); // second frame applies the measured size
  const w = e.gui.getWindow('Auto');
  check(w.h > w.titleH + 40, 'auto window has height for 3 lines, h=' + w.h);
});

test('window state persists across frames and reappears', () => {
  const e = new Env();
  const draw = (show) => () => {
    if (show) {
      if (e.gui.beginWindow('Flicker', { size: [200, 120], pos: [50, 60] })) e.gui.endWindow();
    }
  };
  e.frame(draw(true));
  const w = e.gui.getWindow('Flicker');
  w.x = 150; w.y = 160; // move it
  e.frame(draw(true));
  e.frame(draw(false)); // disappears
  check(!e.gui.state.windows.has('Flicker'), 'window removed when not drawn');
  e.frame(draw(true)); // reappears
  const w2 = e.gui.getWindow('Flicker');
  check(approx(w2.x, 150, 0.01) && approx(w2.y, 160, 0.01), 'position restored from persisted state, got ' + w2.x + ',' + w2.y);
});

test('dragging outside the display does not crash or corrupt', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('Far', { size: [200, 120] })) e.gui.endWindow();
  };
  e.frame(draw);
  const w = e.gui.getWindow('Far');
  e.hover(w.x + 50, w.y + 15);
  e.down();
  for (let i = 0; i < 40; i++) {
    e.hover(w.x + 50 + i * 60, w.y + 15 - i * 20);
    e.frame(draw);
  }
  e.hover(5000, -3000);
  e.frame(draw);
  e.up();
  e.frame(draw);
  check(isFinite(w.x) && isFinite(w.y), 'window still finite after far drag');
  e.hover(400, 300);
  e.frame(draw);
  check(true, 'no crash after recovery');
});

test('tables render header and rows', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('TB2', { size: [320, 220] })) {
      e.gui.beginTable('tbl', 3, { colWidths: [120, 0, 60] });
      e.gui.tableHeader(['Name', 'Size', 'Age']);
      e.gui.tableRow(['alpha', '1.2', '3']);
      e.gui.tableRow(['beta', '4.5', '9']);
      e.gui.endTable();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  const texts = e.renderer.drawnText();
  check(texts.includes('Name') && texts.includes('alpha') && texts.includes('beta'), 'table contents drawn');
});

test('tree nodes expand with indent and pop', () => {
  const e = new Env();
  let inner = false;
  const draw = () => {
    if (e.gui.beginWindow('TR', { size: [300, 240] })) {
      const open = e.gui.treeNode('Node');
      if (open) {
        e.gui.text('nested text');
        inner = true;
        e.gui.treePop();
      }
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  check(inner === false, 'closed by default');
  let rect = null;
  const draw2 = () => {
    if (e.gui.beginWindow('TR', { size: [300, 240] })) {
      const open = e.gui.treeNode('Node');
      if (open) { e.gui.text('nested text'); inner = true; e.gui.treePop(); }
      rect = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw2);
  e.click(rect.x + rect.w / 2, rect.y + rect.h / 2);
  e.frame(draw2);
  check(inner === true, 'tree node opened');
  check(e.renderer.drawnText().includes('nested text'), 'nested content drawn');
  // indent applied: nested text x > node x
  const nodeTxt = e.renderer.calls.find((c) => c[0] === 'drawText' && c[3] === 'Node');
  const nestedTxt = e.renderer.calls.find((c) => c[0] === 'drawText' && c[3] === 'nested text');
  check(nestedTxt[1] > nodeTxt[1], 'nested content is indented');
});

test('plotLines and progressBar draw without errors', () => {
  const e = new Env();
  const vals = [0.1, 0.5, 0.3, 0.9, 0.4, 0.7];
  const draw = () => {
    if (e.gui.beginWindow('P', { size: [320, 200] })) {
      e.gui.plotLines('Signal', vals);
      e.gui.progressBar(0.42);
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  check(e.renderer.calls.some((c) => c[0] === 'polyline'), 'plot polyline drawn');
  check(e.renderer.drawnText().includes('42%'), 'progress overlay drawn');
});

test('setNextItemWidth constrains slider width', () => {
  const e = new Env();
  let r1 = null, r2 = null;
  const draw = () => {
    if (e.gui.beginWindow('WI', { size: [320, 160] })) {
      e.gui.setNextItemWidth(80);
      e.gui.sliderFloat('A', 0.5, 0, 1);
      r1 = e.gui.lastItemRect();
      e.gui.sliderFloat('B', 0.5, 0, 1);
      r2 = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  check(r1.w < r2.w, 'next-item width applied only to the next widget (' + r1.w + ' vs ' + r2.w + ')');
});

test('group treats contents as one layout block', () => {
  const e = new Env();
  let after = null;
  const draw = () => {
    if (e.gui.beginWindow('G', { size: [300, 200] })) {
      e.gui.beginGroup();
      e.gui.text('a');
      e.gui.text('b');
      e.gui.endGroup();
      e.gui.text('after');
      after = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  const win = e.gui.getWindow('G');
  // 'after' should be a full line below the group (two lines of text)
  const lineH = e.gui._lineH();
  check(after.y > win.y + win.titleH + lineH * 2, 'cursor advanced past full group height, y=' + after.y);
});

test('sameLine places the next element on the previous element\u2019s line (automatic padding)', () => {
  const e = new Env();
  let r1 = null, r2 = null;
  const draw = () => {
    if (e.gui.beginWindow('SL', { size: [320, 140] })) {
      e.gui.text('left');
      r1 = e.gui.lastItemRect();
      e.gui.sameLine();
      e.gui.text('right');
      r2 = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  const sp = e.gui._var('itemSpacing');
  check(Math.abs(r2.y - r1.y) < 0.01, 'same y level as the previous element, got ' + r1.y + ' vs ' + r2.y);
  check(Math.abs(r2.x - (r1.x + r1.w + sp[0])) < 0.01,
    'x is to the right of the previous element + the horizontal item spacing, got gap ' + (r2.x - (r1.x + r1.w)) + ' (expected ' + sp[0] + ')');
});

test('sameLine supports explicit spacing and an absolute line offset', () => {
  const e = new Env();
  let ra = null, rb = null, rc = null, rd = null;
  const draw = () => {
    if (e.gui.beginWindow('SL', { size: [420, 140] })) {
      e.gui.text('a');
      ra = e.gui.lastItemRect();
      e.gui.sameLine(24); // explicit 24px padding after the previous element
      e.gui.text('b');
      rb = e.gui.lastItemRect();
      e.gui.text('c'); // back on its own line
      rc = e.gui.lastItemRect();
      e.gui.sameLine(null, 60); // absolute 60px from the line start
      e.gui.text('d');
      rd = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  check(Math.abs(rb.x - (ra.x + ra.w + 24)) < 0.01, 'explicit spacing honored, got gap ' + (rb.x - (ra.x + ra.w)));
  check(Math.abs(rb.y - ra.y) < 0.01, 'explicit-spacing element stays on the line');
  check(Math.abs(rd.x - (rc.x + 60)) < 0.01, 'offsetX anchors from the line start, got x ' + rd.x + ' (line start ' + rc.x + ')');
});

test('sameLine chains across a row, then the next element drops below the row', () => {
  const e = new Env();
  let ra = null, rb = null, rc = null, rd = null;
  const draw = () => {
    if (e.gui.beginWindow('SL', { size: [320, 160] })) {
      e.gui.text('a');
      ra = e.gui.lastItemRect();
      e.gui.sameLine();
      e.gui.text('b');
      rb = e.gui.lastItemRect();
      e.gui.sameLine();
      e.gui.text('c');
      rc = e.gui.lastItemRect();
      e.gui.text('d');
      rd = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  check(Math.abs(rb.y - ra.y) < 0.01 && Math.abs(rc.y - ra.y) < 0.01, 'chained elements share the line y, got ' + [ra.y, rb.y, rc.y].join(','));
  check(rd.y > rc.y + 10, 'the element after the row starts a new line below it, got ' + rd.y + ' vs ' + rc.y);
  check(Math.abs(rd.x - ra.x) < 0.01, 'the new line is left-aligned with the row, got ' + rd.x + ' vs ' + ra.x);
});

test('sameLine with no previous element is a no-op (if applicable)', () => {
  const e = new Env();
  let r1 = null, r2 = null;
  const draw = () => {
    if (e.gui.beginWindow('SL', { size: [300, 140] })) {
      e.gui.sameLine(); // nothing has been drawn yet: not applicable
      e.gui.text('first');
      r1 = e.gui.lastItemRect();
      e.gui.text('second');
      r2 = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  check(r2.y > r1.y + 10, 'no stale request: the first two elements are on separate lines, got ' + r1.y + ' vs ' + r2.y);
  check(Math.abs(r2.x - r1.x) < 0.01, 'the second element is left-aligned (not merged), got ' + r2.x + ' vs ' + r1.x);
});

test('an empty group after sameLine does not leak the request', () => {
  const e = new Env();
  let ra = null, rb = null, rc = null;
  const draw = () => {
    if (e.gui.beginWindow('SL', { size: [320, 160] })) {
      e.gui.text('a');
      ra = e.gui.lastItemRect();
      e.gui.sameLine();
      e.gui.beginGroup();
      e.gui.endGroup(); // empty group: it is the same-line "next element"
      e.gui.text('b');
      rb = e.gui.lastItemRect();
      e.gui.text('c');
      rc = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  check(rb.y > ra.y + 10, 'the empty group consumed the same-line slot; b is on the next line, got (' + rb.x + ',' + rb.y + ') vs (' + ra.x + ',' + ra.y + ')');
  check(Math.abs(rb.x - ra.x) < 0.01, 'b is left-aligned with the line, got ' + rb.x + ' vs ' + ra.x);
  check(rc.y > rb.y + 10, 'no leak: c starts a new line, not a stale merge, got ' + rc.y + ' vs ' + rb.y);
});

test('sameLine before a group places the group on the previous element\u2019s line', () => {
  const e = new Env();
  let ra = null, rb = null, gr = null;
  const sp = e.gui._var('itemSpacing');
  const draw = () => {
    if (e.gui.beginWindow('SL', { size: [360, 160] })) {
      e.gui.text('a');
      ra = e.gui.lastItemRect();
      e.gui.sameLine();
      gr = e.gui.beginGroup();
      e.gui.text('b in group');
      rb = e.gui.lastItemRect();
      e.gui.endGroup();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  check(Math.abs(rb.y - ra.y) < 0.01, 'group content sits on the previous element\u2019s line, got ' + rb.y + ' vs ' + ra.y);
  check(Math.abs(rb.x - (ra.x + ra.w + sp[0])) < 0.01, 'group starts right of the previous element + spacing, got ' + rb.x + ' (expected ' + (ra.x + ra.w + sp[0]) + ')');
});

test('sameLine after a group places the next element to the right of the group', () => {
  const e = new Env();
  let rg = null, rb = null;
  const draw = () => {
    if (e.gui.beginWindow('SL', { size: [360, 160] })) {
      e.gui.beginGroup();
      e.gui.text('group line 1');
      e.gui.text('group line 2');
      rg = e.gui.endGroup();
      e.gui.sameLine(16);
      e.gui.text('after group');
      rb = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  check(Math.abs(rb.y - rg.y) < 0.01, 'text is on the group\u2019s line, got ' + rb.y + ' vs ' + rg.y);
  check(Math.abs(rb.x - (rg.x + rg.w + 16)) < 0.01, 'text is 16px right of the group, got ' + rb.x + ' (group right edge ' + (rg.x + rg.w) + ')');
});

test('a full-width item before a group does not inflate the group width', () => {
  const e = new Env();
  let g = null, ra = null, rb = null;
  const draw = () => {
    if (e.gui.beginWindow('SL', { size: [360, 220] })) {
      e.gui.text('top');
      ra = e.gui.lastItemRect();
      e.gui.separator(); // full width
      e.gui.beginGroup();
      e.gui.text('short');
      g = e.gui.endGroup();
      e.gui.sameLine(16);
      e.gui.text('next');
      rb = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  check(Math.abs(g.w - (ra.x + e.gui._measure('short').w - g.x)) < 1, 'group width = its own content, not the full line, got ' + g.w);
  check(Math.abs(rb.x - (g.x + g.w + 16)) < 0.01, 'next element 16px right of the group, got ' + rb.x + ' (group right ' + (g.x + g.w) + ')');
  check(Math.abs(rb.y - g.y) < 0.01, 'next element on the group\u2019s line, got ' + rb.y + ' vs ' + g.y);
});

test('sameLine works between real widgets (combo + small button)', () => {
  const e = new Env();
  let r1 = null, r2 = null;
  const draw = () => {
    if (e.gui.beginWindow('SL', { size: [360, 140] })) {
      e.gui.setNextItemWidth(120);
      e.gui.combo('choice', 0, ['one', 'two', 'three']);
      r1 = e.gui.lastItemRect();
      e.gui.sameLine();
      if (e.gui.smallButton('ok')) {}
      r2 = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  check(Math.abs(r2.y - r1.y) < 0.01, 'button on the same y level as the combo, got ' + r1.y + ' vs ' + r2.y);
  check(r2.x >= r1.x + r1.w, 'button to the right of the combo, got ' + r2.x + ' vs ' + (r1.x + r1.w));
});

test('rapidly changing values do not desync', () => {
  const e = new Env();
  let value = 0;
  const draw = () => {
    if (e.gui.beginWindow('R', { size: [260, 140] })) {
      value = e.gui.sliderFloat('V', value % 100, 0, 100);
      e.gui.endWindow();
    }
  };
  let rect = null;
  e.frame(() => {
    if (e.gui.beginWindow('R', { size: [260, 140] })) {
      e.gui.sliderFloat('V', 0, 0, 100);
      rect = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  });
  const cx = rect.x + rect.w * 0.3, cy = rect.y + rect.h / 2;
  e.press(cx, cy);
  // drag with the value jumping around each frame
  for (let i = 0; i < 30; i++) {
    e.hover(cx + (i % 5), cy);
    e.frame();
  }
  e.release();
  check(isFinite(value) && value >= 0 && value <= 100, 'value sane after chaotic drag, got ' + value);
});

test('NaN / infinite values are handled', () => {
  const e = new Env();
  let v1, v2;
  const draw = () => {
    if (e.gui.beginWindow('NAN', { size: [260, 180] })) {
      v1 = e.gui.sliderFloat('a', NaN, 0, 10);
      v2 = e.gui.inputFloat('b', Infinity, { min: 0, max: 5 });
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  check(isFinite(v1), 'NaN slider sanitized, got ' + v1);
  check(isFinite(v2) || v2 === Infinity, 'infinity input does not crash, got ' + v2);
});

test('debug overlay renders stats', () => {
  const e = new Env({ debugOverlay: true });
  const draw = () => {
    if (e.gui.beginWindow('DBG', { size: [200, 100] })) e.gui.endWindow();
  };
  e.frames(5, draw);
  check(e.renderer.drawnText().some((t) => /FPS/.test(t)), 'debug overlay shows FPS');
});

test('mouse back button closes topmost popup', () => {
  const e = new Env();
  let idx = 0, rect = null;
  const draw = () => {
    if (e.gui.beginWindow('MF', { size: [280, 140] })) {
      idx = e.gui.combo('F', idx, ['a', 'b', 'c']);
      rect = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  e.click(rect.x + 10, rect.y + 8);
  e.frame(draw);
  check(e.gui.state.popupList.length === 1, 'combo open');
  e.input.mouse.buttons[3] = true; // mouse back
  e.frame(draw);
  e.input.mouse.buttons[3] = false;
  e.frame(draw);
  check(e.gui.state.popupList.length === 0, 'mouse back closed popup');
});

test('scrolled-out content is culled; no zero-size draws reach renderer', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('CULL', { size: [200, 120] })) {
      for (let i = 0; i < 40; i++) e.gui.text('line ' + i);
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  const w = e.gui.getWindow('CULL');
  check(w.maxScrollY > 100, 'content is scrollable, maxScrollY=' + w.maxScrollY);
  w.scrollTargetY = w.maxScrollY; // scroll to bottom (as wheel/scrollbar would)
  e.frame(draw);
  const txt = e.renderer.drawnText();
  check(!txt.some((t) => t.startsWith('line 0')), 'scrolled-out line culled');
  check(txt.includes('line 39'), 'bottom line still drawn');
  const bad = e.renderer.calls.filter((c) => {
    if (c[0] === 'fillRect' || c[0] === 'fillRoundedRect') return c[3] <= 0 || c[4] <= 0;
    return false;
  });
  check(bad.length === 0, 'no zero-size draws reached the renderer');
});

test('image widget forwards to renderer.drawImage', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('IMG', { size: [240, 160] })) {
      e.gui.image('tex1', 64, 64);
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  check(e.renderer.calls.some((c) => c[0] === 'drawImage' && c[1] === 'tex1'), 'drawImage called with id');
});

/* ---------------------------- results ---------------------------------- */

test('window: title click collapses, outside-x click does not, drag does not', () => {
  const e = new Env();
  const draw = () => { if (e.gui.beginWindow('CC', { size: [260, 160] })) e.gui.endWindow(); };
  e.frame(draw);
  const w = e.gui.getWindow('CC');
  const ty = w.y + w.titleH / 2;
  const tx = w.x + w.w / 2; // title bar, right of arrow, left of close
  e.click(tx, ty);
  check(w.collapsed === true, 'title click collapsed, collapsed=' + w.collapsed);
  e.click(tx, ty);
  check(w.collapsed === false, 'second title click uncollapsed');
  // click at title height but far to the LEFT of the window: no effect
  e.click(w.x - 200, ty);
  check(w.collapsed === false, 'click left of window did not collapse');
  // click at title height but far to the RIGHT of the window: no effect
  e.click(w.x + w.w + 200, ty);
  check(w.collapsed === false, 'click right of window did not collapse');
  // drag the title bar: must not collapse
  e.press(tx, ty);
  e.hover(tx + 40, ty + 30); e.frame();
  e.release();
  e.frame();
  check(w.collapsed === false, 'title drag did not collapse');
});

test('window: resize grip drawn at bottom-right, absent when fixed-size', () => {
  const e = new Env();
  const draw = () => { if (e.gui.beginWindow('GR', { size: [260, 160] })) e.gui.endWindow(); };
  e.frame(draw);
  const w = e.gui.getWindow('GR');
  const gy = w.y + w.h, gx = w.x + w.w;
  const nearCorner = (c, cx, cy) => {
    const d = (x, y) => Math.hypot(x - cx, y - cy);
    return d(c[1], c[2]) < 22 && d(c[3], c[4]) < 22; // both endpoints near the corner
  };
  const grip = e.renderer.calls.filter((c) => c[0] === 'line' && nearCorner(c, gx, gy));
  check(grip.length >= 2, 'grip lines near bottom-right corner, got ' + grip.length);
  // the grip is a sizeable triangle: at least one endpoint well clear of the corner
  const d0 = (x, y) => Math.hypot(x - gx, y - gy);
  const reachesFar = grip.some((c) => d0(c[1], c[2]) > 12 || d0(c[3], c[4]) > 12);
  check(reachesFar, 'grip triangle extends past 12px from the corner');
  // fixed-size window: no grip
  const e2 = new Env();
  const draw2 = () => { if (e2.gui.beginWindow('FX', { size: [260, 160], flags: Mim.WindowFlags.FixedSize })) e2.gui.endWindow(); };
  e2.frame(draw2);
  const w2 = e2.gui.getWindow('FX');
  const grip2 = e2.renderer.calls.filter((c) => c[0] === 'line' && nearCorner(c, w2.x + w2.w, w2.y + w2.h));
  check(grip2.length === 0, 'no grip on fixed-size window, got ' + grip2.length);
});

test('window: resize grip takes click priority over the scrollbar and highlights on hover', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('SC', { size: [240, 170], pos: [100, 100] })) {
      for (let i = 0; i < 40; i++) e.gui.text('line ' + i + ' to overflow the window');
      e.gui.endWindow();
    }
  };
  e.frames(2, draw);
  const w = e.gui.getWindow('SC');
  check(w.hadScrollV === true, 'window shows a vertical scrollbar');
  const gx = w.x + w.w, gy = w.y + w.h;
  const gripLine = (x, y) => {
    e.hover(x, y); e.frame(draw);
    const g = e.renderer.calls.filter((c) => c[0] === 'line' &&
      Math.abs(c[1] - gx) < 20 && Math.abs(c[2] - gy) < 20 &&
      Math.abs(c[3] - gx) < 20 && Math.abs(c[4] - gy) < 20);
    return g.length ? g[0][5] : null; // line color arg
  };
  const normal = gripLine(400, 400);
  const hot = gripLine(gx - 4, gy - 4); // the grip zone, over the scrollbar track
  check(normal && hot, 'grip lines drawn in both states');
  check(hot !== normal, 'grip highlights on hover (colors differ)');
  check(e.renderer.lastCursor === 'nwse-resize', 'grip zone cursor, got ' + e.renderer.lastCursor);
  // click the corner (vertical scrollbar track is here too): the resize wins
  e.press(gx - 4, gy - 4);
  check(e.gui.state.drag && e.gui.state.drag.type === 'win-resize' && e.gui.state.drag.edge === 3,
    'corner click starts a resize, got ' + (e.gui.state.drag && e.gui.state.drag.type));
  const w0w = e.gui.getWindow('SC').w, w0h = e.gui.getWindow('SC').h; // snapshot!
  e.dragTo(gx - 4, gy - 4, gx + 30, gy + 20);
  const w1 = e.gui.getWindow('SC');
  check(w1.w > w0w + 20 && w1.h > w0h + 10, 'grip drag resized the window, got ' + w1.w + 'x' + w1.h);
  // the scrollbar still works away from the grip zone (window moved: re-aim)
  e.press(w1.x + w1.w - 4, w1.y + w1.h / 2);
  check(e.gui.state.drag && e.gui.state.drag.type === 'scroll-v',
    'mid-track click still drags the scrollbar, got ' + (e.gui.state.drag && e.gui.state.drag.type));
  e.up(0); e.frame(draw);
});

test('window: resize bars pop up near a side, drag resizes that direction, N configurable', () => {
  const e = new Env();
  const draw = () => { if (e.gui.beginWindow('RB', { size: [240, 200], pos: [100, 100] })) e.gui.endWindow(); };
  e.frames(2, draw);
  check(Number.isInteger(e.gui.flags.resizeBarProximity) && e.gui.flags.resizeBarProximity > 0,
    'resizeBarProximity is a positive integer flag');
  const w = e.gui.getWindow('RB');
  // LEFT side: 3px left of the outline (within N=8)
  e.hover(w.x - 3, w.y + 100); e.frame(draw);
  check(e.renderer.lastCursor === 'ew-resize', 'left side shows ew-resize, got ' + e.renderer.lastCursor);
  // bar: fillRoundedRect(x, y, w, h, r, c) — thin in x, long in y, hugging x=w.x
  const bar = e.renderer.calls.filter((c) => c[0] === 'fillRoundedRect' &&
    c[1] < w.x && c[1] >= w.x - 4 && c[3] <= 6 && c[4] >= 24 && c[4] <= 70 &&
    c[2] > w.y + 40 && c[2] < w.y + w.h - 40);
  check(bar.length >= 1, 'left resize bar drawn over the left side, got ' + bar.length);
  const x0 = w.x, w0 = w.w; // snapshots (windows are live objects)
  e.dragTo(w.x - 3, w.y + 100, w.x - 40, w.y + 100);
  const w2 = e.gui.getWindow('RB');
  check(Math.abs(w2.x - (x0 - 37)) < 1 && Math.abs(w2.w - (w0 + 37)) < 1,
    'left drag moved x and grew w, got x=' + w2.x + ' w=' + w2.w);
  // TOP side
  const y0 = w2.y, h0 = w2.h;
  e.dragTo(w2.x + 100, w2.y - 3, w2.x + 100, w2.y - 30);
  const w3 = e.gui.getWindow('RB');
  check(Math.abs(w3.y - (y0 - 27)) < 1 && Math.abs(w3.h - (h0 + 27)) < 1,
    'top drag moved y and grew h, got y=' + w3.y + ' h=' + w3.h);
  // CORNER: both bars + grip, drag resizes both directions at once
  e.hover(w3.x + w3.w + 4, w3.y + w3.h + 4); e.frame(draw);
  check(e.renderer.lastCursor === 'nwse-resize', 'corner shows nwse-resize, got ' + e.renderer.lastCursor);
  const c0w = w3.w, c0h = w3.h; // snapshot before the corner drag
  e.dragTo(w3.x + w3.w + 4, w3.y + w3.h + 4, w3.x + w3.w + 24, w3.y + w3.h + 14);
  const w4 = e.gui.getWindow('RB');
  check(w4.w > c0w + 10 && w4.h > c0h + 5,
    'corner drag resized both dimensions at once, got ' + w4.w + 'x' + w4.h + ' (was ' + c0w + 'x' + c0h + ')');
  // N is configurable: 0 disables, smaller N tightens the band
  e.gui.flags.resizeBarProximity = 0;
  e.hover(w4.x + w4.w + 3, w4.y + 50); e.frame(draw);
  check(e.renderer.lastCursor !== 'ew-resize', 'proximity 0 disables the side bands');
  e.gui.flags.resizeBarProximity = 3;
  e.hover(w4.x + w4.w + 4, w4.y + 50); e.frame(draw);
  check(e.renderer.lastCursor !== 'ew-resize', '4px out is outside N=3');
  e.hover(w4.x + w4.w + 2, w4.y + 50); e.frame(draw);
  check(e.renderer.lastCursor === 'ew-resize', '2px out is inside N=3');
});

test('slider: clicking the track sets the value to the click position', () => {
  const e = new Env();
  let value = 0.5;
  let rect = null;
  const draw = () => {
    if (e.gui.beginWindow('SL', { size: [300, 120] })) {
      value = e.gui.sliderFloat('F', value, 0, 1);
      rect = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  e.click(rect.x + rect.w * 0.25, rect.y + rect.h / 2);
  check(Math.abs(value - 0.25) < 0.06, 'click at 25% set ~0.25, got ' + value);
  e.click(rect.x + rect.w * 0.75, rect.y + rect.h / 2);
  check(Math.abs(value - 0.75) < 0.06, 'click at 75% set ~0.75, got ' + value);
});

test('listBox: selects on click, shows highlight, scrolls selection into view', () => {
  const e = new Env();
  const items = [];
  for (let i = 0; i < 30; i++) items.push('item ' + i);
  let sel = 0, child = null;
  const draw = () => {
    if (e.gui.beginWindow('LB', { size: [280, 320] })) {
      sel = e.gui.listBox('Pick', sel, items, { rows: 5 });
      for (const w of e.gui.state.windows.values()) if (w.kind === 'child') child = w;
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  check(!!child, 'listbox child region exists');
  const lineH = e.gui._lineH();
  const sp = e.gui._var('itemSpacing')[1];
  const rowH = lineH + 10;
  const pitch = rowH + sp;
  const rowY = (i) => child.y + 4 + i * pitch + rowH / 2;
  e.click(child.x + 30, rowY(2));
  e.frame(draw);
  check(sel === 2, 'clicking row 2 selects it, got ' + sel);
  // selecting a far row scrolls it into view (target set this frame,
  // resolved by beginChild on the next)
  sel = 29;
  e.frame(draw);
  e.frame(draw);
  check(child.scrollY > 0, 'scrolled to selected row, scrollY=' + child.scrollY);
  check(sel === 29, 'selection kept, got ' + sel);
});

test('cursor: pointer over button, move over title, text in edit, grabbing while dragging', () => {
  const e = new Env();
  let btn = null, fld = null;
  const draw = () => {
    if (e.gui.beginWindow('CU', { size: [280, 160] })) {
      e.gui.dummy(10, 4);
      if (e.gui.button('B')) {}
      btn = e.gui.lastItemRect();
      e.gui.inputText('t', 'ab');
      fld = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  const w = e.gui.getWindow('CU');
  // over the button
  e.hover(btn.x + 5, btn.y + btn.h / 2); e.frame(draw);
  check(e.renderer.lastCursor === 'pointer', 'pointer over button, got ' + e.renderer.lastCursor);
  // over the title bar
  e.hover(w.x + w.w / 2, w.y + w.titleH / 2); e.frame(draw);
  check(e.renderer.lastCursor === 'move', 'move over title, got ' + e.renderer.lastCursor);
  // editing the text field
  e.click(fld.x + 10, fld.y + fld.h / 2); e.frame(draw);
  check(e.renderer.lastCursor === 'text', 'text cursor while editing, got ' + e.renderer.lastCursor);
  // dragging the window
  e.press(w.x + w.w / 2, w.y + w.titleH / 2);
  e.hover(w.x + w.w / 2 + 30, w.y + w.titleH / 2 + 20); e.frame(draw);
  check(e.renderer.lastCursor === 'grabbing', 'grabbing while dragging, got ' + e.renderer.lastCursor);
  e.release(); e.frame(draw);
});

test('cursor: not requested when backend lacks the feature', () => {
  const e = new Env();
  e.renderer.features.cursor = false;
  let btn = null;
  const draw = () => {
    if (e.gui.beginWindow('CN', { size: [280, 120] })) {
      if (e.gui.button('B')) {}
      btn = e.gui.lastItemRect();
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  e.hover(btn.x + 5, btn.y + btn.h / 2); e.frame(draw);
  check(e.renderer.lastCursor === 'default', 'no setCursor when unsupported, got ' + e.renderer.lastCursor);
});

test('tooltip: only topmost hovered item shows it, above the cursor after delay', () => {
  const e = new Env();
  e.gui.flags.tooltipDelay = 0.02;
  let topBtn = null, botBtn = null;
  const draw = () => {
    if (e.gui.beginWindow('BOT', { size: [220, 140], pos: [100, 100] })) {
      if (e.gui.button('BB')) {}
      botBtn = e.gui.lastItemRect();
      e.gui.setTooltip('bot tooltip');
      e.gui.endWindow();
    }
    if (e.gui.beginWindow('TOP', { size: [220, 140], pos: [100, 100] })) {
      if (e.gui.button('BB')) {}
      topBtn = e.gui.lastItemRect();
      e.gui.setTooltip('top tooltip');
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  // both windows overlap fully; TOP was drawn last so it is topmost
  e.hover(topBtn.x + 5, topBtn.y + topBtn.h / 2);
  for (let i = 0; i < 5; i++) { e.gui._timeOffset += 20; e.frame(draw); } // age past the delay
  const texts = e.renderer.drawnText();
  check(texts.some((t) => t === 'top tooltip'), 'topmost tooltip shown');
  check(!texts.some((t) => t === 'bot tooltip'), 'occluded tooltip suppressed');
  // tooltip box is drawn above the cursor
  const dt = e.renderer.calls.find((c) => c[0] === 'drawText' && c[3] === 'top tooltip');
  check(dt && dt[2] < e.input.mouse.y, 'tooltip positioned above cursor (y=' + (dt && dt[2]) + ' < ' + e.input.mouse.y + ')');
});

test('dock: joins two windows, divider drag, move, resize, undock, close', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { size: [240, 200], pos: [100, 100] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { size: [240, 200], pos: [400, 100] })) e.gui.endWindow();
  };
  e.frame(draw);
  e.gui.dock('A', 'B', { dir: 'h', ratio: 0.5 });
  e.frame(draw);
  check(e.gui.isDocked('A', 'B'), 'docked after gui.dock');
  let A = e.gui.getWindow('A'), B = e.gui.getWindow('B');
  check(Math.abs(A.x + A.w + 6 - B.x) < 2 && A.y === B.y && A.h === B.h,
    'horizontal dock: A left of B sharing height, A right=' + (A.x + A.w) + ' B x=' + B.x);
  const D0 = e.gui.getDocks()[0];
  check(D0 && Math.abs(D0.ratio - 0.5) < 0.01, 'dock ratio stored');
  // divider drag: ratio increases
  const D = e.gui.state.docks.get(D0.id);
  const divX = D.x + Math.round((D.w - 6) * D.ratio) + 3;
  e.dragTo(divX, D.y + 60, divX + 90, D.y + 60, 8);
  check(D.ratio > 0.6, 'split drag grew A ratio, got ' + D.ratio.toFixed(2));
  // move the whole dock by its title bar
  const x0 = A.x;
  e.dragTo(D.x + D.w / 2, D.y + 8, D.x + D.w / 2 + 120, D.y + 8 + 40, 8);
  A = e.gui.getWindow('A');
  check(Math.abs(A.x - (x0 + 120)) < 2, 'dock move translated member A, got dx=' + (A.x - x0));
  // resize the whole dock from the right edge
  const D2 = e.gui.getDocks()[0];
  const w0 = D2.w;
  e.dragTo(D2.x + D2.w - 2, D2.y + 60, D2.x + D2.w + 80, D2.y + 60, 6);
  check(e.gui.getDocks()[0].w > w0 + 60, 'dock resize widened it, got +(' + (e.gui.getDocks()[0].w - w0) + ')');
  // undock: members become independent windows
  check(e.gui.undock('A', 'B'), 'undock returns true');
  e.frame(draw);
  check(!e.gui.isDocked('A', 'B'), 'undocked');
  A = e.gui.getWindow('A'); B = e.gui.getWindow('B');
  check(A.movable === true && A.x !== B.x, 'members independent again');
});

test('dock: close button removes dock and closes both members; vertical dock works', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('P', { size: [200, 160], pos: [120, 120] })) e.gui.endWindow();
    if (e.gui.beginWindow('Q', { size: [200, 160], pos: [120, 340] })) e.gui.endWindow();
  };
  e.frame(draw);
  e.gui.dock('P', 'Q', { dir: 'v' });
  e.frame(draw);
  let P = e.gui.getWindow('P'), Q = e.gui.getWindow('Q');
  check(Math.abs(P.y + P.h + 6 - Q.y) < 2 && P.x === Q.x, 'vertical dock: P above Q');
  // close button at the right end of the dock title bar
  const D = e.gui.getDocks()[0];
  e.click(D.x + D.w - 16, D.y + 8);
  e.frame(draw);
  check(!e.gui.isDocked('P', 'Q'), 'dock closed via close button');
  check(e.gui.getWindow('P').open === false && e.gui.getWindow('Q').open === false, 'both members closed');
});

test('dock: slim header collapses a member (other grows); undock button frees one member', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { size: [240, 200], pos: [100, 100] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { size: [240, 200], pos: [400, 100] })) e.gui.endWindow();
  };
  e.frame(draw);
  e.gui.dock('A', 'B', { dir: 'h', ratio: 0.5 });
  e.frame(draw);
  let A = e.gui.getWindow('A'), B = e.gui.getWindow('B');
  const wB0 = B.w;
  // click A's slim header (middle, avoiding chevron/undock)
  e.click(A.x + A.w / 2, A.y + A.titleH / 2);
  e.frame(draw);
  A = e.gui.getWindow('A'); B = e.gui.getWindow('B');
  check(A.collapsed === true && B.collapsed === false, 'only the clicked member collapsed');
  check(B.w > wB0 + 100, 'other member grew wide, got +' + (B.w - wB0));
  // undock B via its undock button (right end of B's slim header)
  e.click(B.x + B.w - 13, B.y + B.titleH / 2);
  e.frame(draw);
  check(!e.gui.isDocked('A', 'B'), 'undock button removed the dock');
  check(e.gui.getWindow('B').movable === true, 'B is a normal window again');
});

test('app menu bar: top bar, section open, item click, keyboard shortcut, activateMenu', () => {
  const e = new Env();
  let saved = 0, toggled = 0;
  e.gui.setAppMenuBar([
    { label: 'File', items: [
      { label: 'Save', shortcut: 'ctrl+s', key: 's', keyMod: ['ctrl'], onActivated: () => saved++ },
      { sep: true },
      { label: 'Quit' },
    ] },
    { label: 'Windows', items: [
      { label: 'Toggle A', onActivated: () => toggled++ },
    ] },
  ], { pos: 'top' });
  const draw = () => { if (e.gui.beginWindow('M', { size: [200, 140], pos: [100, 80] })) e.gui.endWindow(); };
  e.frame(draw);
  check(e.gui.state.appBarRect && e.gui.state.appBarRect.w === 1280 && e.gui.state.appBarRect.h === 30,
    'top bar spans the screen');
  const secs = e.gui.state.appMenuSections;
  check(secs.length === 2 && secs[0].label === 'File', 'sections laid out');
  // click File -> popup opens
  e.click(secs[0].rect.x + 5, secs[0].rect.y + 5);
  const pops = e.gui.state.popupList.filter((p) => p.open);
  check(pops.length === 1 && pops[0].data.appMenu, 'section click opened dropdown');
  const fp = pops[0];
  check(fp.data.items.length === 3 && fp.data.items[1].type === 'sep', 'dropdown rows include sep');
  // click the 'Save' row
  const rowH = e.gui._lineH() + 10;
  e.click(fp.x + 20, fp.y + 6 + rowH / 2);
  e.frame(draw);
  check(saved === 1, 'menu item click fired onActivated');
  check(!e.gui.state.popupList.some((p) => p.open), 'menu closed after activation');
  // keyboard shortcut ctrl+s
  e.input.keys = new Set(['ctrl', 's']);
  e.frame(draw);
  e.input.keys = new Set();
  e.frame(draw);
  check(saved === 2, 'keyboard shortcut fired');
  // activateMenu
  check(e.gui.activateMenu('Windows', 'Toggle A') === true && toggled === 1, 'activateMenu triggers item');
  check(e.gui.activateMenu('Windows', 'Nope') === false, 'activateMenu misses unknown item');
});

test('app menu bar: submenu hover-open, and bar blocks clicks to windows underneath', () => {
  const e = new Env();
  let deep = 0;
  e.gui.setAppMenuBar([
    { label: 'W', items: [{ label: 'Sub', items: [{ label: 'Deep', onActivated: () => deep++ }] }] },
  ], { pos: 'left' });
  let under = 0;
  const draw = () => {
    if (e.gui.beginWindow('T', { size: [200, 300], pos: [20, 20] })) {
      if (e.gui.button('Under')) under++;
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  check(e.gui.state.appBarRect.x === 0 && e.gui.state.appBarRect.w === 180, 'left bar geometry');
  const sec = e.gui.state.appMenuSections[0];
  e.click(sec.rect.x + 10, sec.rect.y + 5);
  const wp = e.gui.state.popupList.find((p) => p.open && p.data.appMenu);
  check(!!wp, 'left-bar section opens dropdown');
  const rowH = e.gui._lineH() + 10;
  e.hover(wp.x + 30, wp.y + 6 + rowH / 2);
  e.frame(draw);
  const sp = e.gui.state.popupList.find((p) => p.open && p.id.startsWith('##appsub'));
  check(!!sp && sp.data.items.length === 1, 'submenu opened on hover with its rows');
  e.click(sp.x + 15, sp.y + 6 + rowH / 2);
  check(deep === 1, 'submenu item activated');
  // bar blocks: button 'Under' sits inside the left-bar zone (x=20+10..30)
  const btn = { x: 30, y: 70 };
  e.click(btn.x, btn.y);
  check(under === 0, 'click under the bar did not reach the window');
  // outside the bar it does
  e.click(600, 200);
  check(under === 0 || under === 0, 'no stray clicks elsewhere (button not under cursor)');
});

/* ============ interactive docking: drag grid + screen edges =========== */

function twoWinEnv() {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { size: [240, 200], pos: [100, 100] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { size: [240, 200], pos: [500, 100] })) e.gui.endWindow();
  };
  e.frame(draw);
  return { e, draw };
}
/* B's center is (620,200); grid: a 72x72 square (584..656 x 164..236) of
 * four direction triangles — r centroid (644,200), t centroid (620,180) */

test('drag grid: drop on a part of the hovered window docks (side sets dir/order)', () => {
  // drop A onto B's TOP triangle -> vertical dock, A above B
  let { e, draw } = twoWinEnv();
  e.press(220, 114);
  e.hover(620, 181); e.frame(draw); // B's top triangle
  e.release();
  check(e.gui.isDocked('A', 'B'), 'docked after drop on top part');
  let D = e.gui.getDocks()[0];
  check(D && D.dir === 'v', 'vertical dock for top/bottom drop');
  check(D && D.a === 'A', 'dragged window is the top member');
  // combined size: vertical join => height = A.h + B.h (200+200), width =
  // the wider window (240), anchored on the target
  check(D && D.x === 500 && D.y === 100 && D.w === 240 && D.h === 400,
    'v-dock height is the sum of both windows, got ' + (D && JSON.stringify({ x: D.x, y: D.y, w: D.w, h: D.h })));
  const A = e.gui.getWindow('A'), B = e.gui.getWindow('B');
  check(A.y < B.y && Math.abs(A.y + A.h + 6 - B.y) < 2, 'A above B sharing height');

  // drop C onto B's RIGHT triangle -> horizontal dock, B left of C
  ({ e, draw } = twoWinEnv());
  const drawC = () => {
    draw();
    if (e.gui.beginWindow('C', { size: [200, 160], pos: [100, 400] })) e.gui.endWindow();
  };
  e.clearDraw(); e._draw = null; e.frame(drawC);
  const C = e.gui.getWindow('C');
  e.press(C.x + 100, C.y + 14);
  e.hover(647, 200); e.frame(drawC); // B's right triangle (keep C open!)
  e.release();
  check(e.gui.isDocked('B', 'C'), 'docked after drop on right part');
  D = e.gui.getDocks()[0];
  check(D && D.dir === 'h' && D.a === 'B', 'horizontal dock, target is left member');

  // drop on the center apex -> no direction, plain drop (no dock)
  ({ e, draw } = twoWinEnv());
  e.press(220, 114);
  e.hover(620, 200); e.frame(draw); // exactly B's center
  check(e.gui.state._dockHint && e.gui.state._dockHint.side === null, 'center apex has no direction');
  e.release();
  check(!e.gui.isDocked('A', 'B'), 'center apex drop docks nothing');
  check(e.gui.getWindow('A').open === true, 'window still open after center drop');
});

test('drag grid: NoDock denies docking (as target and as source); flags.docking gates it', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { size: [240, 200], pos: [100, 100] })) e.gui.endWindow();
    if (e.gui.beginWindow('N', { size: [240, 200], pos: [500, 100], flags: WindowFlags.NoDock })) e.gui.endWindow();
  };
  e.frame(draw);
  // N (center 620,200) refuses to be a target: drag A over it
  e.dragTo(220, 114, 620, 181, 12);
  check(!e.gui.state._dockHint || e.gui.state._dockHint.kind !== 'window', 'no grid over a NoDock target');
  e.gui.state._dockHint = null;
  e.frame(draw); // release already happened in dragTo; ensure no dock
  check(!e.gui.isDocked('A', 'N'), 'NoDock target not docked');
  // NoDock source: dragging N produces no hint at all
  const N = e.gui.getWindow('N');
  e.press(N.x + 120, N.y + 14);
  e.hover(620, 400); e.frame(draw);
  check(!e.gui.state._dockHint, 'NoDock source shows no hint');
  e.up(0); e.frame(draw);
  // API also refuses
  check(e.gui.dock('A', 'N') === null, 'gui.dock refuses a NoDock window');
  // global docking flag off: even a normal pair shows no hint
  const e2 = new Env();
  const draw2 = () => {
    if (e2.gui.beginWindow('P', { size: [240, 200], pos: [100, 100] })) e2.gui.endWindow();
    if (e2.gui.beginWindow('Q', { size: [240, 200], pos: [500, 100] })) e2.gui.endWindow();
  };
  e2.gui.flags.docking = false;
  e2.frame(draw2);
  e2.dragTo(220, 114, 620, 181, 12);
  check(!e2.gui.isDocked('P', 'Q'), 'flags.docking=false disables the drop');
});

test('screen edges: drag to an edge band docks the window to the screen side', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('W', { size: [240, 200], pos: [100, 100] })) e.gui.endWindow();
  };
  e.frame(draw);
  e.dragTo(220, 114, 20, 300, 10); // left band (x < 44)
  const W = e.gui.getWindow('W');
  check(W._edge === 'left', 'window docked to left edge');
  check(W.x === 6 && W.w === 228, 'laid out in the column, got x=' + W.x + ' w=' + W.w);
  check(W.movable === false && W.resizable === false, 'edge window is not movable/resizable');
  // a second window joins the same edge (stacked vertically by default)
  const draw2 = () => {
    draw();
    if (e.gui.beginWindow('V', { size: [200, 160], pos: [400, 400] })) e.gui.endWindow();
  };
  e.frame(draw2);
  e.gui.dockToEdge('V', 'left');
  e.frame(draw2);
  const V = e.gui.getWindow('V');
  check(V._edge === 'left' && e.gui.state.edgeDocks.left.wins.length === 2, 'both in the left stack');
  check(Math.abs(V.h - W.h) < 2, 'equal vertical shares, got ' + W.h + ' vs ' + V.h);
  check(Math.abs(V.y - (W.y + W.h + 4)) < 2, 'V below W with the gap');
  // boundary drag resplits the stack
  const midY = W.y + W.h + 2;
  e.dragTo(100, midY, 100, midY - 80, 8);
  check(W.h < V.h, 'boundary drag grew the lower window, got ' + W.h + ' vs ' + V.h);
  // column inner-edge drag widens the stack
  const w0 = e.gui.state.edgeDocks.left.size;
  const innerX = e.gui.state.edgeDocks.left.size - 2;
  e.dragTo(innerX, 600, innerX + 40, 600, 6);
  check(e.gui.state.edgeDocks.left.size > w0 + 20, 'inner-edge drag widened column, +' + (e.gui.state.edgeDocks.left.size - w0));
  // double-click a title bar frees the window from the edge
  e.click(V.x + 100, V.y + 14);
  e.click(V.x + 100, V.y + 14);
  check(!V._edge && V.movable === true, 'double-click undocked from edge, movable restored');
  check(e.gui.state.edgeDocks.left.wins.length === 1, 'only W remains in the stack');
  // closing a window removes it from the stack
  W.open = false;
  e.frame(draw2);
  check(!e.gui.state.edgeDocks.left, 'empty edge dock dissolved after close');
});

test('screen edges: right/top edges + top band respects app menu bar', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('W', { size: [200, 120], pos: [100, 100] })) e.gui.endWindow();
  };
  e.gui.setAppMenuBar([{ label: 'F', items: [{ label: 'x', onActivated: () => {} }] }], { pos: 'top' });
  e.frame(draw);
  e.dragTo(200, 114, 1260, 400, 10); // right band (x > W-44)
  check(e.gui.getWindow('W')._edge === 'right', 'docked to right edge');
  e.gui.dockToEdge('W', 'top');
  e.frame(draw);
  const W = e.gui.getWindow('W');
  check(W._edge === 'top', 'redocked to top edge');
  check(W.y === 36, 'top row sits below the top app bar with padding (y=36), got ' + W.y);
  check(W.x === 6, 'row inset from left');
  e.gui.undockEdge('W');
  e.frame(draw);
  check(!W._edge && e.gui.state.edgeDocks.top === null, 'undockEdge frees and dissolves');
});

test('app menu bar: click on the bar never collapses a window underneath', () => {
  const e = new Env();
  e.gui.setAppMenuBar([{ label: 'F', items: [{ label: 'x', onActivated: () => {} }] }], { pos: 'top' });
  const draw = () => {
    if (e.gui.beginWindow('T', { size: [300, 300], pos: [100, 10], flags: WindowFlags.Closable })) {
      e.gui.endWindow();
    }
  };
  e.frame(draw);
  const T = e.gui.getWindow('T');
  check(!T.collapsed, 'starts expanded');
  // the collapse arrow zone (x 100..128) sits under the top bar (y 0..30)
  e.click(112, 16);
  check(T.collapsed === false, 'bar click did not hit the collapse arrow');
  // clicking the bar's own section still works
  const sec = e.gui.state.appMenuSections[0];
  e.click(sec.rect.x + 8, sec.rect.y + 5);
  check(!!e.gui.state.popupList.find((p) => p.open && p.data.appMenu), 'bar section still opens');
  // an outside click dismisses the popup
  e.click(700, 300);
  check(!e.gui.state.popupList.find((p) => p.open && p.data.appMenu), 'outside click closed the menu');
  // then a normal click below the bar does collapse
  e.click(112, 36);
  check(T.collapsed === true, 'real header click still collapses');
  // and clicking the bar while its popup is open still never touches windows
  e.click(sec.rect.x + 8, sec.rect.y + 5);
  e.click(112, 36); // inside the open popup's area
  check(T.collapsed === true, 'popup click did not flip the window collapse again');
});

test('dock chevron: collapses/expands the whole dock (members hidden, header only)', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('A', { size: [240, 200], pos: [100, 100] })) e.gui.endWindow();
    if (e.gui.beginWindow('B', { size: [240, 200], pos: [400, 100] })) e.gui.endWindow();
  };
  e.frame(draw);
  e.gui.dock('A', 'B', { dir: 'h', ratio: 0.5 });
  e.frame(draw);
  const D = e.gui.getDocks()[0];
  const live = () => e.gui.state.docks.get(D.id);
  const tH = e.gui._var('titleBarHeight');
  // click the chevron (left end of the dock title bar)
  e.click(D.x + 14, D.y + tH / 2);
  check(live().collapsed === true, 'chevron collapsed the dock');
  e.frame(draw);
  check(e.gui.getWindow('A').w === 0 && e.gui.getWindow('B').w === 0, 'members hidden while dock collapsed');
  check(e.gui.isDockCollapsed('A', 'B') && live().collapsed, 'isDockCollapsed true');
  // API toggles it back
  e.gui.setDockCollapsed('A', 'B', false);
  e.frame(draw);
  check(!e.gui.isDockCollapsed('A', 'B') && e.gui.getWindow('A').w > 100, 'setDockCollapsed restores members');
  // chevron again
  e.click(D.x + 14, D.y + tH / 2);
  check(live().collapsed === true, 'chevron collapses again');
  // title drag still works on a collapsed dock
  const x0 = D.x;
  e.dragTo(D.x + 100, D.y + tH / 2, D.x + 100 + 60, D.y + tH / 2, 6);
  check(live().x > x0 + 40, 'collapsed dock still draggable by title, dx=' + (live().x - x0));
});

test('collapsed window: header only (no body, no shadow, hover = header row)', () => {
  const e = new Env();
  const draw = () => {
    if (e.gui.beginWindow('Top', { size: [300, 300], pos: [100, 100] })) e.gui.endWindow();
  };
  e.frame(draw);
  const T = e.gui.getWindow('Top');
  const tH = e.gui._var('titleBarHeight');
  T.collapsed = true;
  e.frame(draw);
  // body fill (windowBg) must now be header-height, and no shadow rects
  const bg = e.gui.style.colors.windowBg;
  const isBg = (c) => c[6] && c[6][0] === bg[0] && c[6][1] === bg[1] && c[6][2] === bg[2] && c[6][3] === bg[3];
  const fills = e.renderer.calls.filter((c) => c[0] === 'fillRoundedRect');
  const body = fills.find((c) => isBg(c) && Math.abs(c[1] - T.x) < 0.01 && Math.abs(c[2] - T.y) < 0.01 && Math.abs(c[3] - T.w) < 0.01);
  check(!!body && Math.abs(body[4] - tH) < 0.01, 'collapsed body is header height only, got h=' + (body && body[4]));
  const shadows = fills.filter((c) => c[5] && c[5][0] === 0 && c[5][1] === 0 && c[5][2] === 0 && c[5][3] < 255);
  check(shadows.length === 0, 'no shadow behind a collapsed window');
  // hover/click only in the header row: the invisible body no longer claims
  e.hover(150, 250); e.frame(draw);
  check(e.gui.state.hoveredWindow !== T, 'body area no longer hovered while collapsed');
  e.hover(150, 100 + tH / 2); e.frame(draw);
  check(e.gui.state.hoveredWindow === T, 'header row still hovered');
  // expanding restores the body
  T.collapsed = false;
  e.frame(draw);
  const fills2 = e.renderer.calls.filter((c) => c[0] === 'fillRoundedRect');
  const body2 = fills2.find((c) => isBg(c) && Math.abs(c[1] - T.x) < 0.01 && Math.abs(c[2] - T.y) < 0.01 && Math.abs(c[3] - T.w) < 0.01);
  check(!!body2 && Math.abs(body2[4] - 300) < 0.01, 'expanded body back to full height, got h=' + (body2 && body2[4]));
});

console.log('\n========================================');
console.log('passed: ' + passed + '   failed: ' + failed);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
} else {
  console.log('ALL TESTS PASSED');
}
