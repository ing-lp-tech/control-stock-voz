// Exportar e importar: Excel (XLSX), CSV y copia de seguridad JSON.
import { state, stockTypeLabel, displayQty, normalizeItem, STOCK_TYPES, enteredOf, sourceOf, serialInfo, historyKind, pricesOn, pricePerOf, remitoCode, PAYMENTS, PRICE_PER } from './store.js';
import { loadScript, download, dateStamp, upper, num, round2, parseMoney } from './utils.js';
import { CONFIG } from './config.js';

const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
async function ensureXLSX() { if (!window.XLSX) await loadScript(XLSX_URL); return window.XLSX; }

export function inventoryRows(items = state.items) {
  // Columnas de precios solo si se usan (con la app como control de stock el archivo queda igual que antes).
  const withPrices = pricesOn() || items.some(i => i.price || i.cost);
  const withCost = items.some(i => i.cost);
  return items.map(i => {
    const d = displayQty(i);
    const prices = withPrices ? { 'PRECIO DE VENTA': i.price || '', ...(withCost ? { 'PRECIO DE COSTO': i.cost || '' } : {}), 'PRECIO POR': pricePerOf(i) === 'dozen' ? 'DOCENA' : 'UNIDAD' } : {};
    return {
      'CÓDIGO SKU': i.sku, 'CÓDIGO DE BARRAS': i.barcode || '', 'MARCA': i.brand, 'PRENDA / TIPO': i.type,
      'TIPO DE STOCK': stockTypeLabel(i.stockType), 'UNIDAD DE STOCK': d.unit, 'CANTIDAD REGISTRADA': d.value,
      'EQUIVALENTE EN UNIDADES': i.unitName === 'unidades' ? i.units : '', 'DOCENAS (SI APLICA)': i.unitName === 'unidades' ? round2(i.units / 12) : '',
      'STOCK MÍNIMO': i.minStock || '', ...prices, 'ÚLTIMA MODIFICACIÓN': new Date(i.updatedAt).toLocaleString('es-AR'),
    };
  });
}
export function historyRows(history = state.history) {
  const KIND = { in: 'Ingreso', out: 'Salida', count: 'Conteo', edit: 'Edición', delete: 'Eliminación', import: 'Importación' };
  return history.map(h => {
    const d = new Date(h.at), e = enteredOf(h), si = serialInfo(h.serial);
    return {
      'FECHA': d.toLocaleDateString('es-AR'), 'HORA': d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      'TIPO': KIND[historyKind(h)] || h.action, 'ACCIÓN': h.action, 'SKU': h.sku, 'MARCA': h.brand, 'PRENDA': h.type,
      'ETIQUETA ESCANEADA': h.serial ? `${h.serial} (${si?.label || ''})` : '',
      'CANTIDAD CARGADA': e ? e.qty : '', 'UNIDAD CARGADA': e ? e.unit : '',
      'UNIDADES MOVIDAS': h.quantity ?? '', 'STOCK ANTES': h.before ?? '', 'STOCK DESPUÉS': h.after ?? '', 'UNIDAD DE STOCK': h.unit || '',
      'TIPO DE STOCK': stockTypeLabel(h.stockType), 'ORIGEN': sourceOf(h), 'NOTA': h.note || '',
    };
  });
}

export function csvDownload(rows, filename) {
  if (!rows.length) return false;
  const cols = Object.keys(rows[0]);
  const csv = [cols, ...rows.map(r => cols.map(k => r[k] ?? ''))].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), filename);
  return true;
}
// Ventas y compras con precio: una fila por producto de cada comprobante (fácil de sumar en Excel).
export function exportSalesCSV(remitos) {
  const rows = [];
  for (const r of remitos.filter(x => x.priced)) {
    const d = new Date(r.at);
    for (const l of r.lines) rows.push({
      'FECHA': d.toLocaleDateString('es-AR'), 'HORA': d.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }),
      'COMPROBANTE': remitoCode(r), 'TIPO': r.kind === 'entrada' ? 'Compra' : 'Venta', 'ESTADO': r.voided ? `Anulado: ${r.voided.reason}` : 'Válido',
      'CLIENTE / PROVEEDOR': r.contact?.name || '', 'CÓDIGO': l.sku, 'PRODUCTO': l.name || '', 'CANTIDAD': `${l.qty} ${l.unit}`, 'UNIDADES': l.units,
      'PRECIO': l.price || 0, 'PRECIO POR': PRICE_PER[l.per] || '', 'IMPORTE': l.amount || 0,
      'DESCUENTO %': r.discount || 0, 'TOTAL DEL COMPROBANTE': r.total, 'FORMA DE PAGO': PAYMENTS[r.payment] || '', 'USUARIO': r.by || '',
    });
  }
  return csvDownload(rows, `StockVoz_ventas_${dateStamp()}.csv`);
}
export const exportInventoryCSV = () => csvDownload(inventoryRows(), `StockVoz_${dateStamp()}.csv`);
export const exportHistoryCSV = (rows = state.history, name = `StockVoz_historial_${dateStamp()}.csv`) => csvDownload(historyRows(rows), name);

export async function exportXLSX() {
  if (!state.items.length) return false;
  const X = await ensureXLSX();
  const wb = X.utils.book_new(), ws = X.utils.json_to_sheet(inventoryRows());
  ws['!cols'] = Object.keys(inventoryRows()[0]).map(k => ({ wch: Math.max(12, Math.min(22, k.length + 2)) }));
  X.utils.book_append_sheet(wb, ws, 'Inventario');
  X.utils.book_append_sheet(wb, X.utils.json_to_sheet(historyRows().length ? historyRows() : [{ 'FECHA': '' }]), 'Historial');
  X.writeFile(wb, `StockVoz_${dateStamp()}.xlsx`);
  return true;
}

export function backupJSON() {
  // Incluye clientes, remitos, ventas y ajustes para poder restaurar todo.
  const data = { app: 'StockVoz', version: CONFIG.VERSION, exportedAt: new Date().toISOString(), items: state.items, history: state.history, extra: state.extra };
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
      // Precios opcionales: "12.500", "12500" o "$ 12.500".
      price: parseMoney(get('PRECIO DE VENTA', 'PRECIO VENTA', 'PRECIO', 'PRECIO UNITARIO', 'PRICE')),
      cost: parseMoney(get('PRECIO DE COSTO', 'PRECIO COSTO', 'COSTO', 'COST')),
      pricePer: /^DOCENA/.test(normKey(get('PRECIO POR'))) ? 'dozen' : 'unit',
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
    return { rows, total: list.length, history: Array.isArray(d.history) ? d.history : null, extra: d.extra && typeof d.extra === 'object' ? d.extra : null };
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

// ---------- Costos desde un archivo ----------
// Acepta el archivo de tandas (.json: { moneda, tandas: [{ tanda, fecha, productos: [{ codigo, costo_usd, … }] }] }),
// una lista JSON de { codigo, costo } o un Excel/CSV con columnas CÓDIGO y COSTO (COSTO USD, PRECIO DE COSTO…).
// Opcionales: PRODUCTO, MARCA, DOCENAS, FECHA, TANDA. Devuelve { entries, currency, per }.
const costNum = v => (typeof v === 'number' ? (v > 0 ? v : null) : parseMoney(v));
export async function readCostFile(file) {
  const name = file.name.toLowerCase();
  let rows = [], currency = null, per = null;
  if (name.endsWith('.json')) {
    const d = JSON.parse(await file.text());
    const moneda = String(d?.moneda || '').toUpperCase();
    if (/USD|DOLAR|DÓLAR/.test(moneda)) currency = 'USD'; else if (/ARS|PESO/.test(moneda)) currency = 'ARS';
    if (/DOCENA/.test(moneda)) per = 'dozen'; else if (/UNIDAD/.test(moneda)) per = 'unit';
    if (Array.isArray(d?.tandas)) rows = d.tandas.flatMap(t => (t.productos || []).map(p => ({ ...p, fecha: p.fecha || t.fecha, tanda: p.tanda || t.tanda })));
    else rows = Array.isArray(d) ? d : (d.productos || d.items || []);
  } else {
    let raw;
    if (name.endsWith('.csv')) raw = parseCSV(await file.text());
    else {
      const X = await ensureXLSX();
      const wb = X.read(await file.arrayBuffer(), { type: 'array' });
      raw = X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
    }
    const headers = raw.length ? Object.keys(raw[0]).map(k => normKey(k).replace(/_/g, ' ')).join(' ') : '';
    if (/USD|DOLAR/.test(headers)) currency = 'USD';
    if (/DOCENA/.test(headers)) per = 'dozen';
    rows = raw;
  }
  const entries = rows.filter(r => r && typeof r === 'object').map(r => {
    const keys = Object.keys(r);
    const nk = x => normKey(x).replace(/_/g, ' ');
    const get = (...names) => { const k = keys.find(x => names.includes(nk(x))); return k === undefined ? '' : r[k]; };
    // Columnas con nombre libre: "Costo USD por docena", "Código del producto"…
    const like = (re, not) => { const k = keys.find(x => re.test(nk(x)) && !not?.test(nk(x))); return k === undefined ? '' : r[k]; };
    return {
      code: upper(get('CODIGO', 'CODIGO SKU', 'SKU', 'CODE') || like(/^(CODIGO|SKU|CODE)/, /BARRAS|EAN/)).replace(/\s+/g, ''),
      name: String(get('PRODUCTO', 'DESCRIPCION', 'PRENDA', 'NOMBRE') || '').trim(),
      brand: String(get('MARCA', 'BRAND') || '').trim(),
      cost: costNum(get('COSTO USD', 'COSTO', 'PRECIO DE COSTO', 'PRECIO COSTO', 'COSTO ARS', 'COST') || like(/^(PRECIO DE |PRECIO )?COSTO?\b/, /MOTIVO|SIN COSTO/)),
      dozens: num(get('DOCENAS', 'DOZENS')) || 0,
      date: String(get('FECHA', 'DATE') || ''),
      batch: String(get('TANDA', 'LOTE') || ''),
      reason: String(get('MOTIVO SIN COSTO') || ''),
    };
  }).filter(e => e.code);
  return { entries, currency, per };
}
