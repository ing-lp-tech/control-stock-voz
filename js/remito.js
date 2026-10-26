// Remito en PDF: se genera en el dispositivo (sin servidor) y se comparte por WhatsApp.
import { loadScript, download, waLink, moneyIn } from './utils.js';
import { remitoCode, remitoCurrency, PACKS, PAYMENTS, PRICE_PER } from './store.js';

const JSPDF_URL = 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js';
// Las fuentes estándar del PDF usan Latin-1: se reemplazan los pocos caracteres que no entran.
const clean = s => String(s ?? '').replace(/[−–—]/g, '-').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/…/g, '...').replace(/[^\x00-\xFF]/g, '');
const fmtN = n => Number(n || 0).toLocaleString('es-AR', { maximumFractionDigits: 2 });
// Importes en la moneda en que se cobró el comprobante (una venta en pesos, una compra en dólares).
const fmtMoney = (r, n) => moneyIn(n, remitoCurrency(r)).replace(/\s/g, ' ');

// Número de WhatsApp: solo dígitos; un celular argentino de 10 dígitos se completa con 549.
export function waNumber(phone) {
  let d = String(phone || '').replace(/\D/g, '').replace(/^0+/, '');
  if (d.length === 10) d = `549${d}`;
  if (d.length === 12 && d.startsWith('54') && !d.startsWith('549')) d = `549${d.slice(2)}`;
  return d.length >= 10 ? d : '';
}

// Rango compacto de etiquetas: [1,2,3,7] → "N.º 0001-0003, 0007"
function serialText(serials = []) {
  const byPack = {};
  for (const s of serials) { const m = String(s).match(/([DU])(\d{4,})$/); if (m) (byPack[m[1]] ||= []).push(Number(m[2])); }
  return Object.entries(byPack).map(([p, nums]) => {
    nums.sort((a, b) => a - b);
    const out = [], pad = n => String(n).padStart(4, '0');
    for (let i = 0; i < nums.length; i++) { let j = i; while (nums[j + 1] === nums[j] + 1) j++; out.push(i === j ? pad(nums[i]) : `${pad(nums[i])}-${pad(nums[j])}`); i = j; }
    return `${PACKS[p].plural} N.º ${out.join(', ')}`;
  }).join(' · ');
}

export async function buildRemitoPDF(remito, { business = '', owner = '' } = {}) {
  const fmtM = n => fmtMoney(remito, n);
  if (!window.jspdf) await loadScript(JSPDF_URL);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const W = 210, M = 16, ink = [17, 18, 20], muted = [107, 109, 115], line = [222, 222, 218];
  const priced = !!remito.priced;
  const title = priced ? (remito.kind === 'entrada' ? 'COMPRA' : 'COMPROBANTE DE VENTA') : remito.kind === 'entrada' ? 'REMITO DE ENTRADA' : 'REMITO';
  const date = new Date(remito.at);
  let y = M;

  const header = () => {
    doc.setTextColor(...ink).setFont('helvetica', 'bold').setFontSize(18).text(clean(business || 'Mi negocio'), M, y + 6);
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...muted).text(clean(owner ? `Responsable: ${owner}` : ''), M, y + 12);
    doc.setTextColor(...ink).setFont('helvetica', 'bold').setFontSize(13).text(title, W - M, y + 5, { align: 'right' });
    doc.setFontSize(16).text(remitoCode(remito), W - M, y + 12, { align: 'right' });
    doc.setFont('helvetica', 'normal').setFontSize(9).setTextColor(...muted)
      .text(clean(`${date.toLocaleDateString('es-AR')} ${date.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' })}`), W - M, y + 17, { align: 'right' })
      .text('Documento no válido como factura', W - M, y + 21, { align: 'right' });
    y += 28;
    doc.setDrawColor(...line).setLineWidth(0.3).line(M, y, W - M, y);
    y += 6;
  };
  header();

  // Datos del cliente / proveedor
  const c = remito.contact;
  doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(...muted).text(remito.kind === 'entrada' ? 'Proveedor' : 'Cliente', M, y);
  doc.setFont('helvetica', 'bold').setFontSize(12).setTextColor(...ink).text(clean(c?.name || 'Consumidor final'), M, y + 6);
  doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(...muted);
  const info = [c?.doc && `CUIT/DNI: ${c.doc}`, c?.phone && `Tel: ${c.phone}`, c?.address].filter(Boolean).map(clean);
  info.forEach((t, i) => doc.text(t, M, y + 11 + i * 4.5));
  y += 14 + info.length * 4.5;

  // Tabla
  // Con precios: Código · Descripción · Cantidad · Precio · Importe. Sin precios: igual que siempre.
  const cols = priced
    ? [{ x: M, w: 26, h: 'Código' }, { x: M + 26, w: 64, h: 'Descripción' }, { x: M + 90, w: 30, h: 'Cantidad', r: true }, { x: M + 120, w: 30, h: 'Precio', r: true }, { x: M + 150, w: 28, h: 'Importe', r: true }]
    : [{ x: M, w: 30, h: 'Código' }, { x: M + 30, w: 78, h: 'Descripción' }, { x: M + 108, w: 36, h: 'Cantidad', r: true }, { x: M + 144, w: 34, h: 'Unidades', r: true }];
  const tableHead = () => {
    doc.setFillColor(242, 242, 238).rect(M, y, W - 2 * M, 8, 'F');
    doc.setFont('helvetica', 'bold').setFontSize(9).setTextColor(...ink);
    cols.forEach(col => doc.text(col.h, col.r ? col.x + col.w - 2 : col.x + 2, y + 5.4, col.r ? { align: 'right' } : undefined));
    y += 8;
  };
  tableHead();
  let totalUnits = 0;
  for (const l of remito.lines) {
    const desc = doc.splitTextToSize(clean(l.name || '-'), cols[1].w - 4);
    const serial = l.serials?.length ? doc.splitTextToSize(clean(`Etiquetas: ${serialText(l.serials)}`), cols[1].w - 4) : [];
    const h = Math.max(priced ? 11 : 8, 4 + (desc.length + serial.length) * 4.2);
    if (y + h > 262) { doc.addPage(); y = M; header(); tableHead(); }
    doc.setFont('helvetica', 'bold').setFontSize(9.5).setTextColor(...ink).text(clean(l.sku), cols[0].x + 2, y + 5.2);
    doc.setFont('helvetica', 'normal').text(desc, cols[1].x + 2, y + 5.2);
    if (serial.length) doc.setFontSize(8).setTextColor(...muted).text(serial, cols[1].x + 2, y + 5.2 + desc.length * 4.2);
    doc.setFontSize(9.5).setTextColor(...ink).text(clean(`${fmtN(l.qty)} ${l.unit}`), cols[2].x + cols[2].w - 2, y + 5.2, { align: 'right' });
    if (priced) {
      doc.text(l.price ? fmtM(l.price) : '-', cols[3].x + cols[3].w - 2, y + 5.2, { align: 'right' });
      if (l.price) doc.setFontSize(7.5).setTextColor(...muted).text(clean(PRICE_PER[l.per] || ''), cols[3].x + cols[3].w - 2, y + 8.8, { align: 'right' }).setFontSize(9.5).setTextColor(...ink);
      doc.text(fmtM(l.amount), cols[4].x + cols[4].w - 2, y + 5.2, { align: 'right' });
    } else doc.text(fmtN(l.units), cols[3].x + cols[3].w - 2, y + 5.2, { align: 'right' });
    y += h;
    doc.setDrawColor(...line).line(M, y, W - M, y);
    totalUnits += Number(l.units) || 0;
  }
  // Totales
  y += 6;
  doc.setFont('helvetica', 'bold').setFontSize(10.5).setTextColor(...ink)
    .text(`${priced ? '' : 'Total: '}${fmtN(totalUnits)} unidades (${fmtN(totalUnits / 12)} docenas) · ${remito.lines.length} artículo${remito.lines.length === 1 ? '' : 's'}`, W - M, y, { align: 'right' });
  y += 8;
  if (priced) {
    const rowR = (label, value, big = false) => {
      doc.setFont('helvetica', big ? 'bold' : 'normal').setFontSize(big ? 13 : 10).setTextColor(...(big ? ink : muted));
      doc.text(clean(label), W - M - 46, y, { align: 'right' }).text(clean(value), W - M, y, { align: 'right' });
      y += big ? 8 : 5.5;
    };
    if (remito.discount) { rowR('Subtotal', fmtM(remito.subtotal)); rowR(`Descuento ${fmtN(remito.discount)} %`, `- ${fmtM(remito.subtotal - remito.total)}`); }
    rowR('TOTAL', fmtM(remito.total), true);
    if (remito.payment) rowR('Forma de pago', PAYMENTS[remito.payment] || '');
    y += 2;
  }
  if (remito.note) {
    doc.setFont('helvetica', 'normal').setFontSize(9.5).setTextColor(...muted);
    const n = doc.splitTextToSize(clean(`Observaciones: ${remito.note}`), W - 2 * M);
    doc.text(n, M, y); y += n.length * 4.5 + 4;
  }
  if (remito.by) { doc.setFontSize(9).setTextColor(...muted).text(clean(`Preparado por: @${remito.by}`), M, y); y += 6; }

  // Firmas
  if (y > 250) { doc.addPage(); y = M + 10; }
  y = Math.max(y + 18, 250);
  doc.setDrawColor(...muted).setLineWidth(0.3);
  [[M, 'Firma'], [M + 62, 'Aclaración'], [M + 124, 'DNI']].forEach(([x, t]) => { doc.line(x, y, x + 54, y); doc.setFontSize(8.5).setTextColor(...muted).text(t, x, y + 4.5); });
  doc.setFontSize(8).text(remito.kind === 'entrada' ? 'Recibí la mercadería detallada.' : 'Recibí conforme la mercadería detallada.', M, y + 11);
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) { doc.setPage(p); doc.setFontSize(7.5).setTextColor(...muted).text(`${remitoCode(remito)} · página ${p} de ${pages} · StockVoz`, W / 2, 290, { align: 'center' }); }
  return doc.output('blob');
}

export const remitoFileName = r => `${r.priced ? (r.kind === 'entrada' ? 'Compra' : 'Venta') : 'Remito'}_${remitoCode(r)}${r.contact?.name ? '_' + r.contact.name.replace(/[^\w]+/g, '_').slice(0, 30) : ''}.pdf`;

// Compartir: en el celular abre el menú para compartir con WhatsApp (adjunta el PDF).
// En la computadora descarga el PDF y abre WhatsApp con el mensaje, para adjuntarlo.
export async function shareRemito(remito, opts) {
  const blob = await buildRemitoPDF(remito, opts), fmtM = n => fmtMoney(remito, n);
  const file = new File([blob], remitoFileName(remito), { type: 'application/pdf' });
  const text = `Hola${remito.contact?.name ? ' ' + remito.contact.name : ''}, te envío ${remito.priced ? 'el comprobante' : 'el remito'} ${remitoCode(remito)} (${remito.lines.length} artículo${remito.lines.length === 1 ? '' : 's'}${remito.priced ? `, total ${fmtM(remito.total)}` : ''}).`;
  if (navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try { await navigator.share({ files: [file], title: remitoCode(remito), text }); return 'shared'; }
    catch (e) { if (e?.name === 'AbortError') return 'cancelled'; }
  }
  download(blob, file.name);
  const phone = waNumber(remito.contact?.phone);
  window.open(phone ? waLink(phone, text) : `https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  return 'downloaded';
}
export async function downloadRemito(remito, opts) {
  download(await buildRemitoPDF(remito, opts), remitoFileName(remito));
}
