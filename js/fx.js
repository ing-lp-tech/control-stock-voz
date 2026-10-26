// Cotización del dólar blue (precio de venta) para mostrar y cobrar en pesos.
// Se consulta en cada dispositivo al abrir la app y cada 30 minutos; si una fuente no responde se prueba la otra.
const SOURCES = [
  { name: 'dolarapi.com', url: 'https://dolarapi.com/v1/dolares/blue', read: d => ({ rate: Number(d?.venta), at: d?.fechaActualizacion }) },
  { name: 'bluelytics', url: 'https://api.bluelytics.com.ar/v2/latest', read: d => ({ rate: Number(d?.blue?.value_sell), at: d?.last_update }) },
];

// Devuelve { rate, at, source, fetchedAt } o null si ninguna fuente respondió.
export async function fetchBlue() {
  for (const s of SOURCES) {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(s.url, { signal: ctrl.signal, cache: 'no-store' });
      if (!res.ok) continue;
      const v = s.read(await res.json());
      if (v.rate > 0) return { rate: v.rate, at: v.at || new Date().toISOString(), source: s.name, fetchedAt: new Date().toISOString() };
    } catch { /* sin conexión o fuente caída: se prueba la siguiente */ } finally { clearTimeout(timer); }
  }
  return null;
}
