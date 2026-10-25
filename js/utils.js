// Utilidades compartidas: DOM, formato, notificaciones, diálogos y feedback.

export const byId = id => document.getElementById(id);
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const txt = v => String(v ?? '').trim();
export const upper = v => txt(v).toLocaleUpperCase('es-AR');
export const num = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
export const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);
export const nowIso = () => new Date().toISOString();
export const fmt = (n, d = 2) => Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: d });
// Dinero en pesos: "$ 12.500" (los centavos solo si hay).
const MONEY = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 0, maximumFractionDigits: 0 });
const MONEY_CENTS = new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = n => { const v = Math.round((Number(n) || 0) * 100) / 100; return (Number.isInteger(v) ? MONEY : MONEY_CENTS).format(v); };
// Lee un importe escrito como en Argentina: "12.500", "12500", "1.234,50", "$ 980". Vacío o inválido → null.
export function parseMoney(v) {
  const s = String(v ?? '').replace(/[^\d.,]/g, '');
  if (!s) return null;
  const clean = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : /^\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, '') : s;
  const n = Number(clean);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
}
export const dateStamp = () => new Date().toLocaleDateString('sv-SE');
export const initials = name => txt(name).split(/[\s._-]+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
export const readJSON = (key, fallback = null) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
export const writeJSON = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };

export function relTime(iso) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 45) return 'recién';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  if (s < 86400 * 7) return `hace ${Math.round(s / 86400)} d`;
  return new Date(iso).toLocaleDateString('es-AR');
}

export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

export const icon = (name, cls = '') => `<svg class="i ${cls}" aria-hidden="true"><use href="icons/sprite.svg#${name}"/></svg>`;
export function hydrateIcons(root = document) {
  root.querySelectorAll('i[data-i]').forEach(el => { el.outerHTML = icon(el.dataset.i, el.className); });
}

// ---------- Notificaciones ----------
export function toast(message, opts = {}) {
  const { type = 'success', action = null, actionLabel = 'Deshacer', duration = 4200 } = typeof opts === 'string' ? { type: opts } : opts;
  let host = byId('toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toasts'; host.className = 'toasts'; host.setAttribute('role', 'status'); host.setAttribute('aria-live', 'polite');
    // Como "popover" el aviso se dibuja en la capa superior: se ve aunque haya una ventana (diálogo) abierta.
    if (typeof host.showPopover === 'function') host.setAttribute('popover', 'manual');
    document.body.append(host);
  }
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  const ic = { success: 'check', error: 'alert', warn: 'alert', info: 'info' }[type] || 'info';
  el.innerHTML = `<span class="toast-icon">${icon(ic)}</span><span class="toast-msg">${esc(message)}</span>${action ? `<button class="toast-action" type="button">${esc(actionLabel)}</button>` : ''}<button class="toast-close" type="button" aria-label="Cerrar">${icon('x')}</button>`;
  host.append(el);
  while (host.children.length > 4) host.firstElementChild.remove();
  if (host.hasAttribute('popover')) {
    try { if (host.matches(':popover-open')) host.hidePopover(); host.showPopover(); } catch { /* sin soporte */ }
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true; el.classList.add('out');
    setTimeout(() => {
      el.remove();
      if (!host.children.length && host.hasAttribute('popover')) { try { host.hidePopover(); } catch { /* ya cerrado */ } }
    }, 220);
  };
  el.querySelector('.toast-close').onclick = close;
  if (action) el.querySelector('.toast-action').onclick = () => { action(); close(); };
  // El tiempo se pausa mientras la pestaña está oculta, para no perderse un aviso.
  let left = duration, started = Date.now(), timer = setTimeout(close, left);
  const onVis = () => {
    if (closed) return document.removeEventListener('visibilitychange', onVis);
    if (document.hidden) { clearTimeout(timer); left -= Date.now() - started; }
    else { started = Date.now(); timer = setTimeout(close, Math.max(1200, left)); }
  };
  document.addEventListener('visibilitychange', onVis);
  return close;
}

// ---------- Diálogo de confirmación / elección ----------
// ask({title, message}) → true/false · ask({title, choices:[{label, value, primary, danger}]}) → value | null
export function ask({ title, message = '', confirm = 'Confirmar', cancel = 'Cancelar', danger = false, choices = null }) {
  return new Promise(resolve => {
    const d = document.createElement('dialog');
    d.className = 'modal modal-sm';
    const btns = choices
      ? choices.map(c => `<button type="button" class="btn ${c.primary ? 'btn-primary' : c.danger ? 'btn-danger' : 'btn-ghost'}" data-v="${esc(c.value)}">${esc(c.label)}</button>`).join('') + `<button type="button" class="btn btn-ghost" data-v="__cancel">${esc(cancel)}</button>`
      : `<button type="button" class="btn btn-ghost" data-v="__cancel">${esc(cancel)}</button><button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-v="__ok">${esc(confirm)}</button>`;
    d.innerHTML = `<div class="modal-inner"><div class="modal-body"><h3>${esc(title)}</h3>${message ? `<p class="muted" style="margin-top:8px">${esc(message)}</p>` : ''}</div><div class="modal-actions ${choices ? 'stack' : ''}">${btns}</div></div>`;
    document.body.append(d);
    let result = choices ? null : false;
    d.addEventListener('click', e => {
      const b = e.target.closest('[data-v]');
      if (b) { const v = b.dataset.v; result = v === '__cancel' ? (choices ? null : false) : choices ? v : true; d.close(); }
      else if (e.target === d) d.close();
    });
    d.addEventListener('close', () => { d.remove(); resolve(result); });
    d.showModal();
    d.querySelector(choices ? '.btn-primary, .btn' : '[data-v="__ok"]')?.focus();
  });
}

// ---------- Feedback de botones ----------
export function busy(btn, on) { if (!btn) return; btn.classList.toggle('is-loading', on); btn.disabled = on; }
export function flashDone(btn, ms = 1100) {
  if (!btn) return;
  btn.classList.remove('is-done'); void btn.offsetWidth; btn.classList.add('is-done');
  clearTimeout(btn._doneT); btn._doneT = setTimeout(() => btn.classList.remove('is-done'), ms);
}
export function shake(el) { if (!el) return; el.classList.remove('shake'); void el.offsetWidth; el.classList.add('shake'); setTimeout(() => el.classList.remove('shake'), 450); }

// Interacciones (criterio de Emil Kowalski): las acciones frecuentes no llevan animación decorativa;
// los diálogos entran rápido y salen más rápido todavía, en vez de desaparecer de golpe.
export function initInteractions() {
  const nativeClose = HTMLDialogElement.prototype.close;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  HTMLDialogElement.prototype.close = function (value) {
    if (!this.open || this._closing || reduced() || !this.classList.contains('modal')) return nativeClose.call(this, value);
    this._closing = true;
    this.classList.add('closing');
    setTimeout(() => { this.classList.remove('closing'); this._closing = false; if (this.open) nativeClose.call(this, value); }, 140);
  };
}

// Contador animado para los indicadores.
export function animateNumber(el, to, decimals = 0) {
  if (!el) return;
  const first = el.dataset.v === undefined, from = Number(el.dataset.v || 0);
  el.dataset.v = to;
  // Solo la primera vez: un número que cambia con cada lectura tiene que ser instantáneo.
  if (!first || from === to || matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = fmt(to, decimals); return; }
  const start = performance.now(), dur = 600;
  cancelAnimationFrame(el._raf);
  const step = t => {
    const p = Math.min(1, (t - start) / dur), e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (to - from) * e, decimals);
    if (p < 1) el._raf = requestAnimationFrame(step);
  };
  el._raf = requestAnimationFrame(step);
}

// ---------- Sonido y vibración ----------
let actx;
export function beep(kind = 'ok') {
  try {
    actx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime, len = kind === 'ok' ? .12 : .32;
    o.type = kind === 'ok' ? 'sine' : 'square';
    o.frequency.value = kind === 'ok' ? 1400 : kind === 'warn' ? 620 : 220;
    g.gain.setValueAtTime(.0001, t);
    g.gain.exponentialRampToValueAtTime(.16, t + .01);
    g.gain.exponentialRampToValueAtTime(.0001, t + len);
    o.connect(g).connect(actx.destination);
    o.start(t); o.stop(t + len + .02);
  } catch { /* sin audio */ }
}
export const vibrate = p => { try { navigator.vibrate?.(p); } catch { /* sin vibración */ } };

// ---------- Archivos y scripts ----------
const scripts = {};
export function loadScript(src) {
  return scripts[src] ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = resolve;
    s.onerror = () => { delete scripts[src]; s.remove(); reject(new Error('No se pudo cargar una librería. Revisá tu conexión.')); };
    document.head.append(s);
  });
}
export function download(blob, name) {
  const u = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = u; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 1500);
}
export const waLink = (phone, text) => `https://wa.me/${String(phone).replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
