// StockVoz · interfaz principal: navegación, vistas y eventos.
import { CONFIG } from './config.js';
import {
  byId, $, $$, esc, icon, hydrateIcons, toast, ask, fmt, txt, upper, num, debounce, relTime, busy, flashDone, shake,
  beep, vibrate, initInteractions, animateNumber, readJSON, writeJSON, initials, waLink,
} from './utils.js';
import * as S from './store.js';
import * as cloud from './cloud.js';
import { parseSpeech, createRecognizer } from './voice.js';
import { initHardwareScanner, startCamera } from './scanner.js';
import * as L from './labels.js';
import * as IO from './io.js';
import * as R from './reports.js';
import { shareRemito, downloadRemito, waNumber } from './remito.js';

const { state } = S;

// ---------- Preferencias del dispositivo ----------
const PREFS_KEY = 'stockvoz_prefs';
const prefs = {
  task: 'inventario', formOp: 'sumar', scanOp: 'sumar', scanQty: 1, scanUnknown: 'ask', sound: true, voiceAutoSave: true, voiceSpeak: true,
  lblKind: 'barcode', lblSize: 'r50x25', lblCopies: 1, lblByStock: false, lblShowName: true, lblHeader: '',
  lblMode: 'product', lblQtyMode: 'stock', lblFixed: 1, lblList: '', lblRestart: false,
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
  escanear: ['Escanear', 'Salidas, entradas y conteos con la pistola'],
  inventario: ['Inventario', 'Todos tus productos'],
  etiquetas: ['Etiquetas', 'Códigos de barras y QR para imprimir'],
  historial: ['Historial', 'Todos los movimientos registrados'],
  datos: ['Datos y respaldos', 'Exportar, importar y copias de seguridad'],
  cuenta: ['Cuenta y nube', 'Respaldo, sincronización y apariencia'],
  clientes: ['Clientes y proveedores', 'Contactos y remitos'],
  reportes: ['Reportes', 'Ventas, ingresos, equipo y control de faltantes'],
  kiosco: ['Modo mostrador', 'Pantalla simple para escanear'],
  ayuda: ['Ayuda', 'Manual de uso paso a paso'],
};
const MORE_VIEWS = ['etiquetas', 'historial', 'datos', 'cuenta', 'clientes', 'reportes', 'kiosco', 'ayuda'];
// Solo la dueña: el historial y los reportes (los empleados ni siquiera los descargan).
const OWNER_VIEWS = ['historial', 'reportes'];
let currentView = 'panel';

const sound = kind => { if (prefs.sound) { beep(kind); vibrate(kind === 'ok' ? 35 : [80, 60, 80]); } };
const productName = i => [i.brand, i.type].filter(Boolean).join(' · ');

// =========================================================
// Navegación
// =========================================================
function route() {
  const [name, query] = location.hash.replace(/^#\/?/, '').split('?');
  let view = VIEWS[name] ? name : 'panel';
  if (OWNER_VIEWS.includes(view) && !canManage()) { toast('El historial y los reportes son solo para la dueña de la cuenta.', 'warn'); view = 'panel'; history.replaceState(null, '', '#/panel'); }
  showView(view, new URLSearchParams(query || ''));
}

function showView(view, params = new URLSearchParams()) {
  const changed = view !== currentView;
  currentView = view;
  document.body.classList.toggle('kiosk-mode', view === 'kiosco');
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
  escanear: params => {
    renderScanSession();
    // Accesos directos del Panel: #/escanear?op=restar abre directo en Salida.
    const op = params.get('op');
    if (op) { history.replaceState(null, '', '#/escanear'); if (op !== prefs.scanOp) { chooseScanOp(op); return; } }
    focusScan();
  },
  inventario: params => { if (params.get('f')) setInvFilter(params.get('f')); renderInventory(); },
  etiquetas: () => { renderLabelList(); renderLabelPreview(); },
  historial: renderHistory,
  datos: renderStorageInfo,
  cuenta: renderAccount,
  clientes: renderContacts,
  reportes: renderReports,
  kiosco: enterKiosk,
  ayuda: params => {
    const t = params.get('s') && byId(`m-${params.get('s')}`);
    if (t) { t.open = true; setTimeout(() => t.scrollIntoView({ block: 'start', behavior: 'smooth' }), 60); }
  },
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
const KIND_ICON = { in: 'arrow-in', out: 'arrow-out', count: 'equal', edit: 'edit', delete: 'trash', import: 'upload', fix: 'undo' };
// Cantidad legible de un movimiento: "−1 docena" (12 unidades), "+5 unidades", "= 240 unidades".
const plural = (n, one, many) => `${fmt(n)} ${Number(n) === 1 ? one : many}`;
const UNIT_WORDS = { unidades: ['unidad', 'unidades'], docenas: ['docena', 'docenas'], cajas: ['caja', 'cajas'], paquetes: ['paquete', 'paquetes'], pares: ['par', 'pares'], rollos: ['rollo', 'rollos'] };
const unitWords = (n, unit) => (UNIT_WORDS[unit] ? plural(n, ...UNIT_WORDS[unit]) : `${fmt(n)} ${unit || ''}`.trim());
function movementQty(h) {
  const k = S.historyKind(h);
  if (!['in', 'out', 'count'].includes(k)) return null;
  if (k === 'count') return { main: `= ${unitWords(h.after, h.unit || 'unidades')}`, sub: 'conteo físico' };
  const sign = k === 'out' ? '−' : '+', e = S.enteredOf(h);
  if (e?.unit === 'docenas') return { main: `${sign}${unitWords(e.qty, 'docenas')}`, sub: unitWords(h.quantity, 'unidades') };
  return { main: `${sign}${unitWords(h.quantity ?? e?.qty, e?.unit || h.unit || 'unidades')}`, sub: '' };
}
const timeOf = iso => new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });
const dateTimeOf = iso => new Date(iso).toLocaleString('es-AR', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

// Permisos: en modo local o como dueño se puede todo; los empleados no pueden corregir ni borrar.
const canManage = () => cloud.isOwner();
function ownerOnly(what) {
  if (canManage()) return true;
  toast(`Solo el dueño de la cuenta puede ${what}.`, 'warn');
  return false;
}
const canFix = h => canManage() && !h.voided && ['in', 'out', 'count'].includes(S.historyKind(h)) && h.before != null && h.after != null && !!S.findByCode(h.sku);

// opts.time: mostrar la hora (en listas agrupadas por día) en lugar de "hace 5 min".
function historyRow(h, opts = {}) {
  const k = S.historyKind(h), si = S.serialInfo(h.serial), src = S.sourceOf(h);
  let q = movementQty(h);
  if (h.corrected && q) {
    const to = h.corrected.to, sign = k === 'out' ? '−' : k === 'in' ? '+' : '= ';
    q = { main: `${sign}${unitWords(k === 'count' ? to.after : to.qty, k === 'count' ? (h.unit || 'unidades') : to.unit)}`, sub: `antes: ${q.main}` };
  }
  const change = h.before != null && h.after != null ? `stock ${fmt(h.before)} → ${fmt(h.after)}${h.unit ? ' ' + esc(h.unit) : ''}` : '';
  const who = [src && `por ${esc(src)}`, h.by && `@${esc(h.by)}`].filter(Boolean).join(' ');
  const party = h.contact ? `${h.contact.kind === 'proveedor' ? 'de' : 'para'} <b>${esc(h.contact.name)}</b>` : '';
  const sub = [esc([h.brand, h.type].filter(Boolean).join(' · ')), change, party, who].filter(Boolean).join(' · ');
  const fixNote = h.voided ? `Anulado${h.voided.by ? ` por @${esc(h.voided.by)}` : ''} el ${esc(dateTimeOf(h.voided.at))} · ${esc(h.voided.reason)}`
    : h.corrected ? `Corregido${h.corrected.by ? ` por @${esc(h.corrected.by)}` : ''} el ${esc(dateTimeOf(h.corrected.at))} · ${esc(h.corrected.reason)}` : '';
  const fixBtn = canFix(h) ? `<button type="button" class="icon-btn tl-fix-btn" data-fix="${esc(h.id)}" title="Corregir o anular este movimiento" aria-label="Corregir movimiento">${icon('edit')}</button>` : '';
  return `<div class="tl-item tl-${k} ${h.voided ? 'is-voided' : ''}" data-move="${esc(h.id)}" ${h.sku ? `data-sku="${esc(h.sku)}"` : ''} tabindex="0" title="Ver el detalle"><span class="tl-icon">${icon(KIND_ICON[k] || 'edit')}</span>
    <div class="tl-body"><div class="tl-title"><strong class="mono">${esc(h.sku) || '—'}</strong> <span>${esc(h.action)}</span>${si ? ` <span class="badge badge-primary">${icon('tag')}${esc(si.label)}</span>` : ''}${h.voided ? ' <span class="badge badge-danger">Anulado</span>' : h.corrected ? ' <span class="badge badge-warn">Corregido</span>' : ''}</div>
    <div class="tl-sub">${sub || esc(h.note || '')}</div>${fixNote ? `<div class="tl-note">${icon('info', 'sm')} ${fixNote}</div>` : ''}${k === 'fix' && h.note ? `<div class="tl-note">${esc(h.note)}</div>` : ''}</div>
    <div class="tl-side">${q ? `<strong class="delta">${q.main}</strong>${q.sub ? `<span class="delta-sub">${q.sub}</span>` : ''}` : ''}<span class="tl-side-row">${fixBtn}<span class="tl-time" title="${esc(dateTimeOf(h.at))}">${opts.time ? timeOf(h.at) : relTime(h.at)}</span></span></div></div>`;
}
// Agrupa movimientos por día, con la hora de cada uno.
function historyByDay(rows) {
  let html = '', day = '';
  for (const h of rows) {
    const d = new Date(h.at).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (d !== day) { html += `<div class="tl-day">${esc(d)}</div>`; day = d; }
    html += historyRow(h, { time: true });
  }
  return html;
}
const emptyState = (ic, title, text, action = '') => `<div class="empty"><span class="empty-icon">${icon(ic)}</span><strong>${esc(title)}</strong><span>${esc(text)}</span>${action}</div>`;

function creatorCard() {
  return `<section class="creator" aria-label="Creador de la app">
    <div class="creator-top">
      <div class="creator-photo"><img src="${CREATOR.photo}" alt="Foto de ${CREATOR.name}" width="96" height="96" loading="lazy"></div>
      <div style="flex:1;min-width:220px">
        <div class="creator-eyebrow">Tecnología, textil e innovación</div>
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
  updateContactLabels();
  updateFormNotice();
}

// Si el código ya existe, el formulario se reduce a código + cantidad: marca y prenda ya están guardadas.
function renderFormProduct(sku, it) {
  const card = byId('formProduct');
  byId('productForm').classList.toggle('is-existing', !!it);
  card.hidden = !sku;
  if (!sku) return;
  if (it) {
    const d = S.displayQty(it);
    card.className = 'span-2 product-card';
    card.innerHTML = `<span class="card-icon">${icon('check')}</span><div class="grow"><strong>Ya cargado: ${esc(it.sku)}</strong><span>${esc(productName(it) || 'Sin marca ni prenda')} · stock ${fmt(d.value)} ${esc(d.unit)}. Solo indicá la cantidad.</span></div><button type="button" class="btn btn-ghost btn-sm" data-edit-product>${icon('edit', 'sm')}Editar datos</button>`;
  } else {
    card.className = 'span-2 product-card is-new';
    card.innerHTML = `<span class="card-icon">${icon('sparkles')}</span><div class="grow"><strong>Producto nuevo: ${esc(sku)}</strong><span>Completá marca y prenda: se guardan una sola vez. La próxima vez alcanza con el código y la cantidad.</span></div>`;
  }
}

function updateFormNotice() {
  const sku = upper(F.sku.value).replace(/\s+/g, ''), it = S.findByCode(sku), qty = num(F.qty.value), u = S.inputUnit(F.unit.value);
  renderFormProduct(sku, it);
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

// preferProduct: al escribir o escanear el código, proponer la unidad habitual del producto (p. ej. docenas).
// Al dictar se respeta la unidad dicha, salvo que no sea compatible.
function syncUnitWithProduct(preferProduct = false) {
  // Si se escanea una etiqueta numerada (1015D0003) en el campo de código, se carga 1 docena / 1 unidad del 1015.
  const res = S.resolveCode(F.sku.value);
  if (res?.pack) {
    F.sku.value = res.item.sku;
    F.unit.value = res.pack === 'D' ? 'dozen' : (res.item.unitName === 'unidades' ? 'unit' : S.inputUnitFor(res.item));
    if (!num(F.qty.value)) F.qty.value = 1;
    highlight(F.sku, F.unit, F.qty);
  }
  const it = S.findByCode(F.sku.value);
  if (it && (S.inputUnit(F.unit.value).stock !== it.unitName || (preferProduct && F.unit.value === 'unit'))) F.unit.value = S.inputUnitFor(it);
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
  const existing = p.sku && S.findByCode(p.sku);
  const missing = !p.sku ? F.sku : p.qty == null ? F.qty : null;
  if (missing) {
    missing.focus();
    toast(`No entendí ${missing === F.sku ? 'el código' : 'la cantidad'}. Completalo a mano.`, 'warn');
    if (prefs.voiceSpeak) say(missing === F.sku ? 'No entendí el código.' : 'No entendí la cantidad.');
  } else if (existing && prefs.voiceAutoSave) {
    byId('productForm').requestSubmit(); // producto conocido: se guarda sin tocar nada (se puede deshacer)
    return;
  } else if (!existing) {
    if (!txt(F.brand.value)) F.brand.focus(); else byId('saveProduct').focus({ preventScroll: true });
    toast(`${p.sku} es un producto nuevo. Completá marca y prenda y tocá Guardar.`, 'info');
    if (prefs.voiceSpeak) say(`${spell(p.sku)} es nuevo. Completá marca y prenda.`);
  } else {
    byId('saveProduct').focus({ preventScroll: true });
    toast('Revisá los datos y tocá Guardar.', 'info');
  }
  if (innerWidth < 900) byId('productForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Confirmación hablada (lectura en voz alta del navegador).
function say(text) {
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const m = new SpeechSynthesisUtterance(text);
  m.lang = 'es-AR';
  m.rate = 1.05;
  speechSynthesis.speak(m);
}
// "N115" se lee mejor como "N 115".
const spell = code => String(code).replace(/([A-Z]+)(\d)/g, '$1 $2').replace(/(\d)([A-Z])/g, '$1 $2');

function saveProduct(e) {
  e.preventDefault();
  const btn = byId('saveProduct');
  const r = S.applyMovement({
    sku: F.sku.value, brand: F.brand.value, type: F.type.value, qty: F.qty.value, unit: F.unit.value, stockType: prefs.task,
    operation: prefs.formOp, minStock: F.min.value, barcode: F.barcode.value, source: formSource, contact: prefs.formOp === 'establecer' ? null : resolveContact(byId('fContact').value, prefs.formOp),
  });
  if (!r.ok) {
    toast(r.error, 'error'); shake(btn); sound('error');
    if (formSource === 'voz' && prefs.voiceSpeak) say(r.error);
    return;
  }
  flashDone(btn);
  sound('ok');
  const savedContact = prefs.formOp === 'establecer' ? '' : txt(byId('fContact').value);
  if (savedContact) toast(`${r.item.sku}: ${fmt(r.before)} → ${fmt(r.after)} ${S.unitLabel(r.item.unitName)} · ${savedContact}`, { actionLabel: 'Hacer remito', duration: 8000, action: () => openRemito({ kind: r.op === 'sumar' ? 'entrada' : 'salida', moves: [{ sku: r.item.sku, units: r.amount, entryId: r.entryId }], contactName: savedContact }) });
  else toast(`${r.item.sku}: ${fmt(r.before)} → ${fmt(r.after)} ${S.unitLabel(r.item.unitName)}`, { action: () => { if (S.undo()) toast('Movimiento deshecho', 'info'); } });
  if (formSource === 'voz' && prefs.voiceSpeak) {
    const u = S.inputUnit(F.unit.value), qty = fmt(num(F.qty.value));
    const what = r.op === 'establecer' ? `queda en ${qty} ${u.short}` : `${r.op === 'restar' ? 'menos' : 'más'} ${qty} ${u.short}`;
    say(`${spell(r.item.sku)}, ${what}. Stock: ${fmt(r.after)} ${S.unitLabel(r.item.unitName)}.`);
  }
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
    if ('speechSynthesis' in window) speechSynthesis.cancel(); // que la app no se escuche a sí misma
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
const session = { reads: 0, units: 0, products: new Set(), counted: new Set(), serials: new Set(), feed: [], contactName: '' };
let lastScan = { code: '', at: 0 };

// Textos de cada modo de escaneo: el aviso de color, el botón de terminar y la lista.
const SCAN_MODES = {
  restar: { name: 'salida', tone: 'danger', icon: 'arrow-out', banner: 'Cada código que escanees se <b>RESTA</b> del stock.', hint: 'Te muestra el resumen y podés mandar el remito por WhatsApp.' },
  sumar: { name: 'entrada', tone: 'success', icon: 'arrow-in', banner: 'Cada código que escanees se <b>SUMA</b> al stock.', hint: 'Te muestra el resumen y podés guardar el remito de entrada.' },
  establecer: { name: 'conteo', tone: 'info', icon: 'equal', banner: 'La primera lectura de cada producto <b>reinicia</b> su stock y las siguientes suman.', hint: 'Cierra el conteo y deja la lista vacía para el próximo.' },
};
const scanMode = () => SCAN_MODES[prefs.scanOp];
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function setScanOp(op) {
  prefs.scanOp = S.OPERATIONS[op] ? op : 'sumar';
  savePrefs();
  const m = scanMode();
  segmented(byId('scanOpSeg'), prefs.scanOp);
  segmented(byId('kOp'), prefs.scanOp);
  const banner = `${icon(m.icon)}<span><b>${cap(m.name)}</b> · ${m.banner}</span>`;
  for (const id of ['scanModeBanner', 'kModeBanner']) { byId(id).className = `mode-banner ${m.tone}`; byId(id).innerHTML = banner; }
  byId('scanHero').dataset.mode = prefs.scanOp;
  byId('scanFinishTitle').textContent = `Terminá ${prefs.scanOp === 'establecer' ? 'el conteo' : `la ${m.name}`}`;
  byId('scanFinishHint').textContent = m.hint;
  byId('sessionTitle').textContent = prefs.scanOp === 'establecer' ? 'Productos contados' : `Productos de esta ${m.name}`;
  // Sin paso de cliente en el conteo: los pasos se renumeran.
  byId('scanStepScan').textContent = prefs.scanOp === 'establecer' ? '2' : '3';
  byId('scanStepFinish').textContent = prefs.scanOp === 'establecer' ? '3' : '4';
  updateContactLabels();
  renderKiosk();
}
// Cambiar de modo con lecturas sin terminar mezclaría una salida con una entrada: primero se pregunta.
async function chooseScanOp(op) {
  if (op === prefs.scanOp) return;
  const pending = liveFeed().length;
  if (pending) {
    const cur = scanMode().name, next = SCAN_MODES[op]?.name || '';
    const v = await ask({
      title: `Tenés una ${cur} sin terminar`,
      message: `Hay ${pending} lectura${pending === 1 ? '' : 's'} de ${cur} (ya descontada${pending === 1 ? '' : 's'} del stock). Terminala para hacer el remito, o cambiá igual y empezá una lista nueva.`,
      choices: [{ label: `Terminar la ${cur}`, value: 'finish', primary: true }, { label: `Cambiar a ${next} igual`, value: 'switch' }],
      cancel: `Seguir con la ${cur}`,
    });
    if (v === 'finish') { segmented(byId('scanOpSeg'), prefs.scanOp); segmented(byId('kOp'), prefs.scanOp); finishScan(); return; }
    if (v !== 'switch') { segmented(byId('scanOpSeg'), prefs.scanOp); segmented(byId('kOp'), prefs.scanOp); focusKioskOrScan(); return; }
    resetSession();
  }
  setScanOp(op);
  toast(`Modo ${SCAN_MODES[prefs.scanOp].name}: ${SCAN_MODES[prefs.scanOp].banner.replace(/<[^>]+>/g, '').toLowerCase()}`, prefs.scanOp === 'restar' ? 'warn' : 'info');
  focusKioskOrScan();
}
const focusKioskOrScan = () => (currentView === 'kiosco' ? byId('kInput').focus({ preventScroll: true }) : focusScan());
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
  if (currentView === 'kiosco') {
    const k = byId('kResult');
    k.className = `kiosk-result ${ok ? 'ok' : 'bad'}`;
    k.innerHTML = html;
  }
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
  if (currentView !== 'escanear' && currentView !== 'kiosco') location.hash = '#/escanear';

  const op = prefs.scanOp, qty = num(prefs.scanQty) || 1;
  const resolved = S.resolveCode(code);
  const item = resolved?.item || null;
  const pack = resolved?.pack ? S.PACKS[resolved.pack] : null;
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
    r = S.applyMovement({ ...data, sku: code, stockType: prefs.task, operation: op, source: `${source} · alta`, contact: sessionContact() });
  } else {
    // Cada lectura cuenta en la unidad base (1 = una prenda aunque el producto se muestre en docenas).
    let unit = item.unitName === 'unidades' ? 'unit' : S.inputUnitFor(item), amount = qty, note = source;
    if (pack) {
      // Etiqueta numerada: mueve exactamente una docena o una unidad, y no se puede registrar dos veces por error.
      amount = 1;
      if (resolved.pack === 'D') unit = 'dozen';
      const label = `${pack.label.toLowerCase()} N.º ${String(resolved.number).padStart(4, '0')}`;
      note = `${source} · ${label}`;
      if (op === 'establecer' && session.serials.has(code)) return scanFail(code, `Esta ${label} ya se contó en esta sesión.`);
      const last = S.lastSerialEvent(code);
      const repeated = last && ((op === 'restar' && last.kind === 'out') || (op === 'sumar' && last.kind === 'in'));
      if (repeated) {
        sound('warn');
        const ok = await ask({
          title: `La ${label} de ${item.sku} ya ${op === 'restar' ? 'salió' : 'ingresó'}`,
          message: `Se registró el ${new Date(last.at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}. ¿Puede ser que la estés escaneando dos veces?`,
          confirm: 'Registrar igual', cancel: 'No registrar',
        });
        focusScan();
        if (!ok) return scanFail(code, `Lectura repetida de la ${label}: no se registró.`);
      }
    }
    const operation = op === 'establecer' && session.counted.has(item.id) ? 'sumar' : op;
    r = S.applyMovement({ sku: item.sku, qty: amount, unit, stockType: prefs.task, operation, source: note, keepDisplay: true, serial: pack ? code : undefined, contact: sessionContact() });
  }
  if (!r.ok) return scanFail(code, r.error);

  if (op === 'establecer') { session.counted.add(r.item.id); if (pack) session.serials.add(code); }
  session.reads++;
  session.units += r.amount;
  session.products.add(r.item.id);
  const serialTag = pack ? `${pack.label} N.º ${String(resolved.number).padStart(4, '0')}` : '';
  session.feed.unshift({ id: Date.now() + Math.random(), entryId: r.entryId, itemId: r.item.id, sku: r.item.sku, name: serialTag || productName(r.item), serial: pack ? code : '', op, amount: r.amount, before: r.before, after: r.after, unit: S.unitLabel(r.item.unitName), at: new Date().toISOString(), undone: false });
  if (session.feed.length > 200) session.feed.length = 200;
  const sign = op === 'restar' ? '−' : op === 'establecer' ? '=' : '+';
  // Texto claro de lo que se movió: "−1 docena (12 unidades)" o "+1 unidad".
  const moved = op === 'establecer' ? `= ${unitWords(r.after, S.unitLabel(r.item.unitName))}`
    : resolved?.pack === 'D' ? `${sign}1 docena` : `${sign}${unitWords(r.amount, S.unitLabel(r.item.unitName))}`;
  const movedSub = resolved?.pack === 'D' && op !== 'establecer' ? ` (${unitWords(r.amount, 'unidades')})` : '';
  scanFeedback(true, `<div class="scan-result ok"><span class="big">${moved}</span><div><strong class="mono">${esc(r.item.sku)}</strong>${serialTag ? ` <span class="badge badge-primary">${esc(serialTag)}</span>` : ''}${r.created ? ' <span class="badge badge-success">Nuevo</span>' : ''}<div class="small">${op === 'restar' ? 'Salida' : op === 'establecer' ? 'Conteo' : 'Ingreso'}${movedSub} · ${esc(productName(r.item) || 'Sin marca')} · stock ${fmt(r.after)} ${esc(S.unitLabel(r.item.unitName))}</div></div></div>`);
  renderScanSession();
  focusScan();
}

function renderScanSession() {
  renderKiosk();
  byId('ssReads').textContent = fmt(session.reads);
  byId('ssUnits').textContent = fmt(session.units);
  byId('ssProducts').textContent = fmt(session.products.size);
  byId('scanFeed').innerHTML = session.feed.length
    ? session.feed.map(f => `<div class="feed-item tl-${f.op === 'restar' ? 'out' : f.op === 'establecer' ? 'count' : 'in'} ${f.undone ? 'undone' : ''}" ${f.entryId ? `data-move="${esc(f.entryId)}"` : ''}>
        <span class="tl-icon">${icon(f.op === 'restar' ? 'arrow-out' : f.op === 'establecer' ? 'equal' : 'arrow-in')}</span>
        <div class="tl-body"><div class="tl-title"><strong class="mono">${esc(f.sku)}</strong> <span>${esc(f.name)}</span></div><div class="tl-sub"><b>${f.op === 'restar' ? '−' : f.op === 'establecer' ? '=' : '+'}${S.serialInfo(f.serial)?.pack === 'D' ? `1 docena (${unitWords(f.amount, 'unidades')})` : unitWords(f.op === 'establecer' ? f.after : f.amount, f.unit)}</b> · stock ${fmt(f.before)} → ${fmt(f.after)} ${esc(f.unit)} · ${new Date(f.at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</div></div>
        ${f.undone ? '<span class="badge">Revertido</span>' : `<button class="btn btn-ghost btn-sm" type="button" data-revert="${f.id}">${icon('undo', 'sm')}Revertir</button>`}</div>`).join('')
    : emptyState('scan', 'Sin lecturas todavía', 'Escaneá un código con la pistola o la cámara para empezar.');
}

function revertScan(id) {
  const f = session.feed.find(x => String(x.id) === String(id));
  if (!f || f.undone) return;
  // Revertir una lectura de esta sesión es anularla (queda registrado quién y por qué). Lo puede hacer quien la hizo.
  const r = f.entryId
    ? S.fixMovement(f.entryId, { remove: true, reason: 'Lectura revertida desde la sesión de escaneo' })
    : { ok: false, error: 'No se encontró la lectura en el historial.' };
  if (!r.ok) return toast(r.error, 'error');
  f.undone = true;
  if (f.serial) session.serials.delete(f.serial);
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
      <button class="icon-btn owner-only" type="button" data-act="history" title="Ver todos sus movimientos">${icon('history')}</button>
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
  if (act === 'history') { openProductHistory(item.sku); return; }
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
  // Los empleados pueden editar datos del producto, pero no cambiar el stock a mano.
  byId('eUnits').disabled = !canManage(); byId('eUnitName').disabled = !canManage();
  byId('eUnits').title = canManage() ? '' : 'Solo el dueño puede cambiar el stock a mano';
  byId('editDialog').showModal();
}
function saveEdit(e) {
  e.preventDefault();
  const item = S.findById(editingId);
  const r = S.saveItem(editingId, {
    sku: byId('eSku').value, barcode: byId('eBarcode').value, brand: byId('eBrand').value, type: byId('eType').value,
    units: canManage() ? byId('eUnits').value : item?.units, unitName: canManage() ? byId('eUnitName').value : item?.unitName,
    minStock: byId('eMin').value, stockType: byId('eStockType').value,
  });
  if (!r.ok) { toast(r.error, 'error'); shake(byId('eSave')); return; }
  byId('editDialog').close();
  toast('Producto actualizado', { action: () => S.undo() });
  flashRow(r.item.id);
}
async function deleteEditing() {
  if (!ownerOnly('eliminar productos')) return;
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
  if (!ownerOnly('eliminar productos')) return;
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

const LBL_MODE_HINTS = {
  product: 'Todas las etiquetas del producto llevan el mismo código (ej. 1015). Al escanear se mueve la cantidad configurada en Escanear.',
  D: 'Cada docena lleva su propio número: 1015D0001, 1015D0002… Al escanearla se mueven 12 unidades, y la app avisa si esa docena ya se registró.',
  U: 'Cada unidad lleva su propio número: 1015U0001, 1015U0002… Al escanearla se mueve 1 unidad, y la app avisa si esa unidad ya se registró.',
};
function setLblMode(mode) {
  prefs.lblMode = ['product', 'D', 'U'].includes(mode) ? mode : 'product';
  savePrefs();
  segmented(byId('lblMode'), prefs.lblMode);
  byId('lblModeHint').textContent = LBL_MODE_HINTS[prefs.lblMode];
  byId('lblProductOpts').hidden = prefs.lblMode !== 'product';
  byId('lblSerialOpts').hidden = prefs.lblMode === 'product';
  setLblQtyMode(prefs.lblQtyMode);
}

const LBL_QTY_HINTS = {
  stock: 'Una etiqueta por cada {u} que hay hoy en stock. Continúa la numeración desde la última impresa.',
  fixed: 'Imprime solo la cantidad que elijas por cada producto (ideal cuando entra mercadería nueva). Continúa la numeración.',
  list: 'Imprime exactamente los números que escribas, por ejemplo para reimprimir etiquetas.',
};
function setLblQtyMode(mode) {
  prefs.lblQtyMode = ['stock', 'fixed', 'list'].includes(mode) ? mode : 'stock';
  savePrefs();
  segmented(byId('lblQtyMode'), prefs.lblQtyMode);
  const unit = prefs.lblMode === 'D' ? 'docena' : 'unidad';
  byId('lblQtyHint').textContent = LBL_QTY_HINTS[prefs.lblQtyMode].replace('{u}', unit);
  byId('lblFixedField').hidden = prefs.lblQtyMode !== 'fixed';
  byId('lblListField').hidden = prefs.lblQtyMode !== 'list';
  byId('lblRestartWrap').hidden = prefs.lblQtyMode === 'list';
  syncLblChips();
  renderLabelPreview();
}
function syncLblChips() {
  $$('#lblFixedChips .chip').forEach(c => c.classList.toggle('active', Number(c.dataset.n) === Number(prefs.lblFixed)));
  $$('#lblCopiesChips .chip').forEach(c => c.classList.toggle('active', Number(c.dataset.n) === Number(prefs.lblCopies) && !prefs.lblByStock));
  $$('#lblListChips .chip').forEach(c => c.classList.toggle('active', c.dataset.list === txt(prefs.lblList)));
}

// "1-7, 10, 15" (o "1 a 7") → [1,2,3,4,5,6,7,10,15]. Devuelve también las partes que no se entendieron.
function parseNumberList(text) {
  const nums = new Set(), bad = [];
  const clean = String(text || '').toLowerCase().replace(/\s*(?:-|–|a|al|hasta)\s*(?=\d)/g, '-');
  for (const part of clean.split(/[,;\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) { bad.push(part); continue; }
    let a = Number(m[1]), b = m[2] ? Number(m[2]) : a;
    if (a > b) [a, b] = [b, a];
    for (let n = Math.max(1, a); n <= b && nums.size < L.MAX_LABELS; n++) nums.add(n);
  }
  return { numbers: [...nums].sort((x, y) => x - y), bad };
}
// [1,2,3,4,7,10,11] → "0001–0004, 0007, 0010–0011"
function formatRanges(numbers) {
  const pad = n => String(n).padStart(4, '0'), out = [];
  for (let i = 0; i < numbers.length; i++) {
    let j = i;
    while (j + 1 < numbers.length && numbers[j + 1] === numbers[j] + 1) j++;
    out.push(i === j ? pad(numbers[i]) : `${pad(numbers[i])}–${pad(numbers[j])}`);
    i = j;
  }
  return out.length > 6 ? `${out.slice(0, 6).join(', ')}…` : out.join(', ');
}

// Arma la lista de etiquetas a imprimir. En modo docena/unidad cada una lleva su número de serie.
// plan: qué numeración usa cada producto (se guarda al confirmar que se imprimió).
function labelEntries() {
  const items = state.items.filter(i => lbl.selected.has(i.id)).sort((a, b) => a.sku.localeCompare(b.sku, 'es', { numeric: true }));
  const out = [], plan = [], skipped = [];
  let truncated = false;
  const push = e => { if (out.length >= L.MAX_LABELS) { truncated = true; return false; } out.push(e); return true; };

  if (prefs.lblMode === 'product') {
    const base = [...items.map(i => ({ code: i.sku, name: productName(i), units: i.units })), ...lbl.custom.map(c => ({ code: c, name: '', units: 1 }))];
    for (const e of base) {
      const n = prefs.lblByStock ? Math.max(1, Math.ceil(e.units)) : Math.max(1, Math.floor(num(prefs.lblCopies)) || 1);
      for (let k = 0; k < n; k++) if (!push(e)) break;
    }
    return { out, truncated, products: base.length, plan, skipped };
  }

  const pack = prefs.lblMode, info = S.PACKS[pack];
  const listed = prefs.lblQtyMode === 'list' ? parseNumberList(prefs.lblList) : null;
  for (const i of items) {
    if (!S.packAllowed(i, pack)) { skipped.push(i); continue; }
    let numbers;
    if (listed) numbers = listed.numbers;
    else {
      const count = prefs.lblQtyMode === 'fixed' ? Math.max(1, Math.floor(num(prefs.lblFixed)) || 1) : Math.floor(i.units / info.factor);
      const start = prefs.lblRestart ? 1 : (i.serials?.[pack] || 0) + 1;
      numbers = Array.from({ length: Math.min(count, L.MAX_LABELS) }, (_, k) => start + k);
    }
    if (!numbers.length) { if (!listed) skipped.push(i); continue; }
    const printed = [];
    for (const n of numbers) {
      const tag = `${info.label} N.º ${String(n).padStart(4, '0')}${pack === 'D' ? ' · 12 u.' : ''}`;
      if (!push({ code: S.serialCode(i.sku, pack, n), name: productName(i), tag })) break;
      printed.push(n);
    }
    if (printed.length) plan.push({ id: i.id, sku: i.sku, pack, numbers: printed, start: printed[0], last: printed.at(-1), count: printed.length, restart: !listed && prefs.lblRestart, current: i.serials?.[pack] || 0 });
    if (truncated) break;
  }
  return { out, truncated, products: items.length, plan, skipped, bad: listed?.bad || [] };
}

function renderLabelPlan({ plan, skipped, bad }) {
  const box = byId('lblPlan');
  if (prefs.lblMode === 'product') { box.innerHTML = ''; return; }
  const info = S.PACKS[prefs.lblMode];
  const rows = plan.slice(0, 5).map(p => {
    const stockNow = Math.floor((S.findById(p.id)?.units || 0) / info.factor);
    const printedBefore = p.current ? ` · ya impresas hasta la N.º ${String(p.current).padStart(4, '0')}` : '';
    return `<div class="notice info">${icon('tag')}<span><b class="mono">${esc(p.sku)}</b>: ${info.plural} N.º ${formatRanges(p.numbers)} (${fmt(p.count)} etiqueta${p.count === 1 ? '' : 's'})<br><span class="small muted">Hay ${fmt(stockNow)} ${info.plural} en stock${printedBefore}</span></span></div>`;
  });
  if (plan.length > 5) rows.push(`<div class="notice">${icon('info')}<span>y ${plan.length - 5} productos más.</span></div>`);
  if (bad?.length) rows.push(`<div class="notice warn">${icon('alert')}<span>No entendí: <b class="mono">${esc(bad.join(', '))}</b>. Usá números y rangos, por ejemplo <span class="mono">1-7, 10, 15</span>.</span></div>`);
  if (prefs.lblQtyMode === 'list' && !txt(prefs.lblList)) rows.push(`<div class="notice">${icon('info')}<span>Escribí qué números querés imprimir o tocá un atajo.</span></div>`);
  if (skipped.length) {
    const why = prefs.lblMode === 'D' ? 'no se controlan en unidades o tienen menos de una docena' : 'no tienen stock';
    rows.push(`<div class="notice warn">${icon('alert')}<span>Se omiten ${skipped.slice(0, 4).map(i => esc(i.sku)).join(', ')}${skipped.length > 4 ? '…' : ''}: ${why}. Usá "Cantidad fija" si igual querés etiquetas.</span></div>`);
  }
  if (!plan.length && !skipped.length && !lbl.selected.size) rows.push(`<div class="notice">${icon('info')}<span>Elegí productos para ver la numeración.</span></div>`);
  box.innerHTML = rows.join('');
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
  const entries = labelEntries(), { out, truncated } = entries;
  renderLabelPlan(entries);
  const pages = L.pageCount(out.length, prefs.lblSize);
  byId('lblTotal').textContent = `${fmt(out.length)} etiqueta${out.length === 1 ? '' : 's'} · ${fmt(pages)} página${pages === 1 ? '' : 's'}${truncated ? ` (máx. ${fmt(L.MAX_LABELS)})` : ''}`;
  byId('lblPrint').disabled = !out.length;
  const opts = { kind: prefs.lblKind, size: prefs.lblSize, showName: prefs.lblShowName, header: txt(prefs.lblHeader) };
  const example = prefs.lblMode === 'product' ? { code: 'EJEMPLO123', name: 'MARCA · PRENDA' }
    : { code: `1015${prefs.lblMode}0001`, name: 'MARCA · PRENDA', tag: `${S.PACKS[prefs.lblMode].label} N.º 0001${prefs.lblMode === 'D' ? ' · 12 u.' : ''}` };
  const sample = out.length ? [...new Map(out.map(e => [e.code, e])).values()].slice(0, 6) : [example];
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
  const { out, truncated, plan } = labelEntries();
  if (!out.length) return toast('Elegí al menos un producto o código.', 'warn');
  if (truncated) toast(`Se imprimen como máximo ${fmt(L.MAX_LABELS)} etiquetas por vez.`, 'warn');
  const btn = byId('lblPrint');
  busy(btn, true);
  try { await L.printLabels(out, { kind: prefs.lblKind, size: prefs.lblSize, showName: prefs.lblShowName, header: txt(prefs.lblHeader) }); }
  catch (e) { toast(e.message || 'No se pudieron generar las etiquetas.', 'error'); busy(btn, false); return; }
  busy(btn, false);
  if (!plan.length) return;
  // Solo se avanza la numeración si se imprimió bien; si no, se pueden reimprimir los mismos números.
  // Reimprimir números que ya existían no cambia la numeración: no hace falta preguntar.
  if (plan.every(p => !p.restart && p.last <= p.current)) { toast('Etiquetas enviadas a la impresora. La numeración no cambia.', 'info'); return; }
  const p0 = plan[0], next = (p0.restart ? p0.last : Math.max(p0.current, p0.last)) + 1;
  const ok = await ask({
    title: '¿Se imprimieron bien las etiquetas?',
    message: `Si confirmás, la próxima tanda sigue desde el número siguiente (por ejemplo ${p0.sku}: N.º ${String(next).padStart(4, '0')}). Si hubo un problema, elegí "Volver a imprimir" y se usan los mismos números.`,
    confirm: 'Sí, guardar numeración', cancel: 'Volver a imprimir',
  });
  if (!ok) return;
  S.reserveSerials(plan);
  if (prefs.lblRestart) { prefs.lblRestart = false; savePrefs(); byId('lblRestart').checked = false; }
  toast('Numeración guardada. La próxima tanda continúa desde el número siguiente.');
  renderLabelPreview();
}

// =========================================================
// Historial
// =========================================================
const hist = { q: '', kind: 'all', code: '', brand: '', type: '', period: 'all', limit: 100 };
const kindMatches = (h, kind) => kind === 'all' || S.historyKind(h) === kind || (kind === 'edit' && ['delete', 'import', 'fix'].includes(S.historyKind(h)));
function periodStart(p) {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  if (p === 'today') return [d, null];
  if (p === 'yesterday') { const y = new Date(d); y.setDate(y.getDate() - 1); return [y, d]; }
  if (p === '7' || p === '30') { d.setDate(d.getDate() - Number(p) + 1); return [d, null]; }
  return [null, null];
}
function filteredHistory() {
  const q = hist.q.toLocaleLowerCase('es-AR'), code = upper(hist.code).replace(/\s+/g, '');
  const [from, to] = periodStart(hist.period);
  return state.history.filter(h => kindMatches(h, hist.kind)
    && (!code || h.sku === code || String(h.sku).includes(code) || h.serial === code)
    && (!hist.brand || h.brand === hist.brand)
    && (!hist.type || h.type === hist.type)
    && (!from || new Date(h.at) >= from) && (!to || new Date(h.at) < to)
    && (!q || [h.sku, h.brand, h.type, h.note, h.action, h.serial, S.serialInfo(h.serial)?.label].some(v => String(v || '').toLocaleLowerCase('es-AR').includes(q))));
}
// Totales de una lista de movimientos (ingresos, salidas, neto), en unidades y docenas.
function movementTotals(rows) {
  let ins = 0, outs = 0;
  for (const h of rows) { const k = S.historyKind(h); if (k === 'in') ins += S.effectiveQty(h); else if (k === 'out') outs += S.effectiveQty(h); }
  const dz = n => `${fmt(n / 12)} docenas`;
  return { ins, outs, net: ins - outs, dz };
}
function renderHistSummary(rows) {
  const t = movementTotals(rows);
  const anyFilter = hist.q || hist.code || hist.brand || hist.type || hist.period !== 'all' || hist.kind !== 'all';
  const code = upper(hist.code).replace(/\s+/g, ''), item = code && (S.findByCode(code) || S.resolveCode(code)?.item);
  byId('histSummary').innerHTML = `
    <div class="sum-tile"><span>Movimientos${anyFilter ? ' (filtrados)' : ''}</span><strong>${fmt(rows.length)}</strong><small>${item ? `<a href="#" class="link" data-open-product="${esc(item.sku)}">Ver ficha de ${esc(item.sku)} ${icon('chevron-right', 'sm')}</a>` : '&nbsp;'}</small></div>
    <div class="sum-tile in"><span>Ingresó</span><strong>+${fmt(t.ins)} u.</strong><small>${t.dz(t.ins)}</small></div>
    <div class="sum-tile out"><span>Salió</span><strong>−${fmt(t.outs)} u.</strong><small>${t.dz(t.outs)}</small></div>
    <div class="sum-tile"><span>Diferencia</span><strong>${t.net >= 0 ? '+' : '−'}${fmt(Math.abs(t.net))} u.</strong><small>${t.dz(Math.abs(t.net))}</small></div>`;
}
function fillHistSelects() {
  const uniq = k => [...new Set([...state.items.map(i => i[k]), ...state.history.map(h => h[k])].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'));
  for (const [id, key, all] of [['histBrand', 'brand', 'Todas'], ['histType', 'type', 'Todas']]) {
    const sel = byId(id), current = hist[key];
    sel.innerHTML = `<option value="">${all}</option>` + uniq(key).map(v => `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(v)}</option>`).join('');
  }
}
function renderHistory() {
  if (currentView !== 'historial') return;
  fillHistSelects();
  $$('#histFilters .chip').forEach(c => c.classList.toggle('active', c.dataset.k === hist.kind));
  const rows = filteredHistory(), shown = rows.slice(0, hist.limit);
  renderHistSummary(rows);
  const filtered = hist.q || hist.code || hist.brand || hist.type || hist.period !== 'all' || hist.kind !== 'all';
  byId('histList').innerHTML = historyByDay(shown) || emptyState('history', 'Sin movimientos', filtered ? 'No hay resultados para estos filtros.' : 'Cuando cargues productos, vas a ver cada movimiento acá.');
  byId('histMore').hidden = rows.length <= shown.length;
  byId('histMore').textContent = `Ver más (${rows.length - shown.length})`;
}

// =========================================================
// Corregir o anular un movimiento (solo el dueño)
// =========================================================
const fix = { id: null, mode: 'edit' };
function openFix(id) {
  if (!ownerOnly('corregir o anular movimientos')) return;
  const h = state.history.find(x => x.id === id);
  if (!h || !canFix(h)) return toast('Este movimiento no se puede corregir.', 'warn');
  fix.id = id;
  const k = S.historyKind(h), item = S.findByCode(h.sku), e = S.enteredOf(h), q = movementQty(h);
  const current = h.corrected ? h.corrected.to : null;
  byId('fixInfo').innerHTML = `<div class="notice info">${icon(KIND_ICON[k])}<span><b>${esc(h.action)} de <span class="mono">${esc(h.sku)}</span></b>${h.serial ? ` · ${esc(S.serialInfo(h.serial)?.label || h.serial)}` : ''}<br>
    ${q ? `<b>${q.main}</b>${q.sub ? ` (${q.sub})` : ''} · ` : ''}${esc(dateTimeOf(h.at))}${S.sourceOf(h) ? ` · por ${esc(S.sourceOf(h))}` : ''}${h.by ? ` @${esc(h.by)}` : ''}</span></div>`;
  byId('fixQtyLabel').textContent = k === 'count' ? 'Cantidad contada correcta' : k === 'out' ? 'Cantidad que realmente salió' : 'Cantidad que realmente ingresó';
  const unitKey = Object.keys(S.INPUT_UNITS).find(u => S.INPUT_UNITS[u].short === (current?.unit || e?.unit)) || S.inputUnitFor(item);
  byId('fixUnit').value = S.inputUnit(unitKey).stock === item.unitName ? unitKey : S.inputUnitFor(item);
  byId('fixQty').value = k === 'count' ? (current?.after ?? h.after) : (current?.qty ?? e?.qty ?? h.quantity);
  byId('fixReason').value = '';
  byId('fixReason').classList.remove('has-error');
  byId('fixError').hidden = true;
  $$('#fixReasons .chip').forEach(c => c.classList.remove('active'));
  // Las etiquetas numeradas mueven siempre lo mismo: solo se pueden anular.
  setFixMode(h.serial ? 'remove' : 'edit');
  byId('fixMode').querySelector('[data-v="edit"]').disabled = !!h.serial;
  byId('fixDialog').showModal();
  setTimeout(() => (h.serial ? byId('fixReason') : byId('fixQty')).focus(), 60);
}
function setFixMode(mode) {
  fix.mode = mode;
  segmented(byId('fixMode'), mode);
  byId('fixQtyFields').hidden = mode === 'remove';
  byId('fixSave').innerHTML = `${icon(mode === 'remove' ? 'x' : 'check')}${mode === 'remove' ? 'Anular movimiento' : 'Guardar corrección'}`;
  byId('fixSave').className = `btn ${mode === 'remove' ? 'btn-danger' : 'btn-primary'}`;
  renderFixPreview();
}
// Muestra cómo va a quedar el stock antes de confirmar.
function renderFixPreview() {
  const h = state.history.find(x => x.id === fix.id), item = h && S.findByCode(h.sku);
  if (!h || !item) return;
  const k = S.historyKind(h), current = h.corrected ? h.corrected.to : { quantity: h.quantity, after: h.after };
  const oldDelta = k === 'count' ? num(current.after ?? h.after) - h.before : (k === 'out' ? -1 : 1) * num(current.quantity);
  let newDelta = 0;
  if (fix.mode === 'edit') {
    const amount = num(byId('fixQty').value) * S.inputUnit(byId('fixUnit').value).factor;
    newDelta = k === 'count' ? amount - h.before : (k === 'out' ? -amount : amount);
  }
  const after = item.units + newDelta - oldDelta, unit = S.unitLabel(item.unitName);
  byId('fixPreview').innerHTML = after < 0
    ? `<div class="notice danger">${icon('alert')}<span>No se puede: el stock de ${esc(item.sku)} quedaría negativo.</span></div>`
    : `<div class="notice ${fix.mode === 'remove' ? 'warn' : 'success'}">${icon('info')}<span>El stock actual de <b class="mono">${esc(item.sku)}</b> pasa de <b>${fmt(item.units)}</b> a <b>${fmt(after)}</b> ${esc(unit)}.${fix.mode === 'remove' ? ' El movimiento queda tachado en el historial.' : ''}</span></div>`;
}
function saveFix(e) {
  e.preventDefault();
  const r = S.fixMovement(fix.id, fix.mode === 'remove'
    ? { remove: true, reason: byId('fixReason').value }
    : { qty: byId('fixQty').value, unit: byId('fixUnit').value, reason: byId('fixReason').value });
  if (!r.ok) {
    // El error se muestra dentro de la ventana, al lado del motivo (no detrás).
    const missingReason = !txt(byId('fixReason').value);
    byId('fixError').innerHTML = `${icon('alert')}${esc(missingReason ? 'Escribí el motivo o tocá uno de los botones de arriba.' : r.error)}`;
    byId('fixError').hidden = false;
    byId('fixReason').classList.toggle('has-error', missingReason);
    if (missingReason) byId('fixReason').focus();
    shake(byId('fixSave'));
    return;
  }
  byId('fixDialog').close();
  toast(`${fix.mode === 'remove' ? 'Movimiento anulado' : 'Movimiento corregido'}: el stock de ${r.item.sku} pasó de ${fmt(r.before)} a ${fmt(r.after)} ${S.unitLabel(r.item.unitName)}`, { duration: 6000 });
}

// =========================================================
// Detalle completo de un movimiento (en el celular las filas muestran un resumen)
// =========================================================
let viewingMove = null;
const KIND_NAMES = { in: 'Ingreso', out: 'Salida', count: 'Conteo físico', edit: 'Edición', delete: 'Eliminación', import: 'Importación', fix: 'Corrección' };
function openMove(id) {
  const h = state.history.find(x => x.id === id);
  if (!h) return toast('No se encontró el movimiento.', 'warn');
  viewingMove = id;
  const k = S.historyKind(h), q = movementQty(h), si = S.serialInfo(h.serial), item = S.findByCode(h.sku);
  const row = (label, value) => (value === '' || value == null ? '' : `<dt>${label}</dt><dd>${value}</dd>`);
  const full = iso => esc(new Date(iso).toLocaleString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }));
  const target = h.fixOf ? state.history.find(x => x.id === h.fixOf) : null;
  const corr = h.corrected, tone = k === 'out' ? 'danger' : k === 'in' ? 'success' : k === 'count' ? 'info' : 'warn';
  byId('mvTitle').textContent = `${h.action || KIND_NAMES[k] || 'Movimiento'} · ${h.sku || '—'}`;
  byId('mvSub').textContent = new Date(h.at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  byId('mvBody').innerHTML = `
    ${q ? `<div class="detail-head"><strong class="delta" style="color:var(--${tone})${h.voided ? ';text-decoration:line-through;opacity:.6' : ''}">${corr ? `${k === 'out' ? '−' : k === 'in' ? '+' : '= '}${unitWords(k === 'count' ? corr.to.after : corr.to.qty, k === 'count' ? (h.unit || 'unidades') : corr.to.unit)}` : q.main}</strong>${q.sub ? `<span class="delta-sub">${q.sub}</span>` : ''}</div>` : ''}
    <dl class="detail-kv">
      ${row('Tipo', esc(KIND_NAMES[k] || h.action))}
      ${row('Código', `<span class="code">${esc(h.sku || '—')}</span>`)}
      ${row('Producto', esc([h.brand, h.type].filter(Boolean).join(' · ') || (item ? productName(item) : '')))}
      ${row('Etiqueta escaneada', si ? `${esc(si.label)} <span class="muted">(${esc(h.serial)})</span>` : '')}
      ${row('Cantidad cargada', S.enteredOf(h) && k !== 'count' ? esc(unitWords(S.enteredOf(h).qty, S.enteredOf(h).unit)) : '')}
      ${row('Unidades movidas', h.quantity != null ? `${fmt(h.quantity)}` : '')}
      ${row('Stock', h.before != null && h.after != null ? `${fmt(h.before)} → ${fmt(h.after)} ${esc(h.unit || '')}` : '')}
      ${row(h.contact?.kind === 'proveedor' ? 'Proveedor' : 'Cliente', h.contact ? esc(h.contact.name) : '')}
      ${row('Registrado por', h.by ? `@${esc(h.by)}` : 'Sin usuario (modo local)')}
      ${row('Cómo', esc(S.sourceOf(h)))}
      ${row('Tarea', h.stockType ? esc(S.stockTypeLabel(h.stockType)) : '')}
      ${row('Fecha y hora', full(h.at))}
      ${row('Nota', h.note && k !== 'fix' ? esc(h.note) : '')}
      ${row('Corrige a', target ? `<a href="#" class="link" data-goto-move="${esc(target.id)}">${esc(target.action)} del ${esc(dateTimeOf(target.at))}</a>` : '')}
      ${row('Motivo', k === 'fix' && h.note ? esc(h.note.replace(/^.*?:\s(?=[^:]*$)/, '')) : '')}
    </dl>
    ${h.voided ? `<div class="notice danger detail-status">${icon('x')}<span><b>Anulado</b>${h.voided.by ? ` por @${esc(h.voided.by)}` : ''} el ${full(h.voided.at)}<br>Motivo: ${esc(h.voided.reason)}</span></div>` : ''}
    ${corr ? `<div class="notice warn detail-status">${icon('edit')}<span><b>Corregido</b>${corr.by ? ` por @${esc(corr.by)}` : ''} el ${full(corr.at)}: de ${esc(unitWords(corr.from?.qty ?? h.quantity, corr.from?.unit || 'unidades'))} a ${esc(k === 'count' ? unitWords(corr.to.after, h.unit || 'unidades') : unitWords(corr.to.qty, corr.to.unit))}.<br>Motivo: ${esc(corr.reason)}</span></div>` : ''}`;
  byId('mvFix').hidden = !canFix(h);
  byId('mvProduct').hidden = !h.sku || !canManage();
  if (!byId('moveDialog').open) byId('moveDialog').showModal();
}

let viewingRemito = null;
function openRemitoView(id) {
  const r = state.extra.remitos.find(x => x.id === id);
  if (!r) return;
  viewingRemito = id;
  const units = r.lines.reduce((s, l) => s + num(l.units), 0);
  byId('rvTitle').textContent = `${S.remitoCode(r)} · ${r.kind === 'entrada' ? 'Entrada' : 'Salida'}`;
  byId('rvSub').textContent = `${r.contact?.name || 'Sin cliente'} · ${dateTimeOf(r.at)}`;
  byId('rvBody').innerHTML = `
    <dl class="detail-kv" style="margin-bottom:14px">
      <dt>${r.kind === 'entrada' ? 'Proveedor' : 'Cliente'}</dt><dd>${esc(r.contact?.name || 'Sin cliente')}</dd>
      ${r.contact?.doc ? `<dt>CUIT / DNI</dt><dd>${esc(r.contact.doc)}</dd>` : ''}
      ${r.contact?.phone ? `<dt>WhatsApp</dt><dd>${esc(r.contact.phone)}</dd>` : ''}
      ${r.contact?.address ? `<dt>Dirección</dt><dd>${esc(r.contact.address)}</dd>` : ''}
      <dt>Total</dt><dd>${fmt(units)} unidades (${fmt(units / 12)} docenas)</dd>
      ${r.by ? `<dt>Preparado por</dt><dd>@${esc(r.by)}</dd>` : ''}
      ${r.note ? `<dt>Observaciones</dt><dd>${esc(r.note)}</dd>` : ''}
    </dl>
    <div class="table-wrap"><table class="table"><thead><tr><th>Código</th><th>Producto</th><th class="num">Cantidad</th></tr></thead><tbody>
      ${r.lines.map(l => `<tr><td><b class="code">${esc(l.sku)}</b></td><td style="white-space:normal">${esc(l.name || '—')}${l.serials?.length ? `<div class="small muted">${l.serials.length} etiqueta${l.serials.length === 1 ? '' : 's'} numerada${l.serials.length === 1 ? '' : 's'}</div>` : ''}</td><td class="num">${fmt(l.qty)} ${esc(l.unit)}<div class="small muted">${fmt(l.units)} u.</div></td></tr>`).join('')}
    </tbody></table></div>`;
  byId('remitoView').showModal();
}

// =========================================================
// Clientes y proveedores
// =========================================================
const kindForOp = op => (op === 'sumar' ? 'proveedor' : 'cliente');
// Busca el contacto por nombre; si no existe, lo crea (así se carga rápido desde la pistola o la voz).
function resolveContact(name, op) {
  const n = txt(name);
  if (!n) return null;
  const kind = kindForOp(op);
  const found = S.findContactByName(n, kind) || S.findContactByName(n);
  if (found) return found;
  const r = S.saveContact({ name: n, kind });
  if (r.ok) toast(`${S.CONTACT_KINDS[kind]} nuevo: ${r.contact.name}. Podés completar sus datos en Clientes.`, 'info');
  return r.ok ? r.contact : null;
}
const sessionContact = () => (prefs.scanOp === 'establecer' ? null : resolveContact(session.contactName, prefs.scanOp));
function updateContactLabels() {
  const f = prefs.formOp, s = prefs.scanOp;
  byId('fContactField').hidden = f === 'establecer';
  byId('fContactLabel').textContent = f === 'sumar' ? 'Proveedor (de quién entra)' : 'Cliente (a quién sale)';
  byId('fContact').placeholder = f === 'sumar' ? 'Elegí o escribí un proveedor (opcional)' : 'Elegí o escribí un cliente (opcional)';
  byId('scanContactField').hidden = s === 'establecer';
  byId('scanContactLabel').textContent = s === 'sumar' ? '¿De qué proveedor viene?' : '¿Para qué cliente es?';
  byId('scanContact').placeholder = s === 'sumar' ? 'Escribí o elegí el proveedor' : 'Escribí o elegí el cliente';
  byId('kContact').placeholder = s === 'sumar' ? 'Proveedor (opcional)' : 'Cliente (opcional)';
}
function setSessionContact(name, from) {
  session.contactName = name;
  if (from !== 'scan') byId('scanContact').value = name;
  if (from !== 'kiosk') byId('kContact').value = name;
}

// Diálogo de contacto: devuelve el contacto guardado (o null si se cancela).
let contactResolve = null, editingContact = null;
function openContact(contact = null, kind = 'cliente', preset = '') {
  editingContact = contact;
  const k = contact?.kind || kind;
  segmented(byId('ctdKind'), k);
  byId('ctdKind').dataset.value = k;
  byId('ctdTitle').textContent = contact ? `Editar ${S.CONTACT_KINDS[k].toLowerCase()}` : `Nuevo ${S.CONTACT_KINDS[k].toLowerCase()}`;
  byId('ctdName').value = contact?.name || preset;
  byId('ctdPhone').value = contact?.phone || '';
  byId('ctdDoc').value = contact?.doc || '';
  byId('ctdAddress').value = contact?.address || '';
  byId('ctdNote').value = contact?.note || '';
  byId('ctdDelete').hidden = !contact;
  byId('contactDialog').showModal();
  setTimeout(() => byId('ctdName').focus(), 60);
  return new Promise(res => { contactResolve = res; });
}
function saveContactForm(e) {
  e.preventDefault();
  const r = S.saveContact({ id: editingContact?.id, kind: byId('ctdKind').dataset.value, name: byId('ctdName').value, phone: byId('ctdPhone').value, doc: byId('ctdDoc').value, address: byId('ctdAddress').value, note: byId('ctdNote').value });
  if (!r.ok) { toast(r.error, 'error'); shake(byId('ctdSave')); return; }
  const res = contactResolve; contactResolve = null;
  byId('contactDialog').close();
  toast(`${S.CONTACT_KINDS[r.contact.kind]} guardado: ${r.contact.name}`);
  res?.(r.contact);
}

const ct = { kind: 'cliente', q: '', filter: null };
function contactStats(c) {
  let units = 0, moves = 0, last = null;
  for (const h of state.history) {
    if (h.contact?.id !== c.id || h.voided) continue;
    moves++; units += S.effectiveQty(h); if (!last || h.at > last) last = h.at;
  }
  return { units, moves, last, remitos: state.extra.remitos.filter(r => r.contact?.id === c.id).length };
}
function renderContacts() {
  if (currentView !== 'clientes') return;
  segmented(byId('ctKind'), ct.kind);
  const q = ct.q.toLocaleLowerCase('es-AR');
  const list = S.contacts(ct.kind).filter(c => !q || [c.name, c.phone, c.doc, c.address].some(v => String(v || '').toLocaleLowerCase('es-AR').includes(q)));
  byId('ctList').innerHTML = list.length ? list.map(c => {
    const st = canManage() ? contactStats(c) : null, phone = waNumber(c.phone);
    return `<div class="contact-row ${ct.filter === c.id ? 'on' : ''}" data-contact="${esc(c.id)}">
      <span class="avatar">${esc(initials(c.name))}</span>
      <div class="grow"><strong>${esc(c.name)}</strong><span>${esc([c.phone, c.doc && `CUIT/DNI ${c.doc}`].filter(Boolean).join(' · ') || 'Sin datos de contacto')}</span>
        ${st ? `<span class="contact-stat">${st.moves ? `${fmt(st.units)} u. ${c.kind === 'proveedor' ? 'recibidas' : 'vendidas'} · ${st.remitos} remito${st.remitos === 1 ? '' : 's'} · último ${relTime(st.last)}` : 'Sin movimientos todavía'}</span>` : ''}</div>
      ${phone ? `<a class="icon-btn" href="${waLink(phone, `Hola ${c.name}`)}" target="_blank" rel="noopener noreferrer" title="Escribir por WhatsApp">${icon('whatsapp')}</a>` : ''}
      <button class="icon-btn" type="button" data-ct="remitos" title="Ver sus remitos">${icon('file')}</button>
      <button class="icon-btn" type="button" data-ct="edit" title="Editar">${icon('edit')}</button></div>`;
  }).join('') : emptyState('users', ct.q ? 'Sin resultados' : `Todavía no hay ${ct.kind === 'cliente' ? 'clientes' : 'proveedores'}`, ct.q ? 'Probá otra búsqueda.' : 'Creálos acá o escribí un nombre al registrar una salida o un ingreso.');
  renderRemitosList();
}
function renderRemitosList() {
  const c = ct.filter && S.findContact(ct.filter);
  const list = state.extra.remitos.filter(r => !c || r.contact?.id === c.id).slice(0, 60);
  byId('ctRemitosSub').innerHTML = c ? `De <b>${esc(c.name)}</b> · <a href="#" class="link" data-ct-all>ver todos</a>` : 'Los últimos remitos emitidos';
  byId('ctRemitos').innerHTML = list.length ? list.map(r => {
    const units = r.lines.reduce((s, l) => s + num(l.units), 0);
    return `<div class="remito-row" data-remito="${esc(r.id)}"><div class="grow"><strong>${esc(S.remitoCode(r))} · ${esc(r.contact?.name || 'Sin cliente')}</strong>
      <span>${r.kind === 'entrada' ? 'Entrada' : 'Salida'} · ${fmt(units)} u. en ${r.lines.length} artículo${r.lines.length === 1 ? '' : 's'} · ${esc(dateTimeOf(r.at))}${r.by ? ` · @${esc(r.by)}` : ''}</span></div>
      <button class="icon-btn" type="button" data-rm="pdf" title="Descargar PDF">${icon('download')}</button>
      <button class="icon-btn" type="button" data-rm="wa" title="Enviar por WhatsApp">${icon('whatsapp')}</button></div>`;
  }).join('') : emptyState('file', 'Sin remitos', 'Se generan desde Escanear, el modo mostrador o al registrar una salida con cliente.');
}

// =========================================================
// Remitos
// =========================================================
const remitoOpts = () => { const s = cloud.getSession(); return { business: s?.business || '', owner: s?.owner?.full_name || s?.fullName || '' }; };
// Agrupa lecturas por código: una línea por producto, con las etiquetas numeradas que se escanearon.
function linesFromMoves(moves) {
  const map = new Map();
  for (const m of moves) {
    const it = S.findByCode(m.sku);
    const l = map.get(m.sku) || { sku: m.sku, name: it ? productName(it) : '', units: 0, serials: [], stock: it?.unitName || 'unidades' };
    l.units += num(m.units);
    if (m.serial) l.serials.push(m.serial);
    map.set(m.sku, l);
  }
  return [...map.values()].map(l => {
    const dozens = l.stock === 'unidades' && l.units >= 12 && l.units % 12 === 0;
    const qty = dozens ? l.units / 12 : l.units;
    const unit = dozens ? (qty === 1 ? 'docena' : 'docenas') : l.stock === 'unidades' ? (qty === 1 ? 'unidad' : 'unidades') : S.unitLabel(l.stock);
    return { sku: l.sku, name: l.name, serials: l.serials, units: l.units, qty, unit };
  });
}
const feedMoves = op => session.feed.filter(f => !f.undone && f.op === op && f.entryId).map(f => ({ sku: f.sku, units: f.amount, serial: f.serial, entryId: f.entryId }));
const liveFeed = () => session.feed.filter(f => !f.undone);

function resetSession() {
  Object.assign(session, { reads: 0, units: 0, products: new Set(), counted: new Set(), serials: new Set(), feed: [] });
  setSessionContact('');
  byId('scanLast').innerHTML = '';
  const k = byId('kResult');
  k.className = 'kiosk-result';
  k.innerHTML = '<p class="kiosk-hint">Listo. Disparale a la etiqueta con la pistola.</p>';
  renderScanSession();
}
// Paso 4: terminar la salida/entrada (resumen + remito) o el conteo.
async function finishScan() {
  const live = liveFeed(), m = scanMode();
  if (!live.length) return toast('Todavía no escaneaste nada.', 'warn');
  const units = live.reduce((s, f) => s + f.amount, 0), products = new Set(live.map(f => f.itemId)).size;
  if (prefs.scanOp === 'establecer') {
    const ok = await ask({ title: 'Terminar el conteo', message: `Contaste ${fmt(products)} producto${products === 1 ? '' : 's'} en ${fmt(live.length)} lectura${live.length === 1 ? '' : 's'}. El stock ya quedó actualizado.`, confirm: 'Terminar conteo', cancel: 'Seguir contando' });
    if (ok) { resetSession(); toast(`Conteo terminado: ${fmt(products)} producto${products === 1 ? '' : 's'}`); }
    focusKioskOrScan();
    return;
  }
  openRemito({ kind: prefs.scanOp === 'sumar' ? 'entrada' : 'salida', moves: feedMoves(prefs.scanOp), contactName: session.contactName, finish: { name: m.name, reads: live.length, units, products } });
}
// Cierra la sesión después de terminar y deja todo listo para la próxima.
function endScanSession(remito) {
  const f = pendingRemito?.finish;
  if (!f) return;
  pendingRemito.finish = null;
  resetSession();
  toast(`${cap(f.name)} terminada: ${fmt(f.reads)} lectura${f.reads === 1 ? '' : 's'} · ${fmt(f.units)} unidades${remito ? ` · ${S.remitoCode(remito)}` : ''}`);
  setTimeout(focusKioskOrScan, 200);
}

let pendingRemito = null;
function openRemito({ kind, moves, contactName = '', finish = null }) {
  if (!moves.length) return toast('No hay productos para el remito.', 'warn');
  pendingRemito = { kind, lines: linesFromMoves(moves), entryIds: moves.map(m => m.entryId).filter(Boolean), created: null, finish };
  byId('rmTitle').textContent = finish ? `Terminar ${finish.name}` : kind === 'entrada' ? 'Remito de entrada' : 'Remito de salida';
  byId('rmSub').textContent = `Remito ${S.remitoCode({ number: state.extra.remitoSeq + 1 })} · ${new Date().toLocaleDateString('es-AR')}`;
  byId('rmFinish').hidden = !finish;
  byId('rmCancel').textContent = finish ? 'Seguir escaneando' : 'Cancelar';
  byId('rmSummary').innerHTML = finish ? `<div class="mode-banner ${kind === 'entrada' ? 'success' : 'danger'}">${icon(kind === 'entrada' ? 'arrow-in' : 'arrow-out')}<span><b>${fmt(finish.reads)} lectura${finish.reads === 1 ? '' : 's'}</b> · ${fmt(finish.units)} unidades de ${fmt(finish.products)} producto${finish.products === 1 ? '' : 's'}. El stock ya está ${kind === 'entrada' ? 'sumado' : 'descontado'}; ahora elegí si querés el remito.</span></div>` : '';
  byId('rmContactLabel').textContent = kind === 'entrada' ? 'Proveedor' : 'Cliente';
  byId('rmContact').value = contactName;
  byId('rmNote').value = '';
  const total = pendingRemito.lines.reduce((s, l) => s + l.units, 0);
  byId('rmLines').innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>Código</th><th>Producto</th><th class="num">Cantidad</th><th class="num">Unidades</th></tr></thead><tbody>
    ${pendingRemito.lines.map(l => `<tr><td><b class="code">${esc(l.sku)}</b></td><td>${esc(l.name || '—')}${l.serials.length ? `<div class="small muted">${l.serials.length} etiqueta${l.serials.length === 1 ? '' : 's'} numerada${l.serials.length === 1 ? '' : 's'}</div>` : ''}</td><td class="num">${fmt(l.qty)} ${esc(l.unit)}</td><td class="num">${fmt(l.units)}</td></tr>`).join('')}
    </tbody></table></div><p class="hint" style="text-align:right">Total: <b>${fmt(total)} unidades</b> (${fmt(total / 12)} docenas)</p>`;
  byId('remitoDialog').showModal();
}
function ensureRemito() {
  if (pendingRemito.created) return pendingRemito.created;
  const op = pendingRemito.kind === 'entrada' ? 'sumar' : 'restar';
  const r = S.createRemito({ kind: pendingRemito.kind, contact: resolveContact(byId('rmContact').value, op), lines: pendingRemito.lines, note: byId('rmNote').value, entryIds: pendingRemito.entryIds });
  if (!r.ok) { toast(r.error, 'error'); return null; }
  pendingRemito.created = r.remito;
  return r.remito;
}
async function sendRemito(e, mode) {
  e?.preventDefault();
  const btn = byId(mode === 'download' ? 'rmDownload' : 'rmSend'), remito = ensureRemito();
  if (!remito) return;
  busy(btn, true);
  try {
    if (mode === 'download') { await downloadRemito(remito, remitoOpts()); toast(`${S.remitoCode(remito)} descargado`); }
    else {
      const how = await shareRemito(remito, remitoOpts());
      // Si se canceló el envío, el diálogo queda abierto para reintentar (el remito ya está numerado).
      if (how === 'cancelled') { toast('Envío cancelado. Podés reintentar o descargar el PDF.', 'info'); return; }
      toast(how === 'downloaded' ? `${S.remitoCode(remito)} descargado. Adjuntalo en el chat de WhatsApp que se abrió.` : `${S.remitoCode(remito)} compartido`);
    }
    endScanSession(remito);
    byId('remitoDialog').close();
  } catch (er) { toast(er.message || 'No se pudo generar el PDF.', 'error'); }
  finally { busy(btn, false); }
}
async function remitoAction(id, action) {
  const r = state.extra.remitos.find(x => x.id === id);
  if (!r) return;
  try {
    if (action === 'pdf') await downloadRemito(r, remitoOpts());
    else { const how = await shareRemito(r, remitoOpts()); if (how === 'downloaded') toast('PDF descargado. Adjuntalo en el chat de WhatsApp que se abrió.', 'info'); }
  } catch (er) { toast(er.message || 'No se pudo generar el PDF.', 'error'); }
}

// =========================================================
// Reportes (solo la dueña)
// =========================================================
const rp = { days: 30, user: '' };
function renderReports() {
  if (currentView !== 'reportes' || !canManage()) return;
  segmented(byId('rpPeriod'), String(rp.days));
  const users = [...new Set(state.history.map(h => h.by).filter(Boolean))].sort();
  byId('rpUser').innerHTML = `<option value="">Todo el equipo</option>${users.map(u => `<option value="${esc(u)}" ${u === rp.user ? 'selected' : ''}>@${esc(u)}</option>`).join('')}`;
  const r = R.computeReport(state, rp);
  byId('rpBody').innerHTML = state.history.length ? R.renderReport(r) : `<div class="card">${emptyState('layers', 'Todavía no hay datos', 'Los reportes se arman con los movimientos que registres.')}</div>`;
}

// =========================================================
// Modo mostrador: pantalla grande y simple para escanear
// =========================================================
function enterKiosk() {
  // El mostrador no hace conteos: si venía de un conteo con lecturas, se cierra antes.
  if (prefs.scanOp === 'establecer') { if (liveFeed().length) resetSession(); setScanOp('restar'); }
  segmented(byId('kOp'), prefs.scanOp);
  byId('kContact').value = session.contactName || '';
  renderKiosk();
  setTimeout(() => byId('kInput').focus({ preventScroll: true }), 80);
}
// Contadores del mostrador y botón "Terminar" (se comparten con Escanear).
function renderKiosk() {
  const live = liveFeed(), units = live.reduce((s, f) => s + f.amount, 0), m = scanMode();
  byId('kCount').textContent = fmt(live.length);
  byId('kUnits').textContent = fmt(units);
  byId('kUndo').disabled = !live.length;
  const verb = `Terminar ${m.name}`;
  byId('kRemito').disabled = byId('scanRemito').disabled = !live.length;
  byId('kFinishLabel').textContent = verb;
  byId('scanFinishLabel').textContent = live.length ? `${verb} (${fmt(live.length)} lectura${live.length === 1 ? '' : 's'} · ${fmt(units)} u.)` : verb;
  byId('scanRemito').className = `btn btn-lg btn-block finish-btn ${m.tone}`;
  byId('kRemito').className = `btn btn-lg finish-btn ${m.tone}`;
}

// =========================================================
// Ficha de movimientos de un producto
// =========================================================
const pd = { sku: '', kind: 'all' };
function openProductHistory(sku) {
  pd.sku = upper(sku); pd.kind = 'all';
  renderProductHistory();
  const d = byId('productDialog');
  if (!d.open) d.showModal();
}
function renderProductHistory() {
  const item = S.findByCode(pd.sku), sku = item?.sku || pd.sku;
  if (!canManage()) {
    const d = item ? S.displayQty(item) : null;
    byId('pdTitle').textContent = sku; byId('pdSub').textContent = item ? productName(item) : '';
    byId('pdEdit').hidden = !item; byId('pdLabels').hidden = !item; byId('pdExport').hidden = true;
    byId('pdBody').innerHTML = `<div class="pd-stats mini-stats"><div><strong>${d ? fmt(d.value) : '—'}</strong><span>${d ? esc(d.unit) : ''} en stock</span></div></div><div class="notice info">${icon('lock')}<span>El historial de movimientos es solo para la dueña de la cuenta.</span></div>`;
    return;
  }
  byId('pdExport').hidden = false;
  const all = state.history.filter(h => h.sku === sku);
  const rows = all.filter(h => kindMatches(h, pd.kind));
  const t = movementTotals(all);
  const lastIn = all.find(h => S.historyKind(h) === 'in'), lastOut = all.find(h => S.historyKind(h) === 'out');
  const d = item ? S.displayQty(item) : null;
  byId('pdTitle').textContent = `Movimientos de ${sku}`;
  byId('pdSub').textContent = item ? (productName(item) || 'Sin marca ni prenda') : 'Este producto ya no está en el inventario';
  byId('pdEdit').hidden = !item; byId('pdLabels').hidden = !item;

  // Estado de cada etiqueta numerada según su último movimiento.
  const serials = new Map();
  for (const h of [...all].reverse()) if (h.serial) serials.set(h.serial, h);
  const bySerial = { D: { out: [], in: [] }, U: { out: [], in: [] } };
  for (const [serial, h] of serials) {
    const si = S.serialInfo(serial), k = S.historyKind(h);
    if (si && (k === 'out' || k === 'in')) bySerial[si.pack][k].push({ n: si.number, at: h.at });
  }
  const chips = (list, cls) => list.sort((a, b) => a.n - b.n).map(x => `<span class="serial-chip ${cls}" title="${esc(dateTimeOf(x.at))}">N.º ${String(x.n).padStart(4, '0')}</span>`).join('');
  const serialBlock = ['D', 'U'].map(p => {
    const printed = item?.serials?.[p] || 0, b = bySerial[p];
    if (!printed && !b.out.length && !b.in.length) return '';
    const name = S.PACKS[p].plural;
    return `<div class="pd-section"><h4>${icon('tag')}Etiquetas por ${S.PACKS[p].label.toLowerCase()}</h4>
      <p class="small muted" style="margin-bottom:8px">${printed ? `Impresas: N.º 0001 a ${String(printed).padStart(4, '0')} · ` : ''}salieron ${fmt(b.out.length)} · ingresaron por escaneo ${fmt(b.in.length)}</p>
      ${b.out.length ? `<p class="small" style="margin-bottom:6px"><b>${name[0].toUpperCase() + name.slice(1)} que salieron</b> (pasá el mouse para ver fecha y hora):</p><div class="serial-chips">${chips(b.out, 'out')}</div>` : ''}
      ${b.in.length ? `<p class="small" style="margin:10px 0 6px"><b>${name[0].toUpperCase() + name.slice(1)} ingresadas por escaneo:</b></p><div class="serial-chips">${chips(b.in, 'in')}</div>` : ''}</div>`;
  }).join('');

  byId('pdBody').innerHTML = `
    <div class="pd-stats mini-stats">
      <div><strong>${d ? fmt(d.value) : '—'}</strong><span>${d ? `${esc(d.unit)} en stock${item.displayUnit === 'dozen' ? ` (${fmt(item.units)} u.)` : ''}` : 'sin stock'}</span></div>
      <div><strong style="color:var(--success)">+${fmt(t.ins)}</strong><span>unidades ingresadas · ${t.dz(t.ins)}</span></div>
      <div><strong style="color:var(--danger)">−${fmt(t.outs)}</strong><span>unidades salidas · ${t.dz(t.outs)}</span></div>
      <div><strong>${fmt(all.length)}</strong><span>movimientos</span></div>
    </div>
    <dl class="kv"><dt>Último ingreso</dt><dd>${lastIn ? esc(dateTimeOf(lastIn.at)) : '—'}</dd><dt>Última salida</dt><dd>${lastOut ? esc(dateTimeOf(lastOut.at)) : '—'}</dd></dl>
    ${serialBlock}
    <div class="pd-section"><h4>${icon('history')}Todos los movimientos</h4>
      <div class="chips" id="pdFilters" style="margin-bottom:6px">
        ${[['all', 'Todos'], ['in', 'Ingresos'], ['out', 'Salidas'], ['count', 'Conteos'], ['edit', 'Ediciones']].map(([k, l]) => `<button type="button" class="chip ${pd.kind === k ? 'active' : ''}" data-pk="${k}">${l} <span class="count">${all.filter(h => kindMatches(h, k)).length}</span></button>`).join('')}
      </div>
      <div class="timeline">${historyByDay(rows) || emptyState('history', 'Sin movimientos', 'No hay movimientos de este tipo para este código.')}</div>
    </div>`;
}

// =========================================================
// Datos
// =========================================================
let pendingImport = null;
async function handleImportFile(file) {
  if (!ownerOnly('importar datos')) return;
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
  if (!ownerOnly('importar datos')) return;
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
  // Los empleados no ven los botones exclusivos del dueño.
  const wasEmployee = document.body.classList.contains('is-employee');
  document.body.classList.toggle('is-employee', !cloud.isOwner());
  if (wasEmployee !== !cloud.isOwner()) renderAll();
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
    const emp = st.session.role === 'employee';
    const roleBadge = emp
      ? `<span class="badge badge-info">${icon('users')}Empleado de ${esc(st.session.business || '@' + (st.session.owner?.username || ''))}</span>`
      : `<span class="badge badge-success">${icon('check')}Dueño de la cuenta</span>`;
    el.innerHTML = `<div class="card auth-card"><div class="profile-head"><span class="avatar lg">${esc(initials(st.session.fullName || st.session.username))}</span><div><h3>${esc(st.session.fullName || st.session.username)}</h3><p class="muted">@${esc(st.session.username)} · ${roleBadge}</p></div></div>
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
    const teamCard = document.createElement('div');
    teamCard.className = 'card';
    teamCard.style.marginTop = '18px';
    teamCard.id = 'teamCard';
    el.append(teamCard);
    if (emp) renderEmployeeInfo(teamCard, st.session); else renderTeam();
    return;
  }
  el.innerHTML = '';
  el.append(buildAuth());
}

// ---------- Equipo: empleados que comparten el inventario ----------
const PERMS = `<div class="perm-list">
  <span class="yes">${icon('check', 'sm')}Cargar por voz y a mano</span><span class="yes">${icon('check', 'sm')}Escanear entradas y salidas</span>
  <span class="yes">${icon('check', 'sm')}Ver inventario e historial</span><span class="yes">${icon('check', 'sm')}Imprimir etiquetas</span>
  <span class="no">${icon('x', 'sm')}Corregir o anular movimientos</span><span class="no">${icon('x', 'sm')}Cambiar el stock a mano</span>
  <span class="no">${icon('x', 'sm')}Eliminar productos o el historial</span><span class="no">${icon('x', 'sm')}Importar datos</span></div>`;
function renderEmployeeInfo(card, s) {
  card.innerHTML = `<div class="card-head"><div class="card-title"><span class="card-icon">${icon('users')}</span><div><h3>Trabajás en ${esc(s.business || 'la cuenta de @' + (s.owner?.username || ''))}</h3><p>Dueño: ${esc(s.owner?.full_name || '')} (@${esc(s.owner?.username || '')})</p></div></div></div>
    <p class="small muted">Usás el mismo inventario que el resto del equipo. Cada movimiento queda registrado con tu usuario.</p>${PERMS}
    <p class="hint" style="margin-top:12px">Si cargaste algo mal, avisale al dueño: él puede corregirlo o anularlo. Una lectura recién escaneada podés revertirla desde la sesión de escaneo.</p>`;
}
let teamCache = null;
async function renderTeam() {
  const card = byId('teamCard');
  if (!card) return;
  card.innerHTML = `<div class="card-head"><div class="card-title"><span class="card-icon">${icon('users')}</span><div><h3>Equipo</h3><p>Empleados que usan tu mismo inventario</p></div></div>
    <button class="btn btn-primary btn-sm" type="button" id="teamAdd">${icon('plus', 'sm')}Agregar empleado</button></div>
    <div id="teamList">${teamCache ? '' : '<div class="skeleton" style="height:54px"></div>'}</div>
    <details class="tips"><summary>${icon('chevron-down')}Qué pueden hacer los empleados</summary>${PERMS}</details>`;
  byId('teamAdd').onclick = () => { ['mName', 'mUser', 'mPass'].forEach(id => { byId(id).value = ''; }); byId('memberDialog').showModal(); setTimeout(() => byId('mName').focus(), 60); };
  if (teamCache) drawTeam();
  try { teamCache = await cloud.team.list(); drawTeam(); }
  catch (e) { const l = byId('teamList'); if (l) l.innerHTML = `<div class="notice warn">${icon('alert')}<span>${esc(e.message)}</span></div>`; }
}
function drawTeam() {
  const list = byId('teamList');
  if (!list || !teamCache) return;
  const m = teamCache.members || [];
  byId('teamAdd').disabled = m.length >= teamCache.max;
  list.innerHTML = (m.length ? m.map(u => `<div class="team-row" data-member="${esc(u.id)}">
      <span class="avatar">${esc(initials(u.full_name || u.username))}</span>
      <div class="grow"><strong>${esc(u.full_name || u.username)}</strong><span class="mono">@${esc(u.username)} · ${u.last_login_at ? `entró ${relTime(u.last_login_at)}` : 'nunca entró'}</span></div>
      <span class="badge ${u.status === 'approved' ? 'badge-success' : 'badge-danger'}">${u.status === 'approved' ? 'Activo' : 'Deshabilitado'}</span>
      <button class="icon-btn" type="button" data-team="toggle" title="${u.status === 'approved' ? 'Deshabilitar' : 'Habilitar'}">${icon(u.status === 'approved' ? 'lock' : 'check')}</button>
      <button class="icon-btn" type="button" data-team="password" title="Cambiar contraseña">${icon('key')}</button>
      <button class="icon-btn danger" type="button" data-team="remove" title="Quitar del equipo">${icon('trash')}</button></div>`).join('')
    : emptyState('users', 'Todavía no agregaste empleados', 'Creales un usuario para que carguen y escaneen en tu mismo inventario.'))
    + `<p class="hint" style="margin-top:8px">${m.length} de ${teamCache.max} empleados.</p>`;
}
async function saveMember(e) {
  e.preventDefault();
  const btn = byId('mSave'), f = { fullName: txt(byId('mName').value), username: txt(byId('mUser').value).toLowerCase(), password: byId('mPass').value };
  if (!/^[a-z0-9._-]{3,30}$/.test(f.username)) { shake(btn); return toast('El usuario debe tener de 3 a 30 caracteres: letras minúsculas, números, punto, guion o guion bajo.', 'warn'); }
  if (f.password.length < 6) { shake(btn); return toast('La contraseña debe tener al menos 6 caracteres.', 'warn'); }
  busy(btn, true);
  try {
    await cloud.team.add(f);
    byId('memberDialog').close();
    toast(`Empleado @${f.username} creado. Pasale su usuario y contraseña.`);
    teamCache = await cloud.team.list(); drawTeam();
  } catch (er) { shake(btn); toast(er.message, 'error'); }
  finally { busy(btn, false); }
}
async function onTeamClick(e) {
  const b = e.target.closest('[data-team]');
  if (!b) return;
  const id = b.closest('[data-member]').dataset.member, u = teamCache?.members.find(x => x.id === id);
  if (!u) return;
  try {
    if (b.dataset.team === 'toggle') {
      await cloud.team.setStatus(id, u.status === 'approved' ? 'disabled' : 'approved');
      toast(u.status === 'approved' ? `@${u.username} deshabilitado: ya no puede entrar.` : `@${u.username} habilitado.`);
    } else if (b.dataset.team === 'password') {
      const p = prompt(`Nueva contraseña para @${u.username} (mínimo 6 caracteres):`);
      if (p === null) return;
      if (p.length < 6) return toast('La contraseña debe tener al menos 6 caracteres.', 'warn');
      await cloud.team.setPassword(id, p);
      toast(`Contraseña de @${u.username} cambiada. Su sesión se cerró en todos los dispositivos.`);
    } else if (b.dataset.team === 'remove') {
      if (!(await ask({ title: `¿Quitar a @${u.username} del equipo?`, message: 'Se borra su usuario. Sus movimientos quedan en el historial.', confirm: 'Quitar', danger: true }))) return;
      await cloud.team.remove(id);
      toast(`@${u.username} quitado del equipo.`);
    }
    teamCache = await cloud.team.list(); drawTeam();
  } catch (er) { toast(er.message, 'error'); }
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
  teamCache = null;
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
  $('meta[name="theme-color"]').content = theme === 'light' ? '#f3f3f0' : '#0e0f11';
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
  byId('contactList').innerHTML = S.contacts().map(c => `<option value="${esc(c.name)}">${esc(S.CONTACT_KINDS[c.kind])}${c.phone ? ' · ' + esc(c.phone) : ''}</option>`).join('');
  byId('skuList').innerHTML = state.items.slice().sort((a, b) => a.sku.localeCompare(b.sku, 'es', { numeric: true })).slice(0, 1000)
    .map(i => `<option value="${esc(i.sku)}">${esc(productName(i))}</option>`).join('');
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
  if (currentView === 'clientes') renderContacts();
  if (currentView === 'reportes') renderReports();
  renderDatalists();
  if (byId('productDialog').open) renderProductHistory();
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
  F.sku.addEventListener('input', debounce(() => syncUnitWithProduct(true), 250));
  F.sku.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); syncUnitWithProduct(true); F.qty.focus(); F.qty.select(); } }); // pistola dentro del campo
  byId('fSkuGen').onclick = () => { F.sku.value = S.generateSku(F.brand.value, F.type.value); highlight(F.sku); updateFormNotice(); };
  byId('fSkuCam').onclick = () => openCamera({ onCode: c => { F.sku.value = upper(c); highlight(F.sku); syncUnitWithProduct(true); } });
  byId('resetForm').onclick = () => { resetForm(); F.sku.focus(); };
  byId('formProduct').addEventListener('click', e => { if (e.target.closest('[data-edit-product]')) { const it = S.findByCode(F.sku.value); if (it) openEdit(it); } });
  byId('voiceAutoSave').onchange = e => { prefs.voiceAutoSave = e.target.checked; savePrefs(); };
  byId('voiceSpeak').onchange = e => { prefs.voiceSpeak = e.target.checked; savePrefs(); };
  byId('speakForm').onclick = speakForm;

  // Escanear
  byId('scanForm').addEventListener('submit', e => { e.preventDefault(); const v = byId('scanInput').value; byId('scanInput').value = ''; handleScan(v, 'escáner'); });
  byId('scanInput').addEventListener('focus', setScanReady);
  byId('scanInput').addEventListener('blur', setScanReady);
  onSegment(byId('scanOpSeg'), chooseScanOp);
  byId('scanQty').addEventListener('input', () => { prefs.scanQty = num(byId('scanQty').value) || 1; savePrefs(); });
  byId('scanUnknown').onchange = e => { prefs.scanUnknown = e.target.value; savePrefs(); };
  byId('scanSound').onchange = e => { prefs.sound = e.target.checked; savePrefs(); };
  byId('scanCamera').onclick = () => openCamera({ continuous: true, onCode: c => handleScan(c, 'cámara') });
  byId('scanNewSession').onclick = () => { resetSession(); toast('Lista vacía. Lo escaneado antes ya quedó guardado en el stock.', 'info'); focusScan(); };
  byId('scanFeed').addEventListener('click', e => {
    const b = e.target.closest('[data-revert]');
    if (b) { revertScan(b.dataset.revert); return; }
    const row = e.target.closest('[data-move]');
    if (row) openMove(row.dataset.move);
  });
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
  byId('lblCopies').addEventListener('input', e => { prefs.lblCopies = Math.max(1, Math.floor(num(e.target.value)) || 1); savePrefs(); syncLblChips(); renderLabelPreview(); });
  byId('lblHeader').addEventListener('input', e => { prefs.lblHeader = e.target.value; savePrefs(); renderLabelPreview(); });
  byId('lblShowName').onchange = e => { prefs.lblShowName = e.target.checked; savePrefs(); renderLabelPreview(); };
  byId('lblByStock').onchange = e => { prefs.lblByStock = e.target.checked; savePrefs(); byId('lblCopies').disabled = e.target.checked; syncLblChips(); renderLabelPreview(); };
  onSegment(byId('lblMode'), setLblMode);
  onSegment(byId('lblQtyMode'), setLblQtyMode);
  byId('lblFixed').addEventListener('input', e => { prefs.lblFixed = Math.max(1, Math.floor(num(e.target.value)) || 1); savePrefs(); syncLblChips(); renderLabelPreview(); });
  byId('lblFixedChips').addEventListener('click', e => { const c = e.target.closest('[data-n]'); if (!c) return; byId('lblFixed').value = c.dataset.n; byId('lblFixed').dispatchEvent(new Event('input', { bubbles: true })); });
  byId('lblCopiesChips').addEventListener('click', e => {
    const c = e.target.closest('[data-n]'); if (!c) return;
    if (prefs.lblByStock) { prefs.lblByStock = false; byId('lblByStock').checked = false; byId('lblCopies').disabled = false; }
    byId('lblCopies').value = c.dataset.n; byId('lblCopies').dispatchEvent(new Event('input', { bubbles: true }));
  });
  byId('lblNumbers').addEventListener('input', debounce(e => { prefs.lblList = e.target.value; savePrefs(); syncLblChips(); renderLabelPreview(); }, 200));
  byId('lblListChips').addEventListener('click', e => { const c = e.target.closest('[data-list]'); if (!c) return; byId('lblNumbers').value = c.dataset.list; prefs.lblList = c.dataset.list; savePrefs(); syncLblChips(); renderLabelPreview(); });
  byId('lblRestart').onchange = async e => {
    if (e.target.checked && !(await ask({ title: '¿Reiniciar la numeración?', message: 'Se van a imprimir números que quizás ya existen en otras etiquetas pegadas. Usalo solo si retiraste las etiquetas anteriores.', confirm: 'Reiniciar desde 1' }))) { e.target.checked = false; return; }
    prefs.lblRestart = e.target.checked; savePrefs(); renderLabelPreview();
  };
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
  byId('histCode').addEventListener('input', debounce(e => { hist.code = e.target.value; hist.limit = 100; renderHistory(); }, 200));
  byId('histBrand').onchange = e => { hist.brand = e.target.value; hist.limit = 100; renderHistory(); };
  byId('histType').onchange = e => { hist.type = e.target.value; hist.limit = 100; renderHistory(); };
  byId('histPeriod').onchange = e => { hist.period = e.target.value; hist.limit = 100; renderHistory(); };
  byId('histReset').onclick = () => {
    Object.assign(hist, { q: '', kind: 'all', code: '', brand: '', type: '', period: 'all', limit: 100 });
    byId('histSearch').value = ''; byId('histCode').value = ''; byId('histPeriod').value = 'all';
    renderHistory();
  };
  // Tocar cualquier movimiento abre la ficha completa de ese código.
  const openFromRow = e => {
    const fixBtn = e.target.closest('[data-fix]');
    if (fixBtn) { if (e.type === 'click') { e.stopPropagation(); openFix(fixBtn.dataset.fix); } return; }
    const link = e.target.closest('[data-open-product]');
    if (link) { e.preventDefault(); openProductHistory(link.dataset.openProduct); return; }
    const row = e.target.closest('.tl-item[data-move]');
    if (!row || (e.type === 'keydown' && e.key !== 'Enter')) return;
    openMove(row.dataset.move);
  };
  document.addEventListener('click', openFromRow);
  document.addEventListener('keydown', openFromRow);
  onSegment(byId('fixMode'), setFixMode);
  byId('fixQty').addEventListener('input', renderFixPreview);
  byId('fixUnit').addEventListener('change', renderFixPreview);
  byId('fixReasons').addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (!c) return;
    byId('fixReason').value = c.textContent;
    $$('#fixReasons .chip').forEach(x => x.classList.toggle('active', x === c));
    byId('fixReason').classList.remove('has-error'); byId('fixError').hidden = true;
  });
  byId('fixReason').addEventListener('input', () => {
    byId('fixReason').classList.remove('has-error'); byId('fixError').hidden = true;
    $$('#fixReasons .chip').forEach(x => x.classList.toggle('active', x.textContent === byId('fixReason').value));
  });
  byId('fixForm').addEventListener('submit', saveFix);
  byId('memberForm').addEventListener('submit', saveMember);
  byId('accountArea').addEventListener('click', onTeamClick);
  byId('mPassGen').onclick = () => { byId('mPass').value = Math.random().toString(36).slice(2, 6) + Math.floor(1000 + Math.random() * 9000); };
  byId('pdBody').addEventListener('click', e => { const c = e.target.closest('[data-pk]'); if (c) { pd.kind = c.dataset.pk; renderProductHistory(); } });
  byId('pdExport').onclick = () => {
    const rows = state.history.filter(h => h.sku === (S.findByCode(pd.sku)?.sku || pd.sku));
    if (!IO.exportHistoryCSV(rows, `StockVoz_movimientos_${pd.sku}_${new Date().toLocaleDateString('sv-SE')}.csv`)) toast('Este código no tiene movimientos.', 'warn');
  };
  byId('pdEdit').onclick = () => { const it = S.findByCode(pd.sku); if (it) { byId('productDialog').close(); openEdit(it); } };
  byId('pdLabels').onclick = () => { const it = S.findByCode(pd.sku); if (it) { byId('productDialog').close(); labelsFor([it.id]); } };
  byId('histFilters').addEventListener('click', e => { const c = e.target.closest('[data-k]'); if (c) { hist.kind = c.dataset.k; hist.limit = 100; renderHistory(); } });
  byId('histMore').onclick = () => { hist.limit += 100; renderHistory(); };
  byId('histExport').onclick = () => { if (!IO.exportHistoryCSV(filteredHistory())) toast('No hay movimientos para exportar.', 'warn'); };
  byId('histClear').onclick = async () => { if (!ownerOnly('borrar el historial')) return; if (await ask({ title: '¿Borrar todo el historial?', message: 'El stock no cambia. Podés deshacerlo enseguida.', confirm: 'Borrar historial', danger: true })) { S.clearHistory(); toast('Historial borrado', { action: () => S.undo() }); } };

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

function bindExtras() {
  // Cliente / proveedor
  byId('fContactNew').onclick = async () => { const c = await openContact(null, kindForOp(prefs.formOp), byId('fContact').value); if (c) byId('fContact').value = c.name; };
  byId('scanContactNew').onclick = async () => { const c = await openContact(null, kindForOp(prefs.scanOp), byId('scanContact').value); if (c) setSessionContact(c.name); focusScan(); };
  byId('scanContact').addEventListener('change', e => setSessionContact(txt(e.target.value), 'scan'));
  byId('kContact').addEventListener('change', e => { setSessionContact(txt(e.target.value), 'kiosk'); byId('kInput').focus(); });
  byId('contactForm').addEventListener('submit', saveContactForm);
  onSegment(byId('ctdKind'), v => { segmented(byId('ctdKind'), v); byId('ctdKind').dataset.value = v; });
  byId('contactDialog').addEventListener('close', () => { if (contactResolve) { contactResolve(null); contactResolve = null; } });
  byId('ctdDelete').onclick = async () => {
    if (!editingContact || !ownerOnly('eliminar clientes o proveedores')) return;
    if (!(await ask({ title: `¿Eliminar a ${editingContact.name}?`, message: 'Sus movimientos y remitos anteriores no se borran.', confirm: 'Eliminar', danger: true }))) return;
    S.deleteContact(editingContact.id); byId('contactDialog').close(); toast('Contacto eliminado');
  };
  // Vista Clientes
  onSegment(byId('ctKind'), v => { ct.kind = v; ct.filter = null; renderContacts(); });
  byId('ctSearch').addEventListener('input', debounce(e => { ct.q = e.target.value; renderContacts(); }, 150));
  byId('ctNew').onclick = () => openContact(null, ct.kind);
  byId('ctList').addEventListener('click', e => {
    const row = e.target.closest('[data-contact]'), b = e.target.closest('[data-ct]');
    if (!row || !b) return;
    const c = S.findContact(row.dataset.contact);
    if (b.dataset.ct === 'edit') openContact(c);
    else { ct.filter = ct.filter === c.id ? null : c.id; renderContacts(); }
  });
  byId('ctRemitos').addEventListener('click', e => {
    const row = e.target.closest('[data-remito]');
    if (!row) return;
    const b = e.target.closest('[data-rm]');
    if (b) remitoAction(row.dataset.remito, b.dataset.rm); else openRemitoView(row.dataset.remito);
  });
  byId('rvPdf').onclick = () => remitoAction(viewingRemito, 'pdf');
  byId('rvWa').onclick = () => remitoAction(viewingRemito, 'wa');
  byId('mvFix').onclick = () => { const id = viewingMove; byId('moveDialog').close(); setTimeout(() => openFix(id), 150); };
  byId('mvProduct').onclick = () => {
    const h = state.history.find(x => x.id === viewingMove);
    byId('moveDialog').close();
    if (h && !(byId('productDialog').open && pd.sku === upper(h.sku))) setTimeout(() => openProductHistory(h.sku), 150);
  };
  byId('mvBody').addEventListener('click', e => { const l = e.target.closest('[data-goto-move]'); if (l) { e.preventDefault(); openMove(l.dataset.gotoMove); } });
  byId('ctRemitosSub').addEventListener('click', e => { if (e.target.closest('[data-ct-all]')) { e.preventDefault(); ct.filter = null; renderContacts(); } });
  // Remitos
  byId('scanRemito').onclick = finishScan;
  byId('kRemito').onclick = finishScan;
  byId('rmFinish').onclick = () => { endScanSession(pendingRemito?.created || null); byId('remitoDialog').close(); };
  // Si el remito ya se numeró (p. ej. se canceló el envío) y se cierra el diálogo, la salida queda terminada.
  byId('remitoDialog').addEventListener('close', () => { if (pendingRemito?.finish && pendingRemito.created) endScanSession(pendingRemito.created); });
  byId('remitoForm').addEventListener('submit', e => sendRemito(e, 'wa'));
  byId('rmDownload').onclick = e => sendRemito(e, 'download');
  // Reportes
  onSegment(byId('rpPeriod'), v => { rp.days = Number(v); renderReports(); });
  byId('rpUser').onchange = e => { rp.user = e.target.value; renderReports(); };
  byId('rpExport').onclick = () => { const rows = R.periodRows(state.history, rp); if (!IO.exportHistoryCSV(rows, `StockVoz_movimientos_${rp.days || 'todo'}dias.csv`)) toast('No hay movimientos en el período.', 'warn'); };
  R.bindChart(byId('rpBody'));
  // Modo mostrador
  onSegment(byId('kOp'), chooseScanOp);
  byId('kForm').addEventListener('submit', e => { e.preventDefault(); const v = byId('kInput').value; byId('kInput').value = ''; handleScan(v, 'mostrador'); });
  byId('kExit').onclick = () => { location.hash = '#/escanear'; };
  byId('kUndo').onclick = () => { const last = session.feed.find(f => !f.undone); if (last) revertScan(last.id); byId('kInput').focus(); };
  byId('kiosk').addEventListener('click', e => { if (!e.target.closest('button, input, a, .segmented')) byId('kInput').focus(); });
  // Manual
  byId('manualOpenAll').onclick = () => { const all = $$('.manual-topic'), open = all.some(d => !d.open); all.forEach(d => { d.open = open; }); byId('manualOpenAll').lastChild.textContent = open ? 'Cerrar todo' : 'Abrir todo'; };
  byId('manualPrint').onclick = () => {
    $$('.manual-topic').forEach(d => { d.open = true; });
    // Se imprime siempre con el tema claro (texto negro sobre blanco) y después se vuelve al tema elegido.
    const theme = document.documentElement.dataset.theme;
    document.documentElement.dataset.theme = 'light';
    document.body.classList.add('print-manual');
    window.addEventListener('afterprint', () => { document.body.classList.remove('print-manual'); document.documentElement.dataset.theme = theme; }, { once: true });
    window.print();
  };
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
  $$('[data-year]').forEach(el => { el.textContent = new Date().getFullYear(); });
  byId('appVersion').textContent = `v${CONFIG.VERSION}`;
  initInteractions();
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
  byId('lblFixed').value = prefs.lblFixed;
  byId('lblNumbers').value = prefs.lblList;
  prefs.lblRestart = false; // por seguridad, nunca arranca activado
  setLblMode(prefs.lblMode);
  setInvFilter('all');
  byId('voiceAutoSave').checked = prefs.voiceAutoSave;
  byId('voiceSpeak').checked = prefs.voiceSpeak;
  byId('voiceBadge').className =`badge ${recog ? 'badge-success' : 'badge-warn'}`;
  byId('voiceBadge').textContent = recog ? 'Disponible' : 'No disponible';
  if (!recog) { byId('micBtn').disabled = true; byId('micStatus').textContent = 'Este navegador no admite dictado. Escribí el producto o usá Chrome.'; }

  bindEvents();
  bindExtras();
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
