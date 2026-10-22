// Exportar e importar: Excel (XLSX), CSV y copia de seguridad JSON.
import { state, stockTypeLabel, displayQty, normalizeItem, STOCK_TYPES } from './store.js';
import { loadScript, download, dateStamp, upper, num, round2 } from './utils.js';
import { CONFIG } from './config.js';

const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
async function ensureXLSX() { if (!window.XLSX) await loadScript(XLSX_URL); return window.XLSX; }

export function inventoryRows(items = state.items) {
  return items.map(i => {
    const d = displayQty(i);
    return {
      'CÓDIGO SKU': i.sku, 'CÓDIGO DE BARRAS': i.barcode || '', 'MARCA': i.brand, 'PRENDA / TIPO': i.type,
      'TIPO DE STOCK': stockTypeLabel(i.stockType), 'UNIDAD DE STOCK': d.unit, 'CANTIDAD REGISTRADA': d.value,
      'EQUIVALENTE EN UNIDADES': i.unitName === 'unidades' ? i.units : '', 'DOCENAS (SI APLICA)': i.unitName === 'unidades' ? round2(i.units / 12) : '',
      'STOCK MÍNIMO': i.minStock || '', 'ÚLTIMA MODIFICACIÓN': new Date(i.updatedAt).toLocaleString('es-AR'),
    };
  });
}
export function historyRows(history = state.history) {
  return history.map(h => ({
    'FECHA': new Date(h.at).toLocaleString('es-AR'), 'ACCIÓN': h.action, 'SKU': h.sku, 'MARCA': h.brand, 'PRENDA': h.type,
    'TIPO DE STOCK': stockTypeLabel(h.stockType), 'ANTES': h.before ?? '', 'DESPUÉS': h.after ?? '', 'CANTIDAD MOVIMIENTO': h.quantity ?? '',
    'UNIDAD': h.unit || '', 'NOTA': h.note || '',
  }));
}

export function csvDownload(rows, filename) {
  if (!rows.length) return false;
  const cols = Object.keys(rows[0]);
  const csv = [cols, ...rows.map(r => cols.map(k => r[k] ?? ''))].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), filename);
  return true;
}
export const exportInventoryCSV = () => csvDownload(inventoryRows(), `StockVoz_${dateStamp()}.csv`);
export const exportHistoryCSV = (rows = state.history) => csvDownload(historyRows(rows), `StockVoz_historial_${dateStamp()}.csv`);

export async function exportXLSX() {
  if (!state.items.length) return false;
  const X = await ensureXLSX();
  const wb = X.utils.book_new(), ws = X.utils.json_to_sheet(inventoryRows());
  ws['!cols'] = [{ wch: 16 }, { wch: 16 }, { wch: 18 }, { wch: 20 }, { wch: 20 }, { wch: 14 }, { wch: 18 }, { wch: 20 }, { wch: 16 }, { wch: 12 }, { wch: 20 }];
  X.utils.book_append_sheet(wb, ws, 'Inventario');
  X.utils.book_append_sheet(wb, X.utils.json_to_sheet(historyRows().length ? historyRows() : [{ 'FECHA': '' }]), 'Historial');
  X.writeFile(wb, `StockVoz_${dateStamp()}.xlsx`);
  return true;
}

export function backupJSON() {
  const data = { app: 'StockVoz', version: CONFIG.VERSION, exportedAt: new Date().toISOString(), items: state.items, history: state.history };
  download(new Blob([JSON.stringify(data)], { type: 'application/json' }), `StockVoz_copia_${dateStamp()}.json`);
}

// ---------- Importación ----------
function parseCSV(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(x => x.trim());
  if (!lines.length) return [];
  const delim = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
  const parseLine = s => {
    const a = []; let v = '', q = false;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '"' && s[i + 1] === '"' && q) { v += '"'; i++; }
      else if (s[i] === '"') q = !q;
      else if (s[i] === delim && !q) { a.push(v); v = ''; }
      else v += s[i];
    }
    a.push(v);
    return a;
  };
  const heads = parseLine(lines.shift()).map(x => x.trim());
  return lines.map(line => Object.fromEntries(parseLine(line).map((v, i) => [heads[i] || `COL${i}`, v])));
}

const normKey = k => String(k).normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase();
const STOCK_TYPE_ALIASES = {
  'ENTRADA': 'entrada', 'STOCK DE ENTRADA': 'entrada', 'ENTRADA DE MERCADERIA': 'entrada', 'SALIDA': 'salida', 'STOCK DE SALIDA': 'salida',
  'SALIDA DE MERCADERIA': 'salida', 'INVENTARIO': 'inventario', 'INVENTARIO GENERAL': 'inventario', 'LOCAL': 'local', 'STOCK DE LOCAL': 'local',
  'DEPOSITO': 'deposito', 'STOCK DE DEPOSITO': 'deposito', 'PRODUCCION': 'produccion', 'TRANSFERENCIA': 'transferencia', 'AJUSTE': 'ajuste',
  'AJUSTE DE STOCK': 'ajuste', 'OTRO': 'otro', 'OTRA': 'otro',
};
const UNIT_ALIASES = {
  'UNIDADES': 'unidades', 'UNIDAD': 'unidades', 'CAJAS': 'cajas', 'CAJA': 'cajas', 'PAQUETES': 'paquetes', 'PAQUETE': 'paquetes', 'PARES': 'pares',
  'PAR': 'pares', 'ROLLOS': 'rollos', 'ROLLO': 'rollos', 'KG': 'kg', 'KILOGRAMOS': 'kg', 'G': 'g', 'GRAMOS': 'g', 'M': 'm', 'METROS': 'm',
  'L': 'l', 'LITROS': 'l', 'OTRA': 'otra', 'OTRA UNIDAD': 'otra',
};

function normalizeRows(rows) {
  return rows.map(r => {
    const keys = Object.keys(r);
    const get = (...names) => { const k = keys.find(x => names.includes(normKey(x))); return k === undefined ? '' : r[k]; };
    const unitRaw = normKey(get('UNIDAD DE STOCK', 'UNIDAD', 'UNIT'));
    const dozen = /^DOCENA/.test(unitRaw);
    let units = get('EQUIVALENTE EN UNIDADES', 'TOTAL UNIDADES', 'UNIDADES', 'UNITS', 'STOCK', 'CANTIDAD');
    if (units === '') { const reg = get('CANTIDAD REGISTRADA'); if (reg !== '') units = num(reg) * (dozen ? 12 : 1); }
    if (units === '') { const d = get('DOCENAS', 'DOZENS', 'DOCENAS (SI APLICA)'); if (d !== '') units = num(d) * 12; }
    return {
      sku: upper(get('CODIGO SKU', 'CODIGO (SKU)', 'SKU', 'CODIGO', 'CODE')),
      barcode: upper(get('CODIGO DE BARRAS', 'BARCODE', 'EAN')),
      brand: upper(get('MARCA', 'BRAND')),
      type: upper(get('PRENDA / TIPO', 'TIPO DE ROPA', 'PRENDA', 'TIPO', 'TYPE')),
      stockType: STOCK_TYPE_ALIASES[normKey(get('TIPO DE STOCK', 'CATEGORIA DE STOCK'))] || 'inventario',
      unitName: dozen ? 'unidades' : (UNIT_ALIASES[unitRaw] || 'unidades'),
      displayUnit: dozen ? 'dozen' : 'unit',
      units: units === '' ? NaN : num(units),
      minStock: num(get('STOCK MINIMO', 'MINIMO')),
    };
  }).filter(i => i.sku && Number.isFinite(i.units) && i.units >= 0);
}

// Devuelve { rows, total, history } listo para previsualizar.
export async function readImportFile(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.json')) {
    const d = JSON.parse(await file.text());
    const list = Array.isArray(d) ? d : (d.items || []);
    const rows = list.filter(i => i && (i.sku || i.code)).map(i => normalizeItem({ ...i, units: i.units ?? i.totalUnits ?? num(i.dozens) * 12 }));
    return { rows, total: list.length, history: Array.isArray(d.history) ? d.history : null };
  }
  let raw;
  if (name.endsWith('.csv')) raw = parseCSV(await file.text());
  else {
    const X = await ensureXLSX();
    const wb = X.read(await file.arrayBuffer(), { type: 'array' });
    raw = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  }
  return { rows: normalizeRows(raw).map(r => ({ ...r, stockType: STOCK_TYPES[r.stockType] ? r.stockType : 'inventario' })), total: raw.length, history: null };
}
