/* Node stub test for the canvas-2d backend.
 * Fake ctx records draw calls; fake canvas captures DOM listeners so we can
 * synthesize mouse/keyboard events. Also drives the real GUI end-to-end. */
'use strict';

require('../mim.js');
const { CanvasRenderer, CanvasInput } = require('../demo-canvas/canvas-backend.js');
const { GUI, Layers, WindowFlags } = global.Mim;

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

/* --------------------------- fakes -------------------------------------- */

function makeFakeCtx() {
    const calls = [];
    let font = '';
    const ctx = {
        __calls: calls,
        __font: () => font,
        setTransform: (...a) => calls.push(['setTransform', ...a]),
        save: () => calls.push(['save']),
        restore: () => calls.push(['restore']),
        beginPath: () => calls.push(['beginPath']),
        rect: (...a) => calls.push(['rect', ...a]),
        clip: () => calls.push(['clip']),
        fillRect: (...a) => calls.push(['fillRect', ...a]),
        strokeRect: (...a) => calls.push(['strokeRect', ...a]),
        fill: () => calls.push(['fill']),
        stroke: () => calls.push(['stroke']),
        moveTo: (...a) => calls.push(['moveTo', ...a]),
        lineTo: (...a) => calls.push(['lineTo', ...a]),
        closePath: () => calls.push(['closePath']),
        arc: (...a) => calls.push(['arc', ...a]),
        arcTo: (...a) => calls.push(['arcTo', ...a]),
        ellipse: (...a) => calls.push(['ellipse', ...a]),
        drawImage: (...a) => calls.push(['drawImage', ...a]),
        fillText: (...a) => calls.push(['fillText', ...a]),
        measureText: (s) => ({ width: Math.round(String(s).length * 7.8) }),
        // properties
        set fillStyle(v) {
            calls.push(['fillStyle', v]);
        },
        get fillStyle() {
            return '';
        },
        set strokeStyle(v) {
            calls.push(['strokeStyle', v]);
        },
        get strokeStyle() {
            return '';
        },
        set lineWidth(v) {
            calls.push(['lineWidth', v]);
        },
        get lineWidth() {
            return 1;
        },
        set font(v) {
            font = v;
            calls.push(['font', v]);
        },
        get font() {
            return font;
        },
        set textAlign(v) {
            calls.push(['textAlign', v]);
        },
        get textAlign() {
            return 'left';
        },
        set textBaseline(v) {
            calls.push(['textBaseline', v]);
        },
        get textBaseline() {
            return 'top';
        },
        set globalCompositeOperation(v) {
            calls.push(['gco', v]);
        },
    };
    return ctx;
}

function makeFakeCanvas() {
    const handlers = { canvas: {}, win: {} };
    const winEl = {
        addEventListener: (ev, fn) => {
            handlers.win[ev] = fn;
        },
    };
    return {
        clientWidth: 960,
        clientHeight: 540,
        width: 960,
        height: 540,
        getBoundingClientRect: () => ({ left: 0, top: 0, width: 960, height: 540 }),
        addEventListener: (ev, fn) => {
            handlers.canvas[ev] = fn;
        },
        __winEl: winEl,
        __handlers: handlers,
        // dispatch helpers
        mouse(ev, obj) {
            if (handlers.canvas[ev]) handlers.canvas[ev](obj);
        },
        win(ev, obj) {
            if (handlers.win[ev]) handlers.win[ev](obj);
        },
    };
}

function evt(extra) {
    return Object.assign(
        {
            preventDefault: () => {},
            clientX: 0,
            clientY: 0,
            button: 0,
            deltaMode: 0,
            key: null,
            target: null,
        },
        extra,
    );
}

/* --------------------------- renderer tests ----------------------------- */

console.log('• CanvasRenderer maps primitives to ctx calls');
{
    const ctx = makeFakeCtx();
    const r = new CanvasRenderer(ctx, {});
    r.beginFrame(960, 540);
    r.fillRect(10, 20, 100, 50, [1, 2, 3, 128]);
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
    const c = ctx.__calls;
    check(
        c.some(
            (x) => x[0] === 'fillRect' && x[1] === 10 && x[2] === 20 && x[3] === 100 && x[4] === 50,
        ),
        'fillRect -> ctx.fillRect',
    );
    check(
        c.some((x) => x[0] === 'fillStyle' && x[1] === 'rgba(1,2,3,0.502)'),
        'colors -> rgba string with alpha',
    );
    check(
        c.some((x) => x[0] === 'arcTo'),
        'rounded rect via arcTo path (no native roundRect in fake)',
    );
    check(
        c.some((x) => x[0] === 'strokeRect'),
        'strokeRect forwarded',
    );
    check(
        c.some((x) => x[0] === 'lineTo'),
        'line forwarded',
    );
    check(c.filter((x) => x[0] === 'lineTo').length >= 4, 'polyline vertices forwarded');
    check(
        c.some((x) => x[0] === 'arc' && x[3] === 10),
        'circle -> arc',
    );
    check(
        c.some((x) => x[0] === 'ellipse' && x[1] === 50),
        'ellipse forwarded',
    );
    check(
        c.some((x) => x[0] === 'fillText' && x[1] === 'hi' && x[2] === 5 && x[3] === 5),
        'text top-left anchored',
    );
    check(
        c.some((x) => x[0] === 'textBaseline' && x[1] === 'top'),
        'textBaseline top',
    );
    check(
        c.some((x) => x[0] === 'setTransform'),
        'beginFrame sets transform (DPR)',
    );
    check(m.w > 0 && m.h > 0, 'textSize measures');
}

console.log('• CanvasRenderer push/pop clip uses save/rect/clip/restore');
{
    const ctx = makeFakeCtx();
    const r = new CanvasRenderer(ctx, {});
    r.pushClip(0, 0, 100, 100);
    r.pushClip(10, 10, 50, 50);
    r.popClip();
    r.popClip();
    const c = ctx.__calls;
    const saves = c.filter((x) => x[0] === 'save').length;
    const restores = c.filter((x) => x[0] === 'restore').length;
    check(saves === 2 && restores === 2, 'save/restore balanced');
    check(
        c.some((x) => x[0] === 'clip'),
        'ctx.clip called',
    );
}

console.log('• CanvasInput normalizes DOM events');
{
    const canvas = makeFakeCanvas();
    const input = new CanvasInput(canvas, { win: canvas.__winEl });
    canvas.win('mousemove', evt({ clientX: 111, clientY: 222 }));
    canvas.mouse('mousedown', evt({ button: 2, clientX: 111, clientY: 222 }));
    canvas.win('keydown', evt({ key: 'a' }));
    canvas.win('keydown', evt({ key: 'b' }));
    const sMid = input.snapshot();
    check(sMid.text === 'ab', 'typed text accumulated, got ' + JSON.stringify(sMid.text));
    canvas.win('keydown', evt({ key: ' ' }));
    canvas.win('keydown', evt({ key: 'Tab' }));
    canvas.mouse('wheel', evt({ deltaY: -120, deltaX: 30 }));
    const s1 = input.snapshot();
    check(s1.mouse.x === 111 && s1.mouse.y === 222, 'mouse pos from rect');
    check(s1.width === 960 && s1.height === 540, 'size from clientWidth/Height');
    check(
        s1.mouse.buttons[1] === true && s1.mouse.buttons[0] === false,
        'DOM right -> Mim right (index 1)',
    );
    check(
        s1.keys.has('tab') && s1.keys.has('a') && s1.keys.has(' '),
        'key tokens incl. space + letters',
    );
    check(s1.text === ' ', 'space arrives as a text char for the editor');
    check(
        s1.mouse.wheelY < 0,
        'wheel up is negative (Mim: positive wheelY = down), got ' + s1.mouse.wheelY,
    );
    check(s1.mouse.wheelX > 0, 'wheelX forwarded');
    canvas.win('keyup', evt({ key: 'Tab' }));
    canvas.win('mouseup', evt({ button: 2 }));
    const s2 = input.snapshot();
    check(s2.keys.has('tab') === false, 'key released');
    check(s2.mouse.buttons[1] === false, 'button released');
    check(s2.text === '' && s2.mouse.wheelY === 0, 'wheel/text consumed after snapshot');
    // outside the canvas
    canvas.win('mousemove', evt({ clientX: 5000, clientY: 5000 }));
    const s3 = input.snapshot();
    check(s3.mouse.x < -1e8, 'outside mouse reported far away (no hover)');
}

/* ----------------------- end-to-end with GUI ----------------------------- */

console.log('• GUI + CanvasRenderer runs headless and responds to clicks');
{
    const ctx = makeFakeCtx();
    const renderer = new CanvasRenderer(ctx, {});
    const canvas = makeFakeCanvas();
    const input = new CanvasInput(canvas, { win: canvas.__winEl });
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
    const frame = () => {
        gui.beginFrame(input.snapshot());
        draw();
        gui.endFrame();
    };
    frame();
    check(btn && btn.w > 0, 'button rect captured, got ' + JSON.stringify(btn));
    // hover + press + release over the button
    canvas.win('mousemove', evt({ clientX: btn.x + btn.w / 2, clientY: btn.y + btn.h / 2 }));
    canvas.mouse(
        'mousedown',
        evt({ button: 0, clientX: btn.x + btn.w / 2, clientY: btn.y + btn.h / 2 }),
    );
    frame();
    canvas.win('mouseup', evt({ button: 0 }));
    frame();
    check(clicks === 1, 'button clicked via canvas input, got ' + clicks);
    check(
        ctx.__calls.some((x) => x[0] === 'fillText' && x[1] === 'T'),
        'window title drawn through ctx',
    );
}

console.log('• scroll wheel drives a child region through the GUI');
{
    const ctx = makeFakeCtx();
    const renderer = new CanvasRenderer(ctx, {});
    const canvas = makeFakeCanvas();
    const input = new CanvasInput(canvas, { win: canvas.__winEl });
    const gui = new GUI(renderer, { flags: { animations: false } });
    const draw = () => {
        if (gui.beginWindow('S', { size: [300, 200] })) {
            if (gui.beginChild('c', { h: 100 })) {
                for (let i = 0; i < 40; i++) gui.text('row ' + i);
                gui.endChild();
            }
            gui.endWindow();
        }
    };
    const frame = () => {
        ctx.__calls.length = 0;
        gui.beginFrame(input.snapshot());
        draw();
        gui.endFrame();
    };
    frame();
    const before = ctx.__calls.filter((x) => x[0] === 'fillText' && x[1] === 'row 10');
    check(before.length === 0, 'row 10 culled before scrolling (outside child clip)');
    // hover over the child then scroll down 3 notches (100px deltaY each)
    canvas.win('mousemove', evt({ clientX: 150, clientY: 150 }));
    canvas.mouse('wheel', evt({ deltaY: 100 }));
    canvas.mouse('wheel', evt({ deltaY: 100 }));
    canvas.mouse('wheel', evt({ deltaY: 100 }));
    frame();
    const after = ctx.__calls;
    // ~120px of scroll over ~23px rows reveals the middle rows
    check(
        after.some((x) => x[0] === 'fillText' && x[1] === 'row 5'),
        'row 5 visible after scrolling down',
    );
    check(
        after.some((x) => x[0] === 'fillText' && x[1] === 'row 8'),
        'row 8 visible after scrolling down',
    );
    check(
        after.some((x) => x[0] === 'fillText' && x[1] === 'row 0') === false,
        'row 0 scrolled out of the child clip',
    );
}

console.log('• renderer advertises features and drives the CSS cursor');
{
    const ctx = makeFakeCtx();
    const fakeCanvas = makeFakeCanvas();
    fakeCanvas.style = {};
    const renderer = new CanvasRenderer(ctx, { canvas: fakeCanvas });
    const input = new CanvasInput(fakeCanvas, { win: fakeCanvas.__winEl });
    const gui = new GUI(renderer, { flags: { animations: false } });
    let btn = null;
    const draw = () => {
        if (gui.beginWindow('C', { size: [240, 120] })) {
            if (gui.button('Go')) {
            }
            btn = gui.lastItemRect();
            gui.endWindow();
        }
    };
    const frame = () => {
        gui.beginFrame(input.snapshot());
        draw();
        gui.endFrame();
    };
    frame();
    check(renderer.features && renderer.features.cursor === true, 'features.cursor advertised');
    fakeCanvas.win('mousemove', evt({ clientX: btn.x + btn.w / 2, clientY: btn.y + btn.h / 2 }));
    frame();
    check(
        fakeCanvas.style.cursor === 'pointer',
        'cursor set to pointer over button, got ' + fakeCanvas.style.cursor,
    );
    fakeCanvas.win('mousemove', evt({ clientX: 5, clientY: 500 })); // empty space
    frame();
    check(
        fakeCanvas.style.cursor === 'default',
        'cursor back to default, got ' + fakeCanvas.style.cursor,
    );
    // without a canvas element the feature is off and setCursor is never used
    const renderer2 = new CanvasRenderer(makeFakeCtx(), {});
    check(renderer2.features.cursor === false, 'no canvas -> cursor feature off');
}

/* ------------------------------ results --------------------------------- */

console.log('\n========================================');
console.log('passed: ' + passed + '   failed: ' + failed);
if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log('  - ' + f);
    process.exit(1);
} else {
    console.log('ALL CANVAS BACKEND TESTS PASSED');
}
