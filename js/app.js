// StockVoz · interfaz principal: navegación, vistas y eventos.
import { CONFIG } from './config.js';
import {
  byId, $, $$, esc, icon, hydrateIcons, toast, ask, fmt, txt, upper, num, debounce, relTime, busy, flashDone, shake,
  beep, vibrate, initInteractions, animateNumber, readJSON, writeJSON, initials, waLink, money, moneyIn, parseMoney, round2, setMoneyCurrency,
} from './utils.js';
import { fetchBlue } from './fx.js';
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
  lblMode: 'product', lblQtyMode: 'stock', lblFixed: 1, lblList: '', lblRestart: false, lblShowPrice: false,
  saleOut: true, buyIn: false, // con precios activados: las salidas son ventas y las entradas no son compras (se puede cambiar)
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
  precios: ['Consultar precio', 'Escaneá o buscá un producto y mirá cuánto sale'],
  ayuda: ['Ayuda', 'Manual de uso paso a paso'],
};
const MORE_VIEWS = ['precios', 'etiquetas', 'historial', 'datos', 'cuenta', 'clientes', 'reportes', 'kiosco', 'ayuda'];
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
  // Sin precios activados, la consulta de precios no existe.
  if (view === 'precios' && !S.pricesOn()) { view = 'panel'; history.replaceState(null, '', '#/panel'); }
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
  precios: () => { renderPriceLookup(); setTimeout(() => byId('plInput').focus({ preventScroll: true }), 60); },
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

// =========================================================
// Precios (opcional): con el ajuste apagado la app es solo control de stock y no muestra nada de esto.
// =========================================================
// Cobrar en pesos: en una venta el precio es el de pesos (fijo o dólares × blue); en una compra, el costo guardado.
const salePrice = (item, kind = 'venta') => (kind === 'venta' && S.chargeArs() ? S.arsPriceFor(item) : S.priceFor(item, kind));
const saleCur = (kind = 'venta') => (kind === 'venta' && S.chargeArs() ? 'ARS' : S.currency());
const remMoney = (r, n) => moneyIn(n, S.remitoCurrency(r));
const repMoney = n => moneyIn(n, S.reportCurrency());
// Importe de un comprobante en la moneda de los reportes (una venta en pesos y una compra en dólares se pueden sumar).
const remitoIn = (r, n = r.total) => S.convert(num(n), S.remitoCurrency(r), S.reportCurrency(), r.fx?.rate) ?? 0;
// "US$ 92,45 · $ 144.700 c/docena": con cobro en pesos se ven las dos monedas.
const priceText = (item, kind = 'venta') => {
  const p = S.priceFor(item, kind), a = kind === 'venta' ? S.arsPriceFor(item) : null;
  if (!p && !a) return '';
  return `${p ? money(p.price) : ''}${p && a ? ' · ' : ''}${a ? `${moneyIn(a.price, 'ARS')}${a.fixed ? ' fijo' : ''}` : ''} ${S.PRICE_PER[(p || a).per]}`;
};
// ¿Lo que se escanea ahora es una venta o una compra? (null = solo stock)
const saleKind = () => (!S.pricesOn() ? null : prefs.scanOp === 'restar' && prefs.saleOut ? 'venta' : prefs.scanOp === 'sumar' && prefs.buyIn ? 'compra' : null);
// Al prender o apagar los precios (acá o desde otro dispositivo) se redibuja todo lo que pudo quedar
// con precios a la vista: el recuadro de la última lectura, el mostrador, la lista y los avisos de Escanear.
let pricesWereOn = null;
function onPricesChanged() {
  feedPriceEdit = null;
  slEditing = false;
  byId('scanLast').innerHTML = '';
  const k = byId('kResult');
  k.className = 'kiosk-result';
  k.innerHTML = '<p class="kiosk-hint">Listo. Disparale a la etiqueta con la pistola.</p>';
  closeMa();
  setScanOp(prefs.scanOp);
}
function applyPricesUI() {
  const on = S.pricesOn();
  const flipped = pricesWereOn !== null && pricesWereOn !== on;
  pricesWereOn = on;
  if (flipped) onPricesChanged();
  document.body.classList.toggle('prices-on', on);
  byId('pricesOn').checked = on;
  byId('pricesOn').disabled = !canManage();
  byId('pricesHint').textContent = on
    ? 'Activado: podés cargar precios en los productos y registrar ventas y compras. Si lo apagás, los precios se ocultan pero no se borran.'
    : 'Apagado: la app funciona solo como control de stock. Encendelo si además querés registrar precios, ventas y compras.';
  if (!canManage()) byId('pricesHint').textContent += ' Solo el dueño de la cuenta puede cambiarlo.';
  setMoneyCurrency(S.currency());
  byId('setCurrency').value = priceMode();
  renderArsSettings();
  renderFxChip();
  const m = S.marginPct(), withCost = state.items.filter(i => i.cost > 0).length, manual = S.manualPriceCount();
  if (document.activeElement !== byId('setMargin')) byId('setMargin').value = m ?? '';
  byId('marginHint').innerHTML = m == null
    ? 'Escribí un porcentaje y el precio de venta se calcula solo: <b>costo + ganancia</b>. Cualquier producto se puede corregir a mano desde Editar.'
    : `Precio de venta = costo + ${fmt(m)} % (ej.: costo ${money(100)} → venta ${money(S.autoPrice({ cost: 100 }))}). ${fmt(withCost)} producto${withCost === 1 ? '' : 's'} con costo${manual ? ` · ${fmt(manual)} con precio a mano (no cambian)` : ''}.`;
}

// Cobro en pesos: cotización del blue, redondeo y cotización fija.
function renderArsSettings() {
  const usd = S.currency() === 'USD', on = S.chargeArs(), fx = S.fxNow(), live = S.fxLiveInfo();
  byId('arsBox').hidden = !usd || !on;
  byId('arsRound').value = String(S.arsRound());
  if (document.activeElement !== byId('fxFixed')) byId('fxFixed').value = S.fxFixed() ? fmt(S.fxFixed()) : '';
  byId('arsDetails').hidden = !on;
  const ex = S.marginPct() != null ? S.autoPrice({ cost: 100 }) : 100;
  byId('fxStatus').innerHTML = !fx
    ? `<span class="warn">Todavía no hay cotización. Revisá la conexión y tocá Actualizar, o escribí una cotización fija.</span>`
    : `${S.fxFixed() ? 'Cotización fija' : 'Dólar blue (venta)'}: <b>${moneyIn(fx.rate, 'ARS')}</b>${!S.fxFixed() && live ? ` · ${esc(live.source)} · ${relTime(live.fetchedAt || live.at)}` : ''}${S.fxFixed() && live ? ` · el blue está a ${moneyIn(live.rate, 'ARS')}` : ''}<br>Ej.: ${S.marginPct() != null ? `costo ${moneyIn(100, 'USD')} + ${fmt(S.marginPct())} % = ` : ''}${moneyIn(ex, 'USD')} × ${moneyIn(fx.rate, 'ARS')} = <b>${moneyIn(S.roundArs(ex * fx.rate), 'ARS')}</b>${S.arsRound() ? ` (redondeado a ${moneyIn(S.arsRound(), 'ARS')})` : ''}`;
}
// Cotización a la vista: arriba de todo, cuando los precios están en dólares.
function renderFxChip() {
  const fx = S.fxNow(), chip = byId('fxChip');
  chip.hidden = !S.pricesOn() || S.currency() !== 'USD' || !fx;
  if (chip.hidden) return;
  chip.innerHTML = `${icon('cash')}<b>${fx.fixed ? 'Dólar fijo' : 'Dólar blue'} ${moneyIn(fx.rate, 'ARS')}</b>`;
}
// Consulta el blue (al abrir, cada 30 minutos y con el botón). quiet: sin avisos si falla.
let fxBusy = false;
async function refreshFx(quiet = true) {
  if (fxBusy || S.currency() !== 'USD' || !S.pricesOn()) return;
  fxBusy = true;
  busy(byId('fxRefresh'), true);
  const fx = await fetchBlue();
  fxBusy = false;
  busy(byId('fxRefresh'), false);
  if (fx) { S.setLiveFx(fx); if (!quiet) toast(`Dólar blue: ${moneyIn(fx.rate, 'ARS')} (${fx.source})`, 'success'); }
  else if (!quiet) toast('No se pudo consultar el dólar blue. Se sigue usando la última cotización guardada.', 'warn');
}
const fxStale = () => { const l = S.fxLiveInfo(); return !l || Date.now() - new Date(l.fetchedAt || l.at).getTime() > 30 * 60000; };

// Ganancia general sobre el costo: se aplica a todos los productos con costo, menos a los de precio a mano.
async function applyMargin() {
  if (!ownerOnly('cambiar la ganancia general')) return;
  const raw = txt(byId('setMargin').value).replace(',', '.'), m = raw === '' ? null : Number(raw);
  if (m !== null && !(m >= 0 && m <= 1000)) { toast('Escribí un porcentaje entre 0 y 1000, por ejemplo 40.', 'error'); shake(byId('setMarginBtn')); return; }
  let overrideManual = false;
  const manual = S.manualPriceCount();
  if (m !== null && manual) {
    const v = await ask({
      title: `¿Aplicar ${fmt(m)} % de ganancia?`,
      message: `${manual} producto${manual === 1 ? ' tiene' : 's tienen'} un precio de venta escrito a mano. ¿Quedan como están o también les aplicás la ganancia general?`,
      choices: [{ label: 'Dejar los precios a mano (recomendado)', value: 'keep', primary: true }, { label: `Aplicar a todos (se reemplazan ${manual} precio${manual === 1 ? '' : 's'} a mano)`, value: 'all' }],
      cancel: 'Cancelar',
    });
    if (!v) return;
    overrideManual = v === 'all';
  }
  const r = S.setMargin(m, { overrideManual });
  if (!r.ok) { toast(r.error, 'error'); return; }
  toast(m === null ? 'Ganancia general quitada: los precios quedan como están.' : `Ganancia ${fmt(m)} % aplicada: ${fmt(r.changed)} precio${r.changed === 1 ? '' : 's'} de venta actualizado${r.changed === 1 ? '' : 's'}.`, { action: () => { if (S.undo()) toast('Cambio deshecho', 'info'); } });
}
// Moneda de los precios: BLUE = costos y precios en dólares y se cobra en pesos con el dólar blue (venta);
// USD = todo en dólares; ARS = todo en pesos.
const priceMode = () => (S.chargeArs() ? 'BLUE' : S.currency());
const PRICE_MODES = { BLUE: 'pesos con el dólar blue', USD: 'dólares (US$)', ARS: 'pesos ($)' };
async function changeCurrency(mode) {
  if (!ownerOnly('cambiar la moneda')) { byId('setCurrency').value = priceMode(); return; }
  if (mode === priceMode()) return;
  const base = mode === 'ARS' ? 'ARS' : 'USD';
  const priced = state.items.some(i => i.price || i.cost);
  if (base !== S.currency() && priced && !(await ask({
    title: base === 'USD' ? '¿Tus costos y precios están en dólares?' : '¿Tus costos y precios están en pesos?',
    message: `Los importes ya cargados no se convierten: se toman como ${base === 'USD' ? 'dólares' : 'pesos'}.${mode === 'BLUE' ? ' En pesos se muestran multiplicados por el dólar blue venta.' : ''}`,
    confirm: 'Sí, cambiar',
  }))) { byId('setCurrency').value = priceMode(); return; }
  S.setCurrency(base, mode === 'BLUE');
  toast(mode === 'BLUE' ? 'Precios en pesos con el dólar blue: (costo en US$ + ganancia) × blue venta.' : `Precios en ${PRICE_MODES[mode]}.`, 'success');
}
// Total en pesos de lo escaneado (con los precios actuales de cada producto).
function sessionMoney() {
  const k = saleKind();
  if (!k) return null;
  let total = 0;
  const missing = new Set(), cur = saleCur(k);
  for (const f of liveFeed()) {
    const p = linePrice(f, k);
    if (p) total += S.lineAmount(f.amount, p.price, p.per); else missing.add(f.sku);
  }
  // Con cobro en pesos se muestra también cuánto es en dólares (igual que al cerrar la venta).
  const rate = cur !== S.currency() ? S.fxRate() : null;
  return { total: round2(total), cur, usd: rate ? round2(total / rate) : null, missing: missing.size, kind: k };
}

// Productos que se cargan y se ven en docenas (la cuenta interna sigue en unidades).
const isDozenItem = i => i?.unitName === 'unidades' && i.displayUnit === 'dozen';
const stockWords = (i, units) => (isDozenItem(i) ? unitWords(units / 12, 'docenas') : unitWords(units, S.unitLabel(i.unitName)));
// Cuánto se movió en la sesión: en docenas si hay productos en docenas.
function sessionQty(live) {
  const units = live.reduce((s, f) => s + f.amount, 0), dz = live.some(f => f.dz), value = dz ? units / 12 : units;
  return { units, value, label: dz ? (value === 1 ? 'docena' : 'docenas') : (value === 1 ? 'unidad' : 'unidades'), short: dz ? 'doc.' : 'u.' };
}
const sessionMoneyText = sm => `${moneyIn(sm.total, sm.cur)}${sm.usd ? ` · ${moneyIn(sm.usd, 'USD')}` : ''}`;

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
  const fixBtn = !opts.select && canFix(h) ? `<button type="button" class="icon-btn tl-fix-btn" data-fix="${esc(h.id)}" title="Corregir o anular este movimiento" aria-label="Corregir movimiento">${icon('edit')}</button>` : '';
  const sel = opts.select && opts.selected?.has(h.id);
  const check = opts.select ? `<span class="check tl-check" aria-hidden="true"><input type="checkbox" tabindex="-1" ${sel ? 'checked' : ''}><span></span></span>` : '';
  return `<div class="tl-item tl-${k} ${h.voided ? 'is-voided' : ''} ${sel ? 'selected' : ''}" data-move="${esc(h.id)}" ${h.sku ? `data-sku="${esc(h.sku)}"` : ''} tabindex="0" ${opts.select ? `role="checkbox" aria-checked="${sel ? 'true' : 'false'}" title="Tocá para elegirlo"` : 'title="Ver el detalle"'}>${check}<span class="tl-icon">${icon(KIND_ICON[k] || 'edit')}</span>
    <div class="tl-body"><div class="tl-title"><strong class="mono">${esc(h.sku) || '—'}</strong> <span>${esc(h.action)}</span>${si ? ` <span class="badge badge-primary">${icon('tag')}${esc(si.label)}</span>` : ''}${h.voided ? ' <span class="badge badge-danger">Anulado</span>' : h.corrected ? ' <span class="badge badge-warn">Corregido</span>' : ''}</div>
    <div class="tl-sub">${sub || esc(h.note || '')}</div>${fixNote ? `<div class="tl-note">${icon('info', 'sm')} ${fixNote}</div>` : ''}${k === 'fix' && h.note ? `<div class="tl-note">${esc(h.note)}</div>` : ''}</div>
    <div class="tl-side">${q ? `<strong class="delta">${q.main}</strong>${q.sub ? `<span class="delta-sub">${q.sub}</span>` : ''}` : ''}<span class="tl-side-row">${fixBtn}<span class="tl-time" title="${esc(dateTimeOf(h.at))}">${opts.time ? timeOf(h.at) : relTime(h.at)}</span></span></div></div>`;
}
// Agrupa movimientos por día, con la hora de cada uno. opts.select: con casillas para elegir varios.
function historyByDay(rows, opts = {}) {
  let html = '', day = '';
  for (const h of rows) {
    const date = new Date(h.at), d = date.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    if (d !== day) {
      const key = date.toDateString(), all = opts.select && rows.filter(x => new Date(x.at).toDateString() === key).every(x => opts.selected.has(x.id));
      html += `<div class="tl-day">${opts.select ? `<span>${esc(d.charAt(0).toUpperCase() + d.slice(1))}</span>` : esc(d)}${opts.select ? `<button type="button" class="link tl-day-sel" data-hsel-day="${esc(key)}">${all ? 'Quitar el día' : 'Elegir todo el día'}</button>` : ''}</div>`;
      day = d;
    }
    html += historyRow(h, { time: true, ...opts });
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

  renderPanelSales();
  byId('recentList').innerHTML = state.history.length
    ? state.history.slice(0, 6).map(historyRow).join('')
    : emptyState('history', 'Sin actividad todavía', 'Tus ingresos, salidas y conteos aparecen acá.');
  byId('alertList').innerHTML = alerts.length
    ? alerts.slice(0, 6).map(i => `<a class="alert-row" href="#/inventario?f=alert"><span class="tl-icon" style="background:var(--${i.units <= 0 ? 'danger' : 'warn'}-soft);color:var(--${i.units <= 0 ? 'danger' : 'warn'})">${icon('alert')}</span><span class="grow" style="min-width:0"><strong class="mono">${esc(i.sku)}</strong><div class="tl-sub">${esc(productName(i) || 'Sin datos')}</div></span><span class="badge ${i.units <= 0 ? 'badge-danger' : 'badge-warn'}">${i.units <= 0 ? 'Sin stock' : `${fmt(i.units)} / mín. ${fmt(i.minStock)}`}</span></a>`).join('')
    : emptyState('check', 'Todo en orden', 'Te avisamos cuando un producto se quede sin stock o baje del mínimo.');
  renderBanners();
}

// Ventas de hoy, de los últimos 7 días y del mes (solo dueño y con precios activados).
function renderPanelSales() {
  const box = byId('panelSales');
  if (!S.pricesOn() || !canManage()) { box.innerHTML = ''; return; }
  const sales = state.extra.remitos.filter(r => r.priced && !r.voided && r.kind !== 'entrada');
  const d0 = new Date(); d0.setHours(0, 0, 0, 0);
  const w0 = new Date(d0); w0.setDate(w0.getDate() - 6);
  const m0 = new Date(d0.getFullYear(), d0.getMonth(), 1);
  const sum = from => { const l = sales.filter(r => new Date(r.at) >= from); return { total: l.reduce((s, r) => s + remitoIn(r), 0), n: l.length }; };
  const tile = (label, s) => `<div><span>${label}</span><strong>${repMoney(s.total)}</strong><small>${s.n ? `${fmt(s.n)} venta${s.n === 1 ? '' : 's'}` : 'Sin ventas'}</small></div>`;
  box.innerHTML = `<div class="card sales-strip">${tile('Ventas de hoy', sum(d0))}${tile('Últimos 7 días', sum(w0))}${tile('Este mes', sum(m0))}<a class="link" href="#/reportes">Reportes ${icon('chevron-right', 'sm')}</a></div>`;
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
    const sims = S.similarCodes(sku);
    card.className = `span-2 product-card is-new${sims.length ? ' is-similar' : ''}`;
    card.innerHTML = sims.length
      ? `<span class="card-icon">${icon('alert')}</span><div class="grow"><strong>¿${esc(sku)} ya está cargado con otro código?</strong><span>Hay productos con código parecido. Si es uno de estos, tocalo para no cargarlo dos veces:</span>
        <div class="similar-list">${sims.map(s => `<button type="button" class="similar-opt" data-use-sku="${esc(s.item.sku)}"><b class="mono">${esc(s.item.sku)}</b><span>${esc(productName(s.item) || 'Sin marca ni prenda')} · stock ${fmt(S.displayQty(s.item).value)} ${esc(S.displayQty(s.item).unit)}</span><small>${esc(s.reason)}</small></button>`).join('')}</div>
        <span>Si es otro producto, completá marca y prenda y guardá.</span></div>`
      : `<span class="card-icon">${icon('sparkles')}</span><div class="grow"><strong>Producto nuevo: ${esc(sku)}</strong><span>Completá marca y prenda: se guardan una sola vez. La próxima vez alcanza con el código y la cantidad.</span></div>`;
  }
}

// Cambia el código del formulario por el de un producto ya cargado (sugerencia de código parecido).
// Se borran marca, prenda y demás datos de alta para no pisar los del producto existente.
function useExistingCode(sku, preferProduct = true) {
  F.sku.value = sku;
  ['brand', 'type', 'min', 'barcode'].forEach(k => { F[k].value = ''; });
  byId('fPrice').value = '';
  syncUnitWithProduct(preferProduct);
  highlight(F.sku);
}

// Antes de dar de alta un código nuevo se ofrece usar un producto con código casi igual (8008 / GT8008).
// Devuelve el producto elegido, 'new' para crearlo igual, null si se cancela, o undefined si no hay parecidos.
async function confirmSimilar(code, { allowNew = true } = {}) {
  const sims = S.similarCodes(code).filter(s => s.strong);
  if (!sims.length) return undefined;
  sound('warn');
  const one = sims.length === 1;
  const v = await ask({
    title: `¿${code} es ${one ? sims[0].item.sku : 'alguno de estos productos'}?`,
    message: `${code} no está cargado, pero ya ${one ? 'hay un producto' : 'hay productos'} con código parecido (${sims.map(s => `${s.item.sku}: ${s.reason}`).join(' · ')}). Si es el mismo, usalo para no tenerlo dos veces en el stock.`,
    choices: [
      ...sims.map((s, n) => ({ label: `Sí, es ${s.item.sku}${productName(s.item) ? ` · ${productName(s.item)}` : ''}`, value: s.item.id, primary: n === 0 })),
      ...(allowNew ? [{ label: `No, ${code} es otro producto`, value: 'new' }] : []),
    ],
    cancel: 'Cancelar',
  });
  if (v === 'new') return 'new';
  return v ? S.findById(v) : null;
}

function updateFormNotice() {
  const sku = upper(F.sku.value).replace(/\s+/g, ''), it = S.findByCode(sku), qty = num(F.qty.value), u = S.inputUnit(F.unit.value);
  renderFormProduct(sku, it);
  byId('fPriceLabel').textContent = `Precio de venta ${F.unit.value === 'dozen' ? 'por docena' : 'por unidad'} (opcional)`;
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
  byId('fPrice').value = '';
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
  if (p.price != null && S.pricesOn() && canManage() && !S.findByCode(p.sku)) { byId('fPrice').value = fmt(p.price); filled.push(byId('fPrice')); }
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
  } else if (!existing && S.similarCodes(p.sku).length) {
    const sim = S.similarCodes(p.sku)[0].item;
    toast(`${p.sku} no está cargado, pero se parece a ${sim.sku}. Si es el mismo, tocalo en la lista de abajo del código.`, 'warn');
    if (prefs.voiceSpeak) say(`${spell(p.sku)} no está cargado. ¿Es ${spell(sim.sku)}?`);
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

async function saveProduct(e) {
  e.preventDefault();
  const btn = byId('saveProduct');
  if (!S.findByCode(F.sku.value) && prefs.formOp !== 'restar' && num(F.qty.value) > 0) {
    const code = upper(F.sku.value).replace(/\s+/g, ''), pick = await confirmSimilar(code);
    if (pick === null) { F.sku.focus(); return; }
    if (pick && pick !== 'new') {
      const unit = F.unit.value;
      useExistingCode(pick.sku, false);
      if (F.unit.value !== unit) { toast(`${pick.sku} se controla en ${S.unitLabel(pick.unitName)}. Revisá la cantidad y guardá.`, 'warn'); F.qty.focus(); return; }
    }
  }
  // Precio opcional, solo para productos nuevos (los existentes se editan desde Inventario).
  const isNew = !S.findByCode(F.sku.value), priceRaw = byId('fPrice').value, price = isNew && S.pricesOn() && canManage() ? parseMoney(priceRaw) : null;
  if (isNew && S.pricesOn() && txt(priceRaw) && price == null) { toast('El precio no es un número válido. Ej.: 12500 o 12.500', 'error'); shake(btn); return; }
  const r = S.applyMovement({
    price, pricePer: F.unit.value === 'dozen' ? 'dozen' : 'unit',
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
// prices: precio de un producto solo para esta venta (itemId → precio, en la moneda y unidad de precio del producto).
const session = { reads: 0, units: 0, products: new Set(), counted: new Set(), serials: new Set(), aliases: new Map(), prices: new Map(), feed: [], contactName: '' };
let lastScan = { code: '', at: 0 };
// Unidad de un precio que se escribe para un producto sin precio: por docena si el producto se carga en docenas.
const newPricePer = it => (it && !(it.price > 0) && !(it.priceArs > 0) && !(it.cost > 0) && isDozenItem(it) ? 'dozen' : S.pricePerOf(it));
// Cambiar el precio de venta desde una venta: la dueña lo deja fijo en el producto al momento;
// un empleado solo lo cambia para esta venta (los precios fijos los pone la dueña).
// Si es igual al sugerido (costo + ganancia), el producto vuelve a seguir el sugerido.
function setSaleItemPrice(item, value) {
  const base = salePrice(item, 'venta'), sug = S.suggestedPrice(item), per = base?.per || newPricePer(item);
  if (!canManage()) {
    if (value == null || (base && value === base.price)) session.prices.delete(item.id); else session.prices.set(item.id, value);
    return value == null ? 'same' : 'session';
  }
  session.prices.delete(item.id);
  const toSuggested = value == null || (sug && value === sug.price);
  if (!toSuggested && base && value === base.price && S.hasFixedPrice(item)) return 'same';
  const r = S.setSalePrice(item.id, toSuggested ? null : value, per);
  if (!r.ok) { toast(r.error, 'error'); return 'error'; }
  return toSuggested ? 'suggested' : 'fixed';
}
function priceSavedToast(item, how) {
  const p = salePrice(item, 'venta'), cur = saleCur('venta'), sug = S.suggestedPrice(item), per = S.PRICE_PER[p?.per || newPricePer(item)];
  if (how === 'fixed') toast(`${item.sku}: precio fijo ${moneyIn(p.price, cur)} ${per}${sug ? ` (sugerido ${moneyIn(sug.price, cur)})` : ''}`, { action: () => { if (S.undo()) { renderScanSession(); toast('Precio anterior restaurado', 'info'); } } });
  else if (how === 'suggested') toast(`${item.sku}: usa el precio sugerido${p ? ` ${moneyIn(p.price, cur)} ${per}` : ''}`, 'info');
  else if (how === 'session') toast(`${item.sku}: precio solo para esta venta (los precios fijos los pone la dueña)`, 'info');
}
// "Sugerido $ X · fijo": para mostrar al lado del precio.
function priceNote(item, shown) {
  const sug = S.suggestedPrice(item), cur = saleCur('venta');
  if (!sug) return S.hasFixedPrice(item) ? 'precio fijo' : '';
  if (shown != null && shown === sug.price) return 'sugerido';
  return `${S.hasFixedPrice(item) ? 'fijo · ' : ''}sugerido ${moneyIn(sug.price, cur)}`;
}
// Venta como carrito: lo escaneado se reserva y el stock se descuenta recién al confirmar la venta.
const cartMode = () => prefs.scanOp === 'restar' && saleKind() === 'venta';
const cartPending = () => liveFeed().filter(f => f.pending);
// Precio de una lectura: el cambiado para esta venta o el del producto.
function linePrice(f, k = saleKind()) {
  const it = S.findById(f.itemId), p = k && salePrice(it, k);
  if (k === 'venta' && session.prices.has(f.itemId)) return { price: session.prices.get(f.itemId), per: p?.per || newPricePer(it), custom: true };
  return p || null;
}
let feedPriceEdit = null;

// Textos de cada modo de escaneo: el aviso de color, el botón de terminar y la lista.
const SCAN_MODES = {
  restar: { name: 'salida', tone: 'danger', icon: 'arrow-out', short: 'Cada código se <b>resta</b> del stock.', banner: 'Cada código que escanees se <b>RESTA</b> del stock.', hint: 'Te muestra el resumen y podés mandar el remito por WhatsApp.' },
  sumar: { name: 'entrada', tone: 'success', icon: 'arrow-in', short: 'Cada código se <b>suma</b> al stock.', banner: 'Cada código que escanees se <b>SUMA</b> al stock.', hint: 'Te muestra el resumen y podés guardar el remito de entrada.' },
  establecer: { name: 'conteo', tone: 'info', icon: 'equal', short: 'La primera lectura <b>reinicia</b> el stock; las demás suman.', banner: 'La primera lectura de cada producto <b>reinicia</b> su stock y las siguientes suman.', hint: 'Cierra el conteo y deja la lista vacía para el próximo.' },
};
// Con precios activados, una salida puede ser una venta y una entrada una compra.
const SALE_TEXT = {
  venta: { short: 'Escaneá los productos: se suman a la venta. <b>El stock se descuenta al confirmar.</b>', banner: 'Cada código que escanees <b>se suma a la venta</b> con su precio. El stock se descuenta <b>recién cuando confirmás</b> la venta al terminar.', hint: 'Te muestra el total; podés cambiar precios, poner descuento y forma de pago. Al confirmar se descuenta del stock.' },
  compra: { short: 'Se <b>suma</b> al stock y registra el <b>costo</b>.', banner: 'Cada código que escanees se <b>SUMA</b> al stock y registra su <b>costo</b>.', hint: 'Te muestra el total de la compra y podés guardar el remito de entrada.' },
};
const scanMode = () => { const base = SCAN_MODES[prefs.scanOp], k = saleKind(); return k ? { ...base, name: k, ...SALE_TEXT[k] } : base; };
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function setScanOp(op) {
  prefs.scanOp = S.OPERATIONS[op] ? op : 'sumar';
  savePrefs();
  const m = scanMode();
  segmented(byId('scanOpSeg'), prefs.scanOp);
  segmented(byId('kOp'), prefs.scanOp);
  const banner = `${icon(m.icon)}<span><b>${cap(m.name)}</b> · ${m.banner}</span>`;
  for (const id of ['scanModeBanner', 'kModeBanner']) byId(id).className = `mode-banner ${m.tone}`;
  // En el celular se ve la versión corta del aviso.
  byId('scanModeBanner').innerHTML = `${icon(m.icon)}<span class="hide-sm">${banner.replace(/^.*?<span>|<\/span>$/g, '')}</span><span class="show-sm"><b>${cap(m.name)}</b> · ${m.short}</span>`;
  byId('kModeBanner').innerHTML = `${icon(m.icon)}<span><b>${cap(m.name)}</b> · ${m.short}</span>`;
  byId('scanHero').dataset.mode = prefs.scanOp;
  byId('scanFinishTitle').textContent = `Terminá ${prefs.scanOp === 'establecer' ? 'el conteo' : `la ${m.name}`}`;
  byId('scanFinishHint').textContent = m.hint;
  byId('sessionTitle').textContent = prefs.scanOp === 'establecer' ? 'Productos contados' : `Productos de esta ${m.name}`;
  // Sin paso de cliente en el conteo: los pasos se renumeran.
  byId('scanStepScan').textContent = prefs.scanOp === 'establecer' ? '2' : '3';
  byId('scanStepFinish').textContent = prefs.scanOp === 'establecer' ? '3' : '4';
  // Interruptor "Es una venta" / "Es una compra" (no aplica al conteo).
  const sk = prefs.scanOp === 'restar' ? 'venta' : prefs.scanOp === 'sumar' ? 'compra' : null;
  byId('scanSaleWrap').hidden = byId('kSaleWrap').hidden = !sk;
  byId('scanSale').checked = byId('kSale').checked = sk === 'venta' ? !!prefs.saleOut : !!prefs.buyIn;
  byId('scanSaleLabel').innerHTML = sk === 'venta' ? 'Es una venta<span class="hide-sm">: sumar precios y mostrar el total</span>' : 'Es una compra<span class="hide-sm">: registrar el costo</span>';
  byId('kSaleLabel').textContent = sk === 'venta' ? 'Venta' : 'Compra';
  updateContactLabels();
  renderScanSession();
}
async function setSale(on) {
  // Apagar la venta con productos sin confirmar los descartaría: primero se pregunta.
  if (!on && cartPending().length) {
    const n = cartPending().length;
    const ok = await ask({ title: 'Tenés una venta sin confirmar', message: `Hay ${n} lectura${n === 1 ? '' : 's'} en la venta (todavía no se descontó nada). Si la apagás, se descarta.`, confirm: 'Descartar la venta', cancel: 'Seguir con la venta', danger: true });
    if (!ok) { byId('scanSale').checked = byId('kSale').checked = true; focusKioskOrScan(); return; }
    resetSession();
  }
  if (prefs.scanOp === 'restar') prefs.saleOut = on; else if (prefs.scanOp === 'sumar') prefs.buyIn = on;
  savePrefs();
  setScanOp(prefs.scanOp);
  focusKioskOrScan();
}
// Cambiar de modo con lecturas sin terminar mezclaría una salida con una entrada: primero se pregunta.
async function chooseScanOp(op) {
  if (op === prefs.scanOp) return;
  const pending = liveFeed().length;
  if (pending) {
    const cur = scanMode().name, next = SCAN_MODES[op]?.name || '';
    const v = await ask({
      title: `Tenés una ${cur} sin terminar`,
      message: cartPending().length
        ? `Hay ${pending} lectura${pending === 1 ? '' : 's'} en la ${cur} sin confirmar (todavía no se descontó nada). Terminala para confirmarla, o cambiá igual y se descarta.`
        : `Hay ${pending} lectura${pending === 1 ? '' : 's'} de ${cur} (ya descontada${pending === 1 ? '' : 's'} del stock). Terminala para hacer el remito, o cambiá igual y empezá una lista nueva.`,
      choices: [{ label: `Terminar la ${cur}`, value: 'finish', primary: true }, { label: `Cambiar a ${next} igual`, value: 'switch' }],
      cancel: `Seguir con la ${cur}`,
    });
    if (v === 'finish') { segmented(byId('scanOpSeg'), prefs.scanOp); segmented(byId('kOp'), prefs.scanOp); finishScan(); return; }
    if (v !== 'switch') { segmented(byId('scanOpSeg'), prefs.scanOp); segmented(byId('kOp'), prefs.scanOp); focusKioskOrScan(); return; }
    resetSession();
  }
  setScanOp(op);
  toast(`Modo ${scanMode().name}: ${scanMode().banner.replace(/<[^>]+>/g, '').toLowerCase()}`, prefs.scanOp === 'restar' ? 'warn' : 'info');
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
    ['nBrand', 'nType', 'nMin', 'nPrice'].forEach(id => { byId(id).value = ''; });
    byId('nQty').value = qty;
    byId('nUnit').value = 'unit';
    byId('newForm').onsubmit = e => {
      e.preventDefault();
      const price = S.pricesOn() && canManage() ? parseMoney(byId('nPrice').value) : null;
      resolve({ brand: byId('nBrand').value, type: byId('nType').value, qty: byId('nQty').value, unit: byId('nUnit').value, minStock: byId('nMin').value, price, pricePer: byId('nUnit').value === 'dozen' ? 'dozen' : 'unit' });
      d.close();
    };
    d.addEventListener('close', () => resolve(null), { once: true });
    d.showModal();
    setTimeout(() => byId('nBrand').focus(), 60);
  });
}

// opts (carga a mano): { qty, unit: 'dozen' | 'unit' }. Sin opts, cada lectura mueve la "Cantidad por lectura".
// Devuelve true si se registró.
async function handleScan(raw, source = 'escáner', opts = {}) {
  const code = upper(raw).replace(/\s+/g, '');
  if (!code) return;
  const t = Date.now();
  if (source === 'cámara' && code === lastScan.code && t - lastScan.at < 1800) return; // la cámara repite lecturas
  lastScan = { code, at: t };
  if (currentView !== 'escanear' && currentView !== 'kiosco') location.hash = '#/escanear';

  const op = prefs.scanOp, qty = num(opts.qty) || num(prefs.scanQty) || 1;
  let resolved = S.resolveCode(code);
  // Código desconocido parecido a uno cargado (8008 / GT8008): se pregunta una vez y se recuerda en esta sesión.
  if (!resolved) {
    let alias = S.findById(session.aliases.get(code));
    if (!alias) {
      const pick = await confirmSimilar(code, { allowNew: op !== 'restar' && prefs.scanUnknown !== 'reject' });
      focusScan();
      if (pick === null) return scanFail(code, 'Lectura cancelada: no se registró.');
      if (pick && pick !== 'new') { alias = pick; session.aliases.set(code, pick.id); }
    }
    if (alias) resolved = { item: alias, pack: null };
  }
  const item = resolved?.item || null;
  const pack = resolved?.pack ? S.PACKS[resolved.pack] : null;
  let r, scanUnit = null;
  if (!item) {
    if (op === 'restar') return scanFail(code, `${code} no existe en el inventario; no se descontó nada.`);
    if (prefs.scanUnknown === 'reject') return scanFail(code, `${code} no está en el inventario.`);
    let data = { qty, unit: opts.unit || 'unit' };
    if (prefs.scanUnknown === 'ask') {
      sound('warn');
      data = await askNewProduct(code, qty);
      focusScan();
      if (!data) return scanFail(code, 'Lectura cancelada.');
    }
    scanUnit = data.unit;
    r = S.applyMovement({ ...data, sku: code, stockType: prefs.task, operation: op, source: `${source} · alta`, contact: sessionContact() });
  } else {
    // Cada lectura mueve la cantidad en la unidad en que se carga el producto: si está en docenas, 1 = una docena.
    // A mano se puede elegir docenas o unidades.
    let unit = item.unitName !== 'unidades' ? S.inputUnitFor(item) : opts.unit ? (opts.unit === 'dozen' ? 'dozen' : 'unit') : (isDozenItem(item) ? 'dozen' : 'unit'), amount = qty, note = source;
    if (pack) {
      // Etiqueta numerada: mueve exactamente una docena o una unidad, y no se puede registrar dos veces por error.
      amount = 1;
      if (resolved.pack === 'D') unit = 'dozen';
      const label = `${pack.label.toLowerCase()} N.º ${String(resolved.number).padStart(4, '0')}`;
      note = `${source} · ${label}`;
      if (op === 'establecer' && session.serials.has(code)) return scanFail(code, `Esta ${label} ya se contó en esta sesión.`);
      if (cartMode() && session.serials.has(code)) return scanFail(code, `Esta ${label} ya está en esta venta.`);
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
    scanUnit = unit;
    if (cartMode()) {
      // Venta: se reserva sin tocar el stock. Se controla que alcance contando lo que ya está en la venta.
      const units = round2(amount * S.inputUnit(unit).factor), reserved = cartPending().filter(f => f.itemId === item.id).reduce((s, f) => s + f.amount, 0);
      const free = round2(item.units - reserved);
      if (free < units) return scanFail(code, `Stock insuficiente de ${item.sku}: ${reserved ? `quedan ${stockWords(item, free)} (ya hay ${stockWords(item, reserved)} en esta venta)` : `hay ${stockWords(item, item.units)}`}.`);
      r = { ok: true, item, before: free, after: round2(free - units), amount: units, entryId: null, created: false, pending: true, qty: amount, unitIn: unit, note };
      if (pack) session.serials.add(code);
    } else r = S.applyMovement({ sku: item.sku, qty: amount, unit, stockType: prefs.task, operation, source: note, keepDisplay: true, serial: pack ? code : undefined, contact: sessionContact() });
  }
  if (!r.ok) return scanFail(code, r.error);

  if (op === 'establecer') { session.counted.add(r.item.id); if (pack) session.serials.add(code); }
  session.reads++;
  session.units += r.amount;
  session.products.add(r.item.id);
  const serialTag = pack ? `${pack.label} N.º ${String(resolved.number).padStart(4, '0')}` : '';
  const feedId = Date.now() + Math.random();
  session.lastId = feedId;
  slEditing = false;
  session.feed.unshift({ id: feedId, entryId: r.entryId, itemId: r.item.id, sku: r.item.sku, name: serialTag || productName(r.item), serial: pack ? code : '', op, amount: r.amount, before: r.before, after: r.after, unit: S.unitLabel(r.item.unitName), dz: isDozenItem(r.item), at: new Date().toISOString(), undone: false, ...(r.pending ? { pending: true, qty: r.qty, unitIn: r.unitIn, note: r.note } : {}) });
  if (session.feed.length > 200) session.feed.length = 200;
  const sign = op === 'restar' ? '−' : op === 'establecer' ? '=' : '+';
  // Texto claro de lo que se movió: "−1 docena (12 unidades)" o "+1 unidad".
  // Producto en docenas (leído o cargado a mano): "−2 docenas (24 unidades)".
  const dz = !pack && scanUnit === 'dozen' && r.item.unitName === 'unidades' && op !== 'establecer';
  const moved = op === 'establecer' ? `= ${isDozenItem(r.item) ? unitWords(r.after / 12, 'docenas') : unitWords(r.after, S.unitLabel(r.item.unitName))}`
    : resolved?.pack === 'D' ? `${sign}1 docena` : dz ? `${sign}${unitWords(r.amount / 12, 'docenas')}` : `${sign}${unitWords(r.amount, S.unitLabel(r.item.unitName))}`;
  const movedSub = (resolved?.pack === 'D' || dz) && op !== 'establecer' ? ` (${unitWords(r.amount, 'unidades')})` : '';
  const sk = saleKind(), pr = sk && linePrice({ itemId: r.item.id }, sk);
  const priceInfo = !sk || sk === 'venta' ? '' : pr ? ` · <b>${moneyIn(S.lineAmount(r.amount, pr.price, pr.per), saleCur(sk))}</b>` : ' · <span class="warn">sin costo: completalo al terminar</span>';
  scanFeedback(true, `<div class="scan-result ok"><span class="big">${moved}</span><div><strong class="mono">${esc(r.item.sku)}</strong>${serialTag ? ` <span class="badge badge-primary">${esc(serialTag)}</span>` : ''}${r.created ? ' <span class="badge badge-success">Nuevo</span>' : ''}<div class="small">${r.pending ? 'En la venta' : op === 'restar' ? 'Salida' : op === 'establecer' ? 'Conteo' : 'Ingreso'}${movedSub} · ${esc(productName(r.item) || 'Sin marca')} · stock ${esc(stockWords(r.item, r.after))}${r.pending ? ' al confirmar' : ''}${priceInfo}</div></div></div>`);
  renderLastPrice();
  renderScanSession();
  focusScan();
  return true;
}

// Precio de la última lectura (en una venta): se ve y se cambia acá mismo, en el recuadro de la lectura.
let slEditing = false;
function renderLastPrice() {
  const box = byId('scanLast'), f = session.feed.find(x => String(x.id) === String(session.lastId));
  box.querySelector('.sl-price')?.remove();
  if (!f || f.undone || saleKind() !== 'venta') return;
  const it = S.findById(f.itemId);
  if (!it) return;
  const cur = saleCur('venta'), pr = linePrice(f, 'venta'), per = pr?.per || newPricePer(it), sug = S.suggestedPrice(it);
  const amount = pr ? S.lineAmount(f.amount, pr.price, pr.per) : null;
  const note = pr?.custom ? 'solo esta venta' : priceNote(it, pr?.price);
  const html = slEditing
    ? `<div class="sl-price editing"><label for="slPriceInput">Precio ${S.PRICE_PER[per]}</label>
        <input id="slPriceInput" class="input money" inputmode="decimal" enterkeyhint="done" value="${pr ? fmt(pr.price) : ''}" placeholder="${sug ? `Sugerido ${fmt(sug.price)}` : 'Escribí el precio'}" aria-label="Precio de ${esc(it.sku)}">
        <button type="button" class="btn btn-primary btn-sm" data-sl-save>Guardar</button>
        <button type="button" class="btn btn-ghost btn-sm" data-sl-cancel>Cancelar</button>
        ${sug ? `<button type="button" class="link" data-sl-suggest>Usar sugerido ${moneyIn(sug.price, cur)}</button>` : ''}</div>`
    : `<div class="sl-price"><span>${pr ? `Precio <b>${moneyIn(pr.price, cur)}</b> ${S.PRICE_PER[per]}${amount !== pr.price ? ` · importe <b>${moneyIn(amount, cur)}</b>` : ''}` : '<b class="warn">Sin precio</b>'}</span>
        ${note ? `<span class="badge ${pr?.custom || S.hasFixedPrice(it) ? 'badge-warn' : ''}">${esc(note)}</span>` : ''}
        <button type="button" class="btn btn-ghost btn-sm" data-sl-edit>${icon('edit', 'sm')}${pr ? 'Cambiar precio' : 'Poner precio'}</button></div>`;
  box.insertAdjacentHTML('beforeend', html);
  if (slEditing) { const el = byId('slPriceInput'); el.focus(); el.select(); }
}
function saveLastPrice(useSuggested = false) {
  const f = session.feed.find(x => String(x.id) === String(session.lastId)), it = f && S.findById(f.itemId);
  if (!it) return;
  let how = 'same';
  if (useSuggested) how = setSaleItemPrice(it, null);
  else {
    const raw = txt(byId('slPriceInput')?.value), v = parseMoney(raw), cur = linePrice(f, 'venta');
    if (raw && v == null) { toast('Escribí el precio como número, por ejemplo 120000 o 120.000.', 'error'); byId('slPriceInput').focus(); return; }
    if (v != null && v !== cur?.price) how = setSaleItemPrice(it, v);
  }
  slEditing = false;
  renderScanSession();
  renderLastPrice();
  priceSavedToast(it, useSuggested && how === 'same' ? 'suggested' : how);
  focusScan();
}

// =========================================================
// Consultar precio: escanear o buscar y ver cuánto sale (no registra nada)
// =========================================================
// Precio por unidad a partir del de la docena (o al revés), para contestar rápido cualquiera de las dos.
const perUnitOf = (p, it) => (p.per === 'dozen' ? p.price / 12 : p.price);
function priceCard(it, big = false) {
  const cur = saleCur('venta'), p = salePrice(it, 'venta'), usd = S.chargeArs() ? S.priceFor(it, 'venta') : null, sug = S.suggestedPrice(it), m = S.marginPct();
  const dozen = it.unitName === 'unidades', per = p?.per || newPricePer(it);
  const unitP = p && dozen ? perUnitOf(p, it) : null, dozenP = p && dozen ? (p.per === 'dozen' ? p.price : p.price * 12) : null;
  const main = !p ? '<span class="pl-none">Sin precio</span>'
    : dozen ? `${moneyIn(dozenP, cur)} <small>la docena</small>` : `${moneyIn(p.price, cur)} <small>${S.PRICE_PER[per]}</small>`;
  const sub = [
    unitP != null ? `${moneyIn(cur === 'ARS' ? Math.round(unitP) : round2(unitP), cur)} c/u` : '',
    usd ? `${moneyIn(usd.price, 'USD')} ${S.PRICE_PER[usd.per]}` : '',
  ].filter(Boolean).join(' · ');
  // Las dos referencias: el precio configurado (costo + ganancia) y el último puesto a mano.
  const fixed = S.hasFixedPrice(it);
  const lm = it.lastManual || (fixed && p ? { price: p.price, cur, per: p.per } : null);
  const unitTxt = (price, c, per) => (dozen && per === 'dozen' ? ` · ${moneyIn(c === 'ARS' ? Math.round(price / 12) : round2(price / 12), c)} c/u` : '');
  const source = !p ? '' : fixed ? 'Se cobra el precio puesto a mano' : sug && sug.price === p.price ? 'Se cobra el precio configurado' : 'Precio de venta';
  const ref = (title, body, active) => `<div class="pl-ref ${active ? 'active' : ''}"><span>${title}${active ? ' · <b>se cobra</b>' : ''}</span>${body}</div>`;
  const refs = [
    ref(`Configurado${m != null ? ` (ganancia ${fmt(m)} %)` : ''}`, sug
      ? `<b>${moneyIn(sug.price, cur)}</b><small>${S.PRICE_PER[sug.per]}${unitTxt(sug.price, cur, sug.per)}</small>`
      : `<small>${m == null ? 'Sin ganancia general configurada' : 'Sin costo cargado'}</small>`, !fixed && !!sug && p?.price === sug.price),
    ref('Último a mano', lm
      ? `<b>${moneyIn(lm.price, lm.cur)}</b><small>${S.PRICE_PER[lm.per]}${unitTxt(lm.price, lm.cur, lm.per)}${lm.at ? ` · ${esc(relTime(lm.at))}` : ''}${lm.by ? ` · @${esc(lm.by)}` : ''}</small>`
      : '<small>Nunca se cambió a mano</small>', fixed),
  ].join('');
  return `<div class="pl-item ${big ? 'big' : ''}">
    <div class="pl-head"><div><b class="mono">${esc(it.sku)}</b> <span>${esc(productName(it) || 'Sin marca ni prenda')}</span></div><span class="pl-stock ${it.units <= 0 ? 'is-zero' : ''}">${it.units <= 0 ? 'Sin stock' : `stock ${esc(qtyText(it))}`}</span></div>
    ${source ? `<div class="pl-source">${source}</div>` : ''}
    <div class="pl-price">${main}</div>
    ${sub ? `<div class="pl-sub">${sub}</div>` : ''}
    <div class="pl-refs">${refs}</div>
  </div>`;
}
function renderPriceLookup() {
  if (currentView !== 'precios') return;
  const q = byId('plInput').value, exact = txt(q) && (S.findByCode(maCode(q)) || S.resolveCode(maCode(q))?.item);
  const list = exact ? [exact] : maMatches(q);
  const fx = S.chargeArs() && S.fxNow();
  byId('plHint').innerHTML = `${fx ? `Dólar ${fx.fixed ? 'fijo' : 'blue'} ${moneyIn(fx.rate, 'ARS')} · ` : ''}${S.marginPct() != null ? `ganancia general ${fmt(S.marginPct())} % · ` : ''}solo consulta: no registra ventas`;
  byId('plResults').innerHTML = !txt(q)
    ? emptyState('search', 'Escaneá o escribí un producto', 'Con la pistola, la cámara o escribiendo parte del código, la marca o la prenda.')
    : list.length ? list.map((it, k) => priceCard(it, list.length === 1 || (exact && k === 0))).join('')
    : emptyState('search', 'No encontramos ese producto', 'Probá con otra parte del código, la marca o la prenda.');
}
// La pistola en esta pantalla busca el precio (no registra nada).
function priceLookup(code) {
  byId('plInput').value = upper(code);
  renderPriceLookup();
  sound('ok');
  byId('plInput').select();
}

// =========================================================
// Carga a mano en Escanear (sin pistola): buscar el producto, cantidad y docenas o unidades
// =========================================================
let maPick = null;
const maCode = v => upper(v).replace(/\s+/g, '');
function maMatches(q) {
  const code = maCode(q), words = txt(q).toLocaleLowerCase('es-AR').split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const hay = i => [i.sku, i.barcode, i.brand, i.type, ...(i.aliases || [])].join(' ').toLocaleLowerCase('es-AR');
  return state.items.filter(i => words.every(w => hay(i).includes(w)))
    .map(i => ({ i, rank: i.sku === code ? 0 : i.sku.startsWith(code) ? 1 : 2 }))
    .sort((a, b) => a.rank - b.rank || a.i.sku.localeCompare(b.i.sku, 'es', { numeric: true }))
    .slice(0, 8).map(x => x.i);
}
function renderMaResults() {
  const q = byId('scanInput').value, box = byId('maResults');
  if (maPick && maPick.sku !== maCode(q)) maPick = null;
  // Código exacto: el producto queda elegido solo (sin mover el cursor, por si se sigue escribiendo).
  const exact = !maPick && state.items.find(i => i.sku === maCode(q));
  if (exact) maSelect(exact, { focus: false });
  const list = maPick ? [] : maMatches(q);
  box.hidden = !list.length || document.activeElement !== byId('scanInput') && !byId('scanForm').contains(document.activeElement);
  byId('scanInput').setAttribute('aria-expanded', String(!box.hidden));
  box.innerHTML = list.map(i => { const p = S.pricesOn() ? priceText(i) : ''; return `<button type="button" class="ma-opt" role="option" data-ma="${esc(i.id)}"><b class="mono">${esc(i.sku)}</b><span>${esc(productName(i) || 'Sin marca ni prenda')}</span><small>stock ${esc(qtyText(i))}${p ? ` · ${esc(p)}` : ''}</small></button>`; }).join('');
  renderMaHint();
}
// En una venta, el campo Precio muestra el del producto (o el ya cambiado para esta venta) y se puede editar.
function fillMaPrice() {
  const it = maPick, f = byId('maPriceField'), sale = !!it && saleKind() === 'venta';
  f.hidden = !sale;
  if (!sale) { delete f.dataset.item; return; }
  if (f.dataset.item === it.id) return; // no pisar lo que se está escribiendo
  f.dataset.item = it.id;
  const pr = linePrice({ itemId: it.id }, 'venta'), cur = saleCur('venta'), per = pr?.per || newPricePer(it);
  byId('maPrice').value = pr ? fmt(pr.price) : '';
  const sug = S.suggestedPrice(it);
  byId('maPrice').placeholder = sug ? `Sugerido ${fmt(sug.price)}` : 'Sin precio: escribilo';
  byId('maPriceLabel').textContent = `Precio ${S.PRICE_PER[per]} (${cur === 'USD' ? 'US$' : '$'})`;
}
// Lo que se va a registrar: producto, stock y, en una venta, el importe con el precio que se ve en el campo.
function renderMaHint() {
  fillMaPrice();
  const it = maPick, qty = num(byId('maQty').value), unit = byId('maUnit').value;
  byId('manualAdd').hidden = !it;
  if (!it) { byId('maHint').textContent = ''; return; }
  const units = qty * (unit === 'dozen' && it.unitName === 'unidades' ? 12 : 1), sk = saleKind(), base = sk && salePrice(it, sk);
  const typed = sk === 'venta' ? parseMoney(byId('maPrice').value) : null, per = base?.per || newPricePer(it);
  const pr = typed != null ? { price: typed, per } : linePrice({ itemId: it.id }, sk);
  const changed = sk === 'venta' && typed != null && (!base || typed !== base.price);
  byId('maHint').innerHTML = `<b class="mono">${esc(it.sku)}</b> · ${esc(productName(it) || 'Sin marca ni prenda')} · stock ${esc(qtyText(it))}${qty > 0 && pr ? ` · importe <b>${moneyIn(S.lineAmount(units, pr.price, pr.per), saleCur(sk))}</b>` : ''}${changed ? ` · <b class="warn">${canManage() ? 'queda como precio fijo del producto' : 'precio solo de esta venta'}</b>` : ''}`;
  // Precio sugerido (costo + ganancia) siempre a la vista, con "Usar sugerido".
  const sug = sk === 'venta' && S.suggestedPrice(it), shown = typed ?? base?.price;
  byId('maSuggest').innerHTML = sug ? `Sugerido <b>${moneyIn(sug.price, saleCur(sk))}</b>${shown !== sug.price ? ` <button type="button" class="link" data-ma-suggest>Usar sugerido</button>` : ''}` : '';
}
function maSelect(item, { focus = true } = {}) {
  // Producto nuevo: la cantidad arranca en la "Cantidad por lectura" (1 docena si el producto va en docenas).
  if (maPick?.id !== item.id) byId('maQty').value = num(prefs.scanQty) || 1;
  maPick = item;
  byId('scanInput').value = item.sku;
  byId('maResults').hidden = true;
  byId('scanInput').setAttribute('aria-expanded', 'false');
  byId('maUnit').disabled = item.unitName !== 'unidades';
  byId('maUnit').value = item.unitName === 'unidades' && item.displayUnit === 'dozen' ? 'dozen' : 'unit';
  delete byId('maPriceField').dataset.item;
  renderMaHint();
  if (!focus) return;
  byId('maQty').focus();
  byId('maQty').select();
}
// Cierra la fila del producto elegido (y las sugerencias).
function closeMa() {
  maPick = null;
  byId('maResults').hidden = true;
  byId('maUnit').disabled = false;
  delete byId('maPriceField').dataset.item;
  renderMaHint();
}
// source: 'escáner' si se confirmó con Enter en el campo (pistola o código escrito), 'manual' si con la fila.
async function maAdd(source = 'manual') {
  const raw = txt(byId('scanInput').value), qty = num(byId('maQty').value);
  if (!raw) { toast('Escribí o elegí un producto.', 'warn'); byId('scanInput').focus(); return; }
  if (!(qty > 0)) { toast('La cantidad tiene que ser mayor que cero.', 'warn'); byId('maQty').focus(); return; }
  const list = maMatches(raw), item = maPick || S.findByCode(raw) || (list.length === 1 ? list[0] : null);
  if (!item && list.length > 1) { toast('Hay varios productos que coinciden: elegí uno de la lista.', 'warn'); renderMaResults(); byId('scanInput').focus(); return; }
  // Precio escrito en el campo: queda fijo en el producto (un empleado: solo esta venta).
  if (item && !byId('maPriceField').hidden) {
    const raw = txt(byId('maPrice').value), v = parseMoney(raw), cur = linePrice({ itemId: item.id }, 'venta');
    if (raw && v == null) { toast('Escribí el precio como número, por ejemplo 120000 o 120.000.', 'error'); byId('maPrice').focus(); return; }
    if (v != null && v !== cur?.price) priceSavedToast(item, setSaleItemPrice(item, v));
  }
  const ok = await handleScan(item ? item.sku : raw, source, { qty, unit: item?.unitName === 'unidades' || !item ? byId('maUnit').value : 'unit' });
  if (ok) { byId('scanInput').value = ''; closeMa(); }
  byId('scanInput').focus();
}

function renderScanSession() {
  renderKiosk();
  renderMaHint();
  byId('ssReads').textContent = fmt(session.reads);
  const sq = sessionQty(liveFeed());
  byId('ssUnits').textContent = fmt(sq.value);
  byId('ssUnits').nextElementSibling.textContent = sq.label;
  byId('ssProducts').textContent = fmt(new Set(liveFeed().map(f => f.itemId)).size); // sin contar lo revertido
  const sm = sessionMoney(), sk = saleKind();
  byId('ssMoneyBox').hidden = !sm;
  if (sm) byId('ssMoney').textContent = sessionMoneyText(sm);
  // En una venta cada producto tiene "Cambiar precio": vale solo para esta venta.
  const lineMoney = f => {
    if (!sk || f.undone) return '';
    const pr = linePrice(f, sk), cur = saleCur(sk), per = pr?.per || newPricePer(S.findById(f.itemId));
    const it = S.findById(f.itemId), sug = sk === 'venta' && S.suggestedPrice(it);
    if (sk === 'venta' && feedPriceEdit === f.itemId) return `<div class="feed-money"><span class="feed-price-edit"><input class="input money feed-price" data-feed-price="${esc(f.itemId)}" inputmode="decimal" value="${pr ? fmt(pr.price) : ''}" placeholder="${sug ? `Sugerido ${fmt(sug.price)}` : `${cur === 'USD' ? 'US$' : '$'} 0`}" aria-label="Precio de ${esc(f.sku)}"> <small>${S.PRICE_PER[per]} · Enter para guardar</small></span>${sug ? ` <button type="button" class="link" data-use-suggest="${esc(f.itemId)}">Usar sugerido ${moneyIn(sug.price, cur)}</button>` : ''}</div>`;
    const amount = pr ? `<b>${moneyIn(S.lineAmount(f.amount, pr.price, pr.per), cur)}</b>` : `<span class="warn">sin ${sk === 'venta' ? 'precio' : 'costo'}</span>`;
    const note = sk === 'venta' && it ? (pr?.custom ? 'precio solo de esta venta' : priceNote(it, pr?.price)) : '';
    return `<div class="feed-money">${amount}${pr ? ` <small>(${moneyIn(pr.price, cur)} ${S.PRICE_PER[per]})</small>` : ''}${note ? ` <span class="badge ${pr?.custom || S.hasFixedPrice(it) ? 'badge-warn' : ''}">${esc(note)}</span>` : ''}</div>`;
  };
  byId('scanFeed').innerHTML = session.feed.length
    ? session.feed.map(f => `<div class="feed-item tl-${f.op === 'restar' ? 'out' : f.op === 'establecer' ? 'count' : 'in'} ${f.undone ? 'undone' : ''}" ${f.entryId ? `data-move="${esc(f.entryId)}"` : ''}>
        <span class="tl-icon">${icon(f.op === 'restar' ? 'arrow-out' : f.op === 'establecer' ? 'equal' : 'arrow-in')}</span>
        <div class="tl-body"><div class="tl-title"><strong class="mono">${esc(f.sku)}</strong> <span>${esc(f.name)}</span></div><div class="tl-sub"><b>${f.op === 'restar' ? '−' : f.op === 'establecer' ? '=' : '+'}${S.serialInfo(f.serial)?.pack === 'D' ? `1 docena (${unitWords(f.amount, 'unidades')})` : f.dz ? (f.op === 'establecer' ? unitWords(f.after / 12, 'docenas') : `${unitWords(f.amount / 12, 'docenas')} (${unitWords(f.amount, 'unidades')})`) : unitWords(f.op === 'establecer' ? f.after : f.amount, f.unit)}</b><span class="fd-extra"> · stock ${f.dz ? `${fmt(f.before / 12)} → ${fmt(f.after / 12)} docenas` : `${fmt(f.before)} → ${fmt(f.after)} ${esc(f.unit)}`}${f.pending ? ' al confirmar' : ''} · ${new Date(f.at).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span></div>${lineMoney(f)}</div>
        ${f.undone ? '<span class="badge">Revertido</span>' : `<button class="btn btn-ghost btn-sm" type="button" data-revert="${f.id}" aria-label="Revertir esta lectura de ${esc(f.sku)}">${icon('undo', 'sm')}<span class="hide-sm">Revertir</span></button>`}</div>`).join('')
    : emptyState('scan', 'Sin lecturas todavía', 'Escaneá un código con la pistola o la cámara para empezar.');
}

function revertScan(id) {
  const f = session.feed.find(x => String(x.id) === String(id));
  if (!f || f.undone) return;
  // Revertir una lectura de esta sesión es anularla (queda registrado quién y por qué). Lo puede hacer quien la hizo.
  // Si todavía estaba solo en la venta (sin confirmar), se saca de la lista: el stock no se había tocado.
  const r = f.pending ? { ok: true } : f.entryId
    ? S.fixMovement(f.entryId, { remove: true, reason: 'Lectura revertida desde la sesión de escaneo' })
    : { ok: false, error: 'No se encontró la lectura en el historial.' };
  if (!r.ok) return toast(r.error, 'error');
  f.undone = true;
  if (f.serial) session.serials.delete(f.serial);
  session.reads = Math.max(0, session.reads - 1);
  session.units = Math.max(0, session.units - f.amount);
  renderScanSession();
  // El recuadro de la última lectura ya no puede mostrarla como registrada.
  const html = `<div class="scan-result reverted"><span class="big">${icon('undo', 'lg')}</span><div><strong class="mono">${esc(f.sku)}</strong><div class="small">Lectura revertida: ${f.pending ? 'se sacó de la venta' : 'se devolvió al stock'}. ${liveFeed().length ? `Quedan ${liveFeed().length} en la lista.` : 'La lista quedó vacía.'}</div></div></div>`;
  byId('scanLast').innerHTML = html;
  const k = byId('kResult');
  k.className = 'kiosk-result';
  k.innerHTML = html;
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
  let rows = state.items.filter(i => !q || [i.sku, i.barcode, i.brand, i.type, ...(i.aliases || [])].some(v => String(v || '').toLocaleLowerCase('es-AR').includes(q)));
  if (inv.filter === 'alert') rows = rows.filter(i => i.units <= 0 || S.isLow(i));
  if (inv.filter === 'zero') rows = rows.filter(i => i.units <= 0);
  const by = {
    sku: (a, b) => a.sku.localeCompare(b.sku, 'es', { numeric: true }),
    brand: (a, b) => a.brand.localeCompare(b.brand, 'es') || a.sku.localeCompare(b.sku, 'es', { numeric: true }),
    desc: (a, b) => b.units - a.units, asc: (a, b) => a.units - b.units,
    price: (a, b) => (b.price || 0) / S.perFactor(S.pricePerOf(b)) - (a.price || 0) / S.perFactor(S.pricePerOf(a)),
    recent: (a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)),
  };
  return rows.sort((inv.sort === 'price' && !S.pricesOn() ? null : by[inv.sort]) || by.sku);
}

function itemRow(i) {
  const d = S.displayQty(i), low = S.isLow(i), zero = i.units <= 0, sel = inv.selected.has(i.id);
  const sub = i.displayUnit === 'dozen' && i.unitName === 'unidades' ? `${fmt(i.units)} unidades` : i.unitName === 'unidades' && i.units >= 12 ? `${fmt(i.units / 12)} docenas` : '';
  return `<div class="inv-row ${sel ? 'selected' : ''}" data-id="${esc(i.id)}">
    <label class="check" title="Seleccionar"><input type="checkbox" data-act="select" ${sel ? 'checked' : ''} aria-label="Seleccionar ${esc(i.sku)}"><span></span></label>
    <div class="inv-product" data-act="edit"><div class="inv-sku mono">${esc(i.sku)}</div><div class="inv-meta">${esc(productName(i) || 'Sin marca ni prenda')}${i.barcode ? ` · ${esc(i.barcode)}` : ''}</div></div>
    <div class="inv-stock"><div class="qty ${zero ? 'is-zero' : low ? 'is-low' : ''}">${fmt(d.value)} <small>${esc(d.unit)}</small></div>${sub ? `<div class="qty-sub">${sub}</div>` : ''}${S.pricesOn() && priceText(i) ? `<div class="qty-sub price-tag">${esc(priceText(i))}</div>${S.hasFixedPrice(i) && S.suggestedPrice(i) && S.suggestedPrice(i).price !== salePrice(i)?.price ? `<div class="qty-sub muted">sugerido ${esc(moneyIn(S.suggestedPrice(i).price, saleCur()))}</div>` : ''}` : ''}</div>
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

  renderInvValue();
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

// Cuánto vale lo que hay en stock, a precio de venta y al costo (solo dueño, con precios activados).
function renderInvValue() {
  const box = byId('invValue');
  if (!S.pricesOn() || !canManage() || !state.items.length) { box.innerHTML = ''; return; }
  let sale = 0, cost = 0, noPrice = 0, saleArs = 0;
  for (const i of state.items) {
    if (i.units <= 0) continue;
    const per = S.pricePerOf(i), a = S.arsPriceFor(i);
    if (a) saleArs += S.lineAmount(i.units, a.price, per);
    if (i.price) sale += S.lineAmount(i.units, i.price, per); else noPrice++;
    if (i.cost) cost += S.lineAmount(i.units, i.cost, per);
  }
  const m = S.marginPct(), noCost = state.items.filter(i => !(i.cost > 0)).length;
  box.innerHTML = `<div class="inv-value">${icon('cash')}<span class="grow">Valor del stock: <b>${money(sale)}</b>${S.chargeArs() && saleArs ? ` (<b>${moneyIn(saleArs, 'ARS')}</b>)` : ''} a precio de venta${cost ? ` · <b>${money(cost)}</b> al costo` : ''}${noPrice ? ` · <span class="muted">${fmt(noPrice)} producto${noPrice === 1 ? '' : 's'} con stock sin precio</span>` : ''}
    <br><span class="muted small">${m != null ? `Ganancia general: ${fmt(m)} % sobre el costo` : 'Sin ganancia general'}${noCost ? ` · ${fmt(noCost)} sin costo` : ''}${S.currency() === 'USD' && S.fxRate() ? ` · dólar ${S.fxFixed() ? 'fijo' : 'blue'} ${moneyIn(S.fxRate(), 'ARS')}` : ''}</span></span>
    <span class="inv-value-actions"><button class="btn btn-ghost btn-sm" type="button" data-cost-import>${icon('upload', 'sm')}Importar costos</button><a class="btn btn-ghost btn-sm" href="#/cuenta">${icon('settings', 'sm')}Ganancia y moneda</a></span></div>`;
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
// touched: se escribió el precio de venta; auto: se pidió volver al precio automático (costo + ganancia general).
let editPrice = { touched: false, auto: false };
function openEdit(i) {
  editingId = i.id;
  editPrice = { touched: false, auto: false };
  byId('editSub').textContent = `Última modificación ${relTime(i.updatedAt)}${i.aliases?.length ? ` · códigos anteriores: ${i.aliases.join(', ')}` : ''}`;
  byId('eSku').value = i.sku; byId('eBarcode').value = i.barcode || ''; byId('eBrand').value = i.brand; byId('eType').value = i.type;
  byId('eUnits').value = i.units; byId('eUnitName').value = i.unitName; byId('eMin').value = i.minStock || ''; byId('eStockType').value = i.stockType;
  // Los empleados pueden editar datos del producto, pero no cambiar el stock a mano.
  byId('eUnits').disabled = !canManage(); byId('eUnitName').disabled = !canManage();
  byId('eUnits').title = canManage() ? '' : 'Solo el dueño puede cambiar el stock a mano';
  // Precios: el empleado ve el de venta pero no lo cambia; el de costo es solo del dueño.
  byId('ePrice').value = i.price ? fmt(i.price) : '';
  byId('eCost').value = i.cost ? fmt(i.cost) : '';
  byId('ePer').value = S.pricePerOf(i);
  byId('ePerField').hidden = i.unitName !== 'unidades';
  byId('ePrice').disabled = byId('ePer').disabled = byId('ePriceArs').disabled = !canManage();
  byId('ePriceArsField').hidden = !S.chargeArs();
  byId('ePriceArs').value = i.priceArs ? fmt(i.priceArs) : '';
  const sign = S.currency() === 'USD' ? 'US$' : '$';
  $('label[for="ePrice"]').textContent = `Precio de venta (${sign})`;
  $('label[for="eCost"]').textContent = `Precio de costo (${sign})`;
  renderMargin();
  byId('editDialog').showModal();
}
// Ganancia por unidad o docena según precio de venta y costo.
function renderMargin(e) {
  if (e?.target?.id === 'ePrice') editPrice = { touched: true, auto: false };
  const item = S.findById(editingId), cost = parseMoney(byId('eCost').value), m = S.marginPct();
  const auto = canManage() && m != null && cost ? S.autoPrice(item, cost) : null;
  // Si el precio sigue la ganancia general y no se tocó, acompaña al costo mientras se escribe.
  if (auto && !editPrice.touched && (!item?.priceManual || editPrice.auto)) byId('ePrice').value = fmt(auto);
  const price = parseMoney(byId('ePrice').value), per = byId('ePer').value === 'dozen' && !byId('ePerField').hidden ? 'dozen' : 'unit';
  const el = byId('eMargin');
  if (!canManage()) { el.textContent = price ? 'Solo el dueño puede cambiar los precios.' : ''; return; }
  const parts = [];
  if (price && cost) { const gain = price - cost; parts.push(`Ganancia ${per === 'dozen' ? 'por docena' : 'por unidad'}: <b class="${gain < 0 ? 'danger-text' : ''}">${money(gain)}</b> (${fmt((gain / cost) * 100, 1)} % sobre el costo)`); }
  if (auto) parts.push(price && price !== auto ? `Precio a mano: no sigue la ganancia general (con ${fmt(m)} % sería ${money(auto)}). <a href="#" class="link" data-price-auto>Usar el automático</a>` : `Precio automático: costo ${money(cost)} + ${fmt(m)} % = <b>${money(auto)}</b>${S.currency() === 'ARS' ? ' (redondeado a pesos)' : ''}.`);
  // En pesos: el precio fijo escrito, o el de dólares por la cotización (se muestra como sugerencia).
  if (S.chargeArs()) {
    const fixed = parseMoney(byId('ePriceArs').value), rate = S.fxRate(), calc = price && rate ? S.roundArs(price * rate) : null;
    const sugUsd = m != null && cost ? S.autoPrice(item, cost) : null, sug = sugUsd && rate ? S.roundArs(sugUsd * rate) : null;
    byId('ePriceArs').placeholder = sug ? `Sugerido ${fmt(sug)}` : calc ? `${fmt(calc)} (según el dólar)` : 'Según el dólar';
    const sugText = sug ? `Precio sugerido: <b>${moneyIn(sug, 'ARS')}</b> (${money(sugUsd)} × dólar ${moneyIn(rate, 'ARS')}).` : '';
    parts.push(fixed ? `Precio fijo en pesos: <b>${moneyIn(fixed, 'ARS')}</b> (no cambia con el dólar). ${sugText}${sug && sug !== fixed ? ' <a href="#" class="link" data-ars-suggest>Usar el sugerido</a>' : ''}`
      : sug && calc === sug ? `En pesos: ${sugText} Si no te gusta, escribí un precio fijo.`
      : calc ? `En pesos: ${money(price)} × dólar ${moneyIn(rate, 'ARS')} = <b>${moneyIn(calc, 'ARS')}</b>. ${sugText}${sug ? ' <a href="#" class="link" data-ars-suggest>Usar el sugerido</a>' : ''}` : '');
  }
  el.innerHTML = parts.filter(Boolean).join('<br>');
}
function saveEdit(e) {
  e.preventDefault();
  const item = S.findById(editingId);
  let prices = {};
  if (S.pricesOn() && canManage()) {
    const bad = ['ePrice', 'eCost'].find(id => txt(byId(id).value) && parseMoney(byId(id).value) == null);
    if (bad) { toast('Revisá el precio: escribí solo el número, por ejemplo 12500 o 12.500.', 'error'); byId(bad).focus(); shake(byId('eSave')); return; }
    // Con ganancia general, el precio solo se manda si se escribió (así queda "a mano"); si no, sigue al costo.
    const price = editPrice.auto ? { priceAuto: true } : editPrice.touched || S.marginPct() == null ? { price: parseMoney(byId('ePrice').value) } : {};
    prices = { ...price, cost: parseMoney(byId('eCost').value), pricePer: byId('ePer').value, ...(S.chargeArs() ? { priceArs: parseMoney(byId('ePriceArs').value) } : {}) };
  }
  const r = S.saveItem(editingId, {
    sku: byId('eSku').value, barcode: byId('eBarcode').value, brand: byId('eBrand').value, type: byId('eType').value,
    units: canManage() ? byId('eUnits').value : item?.units, unitName: canManage() ? byId('eUnitName').value : item?.unitName,
    minStock: byId('eMin').value, stockType: byId('eStockType').value, ...prices,
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
const BULK_FIELDS = { brand: 'Marca', type: 'Prenda / tipo', stockType: 'Tipo de stock', minStock: 'Stock mínimo', unitName: 'Unidad de stock' };
function openBulkEdit() {
  byId('bulkSub').textContent = `${inv.selected.size} productos seleccionados`;
  const fields = { ...BULK_FIELDS, ...(S.pricesOn() && canManage() ? { price: 'Precio de venta', cost: 'Precio de costo', pricePer: 'Precio por unidad o por docena' } : {}) };
  const cur = byId('bulkField').value;
  byId('bulkField').innerHTML = Object.entries(fields).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');
  if (fields[cur]) byId('bulkField').value = cur;
  renderBulkValue();
  byId('bulkDialog').showModal();
}
function renderBulkValue() {
  const f = byId('bulkField').value;
  const opts = f === 'stockType' ? 'stockTypes' : f === 'unitName' ? 'stockUnits' : null;
  if (f === 'price' || f === 'cost') {
    byId('bulkValueWrap').innerHTML = `<label for="bulkValue">Nuevo ${f === 'price' ? 'precio de venta' : 'precio de costo'}</label><input id="bulkValue" class="input money" inputmode="decimal" placeholder="Vacío = quitar el precio"><p class="hint">Se aplica por unidad o por docena según cómo esté cargado cada producto.</p>`;
    return;
  }
  if (f === 'pricePer') {
    byId('bulkValueWrap').innerHTML = `<label for="bulkValue">Los precios son</label><select id="bulkValue" class="input"><option value="unit">Por unidad</option><option value="dozen">Por docena</option></select><p class="hint">Solo cambia cómo se interpreta el precio (no lo convierte). Los productos que no se controlan en unidades quedan por unidad.</p>`;
    return;
  }
  byId('bulkValueWrap').innerHTML = `<label for="bulkValue">Nuevo valor</label>${opts ? `<select id="bulkValue" class="input" data-options="${opts}"></select>` : `<input id="bulkValue" class="input" ${f === 'minStock' ? 'type="number" min="0" step="any"' : ''}>`}`
    + (f === 'unitName' ? '<p class="hint">Cambia solo la unidad, no convierte las cantidades.</p>' : '');
  if (opts) fillSelects(byId('bulkValueWrap'));
}
function applyBulk(e) {
  e.preventDefault();
  const field = byId('bulkField').value;
  let value = byId('bulkValue').value;
  if (field === 'price' || field === 'cost') {
    if (txt(value) && parseMoney(value) == null) { toast('Escribí solo el número, por ejemplo 12500 o 12.500.', 'error'); return; }
    value = parseMoney(value);
  }
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
// Importar costos (archivo de tandas o Excel) y relacionarlos con el inventario
// =========================================================
let costImp = null;
const COST_MODES = { last: 'El de la tanda más nueva', avg: 'El promedio de las tandas (según docenas)' };

function openCostImport() {
  if (!ownerOnly('cargar costos')) return;
  if (!S.pricesOn()) { toast('Primero activá Precios y ventas en Cuenta y nube.', 'warn'); return; }
  costImp = null;
  renderCostImport();
  byId('costDialog').showModal();
}
async function loadCostFile(file) {
  try {
    const r = await IO.readCostFile(file);
    if (!r.entries.some(e => e.cost > 0)) { toast('No encontré costos en ese archivo. Tiene que tener una columna CÓDIGO y otra COSTO.', 'error'); return; }
    costImp = { name: file.name, ...r, per: r.per || 'dozen', mode: 'last', choice: new Map() };
    renderCostImport();
  } catch (err) { toast(`No se pudo leer el archivo: ${err.message}`, 'error'); }
}
// Agrupa el archivo por código, elige el costo y busca el producto: primero el código exacto, después uno casi igual.
function costPlan() {
  const groups = new Map();
  for (const e of costImp.entries) { if (!groups.has(e.code)) groups.set(e.code, []); groups.get(e.code).push(e); }
  const list = [...groups].map(([code, es]) => {
    const priced = es.filter(e => e.cost > 0).sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const doz = priced.reduce((t, e) => t + e.dozens, 0);
    const cost = !priced.length ? null : costImp.mode === 'avg'
      ? round2(doz > 0 ? priced.reduce((t, e) => t + e.cost * e.dozens, 0) / doz : priced.reduce((t, e) => t + e.cost, 0) / priced.length)
      : round2(priced[0].cost);
    return { code, es, priced, cost, info: priced[0] || es[0] };
  });
  const taken = new Set(), rows = [], missing = [], noCost = list.filter(g => !g.cost), repeated = [];
  for (const g of list) {
    if (!g.cost) continue;
    const it = S.findByCode(g.code);
    if (!it) continue;
    if (taken.has(it.id)) { repeated.push(g); continue; }
    taken.add(it.id); g.item = it; g.exact = true;
  }
  // Parecidos: si dos códigos del archivo apuntan al mismo producto, gana el más parecido (YT-4012 antes que 4012).
  const cands = list.filter(g => g.cost && !g.item && !repeated.includes(g))
    .flatMap(g => S.similarCodes(g.code, 5).filter(x => x.strong).map(x => ({ g, ...x })))
    .sort((a, b) => a.score - b.score);
  for (const c of cands) {
    if (c.g.item || taken.has(c.item.id)) continue;
    taken.add(c.item.id); Object.assign(c.g, { item: c.item, reason: c.reason, score: c.score });
  }
  missing.push(...list.filter(g => g.cost && !g.item && !repeated.includes(g)));
  for (const g of list) {
    if (!g.item) continue;
    const t = S.costFor(g.item, g.cost, costImp.per);
    g.target = t;
    g.unchanged = g.item.cost === t.cost && S.pricePerOf(g.item) === t.per;
    // Los parecidos solo se marcan solos si es el mismo código con otro formato (GT-8008 / GT8008).
    g.on = costImp.choice.has(g.code) ? costImp.choice.get(g.code) : g.exact || g.score === 0;
    if (!g.unchanged) rows.push(g);
  }
  rows.sort((a, b) => Number(!!a.exact) - Number(!!b.exact) || a.code.localeCompare(b.code, 'es', { numeric: true }));
  return { rows, missing, noCost, repeated, unchanged: list.filter(g => g.unchanged) };
}
function renderCostImport() {
  const body = byId('costBody'), save = byId('costSave');
  if (!costImp) {
    body.innerHTML = `${noticeHtml('info', 'info', 'Elegí el <b>archivo de tandas</b> (.json) o un <b>Excel / CSV</b> con una columna <b>CÓDIGO</b> y otra <b>COSTO</b> (también sirve COSTO USD o PRECIO DE COSTO). Antes de cargar nada vas a ver qué producto de tu inventario recibe cada costo.')}
      <div><label class="btn btn-primary">${icon('upload')}Elegir archivo<input type="file" id="costFile" accept=".json,.xlsx,.xls,.csv" hidden></label></div>`;
    save.disabled = true; save.lastElementChild.textContent = 'Cargar costos';
    return;
  }
  const p = costPlan(), cur = S.currency(), m = S.marginPct(), fc = costImp.currency;
  const curName = c => (c === 'USD' ? 'dólares' : 'pesos');
  const tile = (n, label, tone = '') => `<div class="cost-tile ${tone}"><strong>${fmt(n)}</strong><span>${label}</span></div>`;
  const suggest = p.rows.filter(r => !r.exact).length;
  const row = g => {
    const it = g.item, t = g.target, sale = m != null ? (it.priceManual && it.price ? `${money(it.price)} <small>a mano</small>` : money(S.autoPrice(it, t.cost))) : '';
    return `<tr class="${g.exact ? '' : 'is-suggest'}"><td><input type="checkbox" data-cost-pick="${esc(g.code)}" ${g.on ? 'checked' : ''} aria-label="Cargar el costo de ${esc(g.code)}"></td>
      <td><b class="mono">${esc(g.code)}</b><small>${esc([g.info.name, g.info.brand].filter(Boolean).join(' · '))}</small></td>
      <td><b class="mono">${esc(it.sku)}</b>${g.exact ? '' : ` <span class="badge badge-warn">${esc(g.reason)}</span>`}<small>${esc(productName(it) || 'Sin marca ni prenda')}</small></td>
      <td class="num">${it.cost ? `${money(it.cost)} <small>${S.PRICE_PER[S.pricePerOf(it)]}</small>` : '—'}</td>
      <td class="num"><b>${money(t.cost)}</b> <small>${S.PRICE_PER[t.per]}${g.priced.length > 1 ? ` · ${g.priced.length} tandas` : ''}</small></td>
      ${m != null ? `<td class="num">${sale}</td>` : ''}</tr>`;
  };
  const codes = gs => gs.map(g => `<span class="chip-code mono" title="${esc([g.info.name, g.info.brand, g.info.reason].filter(Boolean).join(' · '))}">${esc(g.code)}</span>`).join(' ');
  body.innerHTML = `
    ${fc && fc !== cur ? noticeHtml('warn', 'alert', `El archivo está en <b>${curName(fc)}</b> y la app muestra los precios en <b>${curName(cur)}</b>. <a href="#" class="link" data-cost-currency="${fc}">Mostrar los precios en ${curName(fc)}</a>`) : ''}
    <div class="form-grid">
      <div class="field"><label for="costPer">Los costos del archivo son</label><select id="costPer" class="input"><option value="dozen">Por docena</option><option value="unit">Por unidad</option></select></div>
      <div class="field"><label for="costMode">Si un código está en varias tandas, usar</label><select id="costMode" class="input">${Object.entries(COST_MODES).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div>
    </div>
    <div class="cost-tiles">${tile(p.rows.length - suggest, 'con el mismo código', 'ok')}${tile(suggest, 'parecidos: revisalos', suggest ? 'warn' : '')}${tile(p.unchanged.length, 'ya tenían ese costo')}${tile(p.missing.length, 'no están en tu inventario')}${tile(p.noCost.length, 'sin costo en el archivo')}</div>
    ${noticeHtml('info', 'info', m != null ? `El precio de venta se calcula con la ganancia general (<b>${fmt(m)} %</b> sobre el costo), salvo en los productos con precio a mano.` : 'Todavía no hay ganancia general: solo se carga el costo. Después podés ponerla en <b>Cuenta y nube → Precios y ventas</b> y los precios de venta se calculan solos.')}
    ${p.rows.length ? `<div class="table-wrap cost-table"><table class="table"><thead><tr><th></th><th>En el archivo</th><th>Producto en la app</th><th class="num">Costo actual</th><th class="num">Costo nuevo</th>${m != null ? '<th class="num">Venta</th>' : ''}</tr></thead><tbody>${p.rows.map(row).join('')}</tbody></table></div>` : noticeHtml('success', 'check', 'Todos los productos que coinciden ya tienen estos costos. No hay nada para cargar.')}
    ${p.missing.length ? `<details class="cost-more"><summary>${fmt(p.missing.length)} código${p.missing.length === 1 ? '' : 's'} del archivo no están en tu inventario</summary><p class="small muted">No se cargan. Si alguno sí está con otro código, editá el código del producto o uní los duplicados, y volvé a importar.</p><div class="chip-codes">${codes(p.missing)}</div></details>` : ''}
    ${p.noCost.length ? `<details class="cost-more"><summary>${fmt(p.noCost.length)} código${p.noCost.length === 1 ? '' : 's'} sin costo en el archivo</summary><div class="chip-codes">${codes(p.noCost)}</div></details>` : ''}
    ${p.repeated.length ? `<details class="cost-more"><summary>${fmt(p.repeated.length)} código${p.repeated.length === 1 ? '' : 's'} apuntan a un producto que ya recibe otro costo</summary><div class="chip-codes">${codes(p.repeated)}</div></details>` : ''}`;
  byId('costPer').value = costImp.per;
  byId('costMode').value = costImp.mode;
  byId('costSub').textContent = `${costImp.name} · ${fmt(costImp.entries.length)} renglones`;
  updateCostSave(p);
}
function updateCostSave(p = costPlan()) {
  const n = p.rows.filter(r => r.on).length, save = byId('costSave');
  save.disabled = !n;
  save.lastElementChild.textContent = n ? `Cargar ${fmt(n)} costo${n === 1 ? '' : 's'}` : 'Cargar costos';
}
function onCostBody(e) {
  const t = e.target;
  if (t.id === 'costFile' && t.files?.[0]) { loadCostFile(t.files[0]); return; }
  if (!costImp) return;
  if (t.id === 'costPer' || t.id === 'costMode') { costImp[t.id === 'costPer' ? 'per' : 'mode'] = t.value; renderCostImport(); return; }
  if (t.dataset.costPick) { costImp.choice.set(t.dataset.costPick, t.checked); updateCostSave(); }
}
function saveCostImport(e) {
  e.preventDefault();
  const sel = costPlan().rows.filter(r => r.on);
  const r = S.importCosts(sel.map(g => ({ id: g.item.id, cost: g.cost, per: costImp.per })), costImp.name);
  if (!r.ok) { toast(r.error, 'error'); return; }
  byId('costDialog').close();
  sound('ok');
  toast(`Costos cargados en ${fmt(r.count)} producto${r.count === 1 ? '' : 's'}${r.priced ? ` · ${fmt(r.priced)} precio${r.priced === 1 ? '' : 's'} de venta calculado${r.priced === 1 ? '' : 's'} con la ganancia general` : ''}`, { duration: 9000, action: () => { if (S.undo()) toast('Importación deshecha', 'info'); } });
}

// =========================================================
// Productos duplicados: buscarlos y unirlos en uno
// =========================================================
let merge = { ids: [], keep: null, fromDups: false };
const qtyText = i => { const d = S.displayQty(i); return `${fmt(d.value)} ${d.unit}`; };
const noticeHtml = (tone, ic, html) => `<div class="notice ${tone}">${icon(ic)}<span>${html}</span></div>`;

function openDuplicates() {
  if (!ownerOnly('unir productos')) return;
  renderDuplicates();
  if (!byId('dupDialog').open) byId('dupDialog').showModal();
}
function renderDuplicates() {
  const groups = S.duplicateGroups();
  byId('dupSub').textContent = groups.length ? `${groups.length} grupo${groups.length === 1 ? '' : 's'} para revisar. Uní solo los que de verdad son el mismo producto.` : 'Revisamos todo el inventario.';
  byId('dupBody').innerHTML = groups.length
    ? `<div class="dup-list">${groups.map(g => `<div class="dup-group">
        <div class="dup-items">${g.items.map(i => `<div><b class="mono">${esc(i.sku)}</b><span>${esc(productName(i) || 'Sin marca ni prenda')} · stock ${esc(qtyText(i))}</span></div>`).join('')}</div>
        <div class="dup-foot"><small>${esc(g.reasons.join(' · '))}</small><button type="button" class="btn btn-sm btn-primary" data-merge="${esc(g.items.map(i => i.id).join(','))}">${icon('layers', 'sm')}Unir…</button></div></div>`).join('')}</div>`
    : emptyState('check', 'No hay duplicados a la vista', 'No encontramos productos con códigos casi iguales. Si sabés de dos que son el mismo, marcalos en el Inventario y tocá Unir.');
}

function openMerge(ids, fromDups = false) {
  if (!ownerOnly('unir productos')) return;
  const items = ids.map(S.findById).filter(Boolean);
  if (items.length < 2) { toast('Marcá al menos dos productos para unirlos.', 'warn'); return; }
  merge = { ids: items.map(i => i.id), keep: items[0].id, fromDups };
  renderMerge();
  byId('mergeDialog').showModal();
}
function renderMerge() {
  const items = merge.ids.map(S.findById).filter(Boolean), keep = S.findById(merge.keep) || items[0], rest = items.filter(i => i !== keep);
  const mixed = new Set(items.map(i => i.unitName)).size > 1, total = items.reduce((t, i) => t + i.units, 0);
  const codes = rest.map(i => `<b>${esc(i.sku)}</b>`).join(', ');
  const differs = rest.filter(i => (i.brand && keep.brand && i.brand !== keep.brand) || (i.type && keep.type && i.type !== keep.type));
  byId('mergeBody').innerHTML = `<div><p class="small" style="margin-bottom:8px"><b>¿Qué código queda?</b> ${rest.length === 1 ? 'El otro se borra' : 'Los demás se borran'} y su stock pasa a ese.</p>
    <div class="merge-list">${items.map(i => { const n = S.movementCount(i); return `<label class="merge-opt ${i === keep ? 'active' : ''}"><input type="radio" name="mergeKeep" value="${esc(i.id)}" ${i === keep ? 'checked' : ''}><b class="mono">${esc(i.sku)}</b><span>${esc(productName(i) || 'Sin marca ni prenda')} · stock ${fmt(i.units)} ${esc(S.unitLabel(i.unitName))} · ${fmt(n)} movimiento${n === 1 ? '' : 's'}</span>${items.length > 2 && i !== keep ? `<button type="button" class="btn btn-ghost btn-sm" data-merge-drop="${esc(i.id)}" title="No unir este producto">${icon('x', 'sm')}Quitar</button>` : ''}</label>`; }).join('')}</div></div>
    ${mixed
      ? noticeHtml('danger', 'alert', `No se pueden unir: se controlan en unidades distintas (${esc(items.map(i => `${i.sku} en ${S.unitLabel(i.unitName)}`).join(', '))}). Primero cambiá la unidad de uno desde Editar.`)
      : noticeHtml('success', 'check', `Queda <b>${esc(keep.sku)}</b> con <b>${fmt(total)} ${esc(S.unitLabel(keep.unitName))}</b> (${items.map(i => fmt(i.units)).join(' + ')}).`)}
    ${differs.length ? noticeHtml('warn', 'alert', `Se mantienen la marca y la prenda de <b>${esc(keep.sku)}</b> (${esc(productName(keep))}). ${differs.map(i => `${esc(i.sku)} decía ${esc(productName(i))}`).join(' · ')}. Si no es el mismo producto, no los unas.`) : ''}
    ${noticeHtml('info', 'info', `Si alguien escanea o escribe ${codes}, la app lo lleva a <b>${esc(keep.sku)}</b>. Las etiquetas impresas se siguen leyendo y el historial queda junto.`)}`;
  byId('mergeSave').disabled = mixed;
}
function saveMerge(e) {
  e.preventDefault();
  const r = S.mergeItems(merge.keep, merge.ids);
  if (!r.ok) { toast(r.error, 'error'); sound('error'); return; }
  byId('mergeDialog').close();
  inv.selected.clear();
  sound('ok');
  flashRow(r.item.id);
  toast(`${r.merged.join(', ')} unido${r.merged.length === 1 ? '' : 's'} a ${r.item.sku}: stock ${fmt(r.before)} → ${fmt(r.after)} ${S.unitLabel(r.item.unitName)}`, { duration: 8000, action: () => { if (S.undo()) toast('Unión deshecha', 'info'); } });
  if (merge.fromDups && S.duplicateGroups().length) openDuplicates();
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
    const base = [...items.map(i => ({ code: i.sku, name: productName(i), units: i.units, price: labelPrice(i, null) })), ...lbl.custom.map(c => ({ code: c, name: '', units: 1 }))];
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
      if (!push({ code: S.serialCode(i.sku, pack, n), name: productName(i), tag, price: labelPrice(i, pack) })) break;
      printed.push(n);
    }
    if (printed.length) plan.push({ id: i.id, sku: i.sku, pack, numbers: printed, start: printed[0], last: printed.at(-1), count: printed.length, restart: !listed && prefs.lblRestart, current: i.serials?.[pack] || 0 });
    if (truncated) break;
  }
  return { out, truncated, products: items.length, plan, skipped, bad: listed?.bad || [] };
}

// Precio impreso en la etiqueta: el de lo que identifica (una docena, una unidad o el producto como está cargado).
function labelPrice(i, pack) {
  const p = S.pricesOn() && prefs.lblShowPrice ? salePrice(i) : null;
  if (!p) return '';
  const m = n => moneyIn(n, saleCur());
  if (pack === 'D') return `${m(p.per === 'dozen' ? p.price : p.price * 12)} la docena`;
  if (pack === 'U') return m(p.per === 'dozen' ? p.price / 12 : p.price);
  return `${m(p.price)}${p.per === 'dozen' ? ' la docena' : ''}`;
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
  const examplePrice = S.pricesOn() && prefs.lblShowPrice ? moneyIn(prefs.lblMode === 'D' ? 30000 : 2500, saleCur()) : '';
  const example = prefs.lblMode === 'product' ? { code: 'EJEMPLO123', name: 'MARCA · PRENDA', price: examplePrice }
    : { code: `1015${prefs.lblMode}0001`, name: 'MARCA · PRENDA', tag: `${S.PACKS[prefs.lblMode].label} N.º 0001${prefs.lblMode === 'D' ? ' · 12 u.' : ''}`, price: examplePrice };
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
const hist = { q: '', kind: 'all', code: '', brand: '', type: '', period: 'all', limit: 100, select: false, selected: new Set() };
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
  if (hist.select && !canManage()) hist.select = false;
  const ids = new Set(state.history.map(h => h.id));
  for (const id of hist.selected) if (!ids.has(id)) hist.selected.delete(id);
  byId('histList').classList.toggle('selecting', hist.select);
  byId('histList').innerHTML = historyByDay(shown, hist.select ? { select: true, selected: hist.selected } : {}) || emptyState('history', 'Sin movimientos', filtered ? 'No hay resultados para estos filtros.' : 'Cuando cargues productos, vas a ver cada movimiento acá.');
  byId('histMore').hidden = rows.length <= shown.length;
  byId('histMore').textContent = `Ver más (${rows.length - shown.length})`;
  renderHistBulk(rows);
}

// =========================================================
// Elegir varios movimientos para anularlos o borrarlos juntos (solo el dueño)
// =========================================================
function renderHistBulk(rows = filteredHistory()) {
  const n = hist.selected.size, all = rows.length > 0 && rows.every(h => hist.selected.has(h.id));
  byId('histSelect').setAttribute('aria-pressed', String(hist.select));
  byId('histBulkBar').hidden = !hist.select;
  byId('histBulkCount').textContent = n ? `${fmt(n)} seleccionado${n === 1 ? '' : 's'}` : 'Tocá los movimientos';
  byId('histBulkAll').textContent = all ? 'Quitar todos' : `Todos (${fmt(rows.length)})`;
  byId('histBulkAll').disabled = !rows.length;
  byId('histBulkDelete').disabled = !n;
}
function setHistSelect(on) {
  if (on && !ownerOnly('eliminar movimientos')) return;
  hist.select = on;
  if (!on) hist.selected.clear();
  renderHistory();
}
function toggleHistRow(row) {
  const id = row.dataset.move, on = !hist.selected.has(id);
  if (on) hist.selected.add(id); else hist.selected.delete(id);
  row.classList.toggle('selected', on);
  row.setAttribute('aria-checked', String(on));
  const cb = row.querySelector('.tl-check input');
  if (cb) cb.checked = on;
  // Sin volver a dibujar la lista (no se pierde el foco): solo la barra y los botones de cada día.
  const rows = filteredHistory();
  $$('#histList [data-hsel-day]').forEach(b => {
    const key = b.dataset.hselDay;
    b.textContent = rows.filter(h => new Date(h.at).toDateString() === key).every(h => hist.selected.has(h.id)) ? 'Quitar el día' : 'Elegir todo el día';
  });
  renderHistBulk(rows);
}
const hb = { ids: [], mode: 'void', plan: null };
function openHistBulk() {
  if (!ownerOnly('eliminar movimientos')) return;
  hb.ids = [...hist.selected];
  if (!hb.ids.length) return;
  hb.plan = S.planVoid(hb.ids);
  const n = hb.ids.length;
  byId('hbTitle').textContent = `Eliminar ${fmt(n)} movimiento${n === 1 ? '' : 's'}`;
  byId('hbMode').querySelector('[data-v="void"]').disabled = !hb.plan.ok;
  byId('hbReason').value = '';
  byId('hbReason').classList.remove('has-error');
  byId('hbError').hidden = true;
  $$('#hbReasons .chip').forEach(c => c.classList.remove('active'));
  setHbMode(hb.plan.ok ? 'void' : 'delete');
  byId('histBulkDialog').showModal();
}
function setHbMode(mode) {
  hb.mode = mode;
  segmented(byId('hbMode'), mode);
  const plan = hb.plan, n = hb.ids.length, moves = hb.ids.map(id => state.history.find(h => h.id === id)).filter(Boolean);
  const pl = (x, one, many) => `${fmt(x)} ${x === 1 ? one : many}`;
  const inRemito = moves.filter(h => { const r = S.remitoOfEntry(h.id); return r && !r.voided; }).length;
  byId('hbReasonField').hidden = mode !== 'void';
  const notes = [];
  if (mode === 'void') {
    notes.push(`<div class="notice info">${icon('info')}<span>El stock vuelve a como estaba antes de estos movimientos. <b>No se borran:</b> quedan tachados en el historial con tu usuario y el motivo, y dejan de contar en los reportes.</span></div>`);
    if (plan.skipped.length) notes.push(`<div class="notice warn">${icon('alert')}<span>${pl(plan.skipped.length, 'no se puede anular', 'no se pueden anular')} (ya anulado${plan.skipped.length === 1 ? '' : 's'}, ediciones, importaciones o productos borrados): se deja${plan.skipped.length === 1 ? '' : 'n'} como está${plan.skipped.length === 1 ? '' : 'n'}.</span></div>`);
    if (plan.blocked.length) notes.push(`<div class="notice danger">${icon('alert')}<span>${pl(plan.blocked.length, 'no se puede anular', 'no se pueden anular')} porque el stock quedaría negativo: ${[...new Set(plan.blocked.map(h => h.sku))].map(s => `<b class="mono">${esc(s)}</b>`).join(', ')}.</span></div>`);
    if (inRemito) notes.push(`<div class="notice">${icon('file')}<span>${pl(inRemito, 'es parte', 'son parte')} de un remito o venta: el comprobante sigue vigente. Para anularlo, abrí el movimiento y tocá el comprobante.</span></div>`);
  } else {
    const stockMoves = moves.filter(h => !h.voided && ['in', 'out', 'count'].includes(S.historyKind(h))).length;
    notes.push(`<div class="notice warn">${icon('trash')}<span>Se quitan del historial y de los reportes. <b>El stock actual no cambia.</b> Sirve para limpiar pruebas o registros que sobran. Podés deshacerlo enseguida con «Deshacer».</span></div>`);
    if (stockMoves) notes.push(`<div class="notice">${icon('info')}<span>${pl(stockMoves, 'de estos sumó o restó', 'de estos sumaron o restaron')} stock. Si querés que el stock vuelva atrás, elegí <b>«Anular y corregir el stock»</b>.</span></div>`);
  }
  byId('hbInfo').innerHTML = notes.join('');
  if (mode === 'void' && plan.skus.length) {
    const max = 8, list = plan.skus.slice(0, max).map(s => `<span><b class="mono">${esc(s.item.sku)}</b>: ${fmt(s.before)} → <b>${fmt(s.after)}</b> ${esc(S.unitLabel(s.item.unitName))}</span>`).join('');
    byId('hbPreview').innerHTML = `<div class="notice success">${icon('check')}<span>Así queda el stock:<span class="hb-list">${list}${plan.skus.length > max ? `<span class="muted">y ${pl(plan.skus.length - max, 'código más', 'códigos más')}</span>` : ''}</span></span></div>`;
  } else byId('hbPreview').innerHTML = '';
  byId('hbSave').innerHTML = mode === 'void'
    ? `${icon('undo')}Anular ${pl(plan.ok, 'movimiento', 'movimientos')}`
    : `${icon('trash')}Borrar ${pl(n, 'movimiento', 'movimientos')}`;
  byId('hbSave').disabled = mode === 'void' && !plan.ok;
}
function saveHistBulk(e) {
  e.preventDefault();
  if (hb.mode === 'void') {
    const reason = txt(byId('hbReason').value);
    if (!reason) {
      byId('hbError').innerHTML = `${icon('alert')}Escribí el motivo o tocá uno de los botones de arriba.`;
      byId('hbError').hidden = false;
      byId('hbReason').classList.add('has-error');
      byId('hbReason').focus();
      shake(byId('hbSave'));
      return;
    }
    const r = S.voidMovements(hb.ids, reason);
    if (!r.ok) { byId('hbError').innerHTML = `${icon('alert')}${esc(r.error)}`; byId('hbError').hidden = false; shake(byId('hbSave')); return; }
    byId('histBulkDialog').close();
    setHistSelect(false);
    const left = hb.ids.length - r.done;
    toast(`${fmt(r.done)} movimiento${r.done === 1 ? '' : 's'} anulado${r.done === 1 ? '' : 's'} y stock corregido${left ? ` · ${fmt(left)} quedaron sin cambios` : ''}`, { type: left ? 'warn' : 'success', action: () => S.undo(), duration: 7000 });
    return;
  }
  const n = S.deleteMovements(hb.ids);
  byId('histBulkDialog').close();
  setHistSelect(false);
  toast(`${fmt(n)} movimiento${n === 1 ? '' : 's'} borrado${n === 1 ? '' : 's'} del historial`, { action: () => S.undo(), duration: 7000 });
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
      ${(rem => row('Comprobante', rem ? `<a href="#" class="link" data-open-remito="${esc(rem.id)}">${esc(S.remitoCode(rem))}${rem.priced && S.pricesOn() ? ` · ${rem.kind === 'entrada' ? 'compra' : 'venta'} ${remMoney(rem, rem.total)}` : ''}</a>${rem.voided ? ' <span class="badge badge-danger">Anulado</span>' : ''}` : ''))(S.remitoOfEntry(h.id))}
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
  const units = r.lines.reduce((s, l) => s + num(l.units), 0), priced = r.priced && S.pricesOn();
  byId('rvTitle').textContent = `${S.remitoCode(r)} · ${priced ? (r.kind === 'entrada' ? 'Compra' : 'Venta') : r.kind === 'entrada' ? 'Entrada' : 'Salida'}`;
  byId('rvVoid').hidden = !!r.voided || !canManage();
  byId('rvSub').textContent = `${r.contact?.name || 'Sin cliente'} · ${dateTimeOf(r.at)}`;
  byId('rvBody').innerHTML = `
    <dl class="detail-kv" style="margin-bottom:14px">
      <dt>${r.kind === 'entrada' ? 'Proveedor' : 'Cliente'}</dt><dd>${esc(r.contact?.name || 'Sin cliente')}</dd>
      ${r.contact?.doc ? `<dt>CUIT / DNI</dt><dd>${esc(r.contact.doc)}</dd>` : ''}
      ${r.contact?.phone ? `<dt>WhatsApp</dt><dd>${esc(r.contact.phone)}</dd>` : ''}
      ${r.contact?.address ? `<dt>Dirección</dt><dd>${esc(r.contact.address)}</dd>` : ''}
      <dt>${priced ? 'Mercadería' : 'Total'}</dt><dd>${fmt(units)} unidades (${fmt(units / 12)} docenas)</dd>
      ${priced ? `<dt>Subtotal</dt><dd>${remMoney(r, r.subtotal)}</dd>${r.discount ? `<dt>Descuento</dt><dd>${fmt(r.discount)} % (−${remMoney(r, r.subtotal - r.total)})</dd>` : ''}<dt>Total</dt><dd><b>${remMoney(r, r.total)}</b>${r.fx?.rate ? ` <span class="muted">(${moneyIn(r.total / r.fx.rate, 'USD')})</span>` : ''}</dd>${r.fx?.rate ? `<dt>Cotización</dt><dd>${moneyIn(r.fx.rate, 'ARS')} por dólar${r.fx.source ? ` · ${esc(r.fx.source)}` : ''}</dd>` : ''}${r.payment ? `<dt>Forma de pago</dt><dd>${esc(S.PAYMENTS[r.payment] || r.payment)}</dd>` : ''}` : ''}
      ${r.by ? `<dt>Preparado por</dt><dd>@${esc(r.by)}</dd>` : ''}
      ${r.note ? `<dt>Observaciones</dt><dd>${esc(r.note)}</dd>` : ''}
    </dl>
    ${r.voided ? `<div class="notice danger" style="margin-bottom:14px">${icon('x')}<span><b>Anulado</b>${r.voided.by ? ` por @${esc(r.voided.by)}` : ''} el ${esc(dateTimeOf(r.voided.at))}<br>Motivo: ${esc(r.voided.reason)}</span></div>` : ''}
    <div class="table-wrap"><table class="table"><thead><tr><th>Código</th><th>Producto</th><th class="num">Cantidad</th>${priced ? '<th class="num">Precio</th><th class="num">Importe</th>' : ''}</tr></thead><tbody>
      ${r.lines.map(l => `<tr><td><b class="code">${esc(l.sku)}</b></td><td style="white-space:normal">${esc(l.name || '—')}${l.serials?.length ? `<div class="small muted">${l.serials.length} etiqueta${l.serials.length === 1 ? '' : 's'} numerada${l.serials.length === 1 ? '' : 's'}</div>` : ''}</td><td class="num">${fmt(l.qty)} ${esc(l.unit)}<div class="small muted">${fmt(l.units)} u.</div></td>${priced ? `<td class="num">${l.price ? `${remMoney(r, l.price)}<div class="small muted">${S.PRICE_PER[l.per] || ''}</div>` : '—'}</td><td class="num">${remMoney(r, l.amount)}</td>` : ''}</tr>`).join('')}
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
  const mine = state.extra.remitos.filter(r => r.contact?.id === c.id);
  return { units, moves, last, remitos: mine.length, amount: mine.filter(r => r.priced && !r.voided).reduce((s, r) => s + remitoIn(r), 0) };
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
        ${st ? `<span class="contact-stat">${st.moves ? `${fmt(st.units)} u. ${c.kind === 'proveedor' ? 'recibidas' : 'vendidas'}${S.pricesOn() && st.amount ? ` · ${repMoney(st.amount)} en ${c.kind === 'proveedor' ? 'compras' : 'ventas'}` : ''} · ${st.remitos} remito${st.remitos === 1 ? '' : 's'} · último ${relTime(st.last)}` : 'Sin movimientos todavía'}</span>` : ''}</div>
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
    const kind = r.priced ? (r.kind === 'entrada' ? 'Compra' : 'Venta') : r.kind === 'entrada' ? 'Entrada' : 'Salida';
    return `<div class="remito-row ${r.voided ? 'is-voided' : ''}" data-remito="${esc(r.id)}"><div class="grow"><strong>${esc(S.remitoCode(r))} · ${esc(r.contact?.name || 'Sin cliente')}${r.priced && S.pricesOn() ? ` · ${remMoney(r, r.total)}` : ''}${r.voided ? ' <span class="badge badge-danger">Anulado</span>' : ''}</strong>
      <span>${kind} · ${fmt(units)} u. en ${r.lines.length} artículo${r.lines.length === 1 ? '' : 's'}${r.payment ? ` · ${esc(S.PAYMENTS[r.payment] || '')}` : ''} · ${esc(dateTimeOf(r.at))}${r.by ? ` · @${esc(r.by)}` : ''}</span></div>
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
    if (m.price != null) l.price = m.price; // precio cambiado solo para esta venta
    if (m.serial) l.serials.push(m.serial);
    map.set(m.sku, l);
  }
  return [...map.values()].map(l => {
    const dozens = l.stock === 'unidades' && l.units >= 12 && l.units % 12 === 0;
    const qty = dozens ? l.units / 12 : l.units;
    const unit = dozens ? (qty === 1 ? 'docena' : 'docenas') : l.stock === 'unidades' ? (qty === 1 ? 'unidad' : 'unidades') : S.unitLabel(l.stock);
    return { sku: l.sku, name: l.name, serials: l.serials, units: l.units, qty, unit, ...(l.price != null ? { price: l.price } : {}) };
  });
}
const feedMoves = op => session.feed.filter(f => !f.undone && f.op === op && (f.entryId || f.pending)).map(f => ({ sku: f.sku, units: f.amount, serial: f.serial, entryId: f.entryId, price: session.prices.get(f.itemId) }));
const liveFeed = () => session.feed.filter(f => !f.undone);

function resetSession() {
  Object.assign(session, { reads: 0, units: 0, products: new Set(), counted: new Set(), serials: new Set(), aliases: new Map(), prices: new Map(), feed: [] });
  feedPriceEdit = null;
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
  // En el comprobante, los productos van en el orden en que se escanearon (la lista de la pantalla va al revés).
  openRemito({ kind: prefs.scanOp === 'sumar' ? 'entrada' : 'salida', moves: feedMoves(prefs.scanOp).reverse(), contactName: session.contactName, priced: !!saleKind(), finish: { name: m.name, reads: live.length, units, products } });
}
// Cierra la sesión después de terminar y deja todo listo para la próxima.
function endScanSession(remito) {
  const f = pendingRemito?.finish;
  if (!f) return;
  pendingRemito.finish = null;
  resetSession();
  toast(`${cap(f.name)} terminada: ${fmt(f.reads)} lectura${f.reads === 1 ? '' : 's'} · ${fmt(f.units)} unidades${remito ? ` · ${S.remitoCode(remito)}` : ''}${remito?.priced ? ` · ${remMoney(remito, remito.total)}` : ''}`);
  setTimeout(focusKioskOrScan, 200);
}

let pendingRemito = null;
// priced: con precios (venta si es salida, compra si es entrada). Se puede cambiar dentro del diálogo.
function openRemito({ kind, moves, contactName = '', finish = null, priced = null }) {
  if (!moves.length) return toast('No hay productos para el remito.', 'warn');
  const pk = kind === 'entrada' ? 'compra' : 'venta';
  // Cada línea arranca con el precio guardado del producto; se puede cambiar solo para este comprobante.
  // Venta con cobro en pesos: cada línea arranca con el precio en pesos (fijo o dólares × blue) y se puede corregir.
  const cur = saleCur(pk), fx = cur !== S.currency() ? S.fxNow() : null;
  const lines = linesFromMoves(moves).map(l => { const it = S.findByCode(l.sku), p = salePrice(it, pk); return { ...l, per: p?.per || newPricePer(it), price: l.price ?? p?.price ?? null, stored: p?.price ?? null }; });
  // Venta sin confirmar: el stock se descuenta al guardar o enviar el comprobante.
  const cart = finish && kind === 'salida' && cartPending().length > 0;
  pendingRemito = { kind, pk, cur, fx, lines, cart, entryIds: moves.map(m => m.entryId).filter(Boolean), created: null, finish, discount: 0, payment: '',
    priced: S.pricesOn() && (priced ?? (kind === 'entrada' ? prefs.buyIn : prefs.saleOut)) };
  byId('rmTitle').textContent = finish ? `Terminar ${finish.name}` : kind === 'entrada' ? 'Remito de entrada' : 'Remito de salida';
  byId('rmSub').textContent = `Comprobante ${S.remitoCode({ number: state.extra.remitoSeq + 1 })} · ${new Date().toLocaleDateString('es-AR')}`;
  byId('rmCancel').textContent = finish ? 'Seguir escaneando' : 'Cancelar';
  byId('rmContactLabel').textContent = kind === 'entrada' ? 'Proveedor' : 'Cliente';
  byId('rmContact').value = contactName;
  byId('rmNote').value = '';
  byId('rmPriced').checked = pendingRemito.priced;
  byId('rmPricedLabel').textContent = kind === 'entrada' ? 'Es una compra: registrar costos' : 'Es una venta: precios y total';
  renderRemitoLines();
  byId('remitoDialog').showModal();
}
function renderRemitoLines() {
  const r = pendingRemito, priced = r.priced && S.pricesOn(), units = r.lines.reduce((s, l) => s + l.units, 0);
  byId('rmFinish').hidden = !r.finish && !priced;
  byId('rmFinish').innerHTML = `${icon('check')}${r.cart ? `Confirmar ${r.pk} sin enviar` : priced ? `Guardar ${r.pk} sin enviar` : 'Terminar sin remito'}`;
  const serialNote = l => (l.serials.length ? `<div class="small muted">${l.serials.length} etiqueta${l.serials.length === 1 ? '' : 's'} numerada${l.serials.length === 1 ? '' : 's'}</div>` : '');
  byId('rmLines').innerHTML = priced
    ? `<div class="table-wrap"><table class="table rm-priced"><thead><tr><th>Código</th><th>Producto</th><th class="num">Cantidad</th><th class="num">Precio</th><th class="num">Importe</th></tr></thead><tbody>
      ${r.lines.map((l, i) => `<tr><td><b class="code">${esc(l.sku)}</b></td><td>${esc(l.name || '—')}${serialNote(l)}</td><td class="num">${fmt(l.qty)} ${esc(l.unit)}</td>
        <td class="num"><input class="input money rm-price ${l.price ? '' : 'has-error'}" data-line="${i}" inputmode="decimal" value="${l.price ? fmt(l.price) : ''}" placeholder="${r.cur === 'USD' ? 'US$' : '$'} 0" aria-label="Precio de ${esc(l.sku)} ${S.PRICE_PER[l.per]}"><div class="small muted">${S.PRICE_PER[l.per]}</div></td>
        <td class="num" id="rmAmt${i}"></td></tr>`).join('')}
      </tbody></table></div>`
    : `<div class="table-wrap"><table class="table"><thead><tr><th>Código</th><th>Producto</th><th class="num">Cantidad</th><th class="num">Unidades</th></tr></thead><tbody>
      ${r.lines.map(l => `<tr><td><b class="code">${esc(l.sku)}</b></td><td>${esc(l.name || '—')}${serialNote(l)}</td><td class="num">${fmt(l.qty)} ${esc(l.unit)}</td><td class="num">${fmt(l.units)}</td></tr>`).join('')}
      </tbody></table></div><p class="hint" style="text-align:right">Total: <b>${fmt(units)} unidades</b> (${fmt(units / 12)} docenas)</p>`;
  byId('rmTotals').innerHTML = priced
    ? `<div class="rm-totals">
        <div class="field"><label for="rmDiscount">Descuento %</label><input id="rmDiscount" class="input" inputmode="decimal" placeholder="0" value="${r.discount ? fmt(r.discount) : ''}"></div>
        <div class="field"><label for="rmPayment">Forma de pago</label><select id="rmPayment" class="input"><option value="">Sin indicar</option>${Object.entries(S.PAYMENTS).map(([v, l]) => `<option value="${v}" ${v === r.payment ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></div>
        <div class="rm-total"><span id="rmSubRow"></span><strong id="rmTotal"></strong></div>
      </div>
      <div id="rmPriceWarn"></div>
      <label class="switch" id="rmSavePricesWrap" hidden><input type="checkbox" id="rmSavePrices" checked><span class="track"></span><span>Guardar los precios cambiados como precio fijo del producto (si lo apagás, valen solo para esta venta)</span></label>`
    : '';
  updateRemitoTotals();
}
// Recalcula importes y total sin redibujar la tabla (para no perder el foco mientras se escribe).
function updateRemitoTotals() {
  const r = pendingRemito, priced = r?.priced && S.pricesOn();
  const finishSummary = f => `<b>${fmt(f.reads)} lectura${f.reads === 1 ? '' : 's'}</b> · ${fmt(f.units)} unidades de ${fmt(f.products)} producto${f.products === 1 ? '' : 's'}`;
  if (!priced) {
    byId('rmSummary').innerHTML = r.finish ? `<div class="mode-banner ${r.kind === 'entrada' ? 'success' : 'danger'}">${icon(r.kind === 'entrada' ? 'arrow-in' : 'arrow-out')}<span>${finishSummary(r.finish)}. El stock ya está ${r.kind === 'entrada' ? 'sumado' : 'descontado'}; ahora elegí si querés el remito.</span></div>` : '';
    return;
  }
  let sub = 0, missing = 0, changed = 0;
  r.lines.forEach((l, i) => {
    const a = l.price ? S.lineAmount(l.units, l.price, l.per) : 0;
    sub += a;
    if (!l.price) missing++;
    if (l.price && l.price !== l.stored) changed++;
    const c = byId(`rmAmt${i}`);
    if (c) c.textContent = l.price ? moneyIn(a, r.cur) : '—';
  });
  sub = round2(sub);
  const total = round2(sub * (1 - r.discount / 100));
  const m = n => moneyIn(n, r.cur), usd = r.fx?.rate ? ` · ${moneyIn(total / r.fx.rate, 'USD')} (dólar a ${moneyIn(r.fx.rate, 'ARS')})` : '';
  byId('rmSubRow').innerHTML = r.discount ? `Subtotal ${m(sub)} · descuento ${fmt(r.discount)} % (−${m(sub - total)})` : 'Total';
  byId('rmTotal').textContent = m(total);
  byId('rmPriceWarn').innerHTML = missing ? `<div class="notice warn">${icon('alert')}<span>${missing === 1 ? 'Un producto no tiene' : `${missing} productos no tienen`} ${r.pk === 'compra' ? 'costo' : 'precio'}: escribilo en la tabla o se registra en $ 0.</span></div>` : '';
  byId('rmSavePricesWrap').hidden = !changed || !canManage();
  byId('rmSummary').innerHTML = `<div class="mode-banner ${r.kind === 'entrada' ? 'success' : 'danger'}">${icon('cash')}<span>${r.finish ? `${finishSummary(r.finish)} · ` : ''}<b>${cap(r.pk)} por ${m(total)}</b>${usd}. ${r.cart ? 'Todavía no se descontó nada: <b>al confirmar</b> (guardar o enviar) se descuenta del stock.' : r.finish ? `El stock ya está ${r.kind === 'entrada' ? 'sumado' : 'descontado'}.` : ''}</span></div>`;
}
// Confirma la venta: descuenta del stock todo lo reservado. Primero controla que alcance todo; si algo cambió
// (por ejemplo otra persona vendió lo mismo), no descuenta nada y avisa.
function commitCart(pr) {
  const list = cartPending();
  if (!list.length) return true;
  const need = new Map();
  for (const f of list) need.set(f.itemId, (need.get(f.itemId) || 0) + f.amount);
  for (const [id, units] of need) {
    const it = S.findById(id);
    if (!it) { toast('Un producto de la venta ya no está en el inventario. Revertilo y volvé a confirmar.', 'error'); return false; }
    if (it.units < units) { toast(`Stock insuficiente de ${it.sku}: hay ${stockWords(it, it.units)} y la venta lleva ${stockWords(it, units)}. Corregí la venta antes de confirmar.`, 'error'); return false; }
  }
  const contact = resolveContact(byId('rmContact').value, 'restar');
  for (const f of [...list].reverse()) { // en el orden en que se escanearon
    const it = S.findById(f.itemId);
    const r = S.applyMovement({ sku: it.sku, qty: f.qty, unit: f.unitIn, stockType: prefs.task, operation: 'restar', source: f.note, keepDisplay: true, serial: f.serial || undefined, contact });
    if (!r.ok) { toast(r.error, 'error'); return false; }
    Object.assign(f, { pending: false, entryId: r.entryId, before: r.before, after: r.after });
  }
  pr.entryIds = feedMoves('restar').reverse().map(m => m.entryId).filter(Boolean);
  pr.cart = false;
  return true;
}
function ensureRemito() {
  if (pendingRemito.created) return pendingRemito.created;
  const pr = pendingRemito, op = pr.kind === 'entrada' ? 'sumar' : 'restar';
  if (pr.cart && !commitCart(pr)) return null;
  // Venta/compra solo si hay precios activados y al menos un precio; si no, es un remito común.
  const sale = pr.priced && S.pricesOn() && pr.lines.some(l => l.price) ? { discount: pr.discount, payment: pr.payment } : null;
  const lines = pr.lines.map(({ stored, price, per, ...l }) => (sale ? { ...l, price, per } : l));
  const r = S.createRemito({ kind: pr.kind, contact: resolveContact(byId('rmContact').value, op), lines, note: byId('rmNote').value, entryIds: pr.entryIds, sale, currency: pr.cur, fx: pr.fx });
  if (!r.ok) { toast(r.error, 'error'); return null; }
  pr.created = r.remito;
  if (sale && canManage() && byId('rmSavePrices')?.checked && !byId('rmSavePricesWrap').hidden) {
    const field = pr.pk === 'compra' ? 'cost' : pr.cur !== S.currency() ? 'priceArs' : 'price';
    const n = S.setItemPrices(pr.lines.filter(l => l.price && l.price !== l.stored).map(l => ({ sku: l.sku, value: l.price, per: l.per })), field);
    if (n) toast(`${n} precio${n === 1 ? '' : 's'} guardado${n === 1 ? '' : 's'} en los productos`, 'info');
  }
  return r.remito;
}
// Guardar la venta (o terminar sin remito) sin mandar ni descargar el PDF.
function finishWithoutSending() {
  const pr = pendingRemito;
  if (!pr) return;
  const sale = pr.priced && S.pricesOn();
  if (!sale && pr.cart && !commitCart(pr)) return;
  const rem = sale ? ensureRemito() : pr.created;
  if (sale && !rem) return;
  if (pr.finish) endScanSession(rem);
  else if (rem) toast(`${S.remitoCode(rem)} guardado${rem.priced ? ` · ${remMoney(rem, rem.total)}` : ''}`);
  byId('remitoDialog').close();
}
// Anular una venta, compra o remito (solo dueño). Opcionalmente revierte también la mercadería.
async function voidSale(id) {
  if (!ownerOnly('anular ventas o remitos')) return;
  const r = state.extra.remitos.find(x => x.id === id);
  if (!r || r.voided) return;
  const live = (r.entryIds || []).map(eid => state.history.find(h => h.id === eid)).filter(h => h && !h.voided);
  const what = r.priced ? (r.kind === 'entrada' ? 'la compra' : 'la venta') : 'el remito';
  const choice = await ask({
    title: `¿Anular ${what} ${S.remitoCode(r)}?`,
    message: `${r.priced ? `Total ${remMoney(r, r.total)}. Deja de sumar en los reportes. ` : ''}No se borra: queda tachado con tu usuario y el motivo.`,
    choices: [
      ...(live.length ? [{ label: r.kind === 'entrada' ? `Anular y sacar la mercadería del stock (${live.length} lectura${live.length === 1 ? '' : 's'})` : `Anular y devolver la mercadería al stock (${live.length} lectura${live.length === 1 ? '' : 's'})`, value: 'stock', primary: true }] : []),
      { label: live.length ? 'Anular solo el comprobante (el stock no cambia)' : 'Anular', value: 'only', primary: !live.length },
    ],
    cancel: 'No anular',
  });
  if (!choice) return;
  const reason = txt(prompt('Motivo de la anulación (por ejemplo: devolución, error de carga):', r.kind === 'entrada' ? 'Error de carga' : 'Devolución'));
  if (!reason) return toast('Para anular hay que escribir el motivo.', 'warn');
  let failed = 0;
  if (choice === 'stock') for (const h of live) if (!S.fixMovement(h.id, { remove: true, reason: `${reason} (${S.remitoCode(r)})` }).ok) failed++;
  const res = S.voidRemito(id, reason);
  if (!res.ok) return toast(res.error, 'error');
  byId('remitoView').close();
  toast(failed ? `${S.remitoCode(r)} anulado. ${failed} lectura${failed === 1 ? '' : 's'} no se pudo revertir (stock insuficiente): corregila desde el Historial.` : `${S.remitoCode(r)} anulado${choice === 'stock' ? ' y stock corregido' : ''}`, failed ? 'warn' : 'success');
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
  const r = R.computeReport(state, { ...rp, prices: S.pricesOn() });
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
// Lista del mostrador: lo de esta venta (o salida/entrada) agrupado por producto, con importe y "Cambiar precio".
function renderKioskCart() {
  const live = liveFeed(), sk = saleKind(), cur = saleCur(sk || 'venta');
  byId('kCart').hidden = !live.length;
  byId('kiosk').classList.toggle('has-cart', live.length > 0);
  if (!live.length) { byId('kCartList').innerHTML = ''; return; }
  const groups = new Map();
  for (const f of live) { // la lista va de la última lectura a la primera
    const g = groups.get(f.itemId) || { f, units: 0 };
    g.units += f.amount;
    groups.set(f.itemId, g);
  }
  const name = scanMode().name;
  byId('kCartTitle').textContent = `Esta ${name}`;
  byId('kCartSub').innerHTML = cartPending().length ? `${icon('info', 'sm')}Todavía no se descontó nada: se descuenta al confirmar` : prefs.scanOp === 'restar' ? 'Ya descontado del stock' : prefs.scanOp === 'sumar' ? 'Ya sumado al stock' : 'Stock contado';
  byId('kCartList').innerHTML = [...groups.values()].map(({ f, units }) => {
    const it = S.findById(f.itemId), pr = sk ? linePrice(f, sk) : null, per = pr?.per || newPricePer(it);
    const qty = f.dz ? unitWords(units / 12, 'docenas') : unitWords(units, f.unit);
    const sug = sk === 'venta' && S.suggestedPrice(it);
    const edit = sk === 'venta' && feedPriceEdit === f.itemId
      ? `<span class="feed-price-edit"><input class="input money feed-price" data-feed-price="${esc(f.itemId)}" inputmode="decimal" value="${pr ? fmt(pr.price) : ''}" placeholder="${sug ? `Sugerido ${fmt(sug.price)}` : `${cur === 'USD' ? 'US$' : '$'} 0`}" aria-label="Precio de ${esc(f.sku)}"> <small>${S.PRICE_PER[per]}</small></span>${sug ? `<button type="button" class="link" data-use-suggest="${esc(f.itemId)}">Usar sugerido ${moneyIn(sug.price, cur)}</button>` : ''}`
      : sk === 'venta' ? `<button type="button" class="link feed-price-btn" data-price-edit="${esc(f.itemId)}">${icon('edit', 'sm')}Cambiar precio</button>` : '';
    return `<div class="kc-row">
      <div class="kc-info"><div><b class="mono">${esc(f.sku)}</b> <span>${esc(it ? productName(it) : f.name)}</span></div>
        <small>${esc(qty)}${pr ? ` · ${moneyIn(pr.price, cur)} ${S.PRICE_PER[per]}` : ''}${pr?.custom ? ' · <b class="warn">precio de esta venta</b>' : sk === 'venta' && it && priceNote(it, pr?.price) ? ` · ${esc(priceNote(it, pr?.price))}` : ''}</small>${edit}</div>
      <div class="kc-amt">${pr ? moneyIn(S.lineAmount(units, pr.price, pr.per), cur) : sk ? '<span class="warn">sin precio</span>' : ''}</div>
      <button type="button" class="icon-btn bordered" data-revert="${f.id}" title="Quitar una lectura" aria-label="Quitar una lectura de ${esc(f.sku)}">${icon('minus')}</button>
    </div>`;
  }).join('');
}
// Contadores del mostrador y botón "Terminar" (se comparten con Escanear).
function renderKiosk() {
  renderKioskCart();
  const live = liveFeed(), sq = sessionQty(live), m = scanMode();
  byId('kCount').textContent = fmt(live.length);
  byId('kUnits').textContent = fmt(sq.value);
  byId('kUnits').nextElementSibling.textContent = sq.label;
  byId('kUndo').disabled = !live.length;
  const verb = `Terminar ${m.name}`;
  byId('kRemito').disabled = byId('scanRemito').disabled = !live.length;
  byId('kFinishLabel').textContent = verb;
  const sm = sessionMoney();
  byId('kMoneyBox').hidden = !sm;
  if (sm) byId('kMoney').textContent = sessionMoneyText(sm);
  // Celular: barra fija con el total y el botón de terminar.
  byId('scanBar').hidden = !live.length;
  byId('scanBar').className = `scan-bar ${m.tone}`;
  byId('sbTotal').textContent = sm ? moneyIn(sm.total, sm.cur) : `${fmt(sq.value)} ${sq.label}`;
  byId('sbSub').textContent = `${fmt(live.length)} lectura${live.length === 1 ? '' : 's'}${sm?.usd ? ` · ${moneyIn(sm.usd, 'USD')}` : ''}${cartPending().length ? ' · sin confirmar' : ''}`;
  byId('sbLabel').textContent = verb;
  byId('scanSession').classList.toggle('is-empty', !live.length);
  byId('scanFinishLabel').textContent = live.length ? `${verb} (${fmt(live.length)} lectura${live.length === 1 ? '' : 's'} · ${sm ? moneyIn(sm.total, sm.cur) : `${fmt(sq.value)} ${sq.short}`})` : verb;
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
  const skus = new Set([sku, ...(item?.aliases || [])]);
  const all = state.history.filter(h => skus.has(h.sku));
  const rows = all.filter(h => kindMatches(h, pd.kind));
  const t = movementTotals(all);
  const lastIn = all.find(h => S.historyKind(h) === 'in'), lastOut = all.find(h => S.historyKind(h) === 'out');
  const d = item ? S.displayQty(item) : null;
  byId('pdTitle').textContent = `Movimientos de ${sku}`;
  byId('pdSub').textContent = item ? `${productName(item) || 'Sin marca ni prenda'}${item.aliases?.length ? ` · códigos anteriores: ${item.aliases.join(', ')}` : ''}` : 'Este producto ya no está en el inventario';
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
  S.importItems(pendingImport.rows, replace, replace ? pendingImport.history : null, replace ? pendingImport.extra : null);
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
  applyPricesUI();
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
  // Si cambió el ajuste de precios (p. ej. lo cambió el dueño en otro dispositivo), se actualizan los textos de Escanear.
  if (renderAll.prices !== S.pricesOn()) { renderAll.prices = S.pricesOn(); setScanOp(prefs.scanOp); }
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
  byId('formProduct').addEventListener('click', e => {
    if (e.target.closest('[data-edit-product]')) { const it = S.findByCode(F.sku.value); if (it) openEdit(it); }
    const use = e.target.closest('[data-use-sku]');
    if (use) { const from = upper(F.sku.value); useExistingCode(use.dataset.useSku); toast(`Usando ${use.dataset.useSku} en lugar de ${from}.`, 'success'); F.qty.focus(); }
  });
  byId('voiceAutoSave').onchange = e => { prefs.voiceAutoSave = e.target.checked; savePrefs(); };
  byId('voiceSpeak').onchange = e => { prefs.voiceSpeak = e.target.checked; savePrefs(); };
  byId('speakForm').onclick = speakForm;

  // Escanear
  // Un solo campo: la pistola (o un código exacto + Enter) agrega al instante; escribiendo aparecen sugerencias
  // y al elegir un producto se abre la fila de cantidad y precio.
  byId('scanForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = byId('scanInput').value;
    if (!txt(v)) return;
    if (maPick && maPick.sku === maCode(v)) { maAdd('escáner'); return; }
    const list = maMatches(v);
    if (S.resolveCode(maCode(v)) || !list.length) { byId('scanInput').value = ''; closeMa(); handleScan(v, 'escáner'); return; }
    if (list.length === 1) { maSelect(list[0]); return; }
    $('#maResults .ma-opt')?.focus();
  });
  byId('scanInput').addEventListener('input', renderMaResults);
  byId('scanInput').addEventListener('focus', renderMaResults);
  byId('scanInput').addEventListener('keydown', e => {
    const opts = $$('#maResults .ma-opt');
    if (e.key === 'ArrowDown' && opts.length) { e.preventDefault(); opts[0].focus(); }
    else if (e.key === 'Escape') { byId('scanInput').value = ''; closeMa(); }
  });
  byId('maClose').onclick = () => { byId('scanInput').value = ''; closeMa(); byId('scanInput').focus(); };
  byId('maResults').addEventListener('keydown', e => {
    const opts = $$('#maResults .ma-opt'), i = opts.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); opts[Math.min(i + 1, opts.length - 1)]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); (i <= 0 ? byId('scanInput') : opts[i - 1]).focus(); }
    if (e.key === 'Escape') { byId('maResults').hidden = true; byId('scanInput').focus(); }
  });
  byId('maResults').addEventListener('click', e => { const b = e.target.closest('[data-ma]'); if (b) maSelect(S.findById(b.dataset.ma)); });
  byId('scanForm').addEventListener('focusout', () => setTimeout(() => { if (!byId('scanForm').contains(document.activeElement)) byId('maResults').hidden = true; }, 120));
  ['maQty', 'maUnit', 'maPrice'].forEach(id => byId(id).addEventListener('input', renderMaHint));
  byId('maPrice').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); maAdd(); } });
  byId('maSuggest').addEventListener('click', e => { if (!e.target.closest('[data-ma-suggest]')) return; const s = maPick && S.suggestedPrice(maPick); if (s) { byId('maPrice').value = fmt(s.price); renderMaHint(); byId('maPrice').focus(); } });
  byId('maUnit').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); maAdd(); } });
  byId('maQty').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); maAdd(); } });
  byId('maAdd').onclick = maAdd;
  // Consultar precio
  byId('plInput').addEventListener('input', debounce(renderPriceLookup, 120));
  byId('plForm').addEventListener('submit', e => { e.preventDefault(); renderPriceLookup(); byId('plInput').select(); });
  byId('plCamera').onclick = () => openCamera({ onCode: c => priceLookup(c) });
  byId('scanInput').addEventListener('focus', setScanReady);
  byId('scanInput').addEventListener('blur', setScanReady);
  onSegment(byId('scanOpSeg'), chooseScanOp);
  byId('scanQty').addEventListener('input', () => { prefs.scanQty = num(byId('scanQty').value) || 1; savePrefs(); });
  byId('scanUnknown').onchange = e => { prefs.scanUnknown = e.target.value; savePrefs(); };
  byId('scanSound').onchange = e => { prefs.sound = e.target.checked; savePrefs(); };
  byId('scanSale').onchange = e => setSale(e.target.checked);
  byId('kSale').onchange = e => setSale(e.target.checked);
  byId('scanCamera').onclick = () => openCamera({ continuous: true, onCode: c => handleScan(c, 'cámara') });
  byId('scanNewSession').onclick = async () => {
    const n = cartPending().length;
    if (n && !(await ask({ title: '¿Descartar la venta sin confirmar?', message: `Hay ${n} lectura${n === 1 ? '' : 's'} en la venta. Todavía no se descontó nada del stock.`, confirm: 'Descartar', danger: true }))) return;
    resetSession();
    toast(n ? 'Venta descartada: no se descontó nada.' : 'Lista vacía. Lo escaneado antes ya quedó guardado en el stock.', 'info');
    focusScan();
  };
  // Una venta sin confirmar se pierde si se cierra la app: el navegador avisa antes.
  addEventListener('beforeunload', e => { if (cartPending().length) { e.preventDefault(); e.returnValue = ''; } });
  // Precio solo para esta venta
  const savePriceEdit = el => {
    const id = el.dataset.feedPrice, v = parseMoney(el.value), it = S.findById(id), cur = linePrice({ itemId: id }, 'venta');
    if (txt(el.value) && v == null) { toast('Escribí el precio como número, por ejemplo 120000 o 120.000.', 'error'); return; }
    feedPriceEdit = null;
    const how = v != null && v !== cur?.price ? setSaleItemPrice(it, v) : 'same';
    renderScanSession();
    priceSavedToast(it, how);
    if (currentView === 'kiosco') byId('kInput').focus({ preventScroll: true }); // lista para la próxima lectura
  };
  // La lista de Escanear y la del mostrador tienen las mismas acciones.
  for (const list of [byId('scanFeed'), byId('kCartList')]) {
    list.addEventListener('keydown', e => {
      const el = e.target.closest('[data-feed-price]');
      if (!el) return;
      if (e.key === 'Enter') { e.preventDefault(); savePriceEdit(el); }
      if (e.key === 'Escape') { feedPriceEdit = null; renderScanSession(); }
    });
    list.addEventListener('focusout', e => { const el = e.target.closest('[data-feed-price]'); if (el && feedPriceEdit) savePriceEdit(el); });
    list.addEventListener('click', e => {
      const pe = e.target.closest('[data-price-edit]');
      if (pe) {
        feedPriceEdit = pe.dataset.priceEdit;
        renderScanSession();
        const el = list.querySelector(`[data-feed-price="${CSS.escape(feedPriceEdit)}"]`);
        el?.focus(); el?.select();
        return;
      }
      const us = e.target.closest('[data-use-suggest]');
      if (us) { const it = S.findById(us.dataset.useSuggest); feedPriceEdit = null; const how = setSaleItemPrice(it, null); renderScanSession(); priceSavedToast(it, how === 'same' ? 'suggested' : how); return; }
      if (e.target.closest('[data-feed-price]')) return;
      const b = e.target.closest('[data-revert]');
      if (b) { revertScan(b.dataset.revert); if (list.id === 'kCartList') byId('kInput').focus({ preventScroll: true }); return; }
      const row = e.target.closest('[data-move]');
      if (row) openMove(row.dataset.move);
    });
  }
  byId('scanHero').addEventListener('click', e => { if (!e.target.closest('button, input')) focusScan(); });
  // Precio de la última lectura
  byId('scanLast').addEventListener('click', e => {
    if (e.target.closest('[data-sl-edit]')) { slEditing = true; renderLastPrice(); }
    else if (e.target.closest('[data-sl-save]')) saveLastPrice();
    else if (e.target.closest('[data-sl-suggest]')) saveLastPrice(true);
    else if (e.target.closest('[data-sl-cancel]')) { slEditing = false; renderLastPrice(); focusScan(); }
  });
  byId('scanLast').addEventListener('keydown', e => {
    if (e.target.id !== 'slPriceInput') return;
    if (e.key === 'Enter') { e.preventDefault(); saveLastPrice(); }
    if (e.key === 'Escape') { slEditing = false; renderLastPrice(); focusScan(); }
  });

  // Inventario
  byId('invSearch').addEventListener('input', debounce(e => { inv.q = e.target.value; inv.limit = 150; renderInventory(); }, 120));
  byId('invSort').onchange = e => { inv.sort = e.target.value; renderInventory(); };
  byId('invFilters').addEventListener('click', e => { const c = e.target.closest('[data-f]'); if (c) { setInvFilter(c.dataset.f); inv.limit = 150; renderInventory(); } });
  byId('invList').addEventListener('click', onInventoryClick);
  byId('bulkClear').onclick = () => { inv.selected.clear(); renderInventory(); };
  byId('bulkLabels').onclick = () => labelsFor([...inv.selected]);
  byId('bulkEdit').onclick = openBulkEdit;
  byId('bulkDelete').onclick = bulkDelete;
  byId('bulkMerge').onclick = () => openMerge([...inv.selected]);
  byId('invDups').onclick = openDuplicates;
  byId('dupBody').addEventListener('click', e => { const b = e.target.closest('[data-merge]'); if (b) { byId('dupDialog').close(); openMerge(b.dataset.merge.split(','), true); } });
  byId('mergeBody').addEventListener('change', e => { if (e.target.name === 'mergeKeep') { merge.keep = e.target.value; renderMerge(); } });
  byId('mergeBody').addEventListener('click', e => { const b = e.target.closest('[data-merge-drop]'); if (b) { e.preventDefault(); merge.ids = merge.ids.filter(id => id !== b.dataset.mergeDrop); renderMerge(); } });
  byId('mergeForm').addEventListener('submit', saveMerge);
  document.addEventListener('click', e => { if (e.target.closest('[data-cost-import]')) openCostImport(); });
  byId('costBody').addEventListener('change', onCostBody);
  byId('costBody').addEventListener('click', e => { const c = e.target.closest('[data-cost-currency]'); if (c) { e.preventDefault(); changeCurrency(c.dataset.costCurrency).then(() => costImp && renderCostImport()); } });
  byId('costForm').addEventListener('submit', saveCostImport);
  byId('setMarginBtn').onclick = applyMargin;
  byId('setMargin').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); applyMargin(); } });
  byId('setCurrency').onchange = e => changeCurrency(e.target.value).then(() => refreshFx());
  byId('arsRound').onchange = e => { if (ownerOnly('cambiar el redondeo')) S.setArsSettings({ arsRound: e.target.value }); else renderArsSettings(); };
  byId('fxFixed').addEventListener('change', e => {
    if (!ownerOnly('fijar la cotización')) { renderArsSettings(); return; }
    const v = txt(e.target.value) ? parseMoney(e.target.value) : null;
    if (txt(e.target.value) && !v) { toast('Escribí la cotización como número, por ejemplo 1565.', 'error'); return; }
    S.setArsSettings({ fxFixed: v });
    toast(v ? `Cotización fija: ${moneyIn(v, 'ARS')} por dólar.` : 'Se vuelve a usar el dólar blue automático.', 'info');
  });
  byId('fxRefresh').onclick = () => refreshFx(false);
  byId('fxChip').onclick = () => refreshFx(false);
  // Cotización: al abrir, cada 30 minutos y al volver a la app.
  if (fxStale()) refreshFx();
  setInterval(() => { if (fxStale()) refreshFx(); }, 5 * 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && fxStale()) refreshFx(); });
  byId('eMargin').addEventListener('click', e => {
    if (e.target.closest('[data-ars-suggest]')) { e.preventDefault(); byId('ePriceArs').value = ''; editPrice = { touched: false, auto: true }; renderMargin(); return; }
    if (!e.target.closest('[data-price-auto]')) return;
    e.preventDefault();
    editPrice = { touched: false, auto: true };
    renderMargin();
  });
  byId('bulkField').onchange = renderBulkValue;
  byId('bulkForm').addEventListener('submit', applyBulk);
  byId('editForm').addEventListener('submit', saveEdit);
  ['ePrice', 'eCost', 'ePer', 'ePriceArs'].forEach(id => byId(id).addEventListener('input', renderMargin));
  byId('eDelete').onclick = deleteEditing;
  byId('eLabel').onclick = () => { byId('editDialog').close(); labelsFor([editingId]); };
  byId('eBarcodeCam').onclick = () => openCamera({ onCode: c => { byId('eBarcode').value = upper(c); } });

  // Etiquetas
  onSegment(byId('lblKind'), v => { prefs.lblKind = v; savePrefs(); segmented(byId('lblKind'), v); renderLabelPreview(); });
  byId('lblSize').onchange = e => { prefs.lblSize = e.target.value; savePrefs(); renderLabelPreview(); };
  byId('lblCopies').addEventListener('input', e => { prefs.lblCopies = Math.max(1, Math.floor(num(e.target.value)) || 1); savePrefs(); syncLblChips(); renderLabelPreview(); });
  byId('lblHeader').addEventListener('input', e => { prefs.lblHeader = e.target.value; savePrefs(); renderLabelPreview(); });
  byId('lblShowName').onchange = e => { prefs.lblShowName = e.target.checked; savePrefs(); renderLabelPreview(); };
  byId('lblShowPrice').onchange = e => { prefs.lblShowPrice = e.target.checked; savePrefs(); renderLabelPreview(); };
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
    if (!e.target?.closest) return; // eventos del documento (sin elemento): nada que abrir
    const fixBtn = e.target.closest('[data-fix]');
    if (fixBtn) { if (e.type === 'click') { e.stopPropagation(); openFix(fixBtn.dataset.fix); } return; }
    const link = e.target.closest('[data-open-product]');
    if (link) { e.preventDefault(); openProductHistory(link.dataset.openProduct); return; }
    const day = e.target.closest('[data-hsel-day]');
    if (day && e.type === 'click') {
      const rows = filteredHistory().filter(h => new Date(h.at).toDateString() === day.dataset.hselDay);
      const all = rows.every(h => hist.selected.has(h.id));
      rows.forEach(h => (all ? hist.selected.delete(h.id) : hist.selected.add(h.id)));
      renderHistory();
      return;
    }
    const row = e.target.closest('.tl-item[data-move]');
    if (!row) return;
    if (hist.select && row.closest('#histList')) {
      if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      toggleHistRow(row);
      return;
    }
    if (e.type === 'keydown' && e.key !== 'Enter') return;
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
    const it = S.findByCode(pd.sku), skus = new Set([it?.sku || pd.sku, ...(it?.aliases || [])]);
    const rows = state.history.filter(h => skus.has(h.sku));
    if (!IO.exportHistoryCSV(rows, `StockVoz_movimientos_${pd.sku}_${new Date().toLocaleDateString('sv-SE')}.csv`)) toast('Este código no tiene movimientos.', 'warn');
  };
  byId('pdEdit').onclick = () => { const it = S.findByCode(pd.sku); if (it) { byId('productDialog').close(); openEdit(it); } };
  byId('pdLabels').onclick = () => { const it = S.findByCode(pd.sku); if (it) { byId('productDialog').close(); labelsFor([it.id]); } };
  byId('histFilters').addEventListener('click', e => { const c = e.target.closest('[data-k]'); if (c) { hist.kind = c.dataset.k; hist.limit = 100; renderHistory(); } });
  byId('histMore').onclick = () => { hist.limit += 100; renderHistory(); };
  byId('histSelect').onclick = () => setHistSelect(!hist.select);
  byId('histBulkClose').onclick = () => setHistSelect(false);
  byId('histBulkAll').onclick = () => {
    const rows = filteredHistory(), all = rows.every(h => hist.selected.has(h.id));
    rows.forEach(h => (all ? hist.selected.delete(h.id) : hist.selected.add(h.id)));
    renderHistory();
  };
  byId('histBulkDelete').onclick = openHistBulk;
  onSegment(byId('hbMode'), v => { if (!byId('hbMode').querySelector(`[data-v="${v}"]`).disabled) setHbMode(v); });
  byId('hbReasons').addEventListener('click', e => {
    const c = e.target.closest('.chip');
    if (!c) return;
    byId('hbReason').value = c.textContent;
    $$('#hbReasons .chip').forEach(x => x.classList.toggle('active', x === c));
    byId('hbReason').classList.remove('has-error'); byId('hbError').hidden = true;
  });
  byId('hbReason').addEventListener('input', () => {
    byId('hbReason').classList.remove('has-error'); byId('hbError').hidden = true;
    $$('#hbReasons .chip').forEach(x => x.classList.toggle('active', x.textContent === byId('hbReason').value));
  });
  byId('hbForm').addEventListener('submit', saveHistBulk);
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
  byId('mvBody').addEventListener('click', e => {
    const l = e.target.closest('[data-goto-move]');
    if (l) { e.preventDefault(); openMove(l.dataset.gotoMove); return; }
    const rm = e.target.closest('[data-open-remito]');
    if (rm) { e.preventDefault(); byId('moveDialog').close(); setTimeout(() => openRemitoView(rm.dataset.openRemito), 150); }
  });
  byId('ctRemitosSub').addEventListener('click', e => { if (e.target.closest('[data-ct-all]')) { e.preventDefault(); ct.filter = null; renderContacts(); } });
  // Remitos
  byId('scanRemito').onclick = finishScan;
  byId('sbFinish').onclick = () => finishScan();
  // Celular: las opciones de Escanear empiezan plegadas.
  if (matchMedia('(max-width: 960px)').matches) byId('scanOptions').open = false;
  byId('kRemito').onclick = finishScan;
  byId('rmFinish').onclick = finishWithoutSending;
  byId('rmPriced').onchange = e => { pendingRemito.priced = e.target.checked; renderRemitoLines(); };
  byId('rmLines').addEventListener('input', e => {
    const inp = e.target.closest('.rm-price');
    if (!inp || pendingRemito.created) return;
    pendingRemito.lines[Number(inp.dataset.line)].price = parseMoney(inp.value);
    inp.classList.toggle('has-error', !parseMoney(inp.value));
    updateRemitoTotals();
  });
  byId('rmTotals').addEventListener('input', e => {
    if (pendingRemito.created) return;
    if (e.target.id === 'rmDiscount') pendingRemito.discount = Math.min(100, Math.max(0, num(e.target.value)));
    if (e.target.id === 'rmPayment') pendingRemito.payment = e.target.value;
    updateRemitoTotals();
  });
  byId('rvVoid').onclick = () => voidSale(viewingRemito);
  // Si el remito ya se numeró (p. ej. se canceló el envío) y se cierra el diálogo, la salida queda terminada.
  byId('remitoDialog').addEventListener('close', () => { if (pendingRemito?.finish && pendingRemito.created) endScanSession(pendingRemito.created); });
  byId('remitoForm').addEventListener('submit', e => sendRemito(e, 'wa'));
  byId('rmDownload').onclick = e => sendRemito(e, 'download');
  // Reportes
  onSegment(byId('rpPeriod'), v => { rp.days = Number(v); renderReports(); });
  byId('rpUser').onchange = e => { rp.user = e.target.value; renderReports(); };
  byId('rpExportSales').onclick = () => { if (!IO.exportSalesCSV(R.periodRemitos(state.extra.remitos, rp))) toast('No hay ventas ni compras con precio en el período.', 'warn'); };
  byId('rpExport').onclick = () => { const rows = R.periodRows(state.history, rp); if (!IO.exportHistoryCSV(rows, `StockVoz_movimientos_${rp.days || 'todo'}dias.csv`)) toast('No hay movimientos en el período.', 'warn'); };
  R.bindChart(byId('rpBody'));
  // Modo mostrador
  onSegment(byId('kOp'), chooseScanOp);
  byId('kForm').addEventListener('submit', e => { e.preventDefault(); const v = byId('kInput').value; byId('kInput').value = ''; handleScan(v, 'mostrador'); });
  byId('kExit').onclick = () => { location.hash = '#/escanear'; };
  byId('kUndo').onclick = () => { const last = session.feed.find(f => !f.undone); if (last) revertScan(last.id); byId('kInput').focus(); };
  byId('kiosk').addEventListener('click', e => { if (!e.target.closest('button, input, a, .segmented')) byId('kInput').focus(); });
  // Precios y ventas (ajuste del negocio)
  byId('pricesOn').onchange = async e => {
    if (!ownerOnly('activar o desactivar los precios')) { e.target.checked = S.pricesOn(); return; }
    // Una venta sin confirmar no puede quedar a medias: apagando los precios se descarta (no se descontó nada).
    const n = cartPending().length;
    if (!e.target.checked && n) {
      const ok = await ask({ title: 'Tenés una venta sin confirmar', message: `Hay ${n} lectura${n === 1 ? '' : 's'} en la venta (todavía no se descontó nada del stock). Si apagás los precios, la venta se descarta.`, confirm: 'Apagar y descartar la venta', cancel: 'Dejar los precios', danger: true });
      if (!ok) { e.target.checked = true; return; }
      resetSession();
    }
    S.setPricesEnabled(e.target.checked);
    toast(e.target.checked ? 'Precios y ventas activados. Cargá precios en Inventario y usá "Es una venta" al escanear salidas.' : 'Precios ocultos. Los que cargaste quedan guardados por si los volvés a activar.', 'info');
  };
  // Importes: al salir del campo se muestran con separador de miles (12.500).
  document.addEventListener('focusout', e => {
    if (!e.target.matches?.('input.money')) return;
    const v = parseMoney(e.target.value);
    if (txt(e.target.value) && v != null) e.target.value = fmt(v);
  });
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
  applyPricesUI();
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
  byId('lblShowPrice').checked = prefs.lblShowPrice;
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
  initHardwareScanner(code => (currentView === 'precios' ? priceLookup(code) : handleScan(code, 'pistola')));

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
