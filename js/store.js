// Estado del inventario: productos, historial, persistencia local y deshacer.
// Todas las modificaciones pasan por este módulo y notifican a la interfaz y a la sincronización.
import { uid, nowIso, txt, upper, num, round2, fmt } from './utils.js';
import { CONFIG } from './config.js';

const KEY = 'stockvoz_v5_state'; // misma clave que v5: los datos existentes se conservan
const OLD_KEYS = ['stockData_v26', 'stockvoz_data_v4'];
const HISTORY_MAX = 2000;
const UNDO_MAX = 30;

export const STOCK_TYPES = {
  inventario: 'Inventario general', entrada: 'Entrada de mercadería', salida: 'Salida de mercadería', local: 'Stock de local',
  deposito: 'Stock de depósito', produccion: 'Producción', transferencia: 'Transferencia', ajuste: 'Ajuste de stock', otro: 'Otro',
};
// Unidad en la que se guarda el stock de cada producto.
export const STOCK_UNITS = { unidades: 'unidades', cajas: 'cajas', paquetes: 'paquetes', pares: 'pares', rollos: 'rollos', kg: 'kg', g: 'g', m: 'm', l: 'L', otra: 'otra unidad' };
export const STOCK_UNIT_NAMES = { unidades: 'Unidades', cajas: 'Cajas', paquetes: 'Paquetes', pares: 'Pares', rollos: 'Rollos', kg: 'Kilogramos (kg)', g: 'Gramos (g)', m: 'Metros (m)', l: 'Litros (L)', otra: 'Otra unidad' };
// Unidad en la que se carga una cantidad y cómo se convierte al stock (las docenas se guardan como unidades).
export const INPUT_UNITS = {
  unit: { label: 'Unidades', short: 'unidades', stock: 'unidades', factor: 1 },
  dozen: { label: 'Docenas (× 12)', short: 'docenas', stock: 'unidades', factor: 12 },
  box: { label: 'Cajas', short: 'cajas', stock: 'cajas', factor: 1 },
  package: { label: 'Paquetes', short: 'paquetes', stock: 'paquetes', factor: 1 },
  pair: { label: 'Pares', short: 'pares', stock: 'pares', factor: 1 },
  roll: { label: 'Rollos', short: 'rollos', stock: 'rollos', factor: 1 },
  kg: { label: 'Kilogramos (kg)', short: 'kg', stock: 'kg', factor: 1 },
  g: { label: 'Gramos (g)', short: 'g', stock: 'g', factor: 1 },
  m: { label: 'Metros (m)', short: 'm', stock: 'm', factor: 1 },
  l: { label: 'Litros (L)', short: 'L', stock: 'l', factor: 1 },
  other: { label: 'Otra unidad', short: 'otra unidad', stock: 'otra', factor: 1 },
};
export const OPERATIONS = { sumar: 'Ingreso', restar: 'Salida', establecer: 'Conteo físico' };

export const stockTypeLabel = v => STOCK_TYPES[v] || STOCK_TYPES.inventario;
export const unitLabel = v => STOCK_UNITS[v] || v || 'unidades';
export const inputUnit = v => INPUT_UNITS[v] || INPUT_UNITS.unit;
// Unidad de carga recomendada para un producto existente.
export function inputUnitFor(item) {
  if (!item) return 'unit';
  if (item.unitName === 'unidades') return item.displayUnit === 'dozen' ? 'dozen' : 'unit';
  return Object.keys(INPUT_UNITS).find(k => INPUT_UNITS[k].stock === item.unitName) || 'unit';
}

export const state = {
  items: [], history: [], lastBackupAt: null, version: 60,
  // pending: movimientos hechos en este dispositivo que todavía no llegaron a la nube (para combinar con otros usuarios).
  // removed: movimientos borrados acá que la nube todavía tiene (para que no vuelvan al combinar).
  cloud: { owner: null, rev: 0, dirty: false, lastSyncAt: null, pending: [], removed: [] },
  // Datos del negocio que se sincronizan: clientes/proveedores, remitos y ajustes (p. ej. usar precios).
  extra: { contacts: [], remitos: [], remitoSeq: 0, settings: {} },
};
const EXTRA_DEFAULT = () => ({ contacts: [], remitos: [], remitoSeq: 0, settings: {} });
const REMITOS_MAX = 500;
export function normalizeExtra(x) {
  const e = { ...EXTRA_DEFAULT(), ...(x && typeof x === 'object' ? x : {}) };
  e.contacts = Array.isArray(e.contacts) ? e.contacts.filter(c => c && c.id) : [];
  e.remitos = Array.isArray(e.remitos) ? e.remitos.filter(r => r && r.id) : [];
  e.remitoSeq = Math.max(0, Math.floor(num(e.remitoSeq)), ...e.remitos.map(r => num(r.number)));
  e.settings = e.settings && typeof e.settings === 'object' ? e.settings : {};
  return e;
}

// ---------- Precios (todo opcional: la app funciona igual sin cargar ningún precio) ----------
// Cada producto puede tener precio de venta y de costo, por unidad o por docena.
export const PRICE_PER = { unit: 'c/u', dozen: 'c/docena' };
export const PAYMENTS = { efectivo: 'Efectivo', transferencia: 'Transferencia', debito: 'Tarjeta de débito', credito: 'Tarjeta de crédito', mercadopago: 'Mercado Pago', cuenta: 'Cuenta corriente', otro: 'Otro' };
export const cleanPrice = v => { const n = Number(v); return v !== null && v !== '' && Number.isFinite(n) && n > 0 ? round2(n) : null; };
export const pricePerOf = i => (i?.pricePer === 'dozen' && i.unitName === 'unidades' ? 'dozen' : 'unit');
export const perFactor = per => (per === 'dozen' ? 12 : 1);
// Importe de una cantidad (en unidades de stock) a un precio por unidad o por docena.
export const lineAmount = (units, price, per = 'unit') => round2((num(units) / perFactor(per)) * num(price));
// Precio de venta (para salidas) o de costo (para entradas) de un producto; null si no tiene.
export function priceFor(item, kind = 'venta') {
  const v = kind === 'compra' ? item?.cost : item?.price;
  return v > 0 ? { price: v, per: pricePerOf(item) } : null;
}
// Ajuste del negocio (lo decide el dueño y se sincroniza con el equipo).
export const pricesOn = () => !!state.extra.settings?.prices;
const saveSettings = patch => { state.extra.settings = { ...state.extra.settings, ...patch, updatedAt: nowIso() }; };
export function setPricesEnabled(on) {
  saveSettings({ prices: !!on });
  commit('settings');
}

// Moneda en que se muestran los precios. Cambiarla no convierte los importes ya cargados.
export const CURRENCIES = { ARS: 'Pesos ($)', USD: 'Dólares (US$)' };
export const currency = () => (state.extra.settings?.currency === 'USD' ? 'USD' : 'ARS');
const currencySign = () => (currency() === 'USD' ? 'US$' : '$');
// ars: además cobrar en pesos con el dólar blue (solo con precios en dólares).
export function setCurrency(c, ars = state.extra.settings?.ars) {
  saveSettings({ currency: c === 'USD' ? 'USD' : 'ARS', ars: c === 'USD' && !!ars });
  refreshAutoPrices(); // en pesos se redondea a pesos enteros y en dólares a centavos
  commit('settings');
}

// ---------- Cobro en pesos con dólar blue ----------
// Con los precios en dólares se puede cobrar en pesos: el precio en pesos es el de dólares por la cotización del
// blue (venta), redondeado, o un precio fijo en pesos escrito a mano. La cotización se consulta en cada dispositivo
// (no se sincroniza); la dueña puede fijar una a mano, y cada venta guarda la que usó.
export const ARS_ROUNDING = { 0: 'Sin redondear', 10: 'A $ 10', 100: 'A $ 100', 500: 'A $ 500', 1000: 'A $ 1.000' };
export const chargeArs = () => currency() === 'USD' && !!state.extra.settings?.ars;
export const arsRound = () => { const r = state.extra.settings?.arsRound; return ARS_ROUNDING[r] !== undefined ? Number(r) : 100; };
export const fxFixed = () => { const v = Number(state.extra.settings?.fxFixed); return v > 0 ? v : null; };
const FX_KEY = 'stockvoz_fx';
let fxLive = (() => { try { const v = JSON.parse(localStorage.getItem(FX_KEY)); return v?.rate > 0 ? v : null; } catch { return null; } })();
export const fxLiveInfo = () => fxLive;
export const fxRate = () => fxFixed() || fxLive?.rate || null;
// Datos de la cotización que se usa ahora: { rate, source, at, fixed }.
export const fxNow = () => (fxFixed() ? { rate: fxFixed(), source: 'cotización fija', fixed: true } : fxLive ? { rate: fxLive.rate, source: `dólar blue · ${fxLive.source}`, at: fxLive.fetchedAt || fxLive.at } : null);
export function setLiveFx(fx) {
  if (!(fx?.rate > 0)) return;
  fxLive = fx;
  try { localStorage.setItem(FX_KEY, JSON.stringify(fx)); } catch { /* sin almacenamiento */ }
  listeners.forEach(fn => fn('fx'));
}
export function setArsSettings(patch) {
  const p = {};
  if ('ars' in patch) p.ars = !!patch.ars;
  if ('arsRound' in patch) p.arsRound = ARS_ROUNDING[patch.arsRound] !== undefined ? Number(patch.arsRound) : 100;
  if ('fxFixed' in patch) p.fxFixed = Number(patch.fxFixed) > 0 ? round2(Number(patch.fxFixed)) : null;
  saveSettings(p);
  commit('settings');
}
export const roundArs = n => { const r = arsRound(); return r > 0 ? Math.max(r, Math.round(n / r) * r) : Math.round(n); };
// Precio de venta en pesos: { price, per, fixed }. Fijo si se escribió en pesos; si no, dólares × cotización.
export function arsPriceFor(item) {
  if (!chargeArs() || !item) return null;
  const per = pricePerOf(item);
  if (item.priceArs > 0) return { price: item.priceArs, per, fixed: true };
  const rate = fxRate();
  return item.price > 0 && rate ? { price: roundArs(item.price * rate), per, fixed: false } : null;
}
// Comprobantes: moneda en que se cobró (los anteriores a esta versión están en pesos) y conversión para reportes.
export const remitoCurrency = r => (r?.currency === 'USD' ? 'USD' : 'ARS');
export const reportCurrency = () => (chargeArs() ? 'ARS' : currency());
export function convert(n, from, to, rate = fxRate()) {
  if (from === to) return Number(n) || 0;
  if (!(rate > 0)) return null;
  return round2(from === 'USD' ? n * rate : n / rate);
}

// Margen general: el precio de venta es el costo más un porcentaje, salvo en los productos con precio a mano.
export const marginPct = () => { const m = state.extra.settings?.margin; return typeof m === 'number' && m >= 0 ? m : null; };
export function autoPrice(i, cost = i?.cost) {
  const m = marginPct();
  if (m == null || !(cost > 0)) return null;
  const p = cost * (1 + m / 100);
  return currency() === 'ARS' ? Math.round(p) : round2(p);
}
// Recalcula el precio de venta de los productos que siguen el margen general. Devuelve cuántos cambiaron.
function refreshAutoPrices(items = state.items) {
  let n = 0;
  for (const i of items) {
    if (i.priceManual) continue;
    const a = autoPrice(i);
    if (a && a !== i.price) { i.price = a; n++; }
  }
  return n;
}
const isManual = i => (i.priceManual && i.cost > 0) || i.priceArs > 0;
export const manualPriceCount = () => state.items.filter(isManual).length;
// overrideManual: también pisa los precios escritos a mano (vuelven a seguir el margen).
export function setMargin(pct, { overrideManual = false } = {}) {
  const m = pct === null || pct === '' ? null : Number(pct);
  if (m !== null && (!Number.isFinite(m) || m < 0 || m > 1000)) return fail('La ganancia tiene que ser un número entre 0 y 1000 %.');
  checkpoint();
  saveSettings({ margin: m });
  const freed = overrideManual && m !== null ? state.items.filter(isManual) : [];
  freed.forEach(i => { delete i.priceManual; delete i.priceArs; });
  const changed = m === null ? 0 : refreshAutoPrices();
  if (freed.length) log('edit', 'Ganancia general', null, { note: `Ganancia ${fmt(m)} % aplicada también a ${freed.length} precio${freed.length === 1 ? '' : 's'} escrito${freed.length === 1 ? '' : 's'} a mano`, prices: Object.fromEntries(freed.map(i => [i.sku, { priceManual: false, priceArs: null, price: i.price }])) });
  commit('settings');
  return { ok: true, changed };
}

// Aplica a un producto los cambios de precio guardados en un movimiento (importación de costos, ganancia general).
function applyPricePatch(i, p) {
  for (const k of ['cost', 'price', 'priceArs']) if (k in p) { if (cleanPrice(p[k])) i[k] = cleanPrice(p[k]); else delete i[k]; }
  if ('pricePer' in p) { if (p.pricePer === 'dozen' && i.unitName === 'unidades') i.pricePer = 'dozen'; else delete i.pricePer; }
  if ('priceManual' in p) { if (p.priceManual) i.priceManual = true; else delete i.priceManual; }
}
// Costo de un archivo llevado a la unidad de precio del producto. filePer: 'dozen' | 'unit'.
// Si el producto tiene un precio de venta a mano por unidad, el costo se pasa a unidad para no mezclar.
export function costFor(item, cost, filePer = 'dozen') {
  const from = filePer === 'dozen' && item.unitName === 'unidades' ? 'dozen' : 'unit';
  const per = item.priceManual && item.price ? pricePerOf(item) : from;
  return { cost: round2((cost / perFactor(from)) * perFactor(per)), per };
}
// Carga costos de muchos productos a la vez (archivo de tandas, Excel). changes: [{ id, cost, per }].
// Queda un solo registro en el historial con todos los cambios, para no tapar los movimientos de mercadería.
export function importCosts(changes, label = 'archivo') {
  const valid = changes.map(c => ({ item: findById(c.id), cost: cleanPrice(c.cost), per: c.per })).filter(c => c.item && c.cost);
  if (!valid.length) return fail('No hay costos para cargar.');
  checkpoint();
  const patch = {};
  let priced = 0;
  for (const { item, cost, per } of valid) {
    const c = costFor(item, cost, per), p = { cost: c.cost, pricePer: c.per };
    applyPricePatch(item, p);
    const a = !item.priceManual && autoPrice(item);
    if (a) { item.price = a; p.price = a; priced++; }
    item.updatedAt = nowIso();
    patch[item.sku] = p;
  }
  log('edit', 'Importación de costos', null, { note: `Costos de ${valid.length} productos desde ${label}${priced ? ` · ${priced} precios de venta con la ganancia general` : ''}`, prices: patch });
  commit('costs');
  return { ok: true, count: valid.length, priced };
}

// Quién está usando la app (se guarda en cada movimiento). Vacío en modo local.
let actor = '';
export const setActor = name => { actor = name || ''; };

// ---------- Suscripción a cambios ----------
const listeners = new Set();
export const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };
let storageError = false;
export const hasStorageError = () => storageError;

export function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); storageError = false; return true; }
  catch { storageError = true; return false; }
}
// Guarda y avisa. sync=false se usa cuando los datos vienen de la nube (no hay que volver a subirlos).
export function commit(reason, { sync = true } = {}) {
  if (sync) state.cloud.dirty = true;
  persist();
  listeners.forEach(fn => fn(reason));
}

// ---------- Deshacer ----------
const undoStack = [];
function checkpoint() {
  undoStack.push(JSON.stringify({ items: state.items, history: state.history, extra: state.extra, removed: state.cloud.removed }));
  if (undoStack.length > UNDO_MAX) undoStack.shift();
}
export const canUndo = () => undoStack.length > 0;
// Después de sincronizar, deshacer ya no es seguro (otros pueden haber usado esos datos): se usa "Corregir".
export const clearUndo = () => { undoStack.length = 0; };
export function undo() {
  const s = undoStack.pop();
  if (!s) return false;
  const x = JSON.parse(s);
  state.items = x.items; state.history = x.history;
  if (x.extra) state.extra = x.extra;
  if (x.removed) state.cloud.removed = x.removed;
  commit('undo');
  return true;
}

// ---------- Normalización / carga ----------
const cleanText = v => { const s = upper(v); return s === '-' ? '' : s; };
export function normalizeItem(i) {
  return {
    id: i.id || uid(),
    sku: upper(i.sku ?? i.code),
    barcode: upper(i.barcode),
    brand: cleanText(i.brand),
    type: cleanText(i.type),
    stockType: STOCK_TYPES[i.stockType] ? i.stockType : 'inventario',
    unitName: STOCK_UNITS[i.unitName] ? i.unitName : 'unidades',
    displayUnit: INPUT_UNITS[i.displayUnit] ? i.displayUnit : 'unit',
    units: Math.max(0, round2(num(i.units ?? i.totalUnits))),
    minStock: Math.max(0, num(i.minStock)),
    serials: { D: Math.max(0, Math.floor(num(i.serials?.D))), U: Math.max(0, Math.floor(num(i.serials?.U))) },
    // Códigos de productos duplicados que se unieron a este: escanearlos o escribirlos lleva a este producto.
    ...(Array.isArray(i.aliases) && i.aliases.length ? { aliases: [...new Set(i.aliases.map(upper).filter(Boolean))] } : {}),
    // Precios opcionales: solo se guardan si se cargaron.
    ...(cleanPrice(i.price) ? { price: cleanPrice(i.price) } : {}),
    ...(cleanPrice(i.cost) ? { cost: cleanPrice(i.cost) } : {}),
    ...(i.pricePer === 'dozen' ? { pricePer: 'dozen' } : {}),
    ...(i.priceManual ? { priceManual: true } : {}), // precio de venta escrito a mano: no sigue el margen general
    ...(cleanPrice(i.priceArs) ? { priceArs: cleanPrice(i.priceArs) } : {}), // precio fijo en pesos: no sigue al dólar
    updatedAt: i.updatedAt || nowIso(),
    createdAt: i.createdAt || i.updatedAt || nowIso(),
  };
}

export function load() {
  let migrated = false;
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const x = JSON.parse(raw);
      state.items = Array.isArray(x.items) ? x.items : [];
      state.history = Array.isArray(x.history) ? x.history : [];
      state.lastBackupAt = x.lastBackupAt || null;
      state.cloud = { ...state.cloud, ...(x.cloud || {}) };
      if (!Array.isArray(state.cloud.pending)) state.cloud.pending = [];
      if (!Array.isArray(state.cloud.removed)) state.cloud.removed = [];
      state.extra = normalizeExtra(x.extra);
    } else {
      for (const k of OLD_KEYS) {
        const old = localStorage.getItem(k);
        if (!old) continue;
        const data = JSON.parse(old);
        const arr = Array.isArray(data) ? data : (data.items || []);
        state.items = arr.map(i => ({ ...i, units: i.units ?? i.totalUnits ?? num(i.dozens) * 12 }));
        migrated = true;
        break;
      }
    }
    state.items = state.items.filter(i => i && txt(i.sku ?? i.code)).map(normalizeItem);
    state.history = state.history.filter(h => h && h.at);
    if (migrated) persist();
    return { ok: true, migrated };
  } catch {
    return { ok: false };
  }
}

// ---------- Consultas ----------
export const findById = id => state.items.find(i => i.id === id) || null;
export function findByCode(code) {
  const c = upper(code);
  if (!c) return null;
  return state.items.find(i => i.sku === c) || state.items.find(i => i.barcode && i.barcode === c) || state.items.find(i => i.aliases?.includes(c)) || null;
}
export const isLow = i => i.minStock > 0 && i.units <= i.minStock;

// ---------- Códigos parecidos ----------
// Para no dar de alta dos veces el mismo producto con el código escrito distinto: GT8008 / 8008 / GT-8008 / GT8080.
// strong: casi seguro es el mismo (se pregunta antes de crear). Los demás son solo sugerencias (un carácter distinto).
const plainCode = v => upper(v).normalize('NFD').replace(/[^A-Z0-9]/g, '');
const digitsOf = v => v.replace(/\D/g, '').replace(/^0+/, '');
const noZeros = v => v.replace(/(^|\D)0+(?=\d)/g, '$1'); // REM0012 = REM12
// Distancia de edición con transposiciones (8008 / 8080 = 1).
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
function codeLikeness(c, cd, sku) {
  const s = plainCode(sku);
  if (!s) return null;
  if (s === c) return { score: 0, strong: true, reason: 'mismo código con otro formato' };
  if (noZeros(s) === noZeros(c)) return { score: 0, strong: true, reason: 'mismo código con otros ceros' };
  // 8008 / GT8008 es casi seguro el mismo; GT8008 / PT8008 puede ser otra prenda con el mismo número.
  const sameDigits = cd.length >= 3 && digitsOf(s) === cd;
  if (sameDigits && (!/[A-Z]/.test(c) || !/[A-Z]/.test(s))) return { score: 1, strong: true, reason: 'mismo número' };
  const [short, long] = c.length <= s.length ? [c, s] : [s, c];
  if (short.length >= 3 && short.length / long.length >= 0.5 && long.includes(short)) return { score: 2, strong: true, reason: `${long === s ? 'contiene' : 'está dentro de'} ${c}` }; // N28339 / N28339EP
  if (sameDigits) return { score: 3, strong: false, reason: 'mismo número, otras letras' };
  if (Math.abs(c.length - s.length) > 2) return null;
  const dist = editDistance(c, s);
  if ((dist === 1 && short.length >= 4) || (dist === 2 && short.length >= 7)) return { score: 3 + dist, strong: false, reason: dist === 1 ? 'un carácter distinto' : 'dos caracteres distintos' };
  return null;
}
// Devuelve [{ item, reason, strong }] ordenados del más parecido al menos.
export function similarCodes(code, limit = 3) {
  const c = plainCode(code);
  if (c.length < 3 || findByCode(upper(code).replace(/\s+/g, ''))) return [];
  const cd = digitsOf(c);
  return state.items
    .map(item => ({ item, m: codeLikeness(c, cd, item.sku) }))
    .filter(x => x.m)
    .sort((a, b) => a.m.score - b.m.score || b.item.updatedAt.localeCompare(a.item.updatedAt))
    .slice(0, limit)
    .map(({ item, m }) => ({ item, reason: m.reason, strong: m.strong, score: m.score }));
}

// ---------- Etiquetas numeradas ----------
// Una etiqueta puede identificar una docena o una unidad concreta del producto, con su número de serie:
// 1015D0003 = docena N.º 3 del producto 1015 · 1015U0012 = unidad N.º 12. Solo letras y números: cualquier pistola los lee.
export const PACKS = {
  D: { label: 'Docena', plural: 'docenas', factor: 12 },
  U: { label: 'Unidad', plural: 'unidades', factor: 1 },
};
export const serialCode = (sku, pack, n) => `${sku}${pack}${String(n).padStart(4, '0')}`;
export const packAllowed = (item, pack) => pack !== 'D' || item.unitName === 'unidades';

// Devuelve { item, pack, number, serial } para un código de producto o de etiqueta numerada; null si no existe.
export function resolveCode(code) {
  const c = upper(code).replace(/\s+/g, '');
  if (!c) return null;
  const item = findByCode(c);
  if (item) return { item, pack: null };
  const m = c.match(/^(.+)([DU])(\d{4,})$/);
  if (!m) return null;
  const owner = state.items.find(i => i.sku === m[1]) || state.items.find(i => i.aliases?.includes(m[1]));
  if (!owner || !packAllowed(owner, m[2])) return null;
  return { item: owner, pack: m[2], number: Number(m[3]), serial: c };
}
// Último movimiento registrado de una etiqueta numerada (para avisar si se escanea dos veces).
export const lastSerialEvent = serial => state.history.find(h => h.serial === serial && !h.voided && h.kind !== 'fix') || null;

// Guarda hasta qué número se imprimió, para que la próxima tanda continúe la numeración.
export function reserveSerials(plan) {
  let changed = false;
  for (const p of plan) {
    const i = findById(p.id);
    if (!i) continue;
    const last = p.last ?? (p.start + p.count - 1);
    if (last > (i.serials?.[p.pack] || 0) || p.restart) { i.serials = { ...i.serials, [p.pack]: last }; changed = true; }
  }
  if (changed) commit('serials');
}
export function displayQty(i) {
  if (i.displayUnit === 'dozen' && i.unitName === 'unidades') return { value: round2(i.units / 12), unit: 'docenas' };
  return { value: i.units, unit: unitLabel(i.unitName) };
}
// Tipo de movimiento para iconos y filtros (los registros de versiones anteriores no tienen "kind").
// Cantidad del movimiento tal como se cargó. Para registros viejos se reconstruye desde la etiqueta o la nota.
export function enteredOf(h) {
  if (h.entered) return h.entered;
  if (h.serial) { const p = PACKS[h.serial.match(/([DU])\d{4,}$/)?.[1]]; if (p) return { qty: 1, unit: p.factor === 12 ? 'docenas' : (h.unit || 'unidades') }; }
  const m = String(h.note || '').match(/·\s*([\d.,]+)\s+(docenas|unidades|cajas|paquetes|pares|rollos|kg|g|m|L)\s*·/);
  if (m) return { qty: Number(m[1].replace(/\./g, '').replace(',', '.')), unit: m[2] };
  return h.quantity != null ? { qty: h.quantity, unit: h.unit || 'unidades' } : null;
}
// Origen del movimiento: pistola, cámara, voz, manual…
export const sourceOf = h => h.source || (h.kind === 'fix' ? 'corrección' : String(h.note || '').split(' · ')[0] || '');
// Número de etiqueta numerada de un movimiento: { pack: 'D'|'U', number }.
export function serialInfo(serial) {
  const m = String(serial || '').match(/([DU])(\d{4,})$/);
  return m ? { pack: m[1], number: Number(m[2]), label: `${PACKS[m[1]].label} N.º ${m[2]}` } : null;
}

// Unidades que realmente movió un registro, considerando anulaciones y correcciones posteriores.
export function effectiveQty(h) {
  if (h.voided) return 0;
  if (h.corrected) return num(h.corrected.to?.quantity);
  return num(h.quantity);
}

export function historyKind(h) {
  if (h.kind) return h.kind;
  const a = String(h.action || '');
  if (/Ingreso|\+1/.test(a)) return 'in';
  if (/Descuento|Salida|-1/.test(a)) return 'out';
  if (/Conteo/.test(a)) return 'count';
  if (/Elimin/.test(a)) return 'delete';
  if (/Import/.test(a)) return 'import';
  return 'edit';
}
export function generateSku(brand = '', type = '') {
  const part = (v, n) => upper(v).normalize('NFD').replace(/[^A-Z0-9]/g, '').slice(0, n);
  const prefix = (part(brand, 2) + part(type, 2)) || 'SV';
  let n = state.items.length + 1, code;
  do { code = `${prefix}${String(n).padStart(4, '0')}`; n++; } while (findByCode(code));
  return code;
}

function log(kind, action, item, d = {}) {
  const entry = {
    id: uid(), at: nowIso(), kind, action,
    sku: item?.sku || d.sku || '', brand: item?.brand || '', type: item?.type || '',
    stockType: item?.stockType || d.stockType || 'inventario', unit: item ? unitLabel(item.unitName) : '',
    before: d.before ?? null, after: d.after ?? null, quantity: d.quantity ?? null, note: d.note || '',
    ...(d.serial ? { serial: d.serial } : {}),
    ...(d.entered ? { entered: d.entered } : {}), // cantidad tal como se cargó, p. ej. { qty: 1, unit: 'docenas' }
    ...(d.source ? { source: d.source } : {}),
    ...(d.abs ? { abs: true } : {}),             // el stock se fijó a un valor (no es una suma/resta)
    ...(d.fixOf ? { fixOf: d.fixOf } : {}),      // corrección o anulación de otro movimiento
    ...(d.contact ? { contact: d.contact } : {}), // cliente o proveedor
    ...(d.prices ? { prices: d.prices } : {}),   // cambios de precio de muchos productos: { sku: { cost, price, … } }
    ...(actor ? { by: actor } : {}),
  };
  state.history.unshift(entry);
  if (state.history.length > HISTORY_MAX) state.history.length = HISTORY_MAX;
  state.cloud.pending.push(entry.id);
  if (state.cloud.pending.length > 5000) state.cloud.pending.splice(0, state.cloud.pending.length - 5000);
  return entry;
}
const fail = error => ({ ok: false, error });

// ---------- Movimientos ----------
// v: { sku, brand, type, qty, unit, stockType, operation: 'sumar'|'restar'|'establecer', minStock, barcode, source }
export function applyMovement(v) {
  const code = upper(v.sku).replace(/\s+/g, '');
  const op = OPERATIONS[v.operation] ? v.operation : 'sumar';
  const qty = Number(String(v.qty ?? '').replace(',', '.'));
  const u = inputUnit(v.unit);
  const stockType = STOCK_TYPES[v.stockType] ? v.stockType : 'inventario';
  if (!code) return fail('Completá el código / SKU.');
  if (!Number.isFinite(qty) || qty < 0 || (qty === 0 && op !== 'establecer')) return fail('Ingresá una cantidad mayor que cero.');
  const amount = round2(qty * u.factor);
  const existing = findByCode(code);
  if (existing && existing.unitName !== u.stock) return fail(`${existing.sku} se controla en ${unitLabel(existing.unitName)}. Ingresá la cantidad en esa unidad para no mezclar medidas.`);
  if (op === 'restar' && !existing) return fail(`${code} no existe en el inventario; no se descontó nada.`);
  if (op === 'restar' && existing.units < amount) return fail(`Stock insuficiente de ${existing.sku}: hay ${fmt(existing.units)} ${existing.units === 1 && existing.unitName === 'unidades' ? 'unidad' : unitLabel(existing.unitName)}.`);

  checkpoint();
  let item = existing;
  const before = existing ? existing.units : 0;
  if (!item) {
    item = normalizeItem({ sku: code, brand: v.brand, type: v.type, stockType, unitName: u.stock, displayUnit: v.unit, units: 0, minStock: v.minStock, barcode: v.barcode });
    state.items.push(item);
  } else {
    if (txt(v.brand)) item.brand = cleanText(v.brand);
    if (txt(v.type)) item.type = cleanText(v.type);
    if (txt(v.barcode)) item.barcode = upper(v.barcode);
    if (num(v.minStock) > 0) item.minStock = num(v.minStock);
  }
  if (cleanPrice(v.price)) applyPrices(item, { price: v.price, pricePer: v.pricePer || pricePerOf(item) });
  item.units = round2(op === 'establecer' ? amount : op === 'restar' ? before - amount : before + amount);
  item.stockType = stockType;
  if (!v.keepDisplay || !existing) item.displayUnit = v.unit || item.displayUnit;
  item.updatedAt = nowIso();
  const kind = op === 'establecer' ? 'count' : op === 'restar' ? 'out' : 'in';
  const shown = `${fmt(qty)} ${u.short}`;
  const source = String(v.source || 'manual').split(' · ')[0];
  const entry = log(kind, OPERATIONS[op], item, { before, after: item.units, quantity: amount, serial: v.serial, entered: { qty, unit: u.short }, source, contact: v.contact ? { id: v.contact.id, name: v.contact.name, kind: v.contact.kind } : undefined, note: `${v.source || 'manual'} · ${shown} · ${stockTypeLabel(stockType)}` });
  commit('movement');
  return { ok: true, item, before, after: item.units, amount, op, created: !existing, entryId: entry.id };
}

export function adjust(id, delta, note = 'Ajuste rápido') {
  const i = findById(id);
  if (!i) return fail('Producto no encontrado.');
  const after = round2(i.units + delta);
  if (after < 0) return fail('No hay stock para descontar.');
  checkpoint();
  const before = i.units;
  i.units = after; i.updatedAt = nowIso();
  log(delta > 0 ? 'in' : 'out', delta > 0 ? `Ajuste +${fmt(delta)}` : `Ajuste −${fmt(-delta)}`, i, { before, after, quantity: Math.abs(delta), entered: { qty: Math.abs(delta), unit: unitLabel(i.unitName) }, source: 'ajuste rápido', note });
  commit('adjust');
  return { ok: true, item: i, before, after };
}

export function setStock(id, units, action, note = '', serial = '') {
  const i = findById(id);
  if (!i) return fail('Producto no encontrado.');
  checkpoint();
  const before = i.units;
  i.units = Math.max(0, round2(units)); i.updatedAt = nowIso();
  log('edit', action, i, { before, after: i.units, quantity: Math.abs(i.units - before), note, serial });
  commit('adjust');
  return { ok: true, item: i, before, after: i.units };
}

export function saveItem(id, patch) {
  const i = findById(id);
  if (!i) return fail('Producto no encontrado.');
  const sku = upper(patch.sku).replace(/\s+/g, ''), barcode = upper(patch.barcode).replace(/\s+/g, ''), units = Number(patch.units);
  if (!sku) return fail('El código / SKU es obligatorio.');
  if (!Number.isFinite(units) || units < 0) return fail('El stock debe ser un número mayor o igual a cero.');
  const clash = state.items.find(x => x.id !== id && (x.sku === sku || x.aliases?.includes(sku) || (barcode && (x.barcode === barcode || x.sku === barcode))));
  if (clash) return fail(`Ese código ya lo usa ${clash.sku}.`);
  checkpoint();
  const before = i.units;
  Object.assign(i, {
    sku, barcode, brand: cleanText(patch.brand), type: cleanText(patch.type),
    stockType: STOCK_TYPES[patch.stockType] ? patch.stockType : i.stockType,
    unitName: STOCK_UNITS[patch.unitName] ? patch.unitName : i.unitName,
    units: round2(units), minStock: Math.max(0, num(patch.minStock)), updatedAt: nowIso(),
  });
  if (i.unitName !== 'unidades') i.displayUnit = inputUnitFor(i);
  const priceNote = applyPrices(i, patch);
  // Solo si cambió el stock se registra el valor (al combinar con otros usuarios, fija el stock a ese número).
  log('edit', 'Edición', i, before !== i.units
    ? { before, after: i.units, abs: true, note: ['Edición manual del stock', priceNote && `precios: ${priceNote}`].filter(Boolean).join(' · ') }
    : { note: priceNote ? `Precios: ${priceNote}` : 'Edición de datos del producto' });
  commit('edit');
  return { ok: true, item: i };
}

// Aplica los precios que vengan en patch (price, cost, pricePer). Devuelve el detalle de lo que cambió.
// Con ganancia general, el precio de venta sigue al costo salvo que se escriba a mano uno distinto
// (priceAuto: true vuelve al automático; borrar el precio también).
function applyPrices(i, patch) {
  const changes = [], before = { price: i.price || null, cost: i.cost || null };
  if ('pricePer' in patch) {
    const per = patch.pricePer === 'dozen' && i.unitName === 'unidades' ? 'dozen' : 'unit';
    if (per !== pricePerOf(i) && (i.price || i.cost || 'price' in patch || 'cost' in patch)) changes.push(`precio ${PRICE_PER[per]}`);
    if (per === 'dozen') i.pricePer = 'dozen'; else delete i.pricePer;
  }
  const beforeArs = i.priceArs || null;
  for (const k of ['price', 'cost', 'priceArs']) {
    if (!(k in patch)) continue;
    const v = cleanPrice(patch[k]);
    if (v) i[k] = v; else delete i[k];
  }
  if ((i.priceArs || null) !== beforeArs) changes.push(`venta en pesos ${beforeArs ? `$ ${fmt(beforeArs)}` : 'según el dólar'} → ${i.priceArs ? `$ ${fmt(i.priceArs)} fijo` : 'según el dólar'}`);
  const a = autoPrice(i);
  if (patch.priceAuto || ('price' in patch && !i.price)) delete i.priceManual;
  else if ('price' in patch) { if (a && i.price === a) delete i.priceManual; else i.priceManual = true; }
  if (!i.priceManual && a) i.price = a;
  for (const [k, label] of [['price', 'venta'], ['cost', 'costo']]) {
    const v = i[k] || null;
    if (before[k] !== v) changes.push(`${label} ${before[k] ? `${currencySign()} ${fmt(before[k])}` : '—'} → ${v ? `${currencySign()} ${fmt(v)}` : '—'}`);
  }
  return changes.join(', ');
}
// Guarda precios de varios productos (p. ej. los que se escribieron al cerrar una venta). field: 'price' | 'cost' | 'priceArs'.
export function setItemPrices(changes, field = 'price') {
  const valid = changes.map(c => ({ ...c, item: findByCode(c.sku), value: cleanPrice(c.value) })).filter(c => c.item && c.value);
  if (!valid.length) return 0;
  checkpoint();
  let n = 0;
  for (const c of valid) {
    const note = applyPrices(c.item, { [field]: c.value, pricePer: c.per });
    if (!note) continue;
    n++;
    c.item.updatedAt = nowIso();
    log('edit', 'Cambio de precio', c.item, { note: `Precios: ${note}` });
  }
  commit('prices');
  return n;
}

export function deleteItems(ids) {
  const set = new Set(ids), gone = state.items.filter(i => set.has(i.id));
  if (!gone.length) return 0;
  checkpoint();
  state.items = state.items.filter(i => !set.has(i.id));
  gone.forEach(i => log('delete', 'Eliminación', i, { before: i.units, after: 0 }));
  commit('delete');
  return gone.length;
}

// ---------- Productos duplicados ----------
// Grupos de productos que parecen el mismo cargado dos veces: código casi igual (8008 / GT8008 / GT-8008).
// Los códigos con un carácter distinto no se proponen: suelen ser correlativos (1015 / 1016 = otro color o talle).
// Cada grupo viene ordenado con el que conviene conservar primero.
export function duplicateGroups() {
  const items = state.items, n = items.length, parent = items.map((_, k) => k);
  const root = k => { while (parent[k] !== k) k = parent[k] = parent[parent[k]]; return k; };
  const reasons = new Map();
  const codes = items.map(i => plainCode(i.sku));
  for (let a = 0; a < n; a++) {
    if (codes[a].length < 3) continue;
    const cd = digitsOf(codes[a]);
    for (let b = a + 1; b < n; b++) {
      if (codes[b].length < 3) continue;
      const m = codeLikeness(codes[a], cd, items[b].sku);
      if (!m?.strong) continue;
      parent[root(b)] = root(a);
      reasons.set(`${a}:${b}`, `${items[a].sku} y ${items[b].sku}: ${m.reason}`);
    }
  }
  const groups = new Map();
  items.forEach((_, k) => { const r = root(k); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(k); });
  const moves = new Map();
  for (const h of state.history) moves.set(h.sku, (moves.get(h.sku) || 0) + 1);
  // Se conserva el que tiene los datos más completos, después el más usado y después el más viejo.
  const rank = i => (i.brand ? 2 : 0) + (i.type ? 2 : 0) + (i.price ? 1 : 0);
  return [...groups.values()].filter(g => g.length > 1).map(g => ({
    items: g.map(k => items[k]).sort((x, y) => rank(y) - rank(x) || (moves.get(y.sku) || 0) - (moves.get(x.sku) || 0) || String(x.createdAt).localeCompare(String(y.createdAt))),
    reasons: [...new Set([...reasons].filter(([key]) => g.includes(Number(key.split(':')[0]))).map(([, r]) => r))],
  }));
}
export const movementCount = item => state.history.filter(h => h.sku === item.sku || item.aliases?.includes(h.sku)).length;

// Une productos duplicados en uno: suma el stock, completa los datos que falten y borra los demás.
// Los códigos borrados quedan como códigos anteriores del que queda (sus etiquetas se siguen leyendo).
export function mergeItems(targetId, sourceIds) {
  const target = findById(targetId), sources = [...new Set(sourceIds)].filter(id => id !== targetId).map(findById).filter(Boolean);
  if (!target) return fail('Producto no encontrado.');
  if (!sources.length) return fail('Elegí al menos dos productos para unir.');
  const other = sources.find(i => i.unitName !== target.unitName);
  if (other) return fail(`${other.sku} se controla en ${unitLabel(other.unitName)} y ${target.sku} en ${unitLabel(target.unitName)}: no se pueden unir sin mezclar medidas.`);
  checkpoint();
  const before = target.units, aliases = new Set(target.aliases || []);
  for (const src of sources) {
    for (const k of ['brand', 'type', 'barcode']) if (!target[k] && src[k]) target[k] = src[k];
    for (const k of ['price', 'cost']) if (!target[k] && src[k]) { target[k] = src[k]; if (k === 'price' && src.pricePer) target.pricePer = src.pricePer; }
    if (!target.minStock && src.minStock) target.minStock = src.minStock;
    [src.sku, ...(src.aliases || []), ...(src.barcode && src.barcode !== target.barcode ? [src.barcode] : [])].forEach(c => aliases.add(c));
    target.units = round2(target.units + src.units);
  }
  aliases.delete(target.sku);
  if (target.barcode) aliases.delete(target.barcode);
  target.aliases = [...aliases];
  target.updatedAt = nowIso();
  state.items = state.items.filter(i => !sources.includes(i));
  const names = sources.map(i => `${i.sku} (${fmt(i.units)} ${unitLabel(i.unitName)})`).join(', ');
  for (const src of sources) log('delete', 'Unión de productos', src, { before: src.units, after: 0, quantity: src.units, note: `Unido a ${target.sku}: su stock pasó a ese producto` });
  log('edit', 'Unión de productos', target, { before, after: target.units, quantity: round2(target.units - before), note: `Se unió ${names} a ${target.sku}` });
  commit('merge-items');
  return { ok: true, item: target, merged: sources.map(i => i.sku), before, after: target.units };
}

export function bulkSet(ids, field, value) {
  if (field === 'price' || field === 'cost' || field === 'pricePer') {
    const set = new Set(ids), targets = state.items.filter(i => set.has(i.id));
    if (!targets.length) return 0;
    checkpoint();
    for (const i of targets) {
      const note = applyPrices(i, { [field]: field === 'pricePer' ? value : cleanPrice(value) });
      if (!note) continue;
      i.updatedAt = nowIso();
      log('edit', 'Edición múltiple', i, { note: `Precios: ${note}` });
    }
    commit('bulk');
    return targets.length;
  }
  const allowed = { brand: cleanText, type: cleanText, stockType: v => (STOCK_TYPES[v] ? v : null), unitName: v => (STOCK_UNITS[v] ? v : null), minStock: v => Math.max(0, num(v)) };
  const conv = allowed[field];
  if (!conv) return 0;
  const val = conv(value);
  if (val === null) return 0;
  const set = new Set(ids), targets = state.items.filter(i => set.has(i.id));
  if (!targets.length) return 0;
  checkpoint();
  for (const i of targets) {
    const before = i[field];
    i[field] = val; i.updatedAt = nowIso();
    if (field === 'unitName' && val !== 'unidades') i.displayUnit = inputUnitFor(i);
    log('edit', 'Edición múltiple', i, { note: `${field}: ${before || '—'} → ${val || '—'}` });
  }
  commit('bulk');
  return targets.length;
}

export function clearHistory() { checkpoint(); markRemoved(state.history.map(h => h.id)); state.history = []; commit('history'); }
// Borra movimientos del historial sin tocar el stock (para limpiar pruebas o registros que sobran).
export function deleteMovements(ids) {
  const del = new Set(ids), before = state.history.length;
  checkpoint();
  state.history = state.history.filter(h => !del.has(h.id));
  const n = before - state.history.length;
  if (!n) { undoStack.pop(); return 0; }
  markRemoved([...del]);
  commit('history');
  return n;
}
function markRemoved(ids) {
  const list = state.cloud.removed;
  for (const id of ids) if (id && !list.includes(id)) list.push(id);
  if (list.length > 5000) list.splice(0, list.length - 5000);
}

// rows: productos ya normalizados por io.js. replace=true reemplaza todo; si no, combina por SKU.
export function importItems(rows, replace, history = null, extra = null) {
  checkpoint();
  if (replace) {
    state.items = rows.map(r => normalizeItem({ ...r, id: undefined }));
    if (Array.isArray(history)) state.history = history.slice(0, HISTORY_MAX);
    if (extra) state.extra = normalizeExtra(extra); // copia JSON completa: clientes, remitos y ventas
    log('import', 'Importación: reemplazo', null, { note: `${rows.length} productos` });
  } else {
    for (const r of rows) {
      const old = findByCode(r.sku);
      if (old) {
        const before = old.units;
        Object.assign(old, { brand: cleanText(r.brand) || old.brand, type: cleanText(r.type) || old.type, units: round2(num(r.units)), updatedAt: nowIso() });
        if (r.barcode) old.barcode = upper(r.barcode);
        if (r.minStock) old.minStock = num(r.minStock);
        if (cleanPrice(r.price) || cleanPrice(r.cost)) applyPrices(old, { ...(cleanPrice(r.price) ? { price: r.price } : {}), ...(cleanPrice(r.cost) ? { cost: r.cost } : {}), pricePer: r.pricePer });
        log('import', 'Importación: actualización', old, { before, after: old.units });
      } else {
        const i = normalizeItem({ ...r, id: undefined });
        state.items.push(i);
        log('import', 'Importación: alta', i, { before: 0, after: i.units });
      }
    }
  }
  commit('import');
}

// ---------- Corrección de movimientos ----------
// Corrige la cantidad de un ingreso/salida/conteo o lo anula. No borra nada: el original queda marcado
// (quién, cuándo y por qué) y se agrega un movimiento de corrección que ajusta el stock.
// change: { remove: true } o { qty, unit }, más { reason }
export function fixMovement(id, change) {
  const h = state.history.find(x => x.id === id);
  if (!h) return fail('No se encontró el movimiento.');
  return fixEntry(h, change, true);
}
// ¿Se puede anular? Solo ingresos, salidas y conteos de productos que siguen en el inventario.
export function canVoid(h) {
  return !!h && !h.voided && ['in', 'out', 'count'].includes(historyKind(h)) && h.before != null && h.after != null && state.items.some(i => i.sku === h.sku);
}
// Cuánto movió el stock ese movimiento (con su corrección, si la tuvo).
function movedDelta(h) {
  const k = historyKind(h), current = h.corrected ? h.corrected.to : { quantity: h.quantity, after: h.after };
  return k === 'count' ? num(current.after ?? h.after) - h.before : (k === 'out' ? -1 : 1) * num(current.quantity);
}
// Orden para anular varios: primero las salidas (devuelven stock), después conteos e ingresos; los más nuevos primero.
const VOID_ORDER = { out: 0, count: 1, in: 2 };
function voidList(ids) {
  return ids.map(id => state.history.find(x => x.id === id)).filter(Boolean)
    .sort((a, b) => (VOID_ORDER[historyKind(a)] ?? 9) - (VOID_ORDER[historyKind(b)] ?? 9) || String(b.at).localeCompare(String(a.at)));
}
// Simula la anulación de varios movimientos: cómo queda el stock de cada código y cuáles no se pueden anular.
export function planVoid(ids) {
  const units = new Map(), skus = new Map(), skipped = [], blocked = [];
  let ok = 0;
  for (const h of voidList(ids)) {
    if (!canVoid(h)) { skipped.push(h); continue; }
    const item = state.items.find(i => i.sku === h.sku);
    const cur = units.has(h.sku) ? units.get(h.sku) : item.units, next = round2(cur - movedDelta(h));
    if (next < 0) { blocked.push(h); continue; }
    units.set(h.sku, next);
    if (!skus.has(h.sku)) skus.set(h.sku, { item, before: item.units });
    skus.get(h.sku).after = next;
    ok++;
  }
  return { ok, skus: [...skus.values()], skipped, blocked };
}
// Anula varios movimientos juntos (un solo "Deshacer"). Los que no se pueden anular se informan y se saltean.
export function voidMovements(ids, reason) {
  if (!txt(reason)) return fail('Escribí el motivo de la anulación.');
  checkpoint();
  let done = 0;
  const failed = [];
  for (const h of voidList(ids)) {
    if (!canVoid(h)) continue;
    const r = fixEntry(h, { remove: true, reason }, false);
    if (r.ok) done++; else failed.push({ h, error: r.error });
  }
  if (!done) { undoStack.pop(); return fail(failed[0]?.error || 'No hay movimientos para anular.'); }
  commit('fix');
  return { ok: true, done, failed };
}
function fixEntry(h, change, save) {
  if (h.voided) return fail('Este movimiento ya fue anulado.');
  const k = historyKind(h);
  if (!['in', 'out', 'count'].includes(k) || h.before == null || h.after == null) return fail('Solo se pueden corregir ingresos, salidas y conteos.');
  const item = state.items.find(i => i.sku === h.sku);
  if (!item) return fail(`El producto ${h.sku} ya no está en el inventario.`);
  const reason = txt(change.reason);
  if (!reason) return fail('Escribí el motivo de la corrección.');

  const oldDelta = movedDelta(h);
  let newDelta = 0, to = null;
  if (!change.remove) {
    const u = inputUnit(change.unit);
    if (u.stock !== item.unitName) return fail(`${item.sku} se controla en ${unitLabel(item.unitName)}. Elegí una unidad compatible.`);
    const qty = Number(String(change.qty ?? '').replace(',', '.'));
    if (!Number.isFinite(qty) || qty < 0 || (qty === 0 && k !== 'count')) return fail('Ingresá una cantidad válida (o anulá el movimiento).');
    const amount = round2(qty * u.factor);
    newDelta = k === 'count' ? amount - h.before : (k === 'out' ? -amount : amount);
    to = { qty, unit: u.short, quantity: k === 'count' ? Math.abs(amount - h.before) : amount, after: k === 'count' ? amount : null };
  }
  const diff = round2(newDelta - oldDelta);
  if (diff === 0 && !change.remove) return fail('La cantidad nueva es igual a la registrada.');
  if (item.units + diff < 0) return fail(`No se puede: el stock de ${item.sku} quedaría negativo (hoy hay ${fmt(item.units)} ${unitLabel(item.unitName)}).`);

  if (save) checkpoint();
  const before = item.units;
  item.units = round2(before + diff);
  item.updatedAt = nowIso();
  const stamp = { at: nowIso(), by: actor, reason };
  if (change.remove) h.voided = stamp;
  else h.corrected = { ...stamp, from: h.corrected?.from || { qty: enteredOf(h)?.qty, unit: enteredOf(h)?.unit, quantity: h.quantity }, to };
  const when = new Date(h.at).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  log('fix', change.remove ? 'Anulación' : 'Corrección', item, {
    before, after: item.units, quantity: Math.abs(diff), fixOf: h.id, serial: h.serial, source: 'corrección',
    note: `${change.remove ? 'Anula' : 'Corrige'} ${String(h.action).toLowerCase()} del ${when}: ${reason}`,
  });
  if (save) commit('fix');
  return { ok: true, item, before, after: item.units, diff };
}

// ---------- Combinar con cambios de otros usuarios ----------
// Cuando otro dispositivo (o un empleado) guardó antes, se parte de los datos de la nube y se vuelven a aplicar
// encima los movimientos hechos acá que todavía no se subieron. Así nadie pisa el trabajo de otro:
// si dos personas sacan una docena del mismo código, se descuentan las dos.
export function rebase(remote) {
  const pending = new Set(state.cloud.pending), removed = new Set(state.cloud.removed);
  const remoteAll = (remote.history || []).filter(h => h && h.at);
  const remoteHistory = remoteAll.filter(h => !removed.has(h.id));
  const remoteIds = new Set(remoteHistory.map(h => h.id));
  const items = new Map((remote.items || []).filter(i => i && i.sku).map(normalizeItem).map(i => [i.sku, i]));
  const localItems = new Map(state.items.map(i => [i.sku, i]));
  const mine = state.history.filter(h => pending.has(h.id) && !remoteIds.has(h.id)).reverse(); // del más viejo al más nuevo

  for (const h of mine) {
    if (h.prices) { for (const [sku, p] of Object.entries(h.prices)) { const it = items.get(sku); if (it) applyPricePatch(it, p); } continue; }
    const k = historyKind(h);
    if (k === 'delete') { items.delete(h.sku); continue; }
    let it = items.get(h.sku);
    const local = localItems.get(h.sku);
    if (!it) {
      if (!local) continue;
      it = normalizeItem({ ...local, units: 0 });
      items.set(h.sku, it);
    } else if (local && local.updatedAt > it.updatedAt) {
      // Datos del producto (marca, prenda, mínimo…) editados acá: se conservan. El stock se recalcula abajo.
      Object.assign(it, { brand: local.brand, type: local.type, barcode: local.barcode, minStock: local.minStock, stockType: local.stockType, unitName: local.unitName, displayUnit: local.displayUnit });
      for (const k of ['price', 'cost', 'pricePer', 'priceManual', 'priceArs']) { if (local[k] !== undefined) it[k] = local[k]; else delete it[k]; }
    }
    if (h.before != null && h.after != null) {
      it.units = round2(Math.max(0, k === 'count' || h.abs ? h.after : it.units + (h.after - h.before)));
      it.updatedAt = h.at > it.updatedAt ? h.at : it.updatedAt;
    }
  }
  // Numeración de etiquetas: gana el número más alto. Códigos anteriores (productos unidos): se juntan.
  for (const [sku, local] of localItems) {
    const it = items.get(sku);
    if (!it) continue;
    it.serials = { D: Math.max(it.serials.D, local.serials?.D || 0), U: Math.max(it.serials.U, local.serials?.U || 0) };
    if (local.aliases) it.aliases = [...new Set([...(it.aliases || []), ...local.aliases])].filter(c => !items.has(c));
  }
  // Historial: el de la nube más lo hecho acá que todavía no se subió. Un movimiento que ya se había subido y la
  // nube no tiene fue borrado en otro dispositivo: no se recupera (salvo los viejos que la nube ya no guarda).
  // Las anulaciones/correcciones hechas acá se mantienen en el movimiento original.
  const trimmed = remote.role !== 'employee' && remoteAll.length >= CONFIG.CLOUD_HISTORY_LIMIT;
  const oldest = remoteAll.reduce((m, h) => (String(h.at) < m ? String(h.at) : m), '\uffff');
  const merged = new Map(remoteHistory.map(h => [h.id, h]));
  for (const h of state.history) if (!merged.has(h.id) && (pending.has(h.id) || (trimmed && String(h.at) < oldest))) merged.set(h.id, h);
  for (const h of mine) {
    if (!h.fixOf) continue;
    const target = merged.get(h.fixOf), localTarget = state.history.find(x => x.id === h.fixOf);
    if (target && localTarget) { if (localTarget.voided) target.voided = localTarget.voided; if (localTarget.corrected) target.corrected = localTarget.corrected; }
  }
  state.items = [...items.values()];
  state.history = [...merged.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, HISTORY_MAX);
  state.extra = mergeExtra(remote.extra, state.extra);
  refreshAutoPrices(); // la ganancia general pudo cambiar en otro dispositivo
  state.cloud.rev = remote.rev || 0;
  commit('merge');
}
// Clientes: gana la versión editada más recientemente. Remitos: se unen; si dos dispositivos usaron el mismo
// número, el remito hecho acá toma el siguiente número libre.
function mergeExtra(remoteExtra, localExtra) {
  const r = normalizeExtra(remoteExtra), l = normalizeExtra(localExtra);
  const contacts = new Map(r.contacts.map(c => [c.id, c]));
  for (const c of l.contacts) { const o = contacts.get(c.id); if (!o || String(c.updatedAt || '') > String(o.updatedAt || '')) contacts.set(c.id, c); }
  const remitos = new Map(r.remitos.map(x => [x.id, x]));
  let seq = Math.max(r.remitoSeq, l.remitoSeq);
  const used = new Set(r.remitos.map(x => x.number));
  for (const x of l.remitos) {
    const o = remitos.get(x.id);
    // Una venta anulada en este dispositivo sigue anulada aunque la nube tenga la versión anterior.
    if (o) { if (x.voided && !o.voided) remitos.set(x.id, { ...o, voided: x.voided }); continue; }
    const copy = { ...x };
    if (used.has(copy.number)) copy.number = ++seq;
    used.add(copy.number);
    remitos.set(copy.id, copy);
  }
  const list = [...remitos.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, REMITOS_MAX);
  const settings = String(l.settings.updatedAt || '') > String(r.settings.updatedAt || '') ? l.settings : r.settings;
  return { ...r, contacts: [...contacts.values()], remitos: list, remitoSeq: Math.max(seq, ...list.map(x => num(x.number))), settings };
}

// ---------- Clientes y proveedores ----------
export const CONTACT_KINDS = { cliente: 'Cliente', proveedor: 'Proveedor' };
export const contacts = (kind = null) => state.extra.contacts
  .filter(c => !c.deleted && (!kind || c.kind === kind))
  .sort((a, b) => a.name.localeCompare(b.name, 'es'));
export const findContact = id => state.extra.contacts.find(c => c.id === id && !c.deleted) || null;
export const findContactByName = (name, kind) => {
  const n = upper(name);
  return state.extra.contacts.find(c => !c.deleted && upper(c.name) === n && (!kind || c.kind === kind)) || null;
};
export function saveContact(c) {
  const name = txt(c.name);
  if (!name) return fail('Escribí el nombre.');
  const kind = CONTACT_KINDS[c.kind] ? c.kind : 'cliente';
  const dup = state.extra.contacts.find(x => !x.deleted && x.id !== c.id && upper(x.name) === upper(name) && x.kind === kind);
  if (dup) return fail(`Ya existe un ${CONTACT_KINDS[kind].toLowerCase()} llamado ${dup.name}.`);
  const data = { name, kind, phone: txt(c.phone).replace(/[^\d+]/g, ''), doc: txt(c.doc), address: txt(c.address), note: txt(c.note), updatedAt: nowIso() };
  let contact = c.id && state.extra.contacts.find(x => x.id === c.id);
  if (contact) Object.assign(contact, data);
  else { contact = { id: uid(), createdAt: nowIso(), ...data }; state.extra.contacts.push(contact); }
  commit('contacts');
  return { ok: true, contact };
}
// Se marca como borrado (no se elimina) para que no "reaparezca" al combinar con otro dispositivo.
export function deleteContact(id) {
  const c = state.extra.contacts.find(x => x.id === id);
  if (!c) return false;
  c.deleted = true; c.updatedAt = nowIso();
  commit('contacts');
  return true;
}

// ---------- Remitos ----------
// lines: [{ sku, name, qty, unit, units, serials: [], price?, per? }] · kind: 'salida' | 'entrada'
// sale (opcional): { discount, payment } → queda como venta (salida) o compra (entrada), con importes y total.
// currency: moneda en que se cobra · fx: cotización usada si se cobró en pesos con precios en dólares.
export function createRemito({ kind = 'salida', contact = null, lines = [], note = '', entryIds = [], sale = null, currency: cur = 'ARS', fx = null }) {
  if (!lines.length) return fail('El remito no tiene productos.');
  const number = state.extra.remitoSeq + 1;
  const remito = {
    id: uid(), number, at: nowIso(), kind, note: txt(note), by: actor || '',
    contact: contact ? { id: contact.id, name: contact.name, phone: contact.phone || '', doc: contact.doc || '', address: contact.address || '' } : null,
    lines, entryIds,
  };
  if (sale) {
    remito.lines = lines.map(l => {
      const price = cleanPrice(l.price), per = l.per === 'dozen' ? 'dozen' : 'unit';
      return { ...l, price: price || 0, per, amount: price ? lineAmount(l.units, price, per) : 0 };
    });
    const subtotal = round2(remito.lines.reduce((s, l) => s + l.amount, 0));
    const discount = Math.min(100, Math.max(0, round2(num(sale.discount))));
    Object.assign(remito, { priced: true, subtotal, discount, total: round2(subtotal * (1 - discount / 100)), payment: PAYMENTS[sale.payment] ? sale.payment : '', currency: cur === 'USD' ? 'USD' : 'ARS' });
    if (fx?.rate > 0) remito.fx = { rate: fx.rate, source: fx.source || '' };
  }
  state.extra.remitoSeq = number;
  state.extra.remitos.unshift(remito);
  if (state.extra.remitos.length > REMITOS_MAX) state.extra.remitos.length = REMITOS_MAX;
  commit('remito');
  return { ok: true, remito };
}
export const remitoCode = r => `R-${String(r.number).padStart(5, '0')}`;
// Anula una venta/remito: no se borra, queda marcado con quién, cuándo y por qué. El stock se corrige aparte.
export function voidRemito(id, reason) {
  const r = state.extra.remitos.find(x => x.id === id);
  if (!r) return fail('No se encontró el comprobante.');
  if (r.voided) return fail('Ya estaba anulado.');
  if (!txt(reason)) return fail('Escribí el motivo.');
  checkpoint();
  r.voided = { at: nowIso(), by: actor, reason: txt(reason) };
  commit('remito');
  return { ok: true, remito: r };
}
// Comprobante (venta, compra o remito) al que pertenece un movimiento.
export const remitoOfEntry = entryId => (entryId ? state.extra.remitos.find(r => r.entryIds?.includes(entryId)) || null : null);
// Se confirma que estos movimientos ya están en la nube.
export function markSynced(ids, removed = []) {
  const sent = new Set(ids), gone = new Set(removed);
  state.cloud.pending = state.cloud.pending.filter(id => !sent.has(id));
  state.cloud.removed = state.cloud.removed.filter(id => !gone.has(id));
}

// ---------- Datos que llegan de la nube ----------
export function replaceAll(items, history, extra) {
  state.items = (items || []).filter(i => i && i.sku).map(normalizeItem);
  state.history = (history || []).filter(h => h && h.at);
  if (extra !== undefined) state.extra = normalizeExtra(extra);
  commit('cloud', { sync: false });
}
// Combina por SKU (gana la versión modificada más recientemente) y une los historiales sin duplicar.
export function mergeData(items, history, extra) {
  checkpoint();
  if (extra) state.extra = mergeExtra(extra, state.extra);
  const map = new Map(state.items.map(i => [i.sku, i]));
  for (const r of (items || []).filter(i => i && i.sku).map(normalizeItem)) {
    const l = map.get(r.sku);
    if (!l || r.updatedAt > l.updatedAt) map.set(r.sku, r);
  }
  state.items = [...map.values()];
  const seen = new Set();
  state.history = [...state.history, ...(history || [])]
    .filter(h => h && h.at && (!h.id || !seen.has(h.id)) && (h.id ? seen.add(h.id) : true))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, HISTORY_MAX);
  commit('merge');
}

export function markBackup() { state.lastBackupAt = nowIso(); persist(); }
export function wipeLocal() {
  state.items = []; state.history = []; state.cloud = { owner: null, rev: 0, dirty: false, lastSyncAt: null, pending: [], removed: [] };
  state.extra = EXTRA_DEFAULT();
  undoStack.length = 0;
  commit('wipe', { sync: false });
}
