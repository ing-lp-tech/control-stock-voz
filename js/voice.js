// Dictado por voz: interpretación del texto y control del reconocimiento del navegador.
import { txt } from './utils.js';

const UNIT_PATTERN = 'docenas?|unidades?|piezas?|cajas?|paquetes?|pares?|rollos?|kilogramos?|kg|gramos?|metros?|litros?';
const NUMBER_WORDS = {
  uno: 1, una: 1, un: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, docena: 12,
  trece: 13, catorce: 14, quince: 15, dieciseis: 16, 'dieciséis': 16, diecisiete: 17, dieciocho: 18, diecinueve: 19, veinte: 20,
  veintiuno: 21, veintiuna: 21, veintidos: 22, 'veintidós': 22, veintitres: 23, 'veintitrés': 23, veinticuatro: 24, veinticinco: 25,
  veintiseis: 26, 'veintiséis': 26, veintisiete: 27, veintiocho: 28, veintinueve: 29, treinta: 30, cuarenta: 40, cincuenta: 50,
  sesenta: 60, setenta: 70, ochenta: 80, noventa: 90, cien: 100,
};
const GARMENTS = ['remera', 'remeras', 'pantalon', 'pantalón', 'pantalones', 'calza', 'calzas', 'campera', 'camperas', 'buzo', 'buzos', 'short', 'shorts', 'body', 'conjunto', 'vestido', 'pollera', 'chomba', 'camiseta', 'medias', 'camisa', 'camisas', 'jean', 'jeans'];

// Ej.: "Marca URUS, prenda short, código N115, docenas 18" → { brand, type, sku, qty, unit, operation, ... }
export function parseSpeech(s) {
  // Normalizamos números hablados, pero nunca inferimos la cantidad desde los dígitos del SKU.
  let t = txt(s).toLocaleLowerCase('es-AR').replace(/[，]/g, ',');
  for (const [w, n] of Object.entries(NUMBER_WORDS)) t = t.replace(new RegExp('\\b' + w + '\\b', 'gi'), String(n));

  // En móviles el reconocedor puede repetir hipótesis y partir un SKU en segmentos:
  // tomamos los fragmentos dichos después de cada "código" hasta el siguiente campo.
  const codeMarker = /(?:c[oó]digo(?:\s+de\s+barras)?|sku|art[ií]culo)\s*(?:es\s*)?/ig;
  const unitStart = new RegExp(`(?:^|\\s)(?:${UNIT_PATTERN})\\b`, 'i');
  const markers = [...t.matchAll(codeMarker)];
  let sku = '';
  if (markers.length) {
    const chunks = [];
    for (let i = 0; i < markers.length; i++) {
      const from = markers[i].index + markers[i][0].length;
      let to = i + 1 < markers.length ? markers[i + 1].index : t.length;
      const rest = t.slice(from, to);
      const field = /(?:\bmarca\b|\bprenda\b|\btipo\b)/i.exec(rest);
      const unit = unitStart.exec(rest);
      if (field) to = Math.min(to, from + field.index);
      if (unit) to = Math.min(to, from + unit.index);
      const m = t.slice(from, to).trim().match(/^([a-z]*\s*\d+(?:[\s-]*[a-z0-9]+)*)/i);
      if (m) { const part = m[1].replace(/[^a-z0-9-]/gi, '').toUpperCase(); if (part) chunks.push(part); }
    }
    if (chunks.length) {
      sku = chunks[0];
      for (const part of chunks.slice(1)) {
        // Si el móvil repitió el segmento (T12 y T12), unir sin repetir la letra inicial: T12 + T12 → T1212.
        const lead = sku.match(/^[A-Z]+/)?.[0] || '', nextLead = part.match(/^[A-Z]+/)?.[0] || '';
        sku += lead && nextLead && lead === nextLead ? part.slice(nextLead.length) : part;
      }
    }
  }
  if (!sku) {
    const c = [...t.matchAll(/\b[a-z]{1,8}[-]?\d+[a-z0-9-]*\b/ig)].find(m => !/^marca$/i.test(m[0]));
    sku = c ? c[0].toUpperCase() : '';
  }

  const brandMatches = [...t.matchAll(/marca\s+([a-záéíóúüñ][a-záéíóúüñ0-9-]*)/ig)];
  const typeMatches = [...t.matchAll(/(?:prenda|tipo)\s+([a-záéíóúüñ0-9-]+)/ig)];
  const bm = brandMatches.at(-1), tm = typeMatches.at(-1);
  const type = tm ? tm[1] : (GARMENTS.find(g => new RegExp('\\b' + g + '\\b', 'i').test(t)) || '');

  // Prioridad: "docenas 16" (número después de la unidad) gana sobre "16 docenas".
  const beforeUnit = new RegExp(`\\b(\\d+(?:[.,]\\d+)?)\\s*(${UNIT_PATTERN})\\b`, 'i');
  const afterUnit = new RegExp(`\\b(${UNIT_PATTERN})\\s*(?:(?:son|de|:|igual(?:es)?\\s+a)\\s*)?(\\d+(?:[.,]\\d+)?)\\b`, 'i');
  const q1 = t.match(beforeUnit), q2 = t.match(afterUnit);
  let qty = null, unitWord = '';
  if (q2) { unitWord = q2[1].toLowerCase(); qty = Number(q2[2].replace(',', '.')); }
  else if (q1) { qty = Number(q1[1].replace(',', '.')); unitWord = q1[2].toLowerCase(); }
  else {
    const withoutSku = sku ? t.replace(new RegExp('\\b' + sku.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i'), ' ') : t;
    const labeled = withoutSku.match(/(?:sumar|agregar|ingresar|tengo|cantidad|stock|restar|quitar|sacar|descontar|establecer|contar)\s+(\d+(?:[.,]\d+)?)/i);
    if (labeled) qty = Number(labeled[1].replace(',', '.'));
    else { const nums = [...withoutSku.matchAll(/\b\d+(?:[.,]\d+)?\b/g)]; if (nums.length) qty = Number(nums.at(-1)[0].replace(',', '.')); }
  }
  const unit = /docena/.test(unitWord) ? 'dozen' : /^caja/.test(unitWord) ? 'box' : /^paquete/.test(unitWord) ? 'package' : /^par/.test(unitWord) ? 'pair'
    : /^rollo/.test(unitWord) ? 'roll' : /^(kg|kilogramo)/.test(unitWord) ? 'kg' : /^gramo/.test(unitWord) ? 'g' : /^metro/.test(unitWord) ? 'm'
    : /^litro/.test(unitWord) ? 'l' : 'unit';
  const count = /\b(contar|conteo|conteo f[ií]sico|stock real|dejar en)\b/i.test(t);
  const subtract = /\b(restar|quitar|sacar|descontar|salida|egreso|despacho)\b/i.test(t);
  return { brand: bm?.[1] || '', type, sku, qty, unit, operation: count ? 'establecer' : subtract ? 'restar' : null };
}

// Algunos motores móviles reenvían hipótesis acumulativas como si fueran frases nuevas: fusionamos solapamientos.
export function mergeSpeechParts(parts) {
  let out = [];
  const norm = a => a.toLocaleLowerCase('es-AR').replace(/[^a-z0-9áéíóúüñ]+/g, ' ').trim();
  for (const raw of parts) {
    const incoming = raw.trim();
    if (!incoming) continue;
    if (!out.length) { out = incoming.split(/\s+/); continue; }
    const cur = norm(out.join(' ')), inc = norm(incoming);
    if (inc === cur || cur.startsWith(inc + ' ')) continue;
    if (inc.startsWith(cur + ' ')) { out = incoming.split(/\s+/); continue; }
    const a = cur.split(' '), b = inc.split(' ');
    let overlap = Math.min(a.length, b.length);
    while (overlap > 0 && a.slice(-overlap).join(' ') !== b.slice(0, overlap).join(' ')) overlap--;
    out = out.concat(incoming.split(/\s+/).slice(overlap));
  }
  return out.join(' ').trim();
}

// Errores con los que no tiene sentido seguir reintentando.
const FATAL = ['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported', 'bad-grammar'];

// Controlador del micrófono. Se reinicia solo si el navegador corta la escucha mientras el usuario no la detuvo,
// pero nunca en bucle: si se corta enseguida varias veces seguidas, se detiene y explica el motivo.
// onState(estado, error): 'listening' | 'sound' | 'speech' | 'nosound' | 'nospeech' | 'retry' | 'error'
export function createRecognizer({ onState, onText, onEnd }) {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.lang = 'es-AR'; rec.continuous = true; rec.interimResults = true; rec.maxAlternatives = 1;
  let wanted = false, base = '', last = '';
  let startedAt = 0, gotSound = false, quickEnds = 0, lastError = '', fatal = '', watchdog = null;

  const stopWith = err => { wanted = false; clearTimeout(watchdog); onState?.('error', err); };
  rec.onstart = () => { startedAt = Date.now(); onState?.(gotSound ? 'speech' : 'listening'); };
  rec.onaudiostart = () => {
    clearTimeout(watchdog);
    // Micrófono abierto pero sin ningún sonido en 6 s: casi siempre es el micrófono equivocado o silenciado.
    watchdog = setTimeout(() => { if (wanted && !gotSound) onState?.('nosound'); }, 6000);
  };
  rec.onsoundstart = () => { gotSound = true; quickEnds = 0; clearTimeout(watchdog); onState?.('sound'); };
  rec.onspeechstart = () => onState?.('speech');
  rec.onresult = e => {
    quickEnds = 0; lastError = '';
    const finals = [], interims = [];
    for (let i = 0; i < e.results.length; i++) {
      const part = e.results[i][0].transcript.trim();
      if (part) (e.results[i].isFinal ? finals : interims).push(part);
    }
    last = [base, mergeSpeechParts(finals), mergeSpeechParts(interims)].filter(Boolean).join(' ').trim();
    onState?.('speech');
    onText?.(last);
  };
  rec.onerror = e => {
    if (e.error === 'aborted') return;
    if (e.error === 'no-speech') { onState?.('nospeech'); return; }
    lastError = e.error;
    if (FATAL.includes(e.error)) fatal = e.error;
    else onState?.('retry');
  };
  rec.onend = () => {
    clearTimeout(watchdog);
    if (!wanted) { onEnd?.(); return; }
    if (fatal) { stopWith(fatal); onEnd?.(); return; }
    if (Date.now() - startedAt < 1500) quickEnds++;
    if (quickEnds >= 3) { stopWith(lastError || 'loop'); onEnd?.(); return; }
    base = last; // lo dictado hasta ahora se conserva tras el reinicio
    setTimeout(() => {
      if (!wanted) return;
      try { rec.start(); } catch { stopWith('loop'); onEnd?.(); }
    }, quickEnds ? 400 * quickEnds : 0);
  };
  return {
    start(initial = '') {
      base = txt(initial); last = base; wanted = true;
      gotSound = false; quickEnds = 0; lastError = ''; fatal = '';
      try { rec.start(); } catch (e) { wanted = false; throw e; }
    },
    stop() { wanted = false; clearTimeout(watchdog); try { rec.stop(); } catch { onEnd?.(); } },
    get active() { return wanted; },
  };
}
