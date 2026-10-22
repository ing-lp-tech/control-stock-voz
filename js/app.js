// StockVoz · interfaz principal: navegación, vistas y eventos.
import { CONFIG } from './config.js';
import {
  byId, $, $$, esc, icon, hydrateIcons, toast, ask, fmt, txt, upper, num, debounce, relTime, busy, flashDone, shake,
  beep, vibrate, initRipple, animateNumber, readJSON, writeJSON, initials, waLink,
} from './utils.js';
import * as S from './store.js';
import * as cloud from './cloud.js';
import { parseSpeech, createRecognizer } from './voice.js';
import { initHardwareScanner, startCamera } from './scanner.js';
import * as L from './labels.js';
import * as IO from './io.js';

const { state } = S;

// ---------- Preferencias del dispositivo ----------
const PREFS_KEY = 'stockvoz_prefs';
const prefs = {
  task: 'inventario', formOp: 'sumar', scanOp: 'sumar', scanQty: 1, scanUnknown: 'ask', sound: true,
  lblKind: 'barcode', lblSize: 'r50x25', lblCopies: 1, lblByStock: false, lblShowName: true, lblHeader: '',
  ...readJSON(PREFS_KEY, {}),
};
const savePrefs = () => writeJSON(PREFS_KEY, prefs);

const CREATOR = {
  name: 'Ingeniero Emprendedor',
  photo: 'assets/creador.jpg',
  message: 'Hola, vengo de la app de stock y quiero recibir más información sobre tus servicios. Me interesa conocer más sobre apps, pizarras digitalizadoras, plotters e innovaciones para el área textil.',
};

const VIEWS = {
  panel: ['Panel', 'Resumen de tu inventario'],
  cargar: ['Cargar productos', 'Por voz o a mano, un producto por vez'],
  escanear: ['Escanear', 'Pistola lectora o cámara'],
  inventario: ['Inventario', 'Todos tus productos'],
  etiquetas: ['Etiquetas', 'Códigos de barras y QR para imprimir'],
  historial: ['Historial', 'Todos los movimientos registrados'],
  datos: ['Datos y respaldos', 'Exportar, importar y copias de seguridad'],
  cuenta: ['Cuenta y nube', 'Respaldo, sincronización y apariencia'],
};
const MORE_VIEWS = ['etiquetas', 'historial', 'datos', 'cuenta'];
let currentView = 'panel';

const sound = kind => { if (prefs.sound) { beep(kind); vibrate(kind === 'ok' ? 35 : [80, 60, 80]); } };
const productName = i => [i.brand, i.type].filter(Boolean).join(' · ');

// =========================================================
// Navegación
// =========================================================
function route() {
  const [name, query] = location.hash.replace(/^#\/?/, '').split('?');
  const view = VIEWS[name] ? name : 'panel';
  showView(view, new URLSearchParams(query || ''));
}

function showView(view, params = new URLSearchParams()) {
  const changed = view !== currentView;
  currentView = view;
  $$('.view').forEach(v => v.classList.toggle('active', v.dataset.view === view));
  $$('[data-nav]').forEach(a => a.classList.toggle('active', a.dataset.nav === view));
  byId('moreBtn').classList.toggle('active', MORE_VIEWS.includes(view));
  byId('viewTitle').textContent = VIEWS[view][0];
  byId('viewSubtitle').textContent = VIEWS[view][1];
  document.title = `${VIEWS[view][0]} · StockVoz`;
  closeSheet();
  if (changed) window.scrollTo({ top: 0, behavior: 'instant' });
  onEnter[view]?.(params);
}

const onEnter = {
  panel: renderPanel,
  cargar: params => { if (params.get('voz') && recog && !recog.active) toggleMic(); },
  escanear: () => { renderScanSession(); focusScan(); },
  inventario: params => { if (params.get('f')) setInvFilter(params.get('f')); renderInventory(); },
  etiquetas: () => { renderLabelList(); renderLabelPreview(); },
  historial: renderHistory,
  datos: renderStorageInfo,
  cuenta: renderAccount,
};

function openSheet() { byId('moreSheet').classList.add('open'); byId('sheetBackdrop').hidden = false; }
function closeSheet() { byId('moreSheet').classList.remove('open'); byId('sheetBackdrop').hidden = true; }

// =========================================================
// Selects, tarea y segmentados
// =========================================================
function fillSelects(root = document) {
  const sources = {
    stockTypes: Object.entries(S.STOCK_TYPES),
    inputUnits: Object.entries(S.INPUT_UNITS).map(([k, v]) => [k, v.label]),
    stockUnits: Object.entries(S.STOCK_UNIT_NAMES),
  };
  $$('select[data-options]', root).forEach(sel => {
    sel.innerHTML = sources[sel.dataset.options].map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  });
  if (root === document) byId('lblSize').innerHTML = Object.entries(L.LABEL_SIZES).map(([k, s]) => `<option value="${k}">${esc(s.name)}</option>`).join('');
}

function segmented(el, value) {
  el.querySelectorAll('[data-v]').forEach(b => { const on = b.dataset.v === value; b.classList.toggle('active', on); b.setAttribute('aria-pressed', on); });
}
function onSegment(el, fn) { el.addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) fn(b.dataset.v); }); }

function setTask(v) {
  prefs.task = S.STOCK_TYPES[v] ? v : 'inventario';
  savePrefs();
  $$('.task-select').forEach(s => { s.value = prefs.task; });
  if (prefs.task === 'salida') { setFormOp('restar'); setScanOp('restar'); }
  else if (prefs.task === 'entrada') { setFormOp('sumar'); setScanOp('sumar'); }
}

// Botones +/− de los campos numéricos
document.addEventListener('click', e => {
  const b = e.target.closest('.stepper [data-step]');
  if (!b) return;
  const input = b.parentElement.querySelector('input');
  const min = input.min === '' ? 0 : Number(input.min);
  input.value = Math.max(min, Math.round((num(input.value) + Number(b.dataset.step)) * 100) / 100);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

// =========================================================
// Plantillas compartidas
// =========================================================
const KIND_ICON = { in: 'arrow-in', out: 'arrow-out', count: 'equal', edit: 'edit', delete: 'trash', import: 'upload' };
function historyRow(h) {
  const k = S.historyKind(h);
  const sign = k === 'out' ? '−' : k === 'in' ? '+' : k === 'count' ? '=' : '';
  const delta = h.quantity != null && ['in', 'out', 'count'].includes(k) ? `${sign}${fmt(k === 'count' ? h.after : h.quantity)}` : '';
  const change = h.before != null && h.after != null ? ` · ${fmt(h.before)} → ${fmt(h.after)}${h.unit ? ' ' + esc(h.unit) : ''}` : '';
  const sub = [h.brand, h.type].filter(Boolean).join(' · ');
  return `<div class="tl-item tl-${k}"><span class="tl-icon">${icon(KIND_ICON[k] || 'edit')}</span>
    <div class="tl-body"><div class="tl-title"><strong class="mono">${esc(h.sku) || '—'}</strong> <span>${esc(h.action)}</span></div>
    <div class="tl-sub">${esc(sub || h.note || '')}${change}</div></div>
    <div class="tl-side">${delta ? `<strong class="delta">${delta}</strong>` : ''}<span>${relTime(h.at)}</span></div></div>`;
}
const emptyState = (ic, title, text, action = '') => `<div class="empty"><span class="empty-icon">${icon(ic)}</span><strong>${esc(title)}</strong><span>${esc(text)}</span>${action}</div>`;

function creatorCard() {
  return `<section class="creator" aria-label="Creador de la app">
    <div class="creator-top">
      <div class="creator-photo"><img src="${CREATOR.photo}" alt="Foto de ${CREATOR.name}" width="96" height="96" loading="lazy"></div>
      <div style="flex:1;min-width:220px">
        <div class="creator-eyebrow">TECNOLOGÍA · TEXTIL · INNOVACIÓN</div>
        <h2>Hecho por <span>${CREATOR.name}</span></h2>
        <p class="creator-lead">Soluciones tecnológicas pensadas para negocios reales: del taller textil a la gestión digital.</p>
      </div>
    </div>
    <div class="creator-services">
      <div class="creator-service">${icon('grid')}<strong>Apps y sistemas</strong><small>Aplicaciones a medida para ordenar y hacer crecer tu negocio.</small></div>
      <div class="creator-service">${icon('edit')}<strong>Pizarras digitalizadoras</strong><small>Digitalizá moldes y modernizá el trabajo.</small></div>
      <div class="creator-service">${icon('print')}<strong>Plotters</strong><small>Equipos, puesta en marcha y soporte técnico.</small></div>
      <div class="creator-service">${icon('sparkles')}<strong>Innovación textil</strong><small>Automatización y soluciones para la producción.</small></div>
    </div>
    <div class="creator-bottom">
      <div><strong>¿Tenés un proyecto o necesitás asesoramiento?</strong><span>Escribile al creador de StockVoz y conversemos.</span></div>
      <a class="btn btn-wa btn-lg" href="${waLink(CONFIG.ADMIN_WHATSAPP, CREATOR.message)}" target="_blank" rel="noopener noreferrer">${icon('whatsapp')}Contactar por WhatsApp</a>
    </div>
  </section>`;
}
function renderCreator() {
  byId('sideCreator').innerHTML = `<a class="creator-mini" href="${waLink(CONFIG.ADMIN_WHATSAPP, CREATOR.message)}" target="_blank" rel="noopener noreferrer" title="Contactar al creador">
    <img src="${CREATOR.photo}" alt="" width="40" height="40"><span><small>Creado por</small><strong>${CREATOR.name}</strong></span>${icon('whatsapp')}</a>`;
  byId('panelCreator').innerHTML = creatorCard();
  byId('accountCreator').innerHTML = creatorCard();
}

// =========================================================
// Panel
// =========================================================
function renderPanel() {
  const items = state.items;
  const units = items.filter(i => i.unitName === 'unidades').reduce((s, i) => s + i.units, 0);
  const today = new Date().toDateString();
  const todays = state.history.filter(h => new Date(h.at).toDateString() === today);
  const ins = todays.filter(h => S.historyKind(h) === 'in').length, outs = todays.filter(h => S.historyKind(h) === 'out').length;
  const alerts = items.filter(i => i.units <= 0 || S.isLow(i));

  animateNumber(byId('kpiItems'), items.length);
  animateNumber(byId('kpiUnits'), units);
  animateNumber(byId('kpiToday'), todays.length);
  animateNumber(byId('kpiLow'), alerts.length);
  byId('kpiItemsFoot').textContent = `${fmt(items.filter(i => i.units > 0).length)} con stock`;
  byId('kpiUnitsFoot').textContent = `${fmt(units / 12)} docenas`;
  byId('kpiTodayFoot').textContent = todays.length ? `${ins} ingresos · ${outs} salidas` : 'Todavía sin movimientos';

  const name = cloud.getSession()?.fullName?.split(' ')[0];
  const h = new Date().getHours();
  byId('greeting').textContent = `${h < 12 ? 'Buen día' : h < 20 ? 'Buenas tardes' : 'Buenas noches'}${name ? ', ' + name : ''}`;
  byId('todayLabel').textContent = new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });

  byId('recentList').innerHTML = state.history.length
    ? state.history.slice(0, 6).map(historyRow).join('')
    : emptyState('history', 'Sin actividad todavía', 'Tus ingresos, salidas y conteos aparecen acá.');
  byId('alertList').innerHTML = alerts.length
    ? alerts.slice(0, 6).map(i => `<a class="alert-row" href="#/inventario?f=alert"><span class="tl-icon" style="background:var(--${i.units <= 0 ? 'danger' : 'warn'}-soft);color:var(--${i.units <= 0 ? 'danger' : 'warn'})">${icon('alert')}</span><span class="grow" style="min-width:0"><strong class="mono">${esc(i.sku)}</strong><div class="tl-sub">${esc(productName(i) || 'Sin datos')}</div></span><span class="badge ${i.units <= 0 ? 'badge-danger' : 'badge-warn'}">${i.units <= 0 ? 'Sin stock' : `${fmt(i.units)} / mín. ${fmt(i.minStock)}`}</span></a>`).join('')
    : emptyState('check', 'Todo en orden', 'Te avisamos cuando un producto se quede sin stock o baje del mínimo.');
  renderBanners();
}

function renderBanners() {
  const out = [];
  const st = cloud.getStatus();
  if (S.hasStorageError()) out.push(`<div class="banner warn"><span class="card-icon">${icon('alert')}</span><div class="banner-text"><strong>No se pudo guardar en este dispositivo</strong><span>El almacenamiento del navegador está lleno o bloqueado. Descargá una copia ahora.</span></div><button class="btn btn-primary" data-act="backup" type="button">${icon('download')}Descargar copia</button></div>`);
  if (st.configured && !st.session) {
    out.push(`<div class="banner"><span class="card-icon">${icon('cloud')}</span><div class="banner-text"><strong>Guardá tu stock en la nube</strong><span>Creá tu usuario: tus datos quedan respaldados y disponibles en todos tus dispositivos.</span></div><a class="btn btn-primary" href="#/cuenta">Crear cuenta</a></div>`);
  }
  if (!st.session && state.items.length) {
    const days = state.lastBackupAt ? (Date.now() - new Date(state.lastBackupAt)) / 86400000 : Infinity;
    if (days >= 7) out.push(`<div class="banner warn"><span class="card-icon">${icon('shield')}</span><div class="banner-text"><strong>${state.lastBackupAt ? `Hace ${Math.floor(days)} días que no hacés una copia` : 'Todavía no hiciste una copia de seguridad'}</strong><span>Tus datos están solo en este dispositivo. Descargá una copia JSON.</span></div><button class="btn btn-ghost" data-act="backup" type="button">${icon('download')}Descargar copia</button></div>`);
  }
  byId('panelBanners').innerHTML = out.join('');
}

// =========================================================
// Cargar: voz + formulario
// =========================================================
const F = { sku: byId('fSku'), brand: byId('fBrand'), type: byId('fType'), qty: byId('fQty'), unit: byId('fUnit'), min: byId('fMin'), barcode: byId('fBarcode') };
let formSource = 'manual';

function setFormOp(op) {
  prefs.formOp = S.OPERATIONS[op] ? op : 'sumar';
  savePrefs();
  segmented(byId('opSeg'), prefs.formOp);
  byId('saveLabel').textContent = { sumar: 'Sumar al stock', restar: 'Restar del stock', establecer: 'Establecer stock' }[prefs.formOp];
  updateFormNotice();
}

function updateFormNotice() {
  const sku = upper(F.sku.value).replace(/\s+/g, ''), it = S.findByCode(sku), qty = num(F.qty.value), u = S.inputUnit(F.unit.value);
  const badge = byId('formBadge');
  badge.hidden = !sku;
  if (it) { badge.className = 'badge badge-info'; badge.innerHTML = `${icon('box')}Existe · ${fmt(it.units)} ${esc(S.unitLabel(it.unitName))}`; }
  else if (sku) { badge.className = 'badge badge-success'; badge.innerHTML = `${icon('sparkles')}Producto nuevo`; }
  const msgs = [];
  if (it && it.unitName !== u.stock) msgs.push(['warn', 'alert', `${it.sku} se controla en ${S.unitLabel(it.unitName)}. Cambiá la unidad para no mezclar medidas.`]);
  if (sku && qty > 0 && (!it || it.unitName === u.stock)) {
    const amount = qty * u.factor, before = it?.units || 0;
    const after = prefs.formOp === 'establecer' ? amount : prefs.formOp === 'restar' ? before - amount : before + amount;
    const unitName = S.unitLabel(it?.unitName || u.stock);
    if (prefs.formOp === 'restar' && !it) msgs.push(['danger', 'alert', 'No se puede restar: el producto no existe todavía.']);
    else if (after < 0) msgs.push(['danger', 'alert', `Stock insuficiente: hay ${fmt(before)} ${unitName}.`]);
    else msgs.push(['info', 'info', `Stock: ${fmt(before)} → ${fmt(after)} ${unitName}${u.factor !== 1 ? ` (${fmt(qty)} ${u.short} = ${fmt(amount)} unidades)` : ''}`]);
  }
  byId('formNotice').innerHTML = msgs.map(([t, ic, m]) => `<div class="notice ${t}">${icon(ic)}<span>${esc(m)}</span></div>`).join('');
}

function syncUnitWithProduct() {
  const it = S.findByCode(F.sku.value);
  if (it && S.inputUnit(F.unit.value).stock !== it.unitName) F.unit.value = S.inputUnitFor(it);
  if (it) {
    if (!txt(F.brand.value)) F.brand.value = it.brand;
    if (!txt(F.type.value)) F.type.value = it.type;
  }
  updateFormNotice();
}

function resetForm() {
  ['sku', 'brand', 'type', 'qty', 'min', 'barcode'].forEach(k => { F[k].value = ''; });
  F.unit.value = 'unit';
  formSource = 'manual';
  updateFormNotice();
}

function highlight(...els) { els.forEach(el => { el.classList.remove('just-filled'); void el.offsetWidth; el.classList.add('just-filled'); }); }

function interpret() {
  const text = txt(byId('transcript').value);
  if (!text) { toast('Primero dictá o escribí un producto.', 'warn'); return; }
  const p = parseSpeech(text);
  const filled = [];
  if (p.sku) { F.sku.value = p.sku; filled.push(F.sku); }
  if (p.brand) { F.brand.value = upper(p.brand); filled.push(F.brand); }
  if (p.type) { F.type.value = upper(p.type); filled.push(F.type); }
  if (p.qty != null) { F.qty.value = p.qty; filled.push(F.qty); }
  F.unit.value = p.unit; filled.push(F.unit);
  const op = prefs.task === 'salida' ? 'restar' : prefs.task === 'entrada' ? 'sumar' : (p.operation || prefs.formOp);
  setFormOp(op);
  formSource = 'voz';
  syncUnitWithProduct();
  highlight(...filled);
  const missing = !p.sku ? F.sku : p.qty == null ? F.qty : null;
  if (missing) { missing.focus(); toast(`No entendí ${missing === F.sku ? 'el código' : 'la cantidad'}. Completalo a mano.`, 'warn'); }
  else { byId('saveProduct').focus({ preventScroll: true }); toast('Revisá los datos y tocá Guardar.', 'info'); }
  if (innerWidth < 900) byId('productForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function saveProduct(e) {
  e.preventDefault();
  const btn = byId('saveProduct');
  const r = S.applyMovement({
    sku: F.sku.value, brand: F.brand.value, type: F.type.value, qty: F.qty.value, unit: F.unit.value, stockType: prefs.task,
    operation: prefs.formOp, minStock: F.min.value, barcode: F.barcode.value, source: formSource,
  });
  if (!r.ok) { toast(r.error, 'error'); shake(btn); sound('error'); return; }
  flashDone(btn);
  sound('ok');
  toast(`${r.item.sku}: ${fmt(r.before)} → ${fmt(r.after)} ${S.unitLabel(r.item.unitName)}`, { action: () => { if (S.undo()) toast('Movimiento deshecho', 'info'); } });
  byId('transcript').value = '';
  resetForm();
  F.sku.focus();
}

// Micrófono: cada estado del dictado se muestra para que siempre se sepa qué está pasando.
const MIC_STATES = {
  listening: ['live', 'Micrófono abierto. Hablá ahora…'],
  sound: ['live', 'Llega sonido del micrófono…'],
  speech: ['live', 'Te escucho… tocá ✕ cuando termines'],
  nospeech: ['warn', 'No detecto voz. Hablá más cerca del micrófono.'],
  nosound: ['warn', 'No llega sonido del micrófono. Revisá que no esté silenciado y que Chrome use el micrófono correcto: tocá el ícono del micrófono a la derecha de la barra de direcciones.'],
  retry: ['warn', 'Reconectando el dictado…'],
};
const MIC_ERRORS = {
  'not-allowed': 'Chrome bloqueó el micrófono. Tocá el ícono del candado o del micrófono en la barra de direcciones → Micrófono → Permitir, y recargá la página.',
  'service-not-allowed': 'Este navegador no permite el dictado. Usá Google Chrome.',
  'audio-capture': 'No se encontró ningún micrófono. Conectalo o elegilo en Windows: Configuración → Sistema → Sonido → Entrada.',
  'network': 'El servicio de dictado de Google no responde. Revisá internet, desactivá VPN o bloqueadores, y usá Google Chrome (Brave, Opera y algunos Edge no permiten dictar).',
  'language-not-supported': 'Este navegador no reconoce el español para dictado. Usá Google Chrome.',
  'loop': 'El dictado se corta solo. Recargá la página o probá con Google Chrome.',
};
function micStatus(kind, text) {
  const st = byId('micStatus');
  st.className = `mic-status ${kind}`;
  st.textContent = text;
}
const recog = createRecognizer({
  onState: (s, err) => {
    if (s === 'error') {
      const msg = MIC_ERRORS[err] || `El dictado se detuvo (${err}). Probá de nuevo o escribí el producto.`;
      micStatus('error', msg);
      toast(msg, { type: 'error', duration: 8000 });
      return;
    }
    setMic(true);
    micStatus(...MIC_STATES[s]);
  },
  onText: t => { byId('transcript').value = t; },
  onEnd: () => {
    setMic(false);
    if (byId('micStatus').classList.contains('live')) micStatus('', 'Tocá el micrófono y hablá con claridad');
    if (txt(byId('transcript').value)) interpret();
  },
});
function setMic(on) {
  const b = byId('micBtn');
  if (b.classList.contains('listening') === on) return;
  b.classList.toggle('listening', on);
  b.innerHTML = icon(on ? 'x' : 'mic');
  b.setAttribute('aria-label', on ? 'Detener dictado' : 'Iniciar dictado');
}
function toggleMic() {
  if (!recog) return toast('Este navegador no admite dictado. Probá con Google Chrome o escribí el producto.', 'warn');
  if (recog.active) { recog.stop(); return; }
  try {
    micStatus('live', 'Abriendo el micrófono…');
    setMic(true);
    recog.start(byId('transcript').value);
  } catch {
    setMic(false);
    micStatus('warn', 'El micrófono todavía se está cerrando. Esperá un segundo y tocá de nuevo.');
  }
}

function speakForm() {
  if (!('speechSynthesis' in window)) return toast('La lectura en voz alta no está disponible.', 'warn');
  const u = S.inputUnit(F.unit.value);
  speechSynthesis.cancel();
  const msg = new SpeechSynthesisUtterance(`${S.OPERATIONS[prefs.formOp]}. Código ${F.sku.value || 'sin código'}, marca ${F.brand.value || 'sin marca'}, ${F.type.value || ''}, cantidad ${F.qty.value || 'cero'} ${u.short}.`);
  msg.lang = 'es-AR';
  speechSynthesis.speak(msg);
}

// =========================================================
// Escáner
// =========================================================
const session = { reads: 0, units: 0, products: new Set(), counted: new Set(), feed: [] };
let lastScan = { code: '', at: 0 };

function setScanOp(op) {
  prefs.scanOp = S.OPERATIONS[op] ? op : 'sumar';
  savePrefs();
  segmented(byId('scanOpSeg'), prefs.scanOp);
  byId('scanOpHint').textContent = {
    sumar: 'Suma la cantidad al stock del producto (ingreso de mercadería).',
    restar: 'Descuenta la cantidad del stock (venta o salida).',
    establecer: 'Conteo físico: la primera lectura de cada producto reinicia su stock y las siguientes suman. Ideal para inventariar.',
  }[prefs.scanOp];
}
function focusScan() {
  if (currentView !== 'escanear' || document.querySelector('dialog[open]')) return;
  byId('scanInput').focus({ preventScroll: true });
}
function setScanReady() {
  const ready = currentView === 'escanear' && document.activeElement === byId('scanInput');
  byId('scanHero').classList.toggle('ready', ready);
  byId('scanStatusText').textContent = ready ? 'Listo para escanear' : 'Lector activo en toda la app';
}
function scanFeedback(ok, html) {
  const hero = byId('scanHero');
  hero.classList.remove('ok', 'bad'); void hero.offsetWidth; hero.classList.add(ok ? 'ok' : 'bad');
  byId('scanLast').innerHTML = html;
  sound(ok ? 'ok' : 'error');
}
function scanFail(code, msg) {
  scanFeedback(false, `<div class="scan-result bad"><span class="big">${icon('x', 'lg')}</span><div><strong class="mono">${esc(code)}</strong><div class="small">${esc(msg)}</div></div></div>`);
  toast(msg, 'error');
}

function askNewProduct(code, qty) {
  return new Promise(resolve => {
    const d = byId('newDialog');
    byId('nCode').textContent = code;
    ['nBrand', 'nType', 'nMin'].forEach(id => { byId(id).value = ''; });
    byId('nQty').value = qty;
    byId('nUnit').value = 'unit';
    byId('newForm').onsubmit = e => {
      e.preventDefault();
      resolve({ brand: byId('nBrand').value, type: byId('nType').value, qty: byId('nQty').value, unit: byId('nUnit').value, minStock: byId('nMin').value });
      d.close();
    };
    d.addEventListener('close', () => resolve(null), { once: true });
    d.showModal();
    setTimeout(() => byId('nBrand').focus(), 60);
  });
}

async function handleScan(raw, source = 'escáner') {
  const code = upper(raw).replace(/\s+/g, '');
  if (!code) return;
  const t = Date.now();
  if (source === 'cámara' && code === lastScan.code && t - lastScan.at < 1800) return; // la cámara repite lecturas
  lastScan = { code, at: t };
  if (currentView !== 'escanear') location.hash = '#/escanear';

  const op = prefs.scanOp, qty = num(prefs.scanQty) || 1;
  const item = S.findByCode(code);
  let r;
  if (!item) {
    if (op === 'restar') return scanFail(code, `${code} no existe en el inventario; no se descontó nada.`);
    if (prefs.scanUnknown === 'reject') return scanFail(code, `${code} no está en el inventario.`);
    let data = { qty, unit: 'unit' };
    if (prefs.scanUnknown === 'ask') {
      sound('warn');
      data = await askNewProduct(code, qty);
      focusScan();
      if (!data) return scanFail(code, 'Lectura cancelada.');
    }
    r = S.applyMovement({ ...data, sku: code, stockType: prefs.task, operation: op, source: `${source} · alta` });
  } else {
    const operation = op === 'establecer' && session.counted.has(item.id) ? 'sumar' : op;
    // Cada lectura cuenta en la unidad base (1 = una prenda aunque el producto se muestre en docenas).
    const unit = item.unitName === 'unidades' ? 'unit' : S.inputUnitFor(item);
    r = S.applyMovement({ sku: item.sku, qty, unit, stockType: prefs.task, operation, source, keepDisplay: true });
  }
  if (!r.ok) return scanFail(code, r.error);

  if (op === 'establecer') session.counted.add(r.item.id);
  session.reads++;
  session.units += r.amount;
  session.products.add(r.item.id);
  session.feed.unshift({ id: Date.now() + Math.random(), itemId: r.item.id, sku: r.item.sku, name: productName(r.item), op, amount: r.amount, before: r.before, after: r.after, unit: S.unitLabel(r.item.unitName), at: new Date().toISOString(), undone: false });
  if (session.feed.length > 200) session.feed.length = 200;
  const sign = op === 'restar' ? '−' : op === 'establecer' ? '=' : '+';
  scanFeedback(true, `<div class="scan-result ok"><span class="big">${sign}${fmt(op === 'establecer' ? r.after : r.amount)}</span><div><strong class="mono">${esc(r.item.sku)}</strong>${r.created ? ' <span class="badge badge-success">Nuevo</span>' : ''}<div class="small">${esc(productName(r.item) || 'Sin marca')} · stock ${fmt(r.after)} ${esc(S.unitLabel(r.item.unitName))}</div></div></div>`);
  renderScanSession();
  focusScan();
}

function renderScanSession() {
  byId('ssReads').textContent = fmt(session.reads);
  byId('ssUnits').textContent = fmt(session.units);
  byId('ssProducts').textContent = fmt(session.products.size);
  byId('scanFeed').innerHTML = session.feed.length
    ? session.feed.map(f => `<div class="feed-item tl-${f.op === 'restar' ? 'out' : f.op === 'establecer' ? 'count' : 'in'} ${f.undone ? 'undone' : ''}">
        <span class="tl-icon">${icon(f.op === 'restar' ? 'arrow-out' : f.op === 'establecer' ? 'equal' : 'arrow-in')}</span>
        <div class="tl-body"><div class="tl-title"><strong class="mono">${esc(f.sku)}</strong> <span>${esc(f.name)}</span></div><div class="tl-sub">${fmt(f.before)} → ${fmt(f.after)} ${esc(f.unit)} · ${new Date(f.at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div></div>
        ${f.undone ? '<span class="badge">Revertido</span>' : `<button class="btn btn-ghost btn-sm" type="button" data-revert="${f.id}">${icon('undo', 'sm')}Revertir</button>`}</div>`).join('')
    : emptyState('scan', 'Sin lecturas todavía', 'Escaneá un código con la pistola o la cámara para empezar.');
}

function revertScan(id) {
  const f = session.feed.find(x => String(x.id) === String(id));
  if (!f || f.undone) return;
  const it = S.findById(f.itemId);
  if (!it) return toast('El producto ya no existe.', 'warn');
  const target = it.units - (f.after - f.before);
  if (target < 0) return toast('No se puede revertir: el stock quedaría negativo.', 'error');
  const r = S.setStock(it.id, target, 'Reversión de lectura', `Revierte ${S.OPERATIONS[f.op].toLowerCase()} de ${fmt(f.amount)}`);
  if (!r.ok) return toast(r.error, 'error');
  f.undone = true;
  session.reads = Math.max(0, session.reads - 1);
  session.units = Math.max(0, session.units - f.amount);
  renderScanSession();
  toast(`Lectura de ${f.sku} revertida`, 'info');
}

// Cámara (lecturas continuas en Escanear, una sola lectura para un campo)
let stopCam = null;
async function openCamera({ onCode, continuous = false }) {
  const d = byId('cameraDialog'), status = byId('cameraStatus');
  status.className = 'camera-status';
  status.textContent = 'Preparando la cámara…';
  d.showModal();
  try {
    stopCam = await startCamera(byId('cameraVideo'), code => {
      if (!continuous) { closeCamera(); onCode(code); return; }
      status.className = 'camera-status ok';
      status.textContent = `Leído: ${code}`;
      onCode(code);
    });
    if (d.open) status.textContent = continuous ? 'Cámara lista. Cada código se registra automáticamente.' : 'Cámara lista. Centrá el código.';
    else closeCamera();
  } catch (e) {
    closeCamera();
    toast(e?.name === 'NotAllowedError' ? 'Permití el acceso a la cámara en el navegador.' : (e?.message || 'No se pudo abrir la cámara.'), 'error');
  }
}
function closeCamera() {
  if (stopCam) { stopCam(); stopCam = null; }
  if (byId('cameraDialog').open) byId('cameraDialog').close();
}

// =========================================================
// Inventario
// =========================================================
const inv = { q: '', filter: 'all', sort: 'sku', selected: new Set(), limit: 150 };

function setInvFilter(f) {
  inv.filter = ['all', 'alert', 'zero'].includes(f) ? f : 'all';
  $$('#invFilters .chip').forEach(c => c.classList.toggle('active', c.dataset.f === inv.filter));
}

function invRows() {
  const q = inv.q.toLocaleLowerCase('es-AR');
  let rows = state.items.filter(i => !q || [i.sku, i.barcode, i.brand, i.type].some(v => String(v || '').toLocaleLowerCase('es-AR').includes(q)));
  if (inv.filter === 'alert') rows = rows.filter(i => i.units <= 0 || S.isLow(i));
  if (inv.filter === 'zero') rows = rows.filter(i => i.units <= 0);
  const by = {
    sku: (a, b) => a.sku.localeCompare(b.sku, 'es', { numeric: true }),
    brand: (a, b) => a.brand.localeCompare(b.brand, 'es') || a.sku.localeCompare(b.sku, 'es', { numeric: true }),
    desc: (a, b) => b.units - a.units, asc: (a, b) => a.units - b.units,
    recent: (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)),
  };
  return rows.sort(by[inv.sort] || by.sku);
}

function itemRow(i) {
  const d = S.displayQty(i), low = S.isLow(i), zero = i.units <= 0, sel = inv.selected.has(i.id);
  const sub = i.displayUnit === 'dozen' && i.unitName === 'unidades' ? `${fmt(i.units)} unidades` : i.unitName === 'unidades' && i.units >= 12 ? `${fmt(i.units / 12)} docenas` : '';
  return `<div class="inv-row ${sel ? 'selected' : ''}" data-id="${esc(i.id)}">
    <label class="check" title="Seleccionar"><input type="checkbox" data-act="select" ${sel ? 'checked' : ''} aria-label="Seleccionar ${esc(i.sku)}"><span></span></label>
    <div class="inv-product" data-act="edit"><div class="inv-sku mono">${esc(i.sku)}</div><div class="inv-meta">${esc(productName(i) || 'Sin marca ni prenda')}${i.barcode ? ` · ${esc(i.barcode)}` : ''}</div></div>
    <div class="inv-stock"><div class="qty ${zero ? 'is-zero' : low ? 'is-low' : ''}">${fmt(d.value)} <small>${esc(d.unit)}</small></div>${sub ? `<div class="qty-sub">${sub}</div>` : ''}</div>
    <div class="inv-tags">${zero ? '<span class="badge badge-danger">Sin stock</span>' : low ? '<span class="badge badge-warn">Bajo mínimo</span>' : ''}<span class="badge">${esc(S.stockTypeLabel(i.stockType))}</span></div>
    <div class="inv-actions">
      <div class="stepper sm"><button type="button" data-act="minus" title="Restar 1" aria-label="Restar 1">${icon('minus')}</button><button type="button" data-act="plus" title="Sumar 1" aria-label="Sumar 1">${icon('plus')}</button></div>
      <button class="icon-btn" type="button" data-act="label" title="Imprimir etiqueta">${icon('tag')}</button>
      <button class="icon-btn" type="button" data-act="edit" title="Editar">${icon('edit')}</button>
    </div></div>`;
}

function renderInventory() {
  const all = state.items;
  byId('cntAll').textContent = all.length;
  byId('cntAlert').textContent = all.filter(i => i.units <= 0 || S.isLow(i)).length;
  byId('cntZero').textContent = all.filter(i => i.units <= 0).length;
  for (const id of inv.selected) if (!S.findById(id)) inv.selected.delete(id);
  if (currentView !== 'inventario') { renderBulkBar(); return; }

  const rows = invRows(), shown = rows.slice(0, inv.limit);
  const allSel = rows.length > 0 && rows.every(i => inv.selected.has(i.id));
  const someSel = rows.some(i => inv.selected.has(i.id));
  byId('invList').innerHTML = !all.length
    ? `<div class="card">${emptyState('box', 'Tu inventario está vacío', 'Cargá tu primer producto por voz, con la pistola lectora o a mano.', `<div class="row center" style="margin-top:8px"><a class="btn btn-primary" href="#/cargar">${icon('plus')}Cargar producto</a><a class="btn btn-ghost" href="#/escanear">${icon('scan')}Escanear</a></div>`)}</div>`
    : !rows.length
      ? `<div class="card">${emptyState('search', 'Sin resultados', 'Probá con otra búsqueda o filtro.')}</div>`
      : `<div class="inv-list"><div class="inv-head"><label class="check" title="Seleccionar todos"><input type="checkbox" data-act="select-all" ${allSel ? 'checked' : ''} aria-label="Seleccionar todos"><span></span></label><span>Producto</span><span>Stock</span><span>Estado</span><span style="text-align:right">Acciones</span></div>
        ${shown.map(itemRow).join('')}</div>
        ${rows.length > shown.length ? `<div class="list-more"><button class="btn btn-ghost" type="button" data-act="more">Mostrar más (${rows.length - shown.length} restantes)</button></div>` : ''}`;
  const head = $('#invList [data-act="select-all"]');
  if (head) head.indeterminate = someSel && !allSel;
  renderBulkBar();
}

function renderBulkBar() {
  const n = inv.selected.size;
  byId('bulkBar').hidden = !n;
  byId('bulkCount').textContent = `${n} seleccionado${n === 1 ? '' : 's'}`;
}

function flashRow(id) { requestAnimationFrame(() => $(`.inv-row[data-id="${CSS.escape(id)}"]`)?.classList.add('flash')); }

function onInventoryClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'more') { inv.limit += 150; renderInventory(); return; }
  if (act === 'select-all') {
    const rows = invRows();
    if (el.checked) rows.forEach(i => inv.selected.add(i.id)); else rows.forEach(i => inv.selected.delete(i.id));
    renderInventory();
    return;
  }
  const id = el.closest('.inv-row')?.dataset.id, item = id && S.findById(id);
  if (!item) return;
  if (act === 'select') { el.checked ? inv.selected.add(id) : inv.selected.delete(id); el.closest('.inv-row').classList.toggle('selected', el.checked); renderBulkBar(); return; }
  if (act === 'edit') return openEdit(item);
  if (act === 'label') { labelsFor([id]); return; }
  if (act === 'plus' || act === 'minus') {
    const r = S.adjust(id, act === 'plus' ? 1 : -1);
    if (!r.ok) { toast(r.error, 'warn'); sound('warn'); return; }
    flashRow(id);
  }
}

// Edición individual
let editingId = null;
function openEdit(i) {
  editingId = i.id;
  byId('editSub').textContent = `Última modificación ${relTime(i.updatedAt)}`;
  byId('eSku').value = i.sku; byId('eBarcode').value = i.barcode || ''; byId('eBrand').value = i.brand; byId('eType').value = i.type;
  byId('eUnits').value = i.units; byId('eUnitName').value = i.unitName; byId('eMin').value = i.minStock || ''; byId('eStockType').value = i.stockType;
  byId('editDialog').showModal();
}
function saveEdit(e) {
  e.preventDefault();
  const r = S.saveItem(editingId, {
    sku: byId('eSku').value, barcode: byId('eBarcode').value, brand: byId('eBrand').value, type: byId('eType').value,
    units: byId('eUnits').value, unitName: byId('eUnitName').value, minStock: byId('eMin').value, stockType: byId('eStockType').value,
  });
  if (!r.ok) { toast(r.error, 'error'); shake(byId('eSave')); return; }
  byId('editDialog').close();
  toast('Producto actualizado', { action: () => S.undo() });
  flashRow(r.item.id);
}
async function deleteEditing() {
  const i = S.findById(editingId);
  if (!i) return;
  if (!(await ask({ title: `¿Eliminar ${i.sku}?`, message: 'Se quita del inventario. Podés deshacerlo enseguida.', confirm: 'Eliminar', danger: true }))) return;
  S.deleteItems([i.id]);
  byId('editDialog').close();
  toast(`${i.sku} eliminado`, { action: () => S.undo() });
}

// Acciones masivas
function openBulkEdit() {
  byId('bulkSub').textContent = `${inv.selected.size} productos seleccionados`;
  renderBulkValue();
  byId('bulkDialog').showModal();
}
function renderBulkValue() {
  const f = byId('bulkField').value;
  const opts = f === 'stockType' ? 'stockTypes' : f === 'unitName' ? 'stockUnits' : null;
  byId('bulkValueWrap').innerHTML = `<label for="bulkValue">Nuevo valor</label>${opts ? `<select id="bulkValue" class="input" data-options="${opts}"></select>` : `<input id="bulkValue" class="input" ${f === 'minStock' ? 'type="number" min="0" step="any"' : ''}>`}`
    + (f === 'unitName' ? '<p class="hint">Cambia solo la unidad, no convierte las cantidades.</p>' : '');
  if (opts) fillSelects(byId('bulkValueWrap'));
}
function applyBulk(e) {
  e.preventDefault();
  const field = byId('bulkField').value, value = byId('bulkValue').value;
  const n = S.bulkSet([...inv.selected], field, value);
  byId('bulkDialog').close();
  toast(`${n} productos actualizados`, { action: () => S.undo() });
}
async function bulkDelete() {
  const n = inv.selected.size;
  if (!(await ask({ title: `¿Eliminar ${n} productos?`, message: 'Podés deshacerlo enseguida con el botón Deshacer.', confirm: 'Eliminar', danger: true }))) return;
  S.deleteItems([...inv.selected]);
  inv.selected.clear();
  toast(`${n} productos eliminados`, { action: () => S.undo() });
}

// =========================================================
// Etiquetas
// =========================================================
const lbl = { selected: new Set(), custom: [], q: '' };

function labelsFor(ids) {
  lbl.selected = new Set(ids);
  location.hash = '#/etiquetas';
}

function labelEntries() {
  const base = [
    ...state.items.filter(i => lbl.selected.has(i.id)).map(i => ({ code: i.sku, name: productName(i), units: i.units })),
    ...lbl.custom.map(c => ({ code: c, name: '', units: 1 })),
  ];
  const out = [];
  let truncated = false;
  for (const e of base) {
    const n = prefs.lblByStock ? Math.max(1, Math.ceil(e.units)) : Math.max(1, Math.floor(num(prefs.lblCopies)) || 1);
    for (let k = 0; k < n; k++) {
      if (out.length >= L.MAX_LABELS) { truncated = true; break; }
      out.push(e);
    }
  }
  return { out, truncated, products: base.length };
}

function renderLabelList() {
  for (const id of lbl.selected) if (!S.findById(id)) lbl.selected.delete(id);
  const q = lbl.q.toLocaleLowerCase('es-AR');
  const rows = state.items.filter(i => !q || [i.sku, i.brand, i.type].some(v => String(v || '').toLocaleLowerCase('es-AR').includes(q)))
    .sort((a, b) => a.sku.localeCompare(b.sku, 'es', { numeric: true })).slice(0, 400);
  byId('lblList').innerHTML = rows.length
    ? rows.map(i => `<label class="check-item ${lbl.selected.has(i.id) ? 'on' : ''}"><span class="check"><input type="checkbox" value="${esc(i.id)}" ${lbl.selected.has(i.id) ? 'checked' : ''}><span></span></span><span class="grow"><div><strong class="mono">${esc(i.sku)}</strong></div><div class="small muted">${esc(productName(i) || 'Sin datos')} · ${fmt(i.units)} ${esc(S.unitLabel(i.unitName))}</div></span></label>`).join('')
    : emptyState('box', state.items.length ? 'Sin resultados' : 'No hay productos', state.items.length ? 'Probá otra búsqueda.' : 'Podés crear etiquetas para códigos nuevos abajo.');
  byId('lblCustomList').innerHTML = lbl.custom.map(c => `<span class="badge badge-primary mono">${esc(c)}<button type="button" class="toast-close" data-remove="${esc(c)}" aria-label="Quitar ${esc(c)}">${icon('x')}</button></span>`).join('');
  const n = lbl.selected.size + lbl.custom.length;
  byId('lblSelInfo').textContent = n ? `${n} producto${n === 1 ? '' : 's'} seleccionado${n === 1 ? '' : 's'}` : 'Ninguno seleccionado';
}

let previewToken = 0;
const renderLabelPreview = debounce(async () => {
  if (currentView !== 'etiquetas') return;
  const token = ++previewToken, box = byId('lblPreview');
  const { out, truncated } = labelEntries();
  const pages = L.pageCount(out.length, prefs.lblSize);
  byId('lblTotal').textContent = `${fmt(out.length)} etiqueta${out.length === 1 ? '' : 's'} · ${fmt(pages)} página${pages === 1 ? '' : 's'}${truncated ? ' (máx. 1000)' : ''}`;
  byId('lblPrint').disabled = !out.length;
  const opts = { kind: prefs.lblKind, size: prefs.lblSize, showName: prefs.lblShowName, header: txt(prefs.lblHeader) };
  const sample = out.length ? [...new Map(out.map(e => [e.code, e])).values()].slice(0, 6) : [{ code: 'EJEMPLO123', name: 'MARCA · PRENDA' }];
  box.innerHTML = '<div class="skeleton" style="width:190px;height:95px"></div>';
  try {
    await L.ensureLibs(opts.kind);
    if (token !== previewToken) return;
    box.innerHTML = sample.map(e => L.labelHTML(e, opts)).join('');
    if (!out.length) box.firstElementChild.style.opacity = '.55';
  } catch (e) {
    box.innerHTML = `<div class="notice warn">${icon('alert')}<span>${esc(e.message)}</span></div>`;
  }
}, 120);

async function printLabelsNow() {
  const { out, truncated } = labelEntries();
  if (!out.length) return toast('Elegí al menos un producto o código.', 'warn');
  if (truncated) toast('Se imprimen como máximo 1000 etiquetas por vez.', 'warn');
  const btn = byId('lblPrint');
  busy(btn, true);
  try { await L.printLabels(out, { kind: prefs.lblKind, size: prefs.lblSize, showName: prefs.lblShowName, header: txt(prefs.lblHeader) }); }
  catch (e) { toast(e.message || 'No se pudieron generar las etiquetas.', 'error'); }
  finally { busy(btn, false); }
}

// =========================================================
// Historial
// =========================================================
const hist = { q: '', kind: 'all', limit: 100 };
function renderHistory() {
  if (currentView !== 'historial') return;
  $$('#histFilters .chip').forEach(c => c.classList.toggle('active', c.dataset.k === hist.kind));
  const q = hist.q.toLocaleLowerCase('es-AR');
  const rows = state.history.filter(h => (hist.kind === 'all' || S.historyKind(h) === hist.kind || (hist.kind === 'edit' && ['delete', 'import'].includes(S.historyKind(h))))
    && (!q || [h.sku, h.brand, h.type, h.note, h.action].some(v => String(v || '').toLocaleLowerCase('es-AR').includes(q))));
  const shown = rows.slice(0, hist.limit);
  let html = '', day = '';
  for (const h of shown) {
    const d = new Date(h.at).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' });
    if (d !== day) { html += `<div class="tl-day">${esc(d)}</div>`; day = d; }
    html += historyRow(h);
  }
  byId('histList').innerHTML = html || emptyState('history', 'Sin movimientos', q || hist.kind !== 'all' ? 'No hay resultados para este filtro.' : 'Cuando cargues productos, vas a ver cada movimiento acá.');
  byId('histMore').hidden = rows.length <= shown.length;
  byId('histMore').textContent = `Ver más (${rows.length - shown.length})`;
}

// =========================================================
// Datos
// =========================================================
let pendingImport = null;
async function handleImportFile(file) {
  if (!file) return;
  try {
    pendingImport = await IO.readImportFile(file);
    if (!pendingImport.rows.length) throw new Error('No se encontraron filas válidas. El archivo necesita una columna de código/SKU y otra de cantidad.');
    byId('importSummary').textContent = `${pendingImport.rows.length} productos válidos de ${pendingImport.total} filas leídas${pendingImport.history ? ` · incluye ${pendingImport.history.length} movimientos de historial` : ''}.`;
    byId('importPreview').innerHTML = `<div class="table-wrap" style="max-height:340px"><table class="table"><thead><tr><th>Código</th><th>Marca</th><th>Prenda</th><th>Unidad</th><th>Cantidad</th></tr></thead><tbody>${pendingImport.rows.slice(0, 50).map(i => `<tr><td class="mono">${esc(i.sku)}</td><td>${esc(i.brand)}</td><td>${esc(i.type)}</td><td>${esc(S.unitLabel(i.unitName))}</td><td>${fmt(i.units)}</td></tr>`).join('')}</tbody></table></div>${pendingImport.rows.length > 50 ? `<p class="hint">Se muestran 50 de ${pendingImport.rows.length}.</p>` : ''}`;
    byId('importDialog').showModal();
  } catch (e) { toast(e.message || 'No se pudo leer el archivo.', 'error'); }
}
async function commitImport(replace) {
  if (!pendingImport) return;
  if (replace && !(await ask({ title: '¿Reemplazar todo el inventario?', message: 'Los productos actuales se reemplazan por los del archivo. Podés deshacerlo enseguida.', confirm: 'Reemplazar', danger: true }))) return;
  S.importItems(pendingImport.rows, replace, replace ? pendingImport.history : null);
  byId('importDialog').close();
  toast(`Importación aplicada: ${pendingImport.rows.length} productos`, { action: () => S.undo() });
  pendingImport = null;
}
function doBackup() { IO.backupJSON(); S.markBackup(); renderBanners(); renderStorageInfo(); toast('Copia de seguridad descargada'); }

function renderStorageInfo() {
  if (currentView !== 'datos') return;
  let bytes = 0;
  try { bytes = (localStorage.getItem('stockvoz_v5_state') || '').length * 2; } catch { /* sin acceso */ }
  const st = cloud.getStatus();
  byId('storageInfo').innerHTML = `
    <dt>Productos</dt><dd>${fmt(state.items.length)}</dd>
    <dt>Movimientos guardados</dt><dd>${fmt(state.history.length)}</dd>
    <dt>Espacio en este dispositivo</dt><dd>${fmt(bytes / 1024, 0)} KB</dd>
    <dt>Última copia JSON</dt><dd>${state.lastBackupAt ? relTime(state.lastBackupAt) : 'Nunca'}</dd>
    <dt>Nube</dt><dd>${!st.configured ? 'No configurada' : st.session ? `Sincronizada ${relTime(st.lastSyncAt)}` : 'Sin iniciar sesión'}</dd>
    <dt>Movimientos que se guardan en la nube</dt><dd>los últimos ${fmt(CONFIG.CLOUD_HISTORY_LIMIT)}</dd>`;
}

// =========================================================
// Cuenta y nube
// =========================================================
let authTab = 'login', pendingUser = null;

function syncLabel(st) {
  if (!st.session) return { ic: 'cloud-off', text: st.configured ? 'Solo local' : 'Modo local', tone: '' };
  if (!navigator.onLine || st.syncState === 'offline') return { ic: 'cloud-off', text: 'Sin conexión', tone: 'warn' };
  if (st.syncState === 'syncing') return { ic: 'refresh', text: 'Sincronizando', tone: 'busy' };
  if (st.syncState === 'error') return { ic: 'alert', text: 'Error de sincronización', tone: 'danger' };
  if (st.dirty) return { ic: 'cloud', text: 'Cambios por subir', tone: 'warn' };
  return { ic: 'cloud-check', text: 'En la nube', tone: 'success' };
}
function renderSync(st = cloud.getStatus()) {
  const s = syncLabel(st), chip = byId('syncChip');
  chip.className = `sync-chip ${s.tone}`;
  chip.innerHTML = `${icon(s.ic)}<span>${s.text}</span>`;
  chip.title = st.lastError || (st.session ? `Última sincronización: ${relTime(st.lastSyncAt)}` : 'Los datos se guardan en este dispositivo');
  const av = byId('avatarBtn');
  av.innerHTML = st.session ? esc(initials(st.session.fullName || st.session.username)) : icon('user');
  av.title = st.session ? `@${st.session.username}` : 'Cuenta';
  updateGate(st);
  if (currentView === 'cuenta') renderAccountStatusOnly(st);
}

function renderAccount() {
  const st = cloud.getStatus(), el = byId('accountArea');
  if (!st.configured) {
    el.innerHTML = `<div class="card auth-card"><div class="auth-head"><span class="auth-icon">${icon('database')}</span><div><h3>Nube no configurada</h3><p>Tus datos se guardan en este dispositivo. Para activar cuentas y respaldo en la nube, el administrador tiene que conectar Supabase.</p></div></div>
      <ol class="steps"><li>Ejecutar <code>supabase/schema.sql</code> en el SQL Editor de Supabase.</li><li>Completar <code>SUPABASE_URL</code> y <code>SUPABASE_ANON_KEY</code> en <code>js/config.js</code>.</li><li>Publicar los cambios en GitHub/Vercel.</li></ol></div>`;
    return;
  }
  if (st.session) {
    el.innerHTML = `<div class="card auth-card"><div class="profile-head"><span class="avatar lg">${esc(initials(st.session.fullName || st.session.username))}</span><div><h3>${esc(st.session.fullName || st.session.username)}</h3><p class="muted">@${esc(st.session.username)} · <span class="badge badge-success">${icon('check')}Cuenta aprobada</span></p></div></div>
      <div class="sync-box" id="accSync"></div>
      <div class="row"><button class="btn btn-primary" type="button" id="accSyncBtn">${icon('refresh')}<span>Sincronizar ahora</span></button><button class="btn btn-ghost" type="button" id="accLogout">${icon('logout')}<span>Cerrar sesión</span></button></div>
      <p class="hint" style="margin-top:14px">Para cuidar los recursos gratuitos, los cambios se agrupan y se suben ${Math.round(CONFIG.SYNC_DELAY_MS / 1000)} segundos después del último movimiento. Si no hay internet, se suben solos al reconectar.</p></div>`;
    renderAccountStatusOnly(st);
    byId('accSyncBtn').onclick = async e => {
      const b = e.currentTarget; busy(b, true);
      await cloud.syncNow({ force: true });
      busy(b, false);
      const s = cloud.getStatus();
      if (s.syncState === 'idle') { flashDone(b); toast('Datos sincronizados'); } else toast(s.lastError || 'No se pudo sincronizar.', 'error');
    };
    byId('accLogout').onclick = doLogout;
    return;
  }
  el.innerHTML = '';
  el.append(buildAuth());
}
function renderAccountStatusOnly(st) {
  const box = byId('accSync');
  if (!box) return;
  const s = syncLabel(st);
  box.innerHTML = `<span class="card-icon" style="${s.tone === 'success' ? 'background:var(--success-soft);color:var(--success)' : ''}">${icon(s.ic)}</span><div class="grow"><strong>${s.text}</strong><div class="small muted">${st.lastError ? esc(st.lastError) : `Última sincronización: ${relTime(st.lastSyncAt)}`}</div></div>`;
}

function buildAuth() {
  const wrap = document.createElement('div');
  wrap.className = 'card auth-card';
  const adminMsg = u => `Hola, me registré en StockVoz con el usuario "${u.username}"${u.fullName ? ` (${u.fullName}${u.business ? ', ' + u.business : ''})` : ''}. ¿Me das de alta, por favor?`;
  if (pendingUser) {
    wrap.innerHTML = `<div class="pending"><span class="pending-icon">${icon('clock')}</span><h3>Cuenta pendiente de aprobación</h3>
      <p>El usuario <b>${esc(pendingUser.username)}</b> fue creado. El administrador tiene que darte de alta: avisale por WhatsApp para que sea más rápido.</p>
      <a class="btn btn-wa btn-lg" href="${waLink(CONFIG.ADMIN_WHATSAPP, adminMsg(pendingUser))}" target="_blank" rel="noopener noreferrer">${icon('whatsapp')}Avisar al administrador</a>
      <button class="btn btn-ghost" type="button" data-to-login>Ya me aprobaron · Ingresar</button></div>`;
    wrap.querySelector('[data-to-login]').onclick = () => { authTab = 'login'; const u = pendingUser.username; pendingUser = null; rerenderAuth(); setTimeout(() => { const f = $('[data-form="login"] [name="username"]'); if (f) { f.value = u; $('[data-form="login"] [name="password"]')?.focus(); } }, 0); };
    return wrap;
  }
  const pwd = (name, label, auto) => `<div class="field"><label>${label}</label><div class="pwd"><input class="input" name="${name}" type="password" autocomplete="${auto}" required minlength="6" maxlength="72"><button type="button" class="icon-btn" data-eye aria-label="Mostrar contraseña">${icon('eye')}</button></div></div>`;
  wrap.innerHTML = `<div class="auth-head"><span class="auth-icon">${icon('cloud')}</span><div><h3>Guardá tu stock en la nube</h3><p>Respaldá tus datos y usalos en todos tus dispositivos. El administrador aprueba cada cuenta nueva.</p></div></div>
    <div class="segmented" data-tabs><button type="button" data-v="login">Ingresar</button><button type="button" data-v="register">Crear cuenta</button></div>
    <form class="auth-form" data-form="login" novalidate>
      <div class="field"><label>Usuario</label><input class="input" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required></div>
      ${pwd('password', 'Contraseña', 'current-password')}
      <button class="btn btn-primary btn-lg" type="submit">${icon('logout')}<span>Ingresar</span></button>
    </form>
    <form class="auth-form" data-form="register" novalidate>
      <div class="form-grid">
        <div class="field"><label>Nombre y apellido *</label><input class="input" name="fullName" autocomplete="name" required maxlength="80"></div>
        <div class="field"><label>Negocio</label><input class="input" name="business" autocomplete="organization" maxlength="80" placeholder="Opcional"></div>
        <div class="field span-2"><label>WhatsApp *</label><input class="input" name="phone" type="tel" autocomplete="tel" required placeholder="Ej.: 11 2345 6789"></div>
        <div class="field span-2"><label>Usuario *</label><input class="input" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required minlength="3" maxlength="30" placeholder="Ej.: tienda.centro"><p class="hint">3 a 30 caracteres: letras minúsculas, números, punto, guion o guion bajo.</p></div>
        ${pwd('password', 'Contraseña *', 'new-password')}
        ${pwd('password2', 'Repetir contraseña *', 'new-password')}
      </div>
      <button class="btn btn-primary btn-lg" type="submit">${icon('send')}<span>Solicitar acceso</span></button>
    </form>`;
  const tabs = wrap.querySelector('[data-tabs]');
  const showTab = t => { authTab = t; segmented(tabs, t); wrap.querySelector('[data-form="login"]').hidden = t !== 'login'; wrap.querySelector('[data-form="register"]').hidden = t !== 'register'; };
  onSegment(tabs, showTab);
  showTab(authTab);
  wrap.addEventListener('click', e => {
    const eye = e.target.closest('[data-eye]');
    if (eye) { const inp = eye.previousElementSibling; inp.type = inp.type === 'password' ? 'text' : 'password'; }
  });

  wrap.querySelector('[data-form="login"]').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target), btn = e.target.querySelector('[type="submit"]');
    const username = txt(f.get('username')).toLowerCase(), password = String(f.get('password') || '');
    if (!username || !password) { shake(btn); return toast('Completá usuario y contraseña.', 'warn'); }
    busy(btn, true);
    try {
      const r = await cloud.login(username, password);
      if (r.status === 'approved') { flashDone(btn); toast(`¡Hola, ${cloud.getSession().fullName || username}! Tus datos están en la nube.`); rerenderAuth(); renderPanel(); }
      else if (r.status === 'pending') { pendingUser = { username }; rerenderAuth(); toast('Tu cuenta todavía está pendiente de aprobación.', 'warn'); }
      else toast('Tu cuenta está deshabilitada. Contactá al administrador.', 'error');
    } catch (err) { shake(btn); toast(err.message, 'error'); }
    finally { busy(btn, false); }
  };
  wrap.querySelector('[data-form="register"]').onsubmit = async e => {
    e.preventDefault();
    const f = new FormData(e.target), btn = e.target.querySelector('[type="submit"]');
    const u = { fullName: txt(f.get('fullName')), business: txt(f.get('business')), phone: txt(f.get('phone')), username: txt(f.get('username')).toLowerCase(), password: String(f.get('password') || '') };
    const err = !u.fullName ? 'Ingresá tu nombre.' : u.phone.replace(/\D/g, '').length < 8 ? 'Ingresá un WhatsApp válido.'
      : !/^[a-z0-9._-]{3,30}$/.test(u.username) ? 'El usuario debe tener de 3 a 30 caracteres: letras minúsculas, números, punto, guion o guion bajo.'
      : u.password.length < 6 ? 'La contraseña debe tener al menos 6 caracteres.' : u.password !== f.get('password2') ? 'Las contraseñas no coinciden.' : '';
    if (err) { shake(btn); return toast(err, 'warn'); }
    busy(btn, true);
    try {
      await cloud.register(u);
      pendingUser = u;
      rerenderAuth();
      toast('¡Cuenta creada! Ahora avisale al administrador.');
    } catch (er) { shake(btn); toast(er.message, 'error'); }
    finally { busy(btn, false); }
  };
  return wrap;
}
function rerenderAuth() {
  if (!byId('authGate').hidden) { const g = byId('gateAuth'); g.innerHTML = ''; if (!cloud.getSession()) g.append(buildAuth()); }
  if (currentView === 'cuenta') renderAccount();
}

function updateGate(st) {
  const lock = CONFIG.REQUIRE_LOGIN && st.configured && !st.session;
  const gate = byId('authGate');
  if (lock && gate.hidden) {
    gate.hidden = false;
    byId('gateAuth').innerHTML = ''; byId('gateAuth').append(buildAuth());
    byId('gateCreator').innerHTML = `<a class="creator-mini" href="${waLink(CONFIG.ADMIN_WHATSAPP, CREATOR.message)}" target="_blank" rel="noopener noreferrer"><img src="${CREATOR.photo}" alt="" width="40" height="40"><span><small>Creado por</small><strong>${CREATOR.name}</strong></span>${icon('whatsapp')}</a>`;
  } else if (!lock && !gate.hidden) gate.hidden = true;
}

async function doLogout() {
  const choice = await ask({
    title: '¿Cerrar sesión?', message: 'Tus datos ya están guardados en la nube. ¿Qué hacemos con la copia de este dispositivo?',
    choices: [{ label: 'Cerrar sesión y conservar los datos aquí', value: 'keep', primary: true }, { label: 'Cerrar sesión y borrar los datos de este dispositivo', value: 'wipe', danger: true }],
  });
  if (!choice) return;
  await cloud.logout();
  if (choice === 'wipe') S.wipeLocal();
  toast('Sesión cerrada', 'info');
  renderAccount(); renderPanel();
}

async function askConflict(remote) {
  const choice = await ask({
    title: 'Hay datos en la nube y en este dispositivo',
    message: `Nube: ${remote.items?.length || 0} productos. Este dispositivo: ${state.items.length} productos.\n¿Cómo querés seguir?`,
    choices: [
      { label: 'Combinar ambos (recomendado)', value: 'merge', primary: true },
      { label: 'Usar solo los datos de la nube', value: 'cloud' },
      { label: 'Usar solo los de este dispositivo', value: 'local' },
    ],
    cancel: 'Decidir más tarde (combinar)',
  });
  return choice || 'merge';
}

// =========================================================
// Tema, instalación y atajos
// =========================================================
function setTheme(t) {
  const theme = t === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('stockvoz_theme', theme); } catch { /* sin almacenamiento */ }
  $('meta[name="theme-color"]').content = theme === 'light' ? '#f3f5fb' : '#070c18';
  byId('themeBtn').innerHTML = icon(theme === 'light' ? 'moon' : 'sun');
  segmented(byId('themeSeg'), theme);
}

let deferredInstall = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredInstall = e; byId('installBtn').hidden = false; });

function onKeydown(e) {
  const editing = e.target.closest?.('input, textarea, select, [contenteditable]');
  if (e.key === 'F2') { e.preventDefault(); location.hash = '#/escanear'; focusScan(); return; }
  if (e.key === 'Escape') closeSheet();
  if (editing || document.querySelector('dialog[open]')) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); doUndo(); }
  else if (e.key === '/' && !e.ctrlKey) { e.preventDefault(); location.hash = '#/inventario'; setTimeout(() => byId('invSearch').focus(), 50); }
}
function doUndo() { if (S.undo()) toast('Se deshizo el último cambio', 'info'); else toast('No hay nada para deshacer.', 'warn'); }

// =========================================================
// Render general y arranque
// =========================================================
function renderDatalists() {
  const uniq = k => [...new Set(state.items.map(i => i[k]).filter(Boolean))].sort().slice(0, 300);
  byId('brandList').innerHTML = uniq('brand').map(v => `<option value="${esc(v)}">`).join('');
  byId('typeList').innerHTML = uniq('type').map(v => `<option value="${esc(v)}">`).join('');
}
function renderAll() {
  byId('navCount').textContent = state.items.length;
  byId('undoBtn').disabled = !S.canUndo();
  if (currentView === 'panel') renderPanel();
  renderInventory();
  renderHistory();
  renderStorageInfo();
  if (currentView === 'etiquetas') { renderLabelList(); renderLabelPreview(); }
  if (currentView === 'cargar') updateFormNotice();
  renderDatalists();
}

function bindEvents() {
  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', onKeydown);
  byId('moreBtn').onclick = openSheet;
  byId('sheetBackdrop').onclick = closeSheet;
  byId('sheetUndo').onclick = () => { closeSheet(); doUndo(); };
  byId('undoBtn').onclick = doUndo;
  byId('themeBtn').onclick = () => setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
  onSegment(byId('themeSeg'), setTheme);
  byId('syncChip').onclick = () => { location.hash = '#/cuenta'; };
  byId('installBtn').onclick = async () => { if (!deferredInstall) return; deferredInstall.prompt(); await deferredInstall.userChoice; deferredInstall = null; byId('installBtn').hidden = true; };
  document.addEventListener('click', e => { if (e.target.closest('[data-act="backup"]')) doBackup(); });
  // Cerrar diálogos con sus botones [data-close]
  $$('dialog.modal').forEach(d => d.addEventListener('click', e => { if (e.target.closest('[data-close]') || e.target === d) d.close(); }));
  byId('cameraDialog').addEventListener('close', () => { closeCamera(); focusScan(); });

  // Tarea
  $$('.task-select').forEach(s => s.addEventListener('change', () => setTask(s.value)));

  // Cargar
  byId('micBtn').onclick = toggleMic;
  byId('interpretBtn').onclick = interpret;
  byId('clearTranscript').onclick = () => { byId('transcript').value = ''; byId('transcript').focus(); };
  onSegment(byId('opSeg'), setFormOp);
  byId('productForm').addEventListener('submit', saveProduct);
  byId('productForm').addEventListener('input', debounce(updateFormNotice, 80));
  F.sku.addEventListener('change', syncUnitWithProduct);
  F.sku.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); syncUnitWithProduct(); F.qty.focus(); } }); // pistola dentro del campo
  byId('fSkuGen').onclick = () => { F.sku.value = S.generateSku(F.brand.value, F.type.value); highlight(F.sku); updateFormNotice(); };
  byId('fSkuCam').onclick = () => openCamera({ onCode: c => { F.sku.value = upper(c); highlight(F.sku); syncUnitWithProduct(); } });
  byId('resetForm').onclick = () => { resetForm(); F.sku.focus(); };
  byId('speakForm').onclick = speakForm;

  // Escanear
  byId('scanForm').addEventListener('submit', e => { e.preventDefault(); const v = byId('scanInput').value; byId('scanInput').value = ''; handleScan(v, 'escáner'); });
  byId('scanInput').addEventListener('focus', setScanReady);
  byId('scanInput').addEventListener('blur', setScanReady);
  onSegment(byId('scanOpSeg'), setScanOp);
  byId('scanQty').addEventListener('input', () => { prefs.scanQty = num(byId('scanQty').value) || 1; savePrefs(); });
  byId('scanUnknown').onchange = e => { prefs.scanUnknown = e.target.value; savePrefs(); };
  byId('scanSound').onchange = e => { prefs.sound = e.target.checked; savePrefs(); };
  byId('scanCamera').onclick = () => openCamera({ continuous: true, onCode: c => handleScan(c, 'cámara') });
  byId('scanNewSession').onclick = () => { Object.assign(session, { reads: 0, units: 0, products: new Set(), counted: new Set(), feed: [] }); byId('scanLast').innerHTML = ''; renderScanSession(); toast('Nueva sesión de escaneo', 'info'); focusScan(); };
  byId('scanFeed').addEventListener('click', e => { const b = e.target.closest('[data-revert]'); if (b) revertScan(b.dataset.revert); });
  byId('scanHero').addEventListener('click', e => { if (!e.target.closest('button, input')) focusScan(); });

  // Inventario
  byId('invSearch').addEventListener('input', debounce(e => { inv.q = e.target.value; inv.limit = 150; renderInventory(); }, 120));
  byId('invSort').onchange = e => { inv.sort = e.target.value; renderInventory(); };
  byId('invFilters').addEventListener('click', e => { const c = e.target.closest('[data-f]'); if (c) { setInvFilter(c.dataset.f); inv.limit = 150; renderInventory(); } });
  byId('invList').addEventListener('click', onInventoryClick);
  byId('bulkClear').onclick = () => { inv.selected.clear(); renderInventory(); };
  byId('bulkLabels').onclick = () => labelsFor([...inv.selected]);
  byId('bulkEdit').onclick = openBulkEdit;
  byId('bulkDelete').onclick = bulkDelete;
  byId('bulkField').onchange = renderBulkValue;
  byId('bulkForm').addEventListener('submit', applyBulk);
  byId('editForm').addEventListener('submit', saveEdit);
  byId('eDelete').onclick = deleteEditing;
  byId('eLabel').onclick = () => { byId('editDialog').close(); labelsFor([editingId]); };
  byId('eBarcodeCam').onclick = () => openCamera({ onCode: c => { byId('eBarcode').value = upper(c); } });

  // Etiquetas
  onSegment(byId('lblKind'), v => { prefs.lblKind = v; savePrefs(); segmented(byId('lblKind'), v); renderLabelPreview(); });
  byId('lblSize').onchange = e => { prefs.lblSize = e.target.value; savePrefs(); renderLabelPreview(); };
  byId('lblCopies').addEventListener('input', e => { prefs.lblCopies = Math.max(1, Math.floor(num(e.target.value)) || 1); savePrefs(); renderLabelPreview(); });
  byId('lblHeader').addEventListener('input', e => { prefs.lblHeader = e.target.value; savePrefs(); renderLabelPreview(); });
  byId('lblShowName').onchange = e => { prefs.lblShowName = e.target.checked; savePrefs(); renderLabelPreview(); };
  byId('lblByStock').onchange = e => { prefs.lblByStock = e.target.checked; savePrefs(); byId('lblCopies').disabled = e.target.checked; renderLabelPreview(); };
  byId('lblSearch').addEventListener('input', debounce(e => { lbl.q = e.target.value; renderLabelList(); }, 120));
  byId('lblList').addEventListener('change', e => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    cb.checked ? lbl.selected.add(cb.value) : lbl.selected.delete(cb.value);
    cb.closest('.check-item').classList.toggle('on', cb.checked);
    renderLabelList(); renderLabelPreview();
  });
  byId('lblAll').onclick = () => { $$('#lblList input[type="checkbox"]').forEach(cb => lbl.selected.add(cb.value)); renderLabelList(); renderLabelPreview(); };
  byId('lblNone').onclick = () => { lbl.selected.clear(); lbl.custom = []; renderLabelList(); renderLabelPreview(); };
  byId('lblCustomGen').onclick = () => { byId('lblCustom').value = S.generateSku(); };
  byId('lblCustomForm').addEventListener('submit', e => {
    e.preventDefault();
    const c = upper(byId('lblCustom').value).replace(/\s+/g, '');
    if (!c) return toast('Escribí o generá un código.', 'warn');
    const existing = S.findByCode(c);
    if (existing) lbl.selected.add(existing.id); else if (!lbl.custom.includes(c)) lbl.custom.push(c);
    byId('lblCustom').value = '';
    renderLabelList(); renderLabelPreview();
  });
  byId('lblCustomList').addEventListener('click', e => { const b = e.target.closest('[data-remove]'); if (b) { lbl.custom = lbl.custom.filter(c => c !== b.dataset.remove); renderLabelList(); renderLabelPreview(); } });
  byId('lblPrint').onclick = printLabelsNow;

  // Historial
  byId('histSearch').addEventListener('input', debounce(e => { hist.q = e.target.value; hist.limit = 100; renderHistory(); }, 150));
  byId('histFilters').addEventListener('click', e => { const c = e.target.closest('[data-k]'); if (c) { hist.kind = c.dataset.k; hist.limit = 100; renderHistory(); } });
  byId('histMore').onclick = () => { hist.limit += 100; renderHistory(); };
  byId('histExport').onclick = () => { if (!IO.exportHistoryCSV()) toast('No hay movimientos para exportar.', 'warn'); };
  byId('histClear').onclick = async () => { if (await ask({ title: '¿Borrar todo el historial?', message: 'El stock no cambia. Podés deshacerlo enseguida.', confirm: 'Borrar historial', danger: true })) { S.clearHistory(); toast('Historial borrado', { action: () => S.undo() }); } };

  // Datos
  byId('expXlsx').onclick = async e => {
    const b = e.currentTarget; busy(b, true);
    try { if (await IO.exportXLSX()) toast('Excel descargado'); else toast('No hay productos para exportar.', 'warn'); }
    catch (er) { toast(er.message || 'No se pudo generar el Excel. Probá con CSV.', 'error'); }
    finally { busy(b, false); }
  };
  byId('expCsv').onclick = () => { if (IO.exportInventoryCSV()) toast('CSV descargado'); else toast('No hay productos para exportar.', 'warn'); };
  byId('expJson').onclick = doBackup;
  byId('importInput').onchange = e => { handleImportFile(e.target.files[0]); e.target.value = ''; };
  const dz = byId('dropzone');
  dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('over'); handleImportFile(e.dataTransfer.files[0]); });
  byId('importReplace').onclick = () => commitImport(true);
  byId('importMerge').onclick = () => commitImport(false);
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !location.protocol.startsWith('http')) return;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      reg.addEventListener('updatefound', () => {
        const w = reg.installing;
        w?.addEventListener('statechange', () => {
          if (w.state === 'activated' && navigator.serviceWorker.controller) {
            toast('Hay una versión nueva de StockVoz.', { type: 'info', actionLabel: 'Actualizar', action: () => location.reload(), duration: 15000 });
          }
        });
      });
    } catch { /* sin modo offline */ }
  });
}

function init() {
  const loaded = S.load();
  if (!loaded.ok) toast('No se pudieron leer los datos locales. Podés restaurar una copia JSON en Datos.', 'error');
  else if (loaded.migrated) toast('Se recuperaron datos de una versión anterior. Te recomendamos descargar una copia.', 'warn');

  fillSelects();
  hydrateIcons();
  initRipple();
  renderCreator();
  setTheme(document.documentElement.dataset.theme);
  setTask(prefs.task);
  setFormOp(prefs.formOp);
  setScanOp(prefs.scanOp);
  byId('scanQty').value = prefs.scanQty;
  byId('scanUnknown').value = prefs.scanUnknown;
  byId('scanSound').checked = prefs.sound;
  segmented(byId('lblKind'), prefs.lblKind);
  byId('lblSize').value = L.LABEL_SIZES[prefs.lblSize] ? prefs.lblSize : 'r50x25';
  byId('lblCopies').value = prefs.lblCopies;
  byId('lblCopies').disabled = prefs.lblByStock;
  byId('lblHeader').value = prefs.lblHeader;
  byId('lblShowName').checked = prefs.lblShowName;
  byId('lblByStock').checked = prefs.lblByStock;
  setInvFilter('all');
  byId('voiceBadge').className = `badge ${recog ? 'badge-success' : 'badge-warn'}`;
  byId('voiceBadge').textContent = recog ? 'Disponible' : 'No disponible';
  if (!recog) { byId('micBtn').disabled = true; byId('micStatus').textContent = 'Este navegador no admite dictado. Escribí el producto o usá Chrome.'; }

  bindEvents();
  initHardwareScanner(code => handleScan(code, 'pistola'));

  S.subscribe(() => { renderAll(); cloud.schedulePush(); });
  cloud.setHooks({
    conflict: askConflict,
    sessionLost: () => { toast('Tu sesión venció o tu cuenta fue deshabilitada. Ingresá de nuevo.', 'warn'); rerenderAuth(); },
  });
  cloud.onStatus(st => { renderSync(st); if (currentView === 'datos') renderStorageInfo(); });
  renderSync();
  renderDatalists();
  byId('navCount').textContent = state.items.length;
  route();
  cloud.start();
  registerServiceWorker();
  setInterval(() => { if (currentView === 'panel') renderPanel(); renderSync(); }, 60000);
}

init();
