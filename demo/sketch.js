/* ============================================================================
 * Mim canvas demo - plain HTML5 canvas
 * ========================================================================== */
(function () {
    'use strict';

    const canvas = document.getElementById('gui-canvas');
    const ctx = canvas.getContext('2d');

    /* ------------------------------ state --------------------------------- */

    let renderer = null;
    let input = null;
    let gui = null;
    const t0 = performance.now();

    const settings = {
        theme: 0,
        tooltips: true,
        animations: true,
        rightClickNumeric: true,
        windowContextMenu: true,
        keyboardNavigation: true,
        resizeBarProximity: 8,
        debug: false,
    };

    let checked = true;
    let radioSel = 1;
    let sliderV = 0.35;
    let sliderIntV = 42;
    let dragV = 12.5;
    let intInput = 7;
    let floatInput = 1.25;
    let name = 'Mim';
    let comboIdx = 1;
    let listSel = 1;
    let selectableOn = true;
    let modalOpen = false;
    let autoTextLines = 3;
    let winRounding = 8;
    let frameRounding = 5;
    let winBorder = 1;

    const fruits = ['Apple', 'Banana', 'Cherry', 'Date', 'Elderberry', 'Fig'];
    const listItems = Array.from({ length: 30 }, (_, i) => 'Option ' + (i + 1));
    const plotData = [0.2, 0.5, 0.35, 0.8, 0.55, 0.9, 0.4, 0.65, 0.3, 0.75, 0.5, 0.85];

    /* demo data for the addons window */
    const tableRows = [];
    for (let i = 0; i < 24; i++) {
        tableRows.push({
            name: 'node-' + String(i + 1).padStart(2, '0'),
            load: Math.round(8 + Math.sin(i * 1.7) * 40 + 45 + (i % 7) * 2),
            temp: 34 + ((i * 13) % 47),
        });
    }
    const heatData = [];
    for (let i = 0; i < 10; i++) {
        const row = [];
        for (let j = 0; j < 16; j++) row.push(Math.sin(i * 0.65) * Math.cos(j * 0.42));
        heatData.push(row);
    }
    const barData = [12, 28, 19, -6, 34, 22, 41, 27];
    const seriesData = [
        { name: 'cpu', values: plotData },
        { name: 'mem', values: plotData.map((v) => 1 - v * 0.8) },
    ];
    /* global style editor state (published to gui.style every frame) */
    const styleCols = { windowBg: null, titleBg: null, border: null, frameBg: null };
    const styleVars = { windowRounding: 8, titleRounding: 8, windowBorder: 1, shadow: true };
    const logs = [];
    function log(msg) {
        logs.push(msg);
        if (logs.length > 40) logs.shift();
    }

    const allWindowTitles = [
        'Playground',
        'Layout',
        'Custom drawing',
        'Settings',
        'Styled',
        'AutoResize',
        'Addons',
        'Inspector',
        'Console',
        'Style',
    ];
    function toggleWindow(t) {
        const w = gui.getWindow(t);
        if (w) w.open = !w.open;
    }
    function setAllWindows(open) {
        for (const t of allWindowTitles) {
            const w = gui.getWindow(t);
            if (w) w.open = open;
        }
    }
    function saveLayout() {
        const data = {};
        for (const t of allWindowTitles) {
            const st = gui.state.windowStates.get(t);
            if (st)
                data[t] = [Math.round(st.x), Math.round(st.y), Math.round(st.w), Math.round(st.h)];
        }
        try {
            navigator.clipboard && navigator.clipboard.writeText(JSON.stringify(data, null, 2));
        } catch (e) {
            /* ignore */
        }
        log('layout saved to clipboard (File > Save)');
    }
    function setupAppMenuBar() {
        gui.setAppMenuBar(
            [
                {
                    label: 'File',
                    items: [
                        {
                            label: 'Save layout',
                            shortcut: 'ctrl+s',
                            key: 's',
                            keyMod: ['ctrl'],
                            onActivated: saveLayout,
                        },
                        { sep: true },
                        {
                            label: 'Open all windows',
                            onActivated: () => {
                                setAllWindows(true);
                                log('opened all windows');
                            },
                        },
                        {
                            label: 'Hide all windows',
                            onActivated: () => {
                                setAllWindows(false);
                                log('hid all windows');
                            },
                        },
                    ],
                },
                {
                    label: 'Windows',
                    items: allWindowTitles.map((t) => ({
                        label: t,
                        selected: () => !!gui.getWindow(t) && gui.isWindowOpen(t),
                        onActivated: () => {
                            toggleWindow(t);
                            log((gui.isWindowOpen(t) ? 'show ' : 'hide ') + t);
                        },
                    })),
                },
                {
                    label: 'Layout',
                    items: [
                        {
                            label: 'Dock Inspector + Console',
                            selected: () => gui.isDocked('Inspector', 'Console'),
                            onActivated: () => {
                                if (!gui.isDocked('Inspector', 'Console')) {
                                    gui.dock('Inspector', 'Console', {
                                        dir: 'h',
                                        ratio: 0.5,
                                        pos: [24, 488],
                                        size: [356, 170],
                                    });
                                    log('docked Inspector + Console');
                                }
                            },
                        },
                        {
                            label: 'Undock',
                            onActivated: () => {
                                if (gui.undock('Inspector', 'Console'))
                                    log('undocked Inspector + Console');
                            },
                        },
                        { sep: true },
                        {
                            label: 'Screen dock: Addons \u2192 left edge',
                            selected: () => {
                                const w = gui.getWindow('Addons');
                                return !!(w && w._edge === 'left');
                            },
                            onActivated: () => {
                                if (gui.dockToEdge('Addons', 'left'))
                                    log('Addons docked to left screen edge');
                            },
                        },
                        {
                            label: 'Screen undock: Addons',
                            onActivated: () => {
                                if (gui.undockEdge('Addons'))
                                    log('Addons freed from the screen edge');
                            },
                        },
                        { sep: true },
                        {
                            label: 'Docking (drag grids + screen edges)',
                            selected: () => gui.flags.docking,
                            onActivated: () => {
                                gui.flags.docking = !gui.flags.docking;
                                log('interactive docking ' + (gui.flags.docking ? 'on' : 'off'));
                            },
                        },
                    ],
                },
                {
                    label: 'Settings',
                    items: [
                        {
                            label: 'Edit Preferences',
                            onActivated: () => {
                                toggleWindow('Settings');
                                log('opened Settings');
                            },
                        },
                        {
                            label: 'Toggle theme',
                            onActivated: () => {
                                settings.theme = settings.theme ? 0 : 1;
                                applyTheme();
                            },
                        },
                    ],
                },
            ],
            { pos: 'top' },
        );
    }

    /* ------------------------------ setup --------------------------------- */

    function makeChecker() {
        const c = document.createElement('canvas');
        c.width = 64;
        c.height = 64;
        const g = c.getContext('2d');
        for (let i = 0; i < 8; i++) {
            for (let j = 0; j < 8; j++) {
                g.fillStyle = (i + j) % 2 === 0 ? '#ebe6dc' : '#282a3a';
                g.fillRect(i * 8, j * 8, 8, 8);
            }
        }
        return c;
    }

    function resize() {
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.max(1, Math.floor(window.innerWidth * dpr));
        canvas.height = Math.max(1, Math.floor(window.innerHeight * dpr));
        canvas.style.width = window.innerWidth + 'px';
        canvas.style.height = window.innerHeight + 'px';
        renderer.dpr = dpr;
    }

    function syncSettingsToGui() {
        if (!gui) return;
        gui.flags.tooltips = settings.tooltips;
        gui.flags.rightClickNumeric = settings.rightClickNumeric;
        gui.flags.windowContextMenu = settings.windowContextMenu;
        gui.flags.keyboardNavigation = settings.keyboardNavigation;
        gui.flags.resizeBarProximity = settings.resizeBarProximity;
        gui.flags.animations = settings.animations;
        gui.debugOverlay = settings.debug;
    }

    function applyTheme() {
        if (!gui) return;
        gui.setTheme(settings.theme === 0 ? 'dark' : 'light');
    }

    /* ------------------------------ windows ------------------------------- */

    function drawPlayground() {
        if (!gui.beginWindow('Playground', { size: [340, 430], pos: [24, 40] })) return;
        gui.text('Widgets — drag sliders, right-click for exact entry');
        gui.separator();

        if (gui.button('Press me')) gui.setTooltip('Buttons return true when clicked');
        gui.sameLine(8);
        gui.smallButton('sm');
        gui.sameLine(); // no args: the style's horizontal item spacing is used
        gui.text('default gap');
        if (gui.button('Toast success'))
            gui.addons.notifs.toast('mim notifications work', { type: 'success' });
        gui.sameLine(12);
        if (gui.button('Toast error'))
            gui.addons.notifs.toast('something went wrong', { type: 'error' });

        checked = gui.checkbox('checked', checked);
        radioSel = gui.radioButton('radio one', radioSel, 0);
        radioSel = gui.radioButton('radio two', radioSel, 1);
        radioSel = gui.radioButton('radio three', radioSel, 2);

        sliderV = gui.sliderFloat('slider float', sliderV, 0, 1);
        sliderIntV = gui.sliderInt('slider int', sliderIntV, 0, 100);
        dragV = gui.dragFloat('drag float', dragV, 0.5, 0, 100);

        intInput = gui.inputInt('input int', intInput, { min: 0, max: 99 });
        floatInput = gui.inputFloat('input float', floatInput, { min: -10, max: 10 });
        name = gui.inputText('input text', name);

        comboIdx = gui.combo('combo', comboIdx, fruits);
        if (gui.selectable('selectable (click to toggle)', selectableOn))
            selectableOn = !selectableOn;

        const t = (performance.now() - t0) * 0.001;
        const progress = 0.45 + 0.3 * Math.sin(t * 1.2);
        gui.progressBar(progress);

        if (gui.collapsingHeader('collapsing header')) {
            gui.text('inside the header');
            gui.textWrapped(
                'Immediate mode GUIs redraw everything every frame; state lives in the library, keyed by ids — not in the view. Duplicate labels are fine.',
                { maxWidth: 260 },
            );
        }

        if (gui.beginChild('scrollable child', { h: 140 })) {
            for (let i = 0; i < 60; i++) {
                gui.text('row ' + (i + 1).toString().padStart(2, '0'));
                if (i % 10 === 9) gui.separator();
            }
            gui.endChild();
        }

        gui.image('checker', 48, 48);
        gui.sameLine(16);
        // plot takes the remaining row width, so it scales with the window
        gui.setNextItemWidth(Math.max(60, gui.getRegionAvail().w - 64));
        gui.plotLines('plot', plotData, { overlay: '0.00\u20131.00' });

        gui.endWindow();
    }

    function drawLayout() {
        if (!gui.beginWindow('Layout', { size: [360, 344], pos: [384, 40] })) return;

        gui.beginTabBar('layout-tabs');
        if (gui.beginTabItem('Tabs')) {
            gui.text('Tab content A');
            gui.sliderFloat('local slider', null, 0, 1); // stateful: the library keeps the value
            listSel = gui.listBox('list box', listSel, listItems, { rows: 5 });
            gui.text('selected: ' + listItems[listSel]);
            gui.endTabItem();
        }
        if (gui.beginTabItem('Tree')) {
            if (gui.treeNode('root')) {
                gui.text('child text');
                if (gui.treeNode('nested')) {
                    gui.text('deep');
                    gui.treePop();
                }
                gui.treePop();
            }
            gui.endTabItem();
        }
        if (gui.beginTabItem('Table')) {
            if (gui.beginTable('files', 3, { colWidths: [150, 80, 0] })) {
                gui.tableHeader(['Name', 'Size', 'Kind']);
                gui.tableRow(['mim.js', '3.5k lines', 'GUI']);
                gui.tableRow(['canvas-backend.js', '250 lines', 'adapter']);
                gui.tableRow(['sketch.js', 'demo', 'app']);
                gui.endTable();
            }
            gui.endTabItem();
        }
        gui.endTabBar();

        gui.separator();
        gui.beginGroup();
        gui.text('group line 1');
        gui.text('group line 2');
        gui.endGroup();
        gui.sameLine(16);
        gui.text('after group (same line)');

        gui.endWindow();
    }

    function drawCustomDrawing() {
        if (!gui.beginWindow('Custom drawing', { size: [256, 160], pos: [1000, 386] })) return;
        gui.text('Drawn with the exposed renderer, clipped to this window:');
        gui.dummy(10, 6);

        const r = gui.renderer;
        const x0 = 14,
            y0 = 12;
        const t = (performance.now() - t0) * 0.03;
        r.fillCircle(x0 + 50, y0 + 50, 24 + 6 * Math.sin(t), [255, 90, 90, 255]);
        r.strokeRoundedRect(x0 + 108, y0 + 26, 86, 48, 8, [90, 200, 255, 255], 2);
        r.polyline(
            [x0, y0 + 96, x0 + 40, y0 + 66, x0 + 80, y0 + 90, x0 + 120, y0 + 56, x0 + 160, y0 + 82],
            [140, 255, 160, 255],
            2,
        );
        r.fillPolygon(
            [x0 + 188, y0 + 50, x0 + 213, y0 + 85, x0 + 238, y0 + 50],
            [255, 200, 80, 255],
        );
        r.fillRoundedRect(x0 + 248, y0 + 40, 30, 30, 6, [200, 140, 255, 255]);
        r.line(x0, y0 + 106, x0 + 280, y0 + 106, [120, 120, 130, 255], 1);
        r.drawText(
            x0 + 2,
            y0 + 114,
            'layer: gui — drag this window while it animates',
            [200, 200, 210, 255],
            { fontSize: 12 },
        );

        gui.dummy(10, 34);
        gui.text('Everything above is user drawing, not a widget.');
        gui.endWindow();
    }

    function drawSettings() {
        if (!gui.beginWindow('Settings', { size: [300, 310], pos: [384, 400] })) return;

        settings.theme = gui.combo('theme', settings.theme, ['Dark', 'Light']);
        applyTheme();

        gui.separatorText('UX toggles (live)');
        settings.tooltips = gui.checkbox('tooltips', settings.tooltips);
        settings.animations = gui.checkbox('animations', settings.animations);
        settings.rightClickNumeric = gui.checkbox(
            'right-click numeric entry',
            settings.rightClickNumeric,
        );
        settings.windowContextMenu = gui.checkbox(
            'window context menus (right-click titles)',
            settings.windowContextMenu,
        );
        settings.keyboardNavigation = gui.checkbox(
            'keyboard navigation (Tab / Enter / arrows)',
            settings.keyboardNavigation,
        );
        settings.resizeBarProximity = gui.sliderInt(
            'resize bar proximity (0 = off)',
            settings.resizeBarProximity,
            0,
            16,
        );
        settings.debug = gui.checkbox('debug overlay', settings.debug);
        syncSettingsToGui();

        gui.separatorText('Try the new interactions');
        gui.textWrapped('idk click on stuff', { color: [160, 165, 175, 255] });

        gui.separatorText('Live style (push / pop per frame)');
        gui.pushStyleVar('windowRounding', winRounding);
        winRounding = gui.sliderInt('window rounding', winRounding, 0, 24);
        gui.pushStyleVar('frameRounding', frameRounding);
        frameRounding = gui.sliderInt('frame rounding', frameRounding, 0, 16);
        gui.pushStyleVar('windowBorder', winBorder);
        winBorder = gui.sliderInt('window border', winBorder, 0, 3);
        gui.popStyleVar(3);

        gui.separatorText('Windows');
        if (gui.button('Open modal')) modalOpen = true;
        gui.sameLine(12);
        gui.setNextItemWidth(130);
        autoTextLines = gui.sliderInt('auto window lines', autoTextLines, 1, 8);

        gui.dummy(10, 4);
        gui.text('The "Styled" window shows per-window style overrides.', [160, 165, 175, 255]);
        gui.endWindow();
    }

    function drawStyled() {
        if (
            !gui.beginWindow('Styled', {
                size: [228, 120],
                pos: [764, 386],
                flags: Mim.WindowFlags.NoDock,
                style: {
                    bg: [18, 44, 92, 255],
                    titleBg: [24, 58, 120, 255],
                    titleBgActive: [30, 70, 148, 255],
                    border: [120, 170, 255, 255],
                    rounding: 16,
                    titleRounding: 16,
                    borderWidth: 2,
                },
            })
        )
            return;
        gui.text('Per-window style:');
        gui.text('bg, borders, rounding…');
        gui.text('NoDock flag: drag me over');
        gui.text('anything — no dock grid appears');
        gui.checkbox('works', null);
        gui.endWindow();
    }

    function drawAuto() {
        if (!gui.beginWindow('AutoResize', { flags: Mim.WindowFlags.AutoResize, pos: [24, 664] }))
            return;
        for (let i = 0; i < autoTextLines; i++)
            gui.text('line ' + (i + 1) + ' — window sizes itself');
        gui.endWindow();
    }

    /* Global style editor: every change is published to gui.style each frame,
     * so the WHOLE app re-themes live. The picker/color widgets come from
     * addons/mim_color.js. */
    function drawStyle() {
        if (!gui.beginWindow('Style', { size: [300, 258], pos: [700, 452] })) return;
        const C = gui.addons.color;
        if (!styleCols.windowBg) {
            styleCols.windowBg = gui.style.colors.windowBg.slice();
            styleCols.titleBg = gui.style.colors.titleBg.slice();
            styleCols.border = gui.style.colors.border.slice();
            styleCols.frameBg = gui.style.colors.frameBg.slice();
        }
        gui.text('Global style — edits apply live');
        gui.separator();
        const th = gui.combo('theme', settings.theme, ['dark', 'light']);
        if (th !== settings.theme) {
            settings.theme = th;
            gui.setTheme(th === 0 ? 'dark' : 'light');
            styleCols.windowBg = gui.style.colors.windowBg.slice();
            styleCols.titleBg = gui.style.colors.titleBg.slice();
            styleCols.border = gui.style.colors.border.slice();
            styleCols.frameBg = gui.style.colors.frameBg.slice();
        }
        const halfW = gui.getRegionAvail().w * 0.485;
        styleCols.windowBg = C.colorButton('window bg', styleCols.windowBg, {
            w: halfW,
            presets: false,
        });
        gui.sameLine(12);
        styleCols.titleBg = C.colorButton('title bg', styleCols.titleBg, {
            w: halfW,
            presets: false,
        });
        styleCols.border = C.colorButton('border', styleCols.border, { w: halfW, presets: false });
        gui.sameLine(12);
        styleCols.frameBg = C.colorButton('frame bg', styleCols.frameBg, {
            w: halfW,
            presets: false,
        });
        styleVars.windowRounding = gui.sliderInt(
            'window rounding',
            styleVars.windowRounding,
            0,
            24,
        );
        styleVars.titleRounding = gui.sliderInt('title rounding', styleVars.titleRounding, 0, 24);
        styleVars.windowBorder = gui.sliderInt('window border', styleVars.windowBorder, 0, 4);
        styleVars.shadow = gui.checkbox('shadow', styleVars.shadow);
        // publish to the global style — every frame, for every window
        gui.style.colors.windowBg = styleCols.windowBg;
        gui.style.colors.titleBg = styleCols.titleBg;
        gui.style.colors.border = styleCols.border;
        gui.style.colors.frameBg = styleCols.frameBg;
        gui.style.vars.windowRounding = styleVars.windowRounding;
        gui.style.vars.titleRounding = styleVars.titleRounding;
        gui.style.vars.windowBorder = styleVars.windowBorder;
        gui.style.vars.shadow = styleVars.shadow;
        gui.endWindow();
    }

    function drawModal() {
        if (!modalOpen) return;
        if (
            !gui.beginWindow('Modal', {
                flags:
                    Mim.WindowFlags.Modal |
                    Mim.WindowFlags.AlwaysOnTop |
                    Mim.WindowFlags.Closable |
                    Mim.WindowFlags.FixedSize,
                size: [260, 140],
                onClose: () => {
                    modalOpen = false;
                },
            })
        ) {
            modalOpen = false;
            return;
        }
        gui.textWrapped(
            'This modal blocks the windows it covers. A window drawn above it (AlwaysOnTop) stays clickable.',
        );
        gui.dummy(10, 4);
        if (gui.button('Close')) modalOpen = false;
        gui.endWindow();
    }

    function drawInspector() {
        if (!gui.beginWindow('Inspector', { size: [178, 170], pos: [24, 488] })) return;
        const s = gui.state;
        gui.text('hovered: ' + (s.hoveredWindow ? s.hoveredWindow.title : '—'));
        gui.text('top window: ' + (s.zOrder.length ? s.zOrder[s.zOrder.length - 1].title : '—'));
        gui.text('windows: ' + s.zOrder.length + '    docks: ' + s.docks.size);
        gui.text('fps: ' + Math.round(s.stats.fps) + '    ' + s.stats.ms.toFixed(2) + ' ms');
        gui.separator();
        if (gui.button('Clear console')) logs.length = 0;
        gui.endWindow();
    }

    function drawConsole() {
        if (!gui.beginWindow('Console', { size: [178, 170], pos: [212, 488] })) return;
        if (gui.beginChild('##consolebody', { h: 132 })) {
            if (logs.length === 0) gui.text('(empty)', [120, 122, 130, 255]);
            for (let i = logs.length - 1; i >= 0; i--) gui.text(logs[i]);
        }
        gui.endChild();
        gui.endWindow();
    }

    function drawAddons() {
        if (!gui.beginWindow('Addons', { size: [492, 330], pos: [764, 40] })) return;
        gui.text('Addons (mim_plots.js / mim_3d.js / mim_tables.js)');
        gui.beginTabBar('addon-tabs');
        if (gui.beginTabItem('Curves')) {
            gui.addons.plots.plotBezier(
                'bezier — drag the dots (points rescale with the window)',
                null,
                { share: 2 },
            );
            gui.addons.plots.plotPolar('polar rose', (t) => 0.5 + 0.45 * Math.sin(4 * t), {
                share: 2,
            });
            gui.endTabItem();
        }
        if (gui.beginTabItem('Data')) {
            gui.addons.plots.plotBars('bars — hover a bar (negatives hang below zero)', barData, {
                share: 2,
            });
            gui.addons.plots.plotSeries('two series — hover for values', seriesData, { share: 2 });
            gui.endTabItem();
        }
        if (gui.beginTabItem('3D')) {
            gui.addons.t3d.plot3D(
                'surface z = sin(2x)·cos(2y) — drag to rotate, wheel zooms',
                (x, y) => Math.sin(2 * x) * Math.cos(2 * y),
                { share: 1 },
            );
            gui.endTabItem();
        }
        if (gui.beginTabItem('Table')) {
            gui.addons.tables.advancedTable(
                'nodes — click headers to sort, click rows to select',
                [
                    { id: 'name', label: 'Name', width: 120 },
                    { id: 'load', label: 'Load %', width: 80, align: 'right' },
                    { id: 'temp', label: 'Temp °C', width: 80, align: 'right' },
                ],
                tableRows,
                { share: 1 },
            );
            gui.endTabItem();
        }
        if (gui.beginTabItem('Heatmap')) {
            gui.addons.plots.plotHeatmap('field — 10×16 values', heatData, { share: 1 });
            gui.endTabItem();
        }
        gui.endTabBar();
        gui.endWindow();
    }

    /* -------------------------------- loop --------------------------------- */

    function loop() {
        gui.beginFrame(input.snapshot());

        // background layer: grid drawn before all windows
        gui.layer(Mim.Layers.Background, (r) => {
            const w = canvas.clientWidth,
                h = canvas.clientHeight;
            r.fillRect(0, 0, w, h, settings.theme === 0 ? [15, 16, 20, 255] : [238, 238, 242, 255]);
            const grid = settings.theme === 0 ? [255, 255, 255, 7] : [0, 0, 0, 8];
            for (let gx = 0; gx < w; gx += 32) r.line(gx, 0, gx, h, grid, 1);
            for (let gy = 0; gy < h; gy += 32) r.line(0, gy, w, gy, grid, 1);
        });

        drawPlayground();
        drawLayout();
        drawCustomDrawing();
        drawAddons();
        drawSettings();
        drawStyled();
        drawAuto();
        drawInspector();
        drawConsole();
        drawStyle();
        drawModal();

        gui.endFrame();

        // foreground layer: toasts + overlay above everything
        gui.layer(Mim.Layers.Foreground, (r) => {
            gui.addons.notifs.draw();
            if (settings.debug) {
                const w = canvas.clientWidth,
                    h = canvas.clientHeight;
                r.strokeRoundedRect(3, 3, w - 6, h - 6, 6, [255, 60, 60, 90], 3);
            }
        });

        requestAnimationFrame(loop);
    }

    /* -------------------------------- init --------------------------------- */

    renderer = new MimCanvas.CanvasRenderer(ctx, {
        dpr: window.devicePixelRatio || 1,
        canvas: canvas, // enables the setCursor feature (CSS cursor styles)
        images: { checker: makeChecker() },
    });
    input = new MimCanvas.CanvasInput(canvas);
    gui = new Mim.GUI(renderer, {
        flags: {
            animations: settings.animations,
            tooltips: settings.tooltips,
            rightClickNumeric: settings.rightClickNumeric,
            keyboardNavigation: settings.keyboardNavigation,
        },
        debugOverlay: settings.debug,
    });

    // app menu bar (top) + a docked window pair (pending until first frame)
    setupAppMenuBar();
    gui.dock('Inspector', 'Console', { dir: 'h', ratio: 0.5, pos: [24, 488], size: [356, 170] });
    log('demo ready');

    window.addEventListener('resize', resize);
    resize();
    requestAnimationFrame(loop);
})();
