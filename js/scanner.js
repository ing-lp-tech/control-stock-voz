// Lectura de códigos: pistolas lectoras (USB/Bluetooth en modo teclado) y cámara del dispositivo.
import { loadScript } from './utils.js';

const ZXING_URL = 'https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js';
const FORMATS = ['code_128', 'code_39', 'code_93', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'itf', 'codabar', 'qr_code', 'data_matrix'];

const isEditable = el => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

// Una pistola "teclea" el código en milisegundos y termina con Enter (o Tab).
// Detectamos esa ráfaga cuando el foco NO está en un campo de texto; dentro de un campo, la pistola escribe normalmente.
export function initHardwareScanner(onScan, { minLength = 3, maxGap = 50 } = {}) {
  let buf = '', last = 0, timer;
  document.addEventListener('keydown', e => {
    if (e.ctrlKey || e.altKey || e.metaKey || e.isComposing) return;
    if (isEditable(e.target) || document.querySelector('dialog[open]')) { buf = ''; return; }
    const t = performance.now();
    if (t - last > maxGap) buf = '';
    last = t;
    if (e.key === 'Enter' || e.key === 'Tab') {
      if (buf.length >= minLength) { e.preventDefault(); const code = buf; buf = ''; onScan(code); }
      buf = '';
      return;
    }
    if (e.key.length === 1) buf += e.key;
    clearTimeout(timer);
    timer = setTimeout(() => { buf = ''; }, 400);
  }, true);
}

// Abre la cámara trasera y llama a onCode con cada lectura. Devuelve una función para detener.
export async function startCamera(video, onCode) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador no permite usar la cámara.');
  const constraints = { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false };

  if ('BarcodeDetector' in window) {
    let supported = FORMATS;
    try { supported = (await BarcodeDetector.getSupportedFormats()).filter(f => FORMATS.includes(f)); } catch { /* usar lista por defecto */ }
    if (supported.length) {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      video.srcObject = stream;
      await video.play();
      const detector = new BarcodeDetector({ formats: supported });
      let alive = true, timer;
      const loop = async () => {
        if (!alive) return;
        try { const codes = await detector.detect(video); if (codes[0]?.rawValue) onCode(codes[0].rawValue); } catch { /* cuadro sin código */ }
        timer = setTimeout(loop, 180);
      };
      loop();
      return () => { alive = false; clearTimeout(timer); stream.getTracks().forEach(t => t.stop()); video.srcObject = null; };
    }
  }

  // Navegadores sin BarcodeDetector (iPhone, Firefox, Chrome de Windows): librería ZXing, se descarga solo si se necesita.
  await loadScript(ZXING_URL);
  const reader = new window.ZXing.BrowserMultiFormatReader();
  await reader.decodeFromConstraints(constraints, video, result => { if (result) onCode(result.getText()); });
  return () => { try { reader.reset(); } catch { /* ya detenido */ } video.srcObject = null; };
}
