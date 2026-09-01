/* Node stub test for the p5.js backend.
 * Uses a fake p5 instance (recording drawing calls, fake context, fake keys)
 * to verify P5Renderer + P5Input and to drive the real GUI end-to-end. */
'use strict';

require('../mim.js');
const { P5Renderer, P5Input } = require('../demo/p5-backend.js');
const { GUI, Layers, WindowFlags } = global.Mim;

let passed = 0, failed = 0;
const failures = [];
function check(cond, msg) {
  if (cond) passed++;
  else { failed++; failures.push(msg); console.error('  FAIL: ' + msg); }
}

/* ------------------------- fake p5 instance ---------------------------- */

function makeFakeP5() {
  const calls = [];
  const ctxOps = [];
  const keyCodes = new Set();

  const p5 = {
    width: 960, height: 540,
    mouseX: -100, mouseY: -100,
    mouseIsDown: false,
    mouseButton: undefined,
    drawingContext: {
      save: () => ctxOps.push('save'),
      restore: () => ctxOps.push('restore'),
      beginPath: () => ctxOps.push('beginPath'),
      rect: (...a) => ctxOps.push(['rect', ...a]),
      clip: () => ctxOps.push('clip'),
    },
    // p5 constants
    LEFT: 'LEFT', RIGHT: 'RIGHT', CENTER: 'CENTER',
    CLOSE: 'CLOSE', CENTER_ELL: 'CENTER',
    TAB: 9, ENTER: 13, ESCAPE: 27, BACKSPACE: 8, DELETE: 46,
    HOME: 36, END: 35, PAGE_UP: 33, PAGE_DOWN: 34,
    LEFT_ARROW: 37, RIGHT_ARROW: 39, UP_ARROW: 38, DOWN_ARROW: 40,
    SHIFT: 16, CONTROL: 17, ALT: 18,
    LEFT: 'LEFT', TOP: 'TOP',
    // drawing API
    color: (r, g, b, a) => [r, g, b, a == null ? 255 : a],
    fill: (c) => calls.push(['fill', c]),
    noFill: () => calls.push(['noFill']),
    stroke: (c) => calls.push(['stroke', c]),
    noStroke: () => calls.push(['noStroke']),
    strokeWeight: (w) => calls.push(['strokeWeight', w]),
    rect: (...a) => calls.push(['rect', ...a]),
    line: (...a) => calls.push(['line', ...a]),
    beginShape: () => calls.push(['beginShape']),
    endShape: (m) => calls.push(['endShape', m]),
    vertex: (x, y) => calls.push(['vertex', x, y]),
    ellipse: (...a) => calls.push(['ellipse', ...a]),
    ellipseMode: (m) => calls.push(['ellipseMode', m]),
    image: (...a) => calls.push(['image', ...a]),
    tint: (...a) => calls.push(['tint', ...a]),
    noTint: () => calls.push(['noTint']),
    text: (...a) => calls.push(['text', ...a]),
    textFont: (f) => calls.push(['textFont', f]),
    textSize: (s) => calls.push(['textSize', s]),
    textAlign: (h, v) => calls.push(['textAlign', h, v]),
    textBaseline: (b) => calls.push(['textBaseline', b]),
    textWidth: (s) => Math.round(String(s).length * 7.8),
    isKeyDown: (code) => keyCodes.has(code),
    // test helpers
    __calls: calls,
    __ctxOps: ctxOps,
    __keys: keyCodes,
    __down: (code) => keyCodes.add(code),
    __up: (code) => keyCodes.delete(code),
  };
  return p5;
}

/* --------------------------- renderer tests ---------------------------- */

console.log('• P5Renderer maps primitives to p5 calls');
{
  const p5 = makeFakeP5();
  const r = new P5Renderer(p5, {});
  r.beginFrame(960, 540);
  r.fillRect(10, 20, 100, 50, [1, 2, 3, 255]);
  r.fillRoundedRect(10, 20, 100, 50, 8, [4, 5, 6, 255]);
  r.strokeRect(0, 0, 50, 50, [9, 9, 9, 255], 2);
  r.strokeRoundedRect(0, 0, 50, 50, 8, [9, 9, 9, 255], 2);
  r.line(0, 0, 10, 10, [7, 7, 7, 255], 1.5);
  r.polyline([0, 0, 10, 10, 20, 0], [6, 6, 6, 255], 2);
  r.fillPolygon([0, 0, 10, 0, 5, 10], [5, 5, 5, 255]);
  r.fillCircle(50, 50, 10, [3, 3, 3, 255]);
  r.fillEllipse(50, 50, 20, 10, [2, 2, 2, 255]);
  r.drawImage('missing', 0, 0, 32, 32);
  r.drawText(5, 5, 'hi', [10, 10, 10, 255], { fontSize: 12 });
  const m = r.textSize('hello', { fontSize: 12 });
  r.endFrame();
  const c = p5.__calls;
  check(c.some((x) => x[0] === 'rect' && x[1] === 10 && x[2] === 20 && x[3] === 100), 'fillRect -> p5.rect');
  check(c.some((x) => x[0] === 'rect' && x[5] === 8), 'fillRoundedRect -> rounded p5.rect');
  check(c.some((x) => x[0] === 'fill' && x[1][0] === 4 && x[1][1] === 5), 'colors forwarded as [r,g,b,a]');
  check(c.some((x) => x[0] === 'line'), 'line forwarded');
  check(c.filter((x) => x[0] === 'vertex').length >= 5, 'polyline vertices forwarded');
  check(c.some((x) => x[0] === 'endShape' && x[1] === 'CLOSE'), 'polygon closed');
  check(c.some((x) => x[0] === 'ellipse' && x[1] === 50 && x[2] === 50), 'circle -> centered ellipse');
  check(c.some((x) => x[0] === 'image' && x[1] === 'missing') === false, 'missing image skipped (placeholder)');
  check(c.some((x) => x[0] === 'text' && x[1] === 'hi'), 'text drawn');
  check(c.some((x) => x[0] === 'textBaseline' && x[1] === 'TOP'), 'text baseline TOP for layout');
  check(m.w > 0 && m.h > 0, 'textSize measures');
}

console.log('• P5Renderer push/pop clip uses the 2D context');
{
  const p5 = makeFakeP5();
  const r = new P5Renderer(p5, {});
  r.pushClip(0, 0, 100, 100);
  r.pushClip(10, 10, 50, 50);
  r.popClip();
  r.popClip();
  const ops = p5.__ctxOps;
  const saves = ops.filter((o) => o === 'save').length;
  const restores = ops.filter((o) => o === 'restore').length;
  check(saves === 2 && restores === 2, 'clip save/restore balanced');
  check(ops.some((o) => o === 'clip'), 'ctx.clip called');
}

console.log('• P5Input normalizes p5 state');
{
  const p5 = makeFakeP5();
  const input = new P5Input(p5);
  p5.mouseX = 111; p5.mouseY = 222;
  p5.mouseIsDown = true; p5.mouseButton = p5.RIGHT;
  input.keyDown({ key: ' ' });
  input.keyTyped('h'); input.keyTyped('i');
  input.mouseWheel({ delta: -100, deltaX: 30 });
  p5.__down(p5.TAB);
  p5.__down(p5.CONTROL);
  const s1 = input.snapshot();
  check(s1.mouse.x === 111 && s1.mouse.y === 222, 'mouse pos');
  check(s1.mouse.buttons[1] === true && s1.mouse.buttons[0] === false, 'right button mapped');
  check(s1.keys.has('tab') && s1.keys.has('ctrl') && s1.keys.has(' '), 'key tokens incl. space');
  check(s1.text === 'hi', 'typed text accumulated');
  check(s1.mouse.wheelY < 0, 'wheel up is negative (Mim: positive wheelY = down), got ' + s1.mouse.wheelY);
  check(s1.mouse.wheelX > 0, 'wheelX forwarded');
  const s2 = input.snapshot();
  check(s2.text === '' && s2.mouse.wheelY === 0, 'wheel/text consumed after snapshot');
}

/* ----------------------- end-to-end with GUI --------------------------- */

console.log('• GUI + P5Renderer runs headless and responds to clicks');
{
  const p5 = makeFakeP5();
  const renderer = new P5Renderer(p5, {});
  const input = new P5Input(p5);
  const gui = new GUI(renderer, { flags: { animations: false } });
  let clicks = 0;
  let btn = null;
  const draw = () => {
    if (gui.beginWindow('T', { size: [260, 140] })) {
      if (gui.button('Go')) clicks++;
      if (!btn) btn = Object.assign({}, gui.lastItemRect());
      gui.dummy(10, 10);
      gui.endWindow();
    }
  };
  const frame = () => { gui.beginFrame(input.snapshot()); draw(); gui.endFrame(); };
  frame();
  check(btn && btn.w > 0, 'button rect captured, got ' + JSON.stringify(btn));
  // hover + press + release over the button
  p5.mouseX = btn.x + btn.w / 2;
  p5.mouseY = btn.y + btn.h / 2;
  p5.mouseIsDown = true; p5.mouseButton = p5.LEFT;
  frame();
  p5.mouseIsDown = false; p5.mouseButton = undefined;
  frame();
  check(clicks === 1, 'button clicked via p5 input, got ' + clicks);
  check(p5.__calls.some((x) => x[0] === 'text' && x[1] === 'T'), 'window title drawn through p5');
}

console.log('• P5Renderer advertises features and drives the CSS cursor');
{
  const p5 = makeFakeP5();
  const elt = { style: {} };
  const renderer = new P5Renderer(p5, { canvas: elt });
  const input = new P5Input(p5);
  const gui = new GUI(renderer, { flags: { animations: false } });
  let btn = null;
  const draw = () => {
    if (gui.beginWindow('C', { size: [240, 120] })) {
      if (gui.button('Go')) {}
      btn = gui.lastItemRect();
      gui.endWindow();
    }
  };
  const frame = () => { gui.beginFrame(input.snapshot()); draw(); gui.endFrame(); };
  frame();
  check(renderer.features && renderer.features.cursor === true, 'features.cursor advertised');
  p5.mouseX = btn.x + btn.w / 2; p5.mouseY = btn.y + btn.h / 2;
  frame();
  check(elt.style.cursor === 'pointer', 'cursor set to pointer over button, got ' + elt.style.cursor);
  p5.mouseX = 5; p5.mouseY = 500;
  frame();
  check(elt.style.cursor === 'default', 'cursor back to default, got ' + elt.style.cursor);
  // without a canvas element the feature is off
  const renderer2 = new P5Renderer(makeFakeP5(), {});
  check(renderer2.features.cursor === false, 'no canvas -> cursor feature off');
}

/* ------------------------------ results -------------------------------- */

console.log('\n========================================');
console.log('passed: ' + passed + '   failed: ' + failed);
if (failed) {
  console.log('\nFailures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
} else {
  console.log('ALL P5 BACKEND TESTS PASSED');
}
