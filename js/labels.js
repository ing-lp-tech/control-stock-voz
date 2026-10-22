// Etiquetas con código de barras (Code 128) o QR, listas para imprimir en rollo térmico o en hoja A4.
import { loadScript, esc, byId } from './utils.js';

const JSBARCODE_URL = 'https://cdn.jsdelivr.net/npm/jsbarcode@3.11.6/dist/JsBarcode.all.min.js';
const QR_URL = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js';
export const MAX_LABELS = 1000;

// w/h en milímetros. "sheet" = hoja con varias etiquetas; si no, una etiqueta por página (rollo).
export const LABEL_SIZES = {
  r50x25: { name: 'Rollo térmico 50 × 25 mm', w: 50, h: 25 },
  r40x30: { name: 'Rollo térmico 40 × 30 mm', w: 40, h: 30 },
  r60x40: { name: 'Rollo térmico 60 × 40 mm', w: 60, h: 40 },
  r100x50: { name: 'Rollo térmico 100 × 50 mm', w: 100, h: 50 },
  r100x150: { name: 'Térmica 100 × 150 mm (etiqueta de envío / fanfold)', w: 100, h: 150 },
  a4_3x8: { name: 'Hoja A4 · 24 etiquetas (3 × 8)', w: 70, h: 37, cols: 3, rows: 8 },
  a4_4x10: { name: 'Hoja A4 · 40 etiquetas (4 × 10)', w: 52.5, h: 29.7, cols: 4, rows: 10 },
  a4_2x5: { name: 'Hoja A4 · 10 etiquetas grandes (2 × 5)', w: 105, h: 59.4, cols: 2, rows: 5 },
};

export async function ensureLibs(kind) {
  if (kind === 'qr') { if (!window.qrcode) await loadScript(QR_URL); }
  else if (!window.JsBarcode) await loadScript(JSBARCODE_URL);
}

function barcodeSVG(value) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  window.JsBarcode(svg, value, { format: 'CODE128', displayValue: false, margin: 0, height: 80, width: 2 });
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.removeAttribute('style');
  return svg.outerHTML;
}
function qrSVG(value) {
  const qr = window.qrcode(0, 'M');
  qr.addData(value);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
}

// entry: { code, name } · opts: { kind: 'barcode'|'qr', size, showName, header }
export function labelHTML(entry, opts) {
  const s = LABEL_SIZES[opts.size] || LABEL_SIZES.r50x25;
  let kind = opts.kind, code;
  try { code = kind === 'qr' ? qrSVG(entry.code) : barcodeSVG(entry.code); }
  catch {
    // Code 128 no admite letras como Ñ o tildes: esa etiqueta sale en QR si la librería está, o con aviso.
    if (window.qrcode) { kind = 'qr'; code = qrSVG(entry.code); }
    else code = '<div class="lbl-error">Código no compatible</div>';
  }
  const header = opts.header ? `<div class="lbl-header">${esc(opts.header)}</div>` : '';
  const name = opts.showName && entry.name ? `<div class="lbl-name">${esc(entry.name)}</div>` : '';
  const sku = `<div class="lbl-sku">${esc(entry.code)}</div>`;
  const body = kind === 'qr'
    ? `<div class="lbl-code">${code}</div><div class="lbl-text">${header}${sku}${name}</div>`
    : `${header}<div class="lbl-code">${code}</div>${sku}${name}`;
  return `<div class="lbl lbl-${kind}" style="--h:${s.h};width:${s.w}mm;height:${s.h}mm">${body}</div>`;
}

export function pageCount(total, size) {
  const s = LABEL_SIZES[size] || LABEL_SIZES.r50x25;
  return s.cols ? Math.ceil(total / (s.cols * s.rows)) : total;
}

export async function printLabels(entries, opts) {
  await ensureLibs(opts.kind);
  const s = LABEL_SIZES[opts.size] || LABEL_SIZES.r50x25;
  const labels = entries.map(e => labelHTML(e, opts));
  let html = '';
  if (s.cols) {
    const per = s.cols * s.rows;
    for (let i = 0; i < labels.length; i += per) {
      html += `<div class="print-page print-sheet" style="width:210mm;height:297mm;grid-template-columns:repeat(${s.cols},${s.w}mm);grid-auto-rows:${s.h}mm">${labels.slice(i, i + per).join('')}</div>`;
    }
  } else {
    html = labels.map(l => `<div class="print-page" style="width:${s.w}mm;height:${s.h}mm">${l}</div>`).join('');
  }
  byId('printArea').innerHTML = html;
  let style = byId('printPageStyle');
  if (!style) { style = document.createElement('style'); style.id = 'printPageStyle'; document.head.append(style); }
  style.textContent = `@page { size: ${s.cols ? 'A4' : `${s.w}mm ${s.h}mm`}; margin: 0; }`;
  document.body.classList.add('printing');
  window.addEventListener('afterprint', () => { document.body.classList.remove('printing'); style.textContent = ''; }, { once: true });
  await new Promise(r => requestAnimationFrame(() => setTimeout(r, 60)));
  window.print();
}
