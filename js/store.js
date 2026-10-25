// Estado del inventario: productos, historial, persistencia local y deshacer.
// Todas las modificaciones pasan por este módulo y notifican a la interfaz y a la sincronización.
import { uid, nowIso, txt, upper, num, round2, fmt } from './utils.js';

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
  cloud: { owner: null, rev: 0, dirty: false, lastSyncAt: null, pending: [] },
  // Datos del negocio que se sincronizan: clientes/proveedores y remitos.
  extra: { contacts: [], remitos: [], remitoSeq: 0 },
};
const EXTRA_DEFAULT = () => ({ contacts: [], remitos: [], remitoSeq: 0 });
const REMITOS_MAX = 500;
export function normalizeExtra(x) {
  const e = { ...EXTRA_DEFAULT(), ...(x && typeof x === 'object' ? x : {}) };
  e.contacts = Array.isArray(e.contacts) ? e.contacts.filter(c => c && c.id) : [];
  e.remitos = Array.isArray(e.remitos) ? e.remitos.filter(r => r && r.id) : [];
  e.remitoSeq = Math.max(0, Math.floor(num(e.remitoSeq)), ...e.remitos.map(r => num(r.number)));
  return e;
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
  undoStack.push(JSON.stringify({ items: state.items, history: state.history, extra: state.extra }));
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
  return state.items.find(i => i.sku === c) || state.items.find(i => i.barcode && i.barcode === c) || null;
}
export const isLow = i => i.minStock > 0 && i.units <= i.minStock;

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
  const owner = state.items.find(i => i.sku === m[1]);
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
  if (op === 'restar' && existing.units < amount) return fail(`Stock insuficiente de ${existing.sku}: hay ${fmt(existing.units)} ${unitLabel(existing.unitName)}.`);

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
  const clash = state.items.find(x => x.id !== id && (x.sku === sku || (barcode && (x.barcode === barcode || x.sku === barcode))));
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
  // Solo si cambió el stock se registra el valor (al combinar con otros usuarios, fija el stock a ese número).
  log('edit', 'Edición', i, before !== i.units ? { before, after: i.units, abs: true, note: 'Edición manual del stock' } : { note: 'Edición de datos del producto' });
  commit('edit');
  return { ok: true, item: i };
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

export function bulkSet(ids, field, value) {
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

export function clearHistory() { checkpoint(); state.history = []; commit('history'); }

// rows: productos ya normalizados por io.js. replace=true reemplaza todo; si no, combina por SKU.
export function importItems(rows, replace, history = null) {
  checkpoint();
  if (replace) {
    state.items = rows.map(r => normalizeItem({ ...r, id: undefined }));
    if (Array.isArray(history)) state.history = history.slice(0, HISTORY_MAX);
    log('import', 'Importación: reemplazo', null, { note: `${rows.length} productos` });
  } else {
    for (const r of rows) {
      const old = findByCode(r.sku);
      if (old) {
        const before = old.units;
        Object.assign(old, { brand: cleanText(r.brand) || old.brand, type: cleanText(r.type) || old.type, units: round2(num(r.units)), updatedAt: nowIso() });
        if (r.barcode) old.barcode = upper(r.barcode);
        if (r.minStock) old.minStock = num(r.minStock);
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
  if (h.voided) return fail('Este movimiento ya fue anulado.');
  const k = historyKind(h);
  if (!['in', 'out', 'count'].includes(k) || h.before == null || h.after == null) return fail('Solo se pueden corregir ingresos, salidas y conteos.');
  const item = state.items.find(i => i.sku === h.sku);
  if (!item) return fail(`El producto ${h.sku} ya no está en el inventario.`);
  const reason = txt(change.reason);
  if (!reason) return fail('Escribí el motivo de la corrección.');

  const current = h.corrected ? h.corrected.to : { quantity: h.quantity, after: h.after };
  const oldDelta = k === 'count' ? num(current.after ?? h.after) - h.before : (k === 'out' ? -1 : 1) * num(current.quantity);
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

  checkpoint();
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
  commit('fix');
  return { ok: true, item, before, after: item.units, diff };
}

// ---------- Combinar con cambios de otros usuarios ----------
// Cuando otro dispositivo (o un empleado) guardó antes, se parte de los datos de la nube y se vuelven a aplicar
// encima los movimientos hechos acá que todavía no se subieron. Así nadie pisa el trabajo de otro:
// si dos personas sacan una docena del mismo código, se descuentan las dos.
export function rebase(remote) {
  const pending = new Set(state.cloud.pending);
  const remoteHistory = (remote.history || []).filter(h => h && h.at);
  const remoteIds = new Set(remoteHistory.map(h => h.id));
  const items = new Map((remote.items || []).filter(i => i && i.sku).map(normalizeItem).map(i => [i.sku, i]));
  const localItems = new Map(state.items.map(i => [i.sku, i]));
  const mine = state.history.filter(h => pending.has(h.id) && !remoteIds.has(h.id)).reverse(); // del más viejo al más nuevo

  for (const h of mine) {
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
    }
    if (h.before != null && h.after != null) {
      it.units = round2(Math.max(0, k === 'count' || h.abs ? h.after : it.units + (h.after - h.before)));
      it.updatedAt = h.at > it.updatedAt ? h.at : it.updatedAt;
    }
  }
  // Numeración de etiquetas: gana el número más alto.
  for (const [sku, local] of localItems) {
    const it = items.get(sku);
    if (it) it.serials = { D: Math.max(it.serials.D, local.serials?.D || 0), U: Math.max(it.serials.U, local.serials?.U || 0) };
  }
  // Historial: unión sin duplicados; las anulaciones/correcciones hechas acá se mantienen en el movimiento original.
  const merged = new Map(remoteHistory.map(h => [h.id, h]));
  for (const h of state.history) if (!merged.has(h.id)) merged.set(h.id, h);
  for (const h of mine) {
    if (!h.fixOf) continue;
    const target = merged.get(h.fixOf), localTarget = state.history.find(x => x.id === h.fixOf);
    if (target && localTarget) { if (localTarget.voided) target.voided = localTarget.voided; if (localTarget.corrected) target.corrected = localTarget.corrected; }
  }
  state.items = [...items.values()];
  state.history = [...merged.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, HISTORY_MAX);
  state.extra = mergeExtra(remote.extra, state.extra);
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
    if (remitos.has(x.id)) continue;
    const copy = { ...x };
    if (used.has(copy.number)) copy.number = ++seq;
    used.add(copy.number);
    remitos.set(copy.id, copy);
  }
  const list = [...remitos.values()].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, REMITOS_MAX);
  return { ...r, contacts: [...contacts.values()], remitos: list, remitoSeq: Math.max(seq, ...list.map(x => num(x.number))) };
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
// lines: [{ sku, name, qty, unit, units, serials: [] }] · kind: 'salida' | 'entrada'
export function createRemito({ kind = 'salida', contact = null, lines = [], note = '', entryIds = [] }) {
  if (!lines.length) return fail('El remito no tiene productos.');
  const number = state.extra.remitoSeq + 1;
  const remito = {
    id: uid(), number, at: nowIso(), kind, note: txt(note), by: actor || '',
    contact: contact ? { id: contact.id, name: contact.name, phone: contact.phone || '', doc: contact.doc || '', address: contact.address || '' } : null,
    lines, entryIds,
  };
  state.extra.remitoSeq = number;
  state.extra.remitos.unshift(remito);
  if (state.extra.remitos.length > REMITOS_MAX) state.extra.remitos.length = REMITOS_MAX;
  commit('remito');
  return { ok: true, remito };
}
export const remitoCode = r => `R-${String(r.number).padStart(5, '0')}`;
// Se confirma que estos movimientos ya están en la nube.
export function markSynced(ids) {
  const sent = new Set(ids);
  state.cloud.pending = state.cloud.pending.filter(id => !sent.has(id));
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
  state.items = []; state.history = []; state.cloud = { owner: null, rev: 0, dirty: false, lastSyncAt: null, pending: [] };
  state.extra = EXTRA_DEFAULT();
  undoStack.length = 0;
  commit('wipe', { sync: false });
}
