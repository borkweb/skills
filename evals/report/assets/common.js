'use strict';
// Shared helpers for the eval report and index pages. Every string from the data reaches the DOM through
// textContent or setAttribute on a fixed allowlist; nothing here parses markup.

const SVGNS = 'http://www.w3.org/2000/svg';
const SAFE_ATTRS = /^(class|id|role|tabindex|title|href|type|value|selected|disabled|hidden|scope|colspan|rowspan|for|lang|open|aria-[a-z-]+|data-[a-z0-9-]+|x|y|x1|x2|y1|y2|cx|cy|r|rx|width|height|d|points|viewBox|fill|stroke|stroke-width|stroke-dasharray|stroke-linecap|stroke-linejoin|text-anchor|dominant-baseline|transform|style|focusable)$/;

function setAttrs(node, attrs) {
  for (const [name, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (name === 'text') { node.textContent = String(value); continue; }
    if (!SAFE_ATTRS.test(name)) throw new Error('attribute not allowed: ' + name);
    node.setAttribute(name, value === true ? '' : String(value));
  }
}

function append(node, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
  return node;
}

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  setAttrs(node, attrs);
  return append(node, children);
}

function sv(tag, attrs, ...children) {
  const node = document.createElementNS(SVGNS, tag);
  setAttrs(node, attrs);
  return append(node, children);
}

function readData() {
  return JSON.parse(document.getElementById('report-data').textContent);
}

// ---- formatting ------------------------------------------------------------------------------------------

function fmt(value, kind, estimated) {
  if (value === null || value === undefined) return 'n/a';
  let out;
  if (kind === 'rate') out = (value * 100).toFixed(value === 0 || value === 1 ? 0 : (Math.abs(value) < 0.1 ? 1 : 0)) + '%';
  else if (kind === 'cost') out = (value < 0 ? '−$' : '$') + Math.abs(value).toFixed(Math.abs(value) < 1 ? 3 : 2);
  else if (kind === 'duration') {
    const a = Math.abs(value), sign = value < 0 ? '−' : '';
    out = a < 90 ? sign + a.toFixed(a < 10 ? 1 : 0) + ' s' : a < 5400 ? sign + (a / 60).toFixed(1) + ' min' : sign + (a / 3600).toFixed(1) + ' h';
  } else if (kind === 'count') out = Number.isInteger(value) ? String(value) : value.toFixed(1);
  else out = Math.abs(value) >= 100 ? Math.round(value).toLocaleString('en-US') : (+value.toFixed(2)).toString();
  return (estimated ? '≈' : '') + out;
}

function fmtDelta(value, kind, estimated) {
  if (value === null || value === undefined) return 'n/a';
  if (kind === 'rate') return (value > 0 ? '+' : value < 0 ? '−' : '±') + (Math.abs(value) * 100).toFixed(1) + ' pts';
  const body = fmt(Math.abs(value), kind, estimated);
  return (value > 0 ? '+' : value < 0 ? '−' : '±') + body;
}

function fmtInterval(lo, hi, kind, estimated) {
  if (lo === null || lo === undefined) return 'no interval';
  return fmt(lo, kind, estimated) + ' – ' + fmt(hi, kind, estimated);
}

function shortSha(sha) { return sha ? String(sha).slice(0, 12) : 'n/a'; }

function fmtDate(iso) {
  if (!iso) return 'n/a';
  const d = new Date(iso);
  if (isNaN(d)) return String(iso);
  return d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }

// ---- color ------------------------------------------------------------------------------------------------

// Ordinal step 0..4 for a goodness in 0..1 (1 is best); null gives the neutral class.
const STEPS = 5;
function stepClass(goodness) {
  if (goodness === null || goodness === undefined || isNaN(goodness)) return 'qnone';
  return 'q' + Math.max(0, Math.min(STEPS - 1, Math.round(goodness * (STEPS - 1))));
}

function goodnessFromRank(rank, count) {
  if (rank === null || rank === undefined) return null;
  return count <= 1 ? 1 : (count - rank) / (count - 1);
}

const SERIES = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'];
function seriesColor(i) { return 'var(' + SERIES[i % SERIES.length] + ')'; }

function rampLegend(lowText, highText) {
  return el('span', { class: 'small muted' }, lowText,
    el('span', { class: 'ramp', 'aria-hidden': 'true' }, [0, 1, 2, 3, 4].map(i => el('span', { class: 'q' + i }))),
    highText);
}

// ---- layout pieces --------------------------------------------------------------------------------------

function card(id, title, lede, ...body) {
  return el('section', { class: 'card', id },
    el('header', {}, el('h2', { text: title }), lede ? el('p', { class: 'lede', text: lede }) : null), body);
}

function empty(kind, text) {
  return el('div', { class: 'empty', 'data-empty': kind, role: 'note' }, text);
}

function scrollTable(table) { return el('div', { class: 'scroll-x' }, table); }

function selectBox(label, options, value, onChange) {
  const select = el('select', {}, options.map(o => el('option', { value: o.value, text: o.label, selected: o.value === value })));
  select.addEventListener('change', () => onChange(select.value));
  return el('label', {}, label, select);
}

// ---- tooltip ------------------------------------------------------------------------------------------------

let tipNode = null;
function tip() {
  if (!tipNode) { tipNode = el('div', { class: 'tip', role: 'status', hidden: true }); document.body.appendChild(tipNode); }
  return tipNode;
}
function showTip(lines, x, y) {
  const node = tip();
  node.replaceChildren(...lines.map(line => el('div', { text: line })));
  node.hidden = false;
  const w = node.offsetWidth, h = node.offsetHeight;
  let left = x + 14, top = y + 14;
  if (left + w > window.innerWidth - 8) left = Math.max(8, x - w - 14);
  if (top + h > window.innerHeight - 8) top = Math.max(8, y - h - 14);
  node.style.left = left + 'px';
  node.style.top = top + 'px';
}
function hideTip() { if (tipNode) tipNode.hidden = true; }

// Attach a hover/focus/tap tooltip to an SVG hit target.
function withTip(target, lines) {
  target.addEventListener('mouseenter', e => showTip(lines, e.clientX, e.clientY));
  target.addEventListener('mousemove', e => showTip(lines, e.clientX, e.clientY));
  target.addEventListener('mouseleave', hideTip);
  target.addEventListener('focus', () => { const r = target.getBoundingClientRect(); showTip(lines, r.right, r.top); });
  target.addEventListener('blur', hideTip);
  target.addEventListener('touchstart', () => { const r = target.getBoundingClientRect(); showTip(lines, r.right, r.top); }, { passive: true });
  target.setAttribute('aria-label', lines.join('. '));
  return target;
}

// ---- charts -------------------------------------------------------------------------------------------------

function niceTicks(min, max, count) {
  if (min === max) { max = min + 1; }
  const span = max - min;
  const raw = span / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => span / s <= count) || 10 * mag;
  const start = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 0.5; v += step) ticks.push(+v.toFixed(10));
  return ticks;
}

function scale(d0, d1, r0, r1) {
  const k = d1 === d0 ? 0 : (r1 - r0) / (d1 - d0);
  return v => r0 + (v - d0) * k;
}

// The domain of a metric's axis: 0..1 for a rate, else from 0 (or the min, when negative) to the max.
function domainFor(kind, values) {
  if (kind === 'rate') return [0, 1];
  const vs = values.filter(v => v !== null && v !== undefined);
  if (!vs.length) return [0, 1];
  const lo = Math.min(0, ...vs), hi = Math.max(...vs);
  return [lo, hi === lo ? lo + 1 : hi];
}

// Charts draw at their container's pixel width, so text stays legible on a phone; they redraw on resize.
const redrawers = [];
function responsive(container, draw) {
  const run = () => { const w = Math.max(280, Math.floor(container.clientWidth)); container.replaceChildren(draw(w)); };
  redrawers.push(run);
  requestAnimationFrame(run);
  return container;
}
let resizeTimer = null;
let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => redrawers.slice().forEach(f => f()), 120);
});

function resetRedrawers() { redrawers.length = 0; }

// ---- theme --------------------------------------------------------------------------------------------------

function themeToggle() {
  const order = ['auto', 'light', 'dark'];
  let current = 'auto';
  try { current = localStorage.getItem('eval-report-theme') || 'auto'; } catch (e) { /* storage blocked */ }
  if (!order.includes(current)) current = 'auto';
  const apply = () => {
    if (current === 'auto') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', current);
    button.textContent = 'Theme: ' + current;
  };
  const button = el('button', { class: 'theme-toggle', type: 'button', title: 'Switch between auto, light and dark' });
  button.addEventListener('click', () => {
    current = order[(order.indexOf(current) + 1) % order.length];
    try { localStorage.setItem('eval-report-theme', current); } catch (e) { /* storage blocked */ }
    apply();
  });
  apply();
  return button;
}
