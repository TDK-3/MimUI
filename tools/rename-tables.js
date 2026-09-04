/* tools/rename-tables.js — the guarded rename tables shared by the two
 * source builders:
 *
 *   tools/make-expanded.js   mim.compressed.js -> mim.js     (cryptic -> detailed)
 *   tools/make-compressed.js mim.js              -> mim.compressed.js (detailed -> cryptic)
 *
 * LOCAL_RENAMES maps a cryptic scope-local name to a detailed one; `ok(init)`
 * is a structural guard on the initializer that proves the meaning, so the
 * table works in BOTH directions (the guard only inspects the init node,
 * never the name).
 * PARAM_RENAMES maps, per function/method name, cryptic parameter names to
 * detailed ones.
 */
'use strict';

const isMember = (n, propName) =>
  n && n.type === 'MemberExpression' && n.property && n.property.type === 'Identifier' && n.property.name === propName;

// guards: (initNode) -> bool. Structural, so they survive other renames.
const LOCAL_RENAMES = {
  s: {
    to: 'guiState',
    ok: (init) =>
      (init && init.type === 'MemberExpression' && init.object && init.object.type === 'ThisExpression' && init.property && init.property.name === 'state') ||
      (init && init.type === 'AssignmentExpression' && init.left && init.left.type === 'MemberExpression' && init.left.object && init.left.object.type === 'ThisExpression' && init.left.property && init.left.property.name === 'state'),
  },
  L: { to: 'layout', ok: (init) => isMember(init, 'layout') },
  D: {
    to: 'dock',
    ok: (init) => {
      if (!init) return false;
      if (isMember(init, '_dock')) return true;
      if (init.type === 'CallExpression') {
        const c = init.callee;
        if (isMember(c, '_findDock')) return true;
        if (isMember(c, 'get') && c.object && isMember(c.object, 'docks')) return true;
      }
      if (init.type === 'ObjectExpression') {
        return init.properties.some((p) => p.type === 'ObjectProperty' && p.key && p.key.name === 'key');
      }
      return false;
    },
  },
  it: {
    to: 'item',
    ok: (init) => {
      if (!init) return false;
      if (init.type === 'CallExpression') {
        if (isMember(init.callee, '_item')) return true;
        if (isMember(init.callee, 'get') && init.callee.object && isMember(init.callee.object, 'items')) return true;
      }
      if (isMember(init, 'lastItem') || isMember(init, 'it')) return true;
      return false;
    },
  },
  fo: { to: 'fontOptions', ok: (init) => !!(init && init.type === 'CallExpression' && isMember(init.callee, '_fo')) },
  mo: { to: 'mouse', ok: (init) => isMember(init, 'mouse') },
  tw: {
    to: 'textWidth',
    ok: (init) => isMember(init, 'w') && init.object && init.object.type === 'CallExpression' && isMember(init.object.callee, '_measure'),
  },
  sp: {
    to: 'itemSpacing',
    ok: (init) => !!(init && init.type === 'CallExpression' && isMember(init.callee, '_var') && init.arguments[0] && init.arguments[0].value === 'itemSpacing'),
  },
};


const PARAM_RENAMES = {
  // RendererProxy — the renderer interface the backend implements
  _has: { m: 'method' },
  _call: { m: 'method', args: 'callArgs' },
  _clipOk: { x: 'clipX', y: 'clipY', w: 'clipWidth', h: 'clipHeight' },
  beginFrame: { w: 'displayWidth', h: 'displayHeight' },
  setLayer: { l: 'layerName' },
  setCursor: { c: 'cursorName' },
  pushClip: { x: 'clipX', y: 'clipY', w: 'clipWidth', h: 'clipHeight' },
  fillRect: { x: 'xPos', y: 'yPos', w: 'width', h: 'height', c: 'fillColor' },
  fillRoundedRect: { x: 'xPos', y: 'yPos', w: 'width', h: 'height', r: 'cornerRadius', c: 'fillColor' },
  strokeRect: { x: 'xPos', y: 'yPos', w: 'width', h: 'height', c: 'strokeColor', t: 'thickness' },
  strokeRoundedRect: { x: 'xPos', y: 'yPos', w: 'width', h: 'height', r: 'cornerRadius', c: 'strokeColor', t: 'thickness' },
  line: { x1: 'xStart', y1: 'yStart', x2: 'xEnd', y2: 'yEnd', c: 'lineColor', t: 'thickness' },
  polyline: { pts: 'points', c: 'lineColor', t: 'thickness' },
  fillPolygon: { pts: 'points', c: 'fillColor' },
  fillCircle: { cx: 'centerX', cy: 'centerY', r: 'radius', c: 'fillColor' },
  fillEllipse: { cx: 'centerX', cy: 'centerY', rx: 'radiusX', ry: 'radiusY', c: 'fillColor' },
  drawImage: { id: 'imageId', x: 'xPos', y: 'yPos', w: 'width', h: 'height', tint: 'tintColor' },
  drawText: { x: 'xPos', y: 'yPos', str: 'text', c: 'fillColor', o: 'options' },
  textSize: { str: 'text', o: 'options' },
  // GUI — main public widgets
  sliderFloat: { vmin: 'minValue', vmax: 'maxValue', fmt: 'format' },
  sliderInt: { vmin: 'minValue', vmax: 'maxValue', fmt: 'format' },
  slider: { min: 'minValue', max: 'maxValue', opts: 'options' },
  dragFloat: { speed: 'dragSpeed', vmin: 'minValue', vmax: 'maxValue' },
  dragInt: { speed: 'dragSpeed', vmin: 'minValue', vmax: 'maxValue' },
  inputInt: { opts: 'options' },
  inputFloat: { opts: 'options' },
  inputText: { opts: 'options' },
  combo: { items: 'itemList', opts: 'options' },
  listBox: { items: 'itemList', opts: 'options' },
  checkbox: { value: 'checked' },
  button: { opts: 'options' },
  radioButton: { value: 'checked', index: 'groupIndex' },
  selectable: { selected: 'isSelected', opts: 'options' },
  collapsingHeader: { opts: 'options' },
  beginTabItem: { opts: 'options' },
  menuItem: { shortcut: 'shortcutLabel', opts: 'options' },
  plotLines: { values: 'seriesValues', opts: 'options' },
};


module.exports = { isMember, LOCAL_RENAMES, PARAM_RENAMES };
