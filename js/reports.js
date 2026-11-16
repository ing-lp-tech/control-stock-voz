// Reportes (solo la dueña): ventas, costo y ganancia, ingresos, clientes, equipo y controles para detectar faltantes.
import { esc, fmt, icon, moneyIn, round2 } from './utils.js';
import * as S from './store.js';

// Los reportes de dinero se muestran en una sola moneda: en pesos si se cobra en pesos con el dólar blue.
const money = n => moneyIn(n, S.reportCurrency());

const DAY = 86400000;
const dayKey = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
const monthKey = d => { const x = new Date(d); return new Date(x.getFullYear(), x.getMonth(), 1).getTime(); };
const addDays = (t, n) => { const x = new Date(t); x.setDate(x.getDate() + n); return x.getTime(); };
const addMonths = (t, n) => { const x = new Date(t); x.setMonth(x.getMonth() + n); return x.getTime(); };
const name = i => [i?.brand, i?.type].filter(Boolean).join(' · ');
const dz = u => `${fmt(u / 12)} doc.`;
const pct = v => (v == null || !isFinite(v) ? '—' : `${fmt(v * 100, 1)} %`);

// ---------- Período elegido → rango de fechas [from, to) en milisegundos ----------
// "2026-11-15" ↔ fecha local
export const parseDay = s => { const [y, m, d] = String(s || '').split('-').map(Number); return y && m && d ? new Date(y, m - 1, d).getTime() : null; };
export const isoDay = t => { const x = new Date(t); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
export function periodRange({ period = '30', from = '', to = '' } = {}) {
  const today = dayKey(Date.now()), tomorrow = addDays(today, 1);
  let r;
  switch (String(period)) {
    case 'hoy': r = [today, tomorrow]; break;
    case 'ayer': r = [addDays(today, -1), today]; break;
    case 'mes': r = [monthKey(today), tomorrow]; break;
    case 'mes-ant': r = [addMonths(monthKey(today), -1), monthKey(today)]; break;
    case '0': r = [0, tomorrow]; break;
    case 'rango': {
      let f = parseDay(from) ?? monthKey(today), t = parseDay(to) ?? today;
      if (f > t) [f, t] = [t, f];
      r = [f, addDays(t, 1)]; break;
    }
    default: r = [addDays(today, -((Number(period) || 30) - 1)), tomorrow];
  }
  return { from: r[0], to: r[1] };
}
const inRange = (at, { from = 0, to = Infinity } = {}) => { const t = new Date(at).getTime(); return t >= from && t < to; };
// Texto del rango: "1 nov – 15 nov 2026" o "domingo, 15 de noviembre de 2026".
function rangeLabel(start, to) {
  const last = addDays(to, -1), sameYear = new Date(start).getFullYear() === new Date(last).getFullYear();
  const d = (t, y) => { const x = new Date(t); return `${x.getDate()} ${x.toLocaleDateString('es-AR', { month: 'short' }).replace('.', '')}${y ? ` ${x.getFullYear()}` : ''}`; };
  return dayKey(start) === dayKey(last) ? new Date(start).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : `${d(start, !sameYear)} – ${d(last, true)}`;
}
// Para el nombre de los archivos exportados.
export const rangeTag = ({ from, to }) => `${from ? isoDay(from) : 'inicio'}_a_${isoDay(addDays(to, -1))}`;

// Movimientos válidos del período (sin anulados), con la cantidad efectiva (si se corrigió, la corregida).
export function periodRows(history, opts = {}) {
  return history.filter(h => !h.lite && inRange(h.at, opts) && (!opts.user || h.by === opts.user));
}

// Comprobantes del período (ventas, compras y remitos).
export function periodRemitos(remitos, opts = {}) {
  return remitos.filter(r => inRange(r.at, opts) && (!opts.user || r.by === opts.user));
}

// Cortes del período por día o por mes, con sus etiquetas.
function buckets(from, to, unit) {
  const out = [], next = unit === 'month' ? t => addMonths(t, 1) : t => addDays(t, 1);
  for (let t = unit === 'month' ? monthKey(from) : dayKey(from); t < to && out.length < 1000; t = next(t)) {
    const d = new Date(t);
    out.push(unit === 'month'
      ? { t, label: d.toLocaleDateString('es-AR', { month: 'short', year: '2-digit' }), long: d.toLocaleDateString('es-AR', { month: 'long', year: 'numeric' }) }
      : { t, label: d.toLocaleDateString('es-AR', { day: 'numeric', month: 'short' }), long: d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' }) });
  }
  return out;
}
const keyOf = unit => (unit === 'month' ? monthKey : dayKey);
// Primer día real del período (en "Todo", el del primer registro).
const startOf = (opts, dates) => (opts.from ? opts.from : dayKey(dates.reduce((m, a) => Math.min(m, new Date(a).getTime()), Date.now())));
const spanDays = (from, to) => Math.max(1, Math.round((to - from) / DAY));

// Ventas y compras (solo comprobantes con precios y no anulados), llevadas a la moneda de los reportes con la
// cotización que usó cada venta. El costo de cada línea es el que tenía el producto al venderse (las ventas
// anteriores a que se guardara usan el costo actual). La ganancia y el margen se calculan sobre lo que tiene costo.
function computeSales(state, opts) {
  const list = periodRemitos(state.extra.remitos, opts).filter(r => r.priced && !r.voided);
  const sales = list.filter(r => r.kind !== 'entrada'), buys = list.filter(r => r.kind === 'entrada');
  const cur = S.reportCurrency(), conv = (r, n, from = S.remitoCurrency(r)) => S.convert(Number(n) || 0, from, cur, r.fx?.rate) ?? 0;
  const total = l => round2(l.reduce((s, r) => s + conv(r, r.total), 0));
  const start = startOf(opts, sales.map(r => r.at));
  const group = opts.group === 'day' || opts.group === 'month' ? opts.group : spanDays(start, opts.to) > 62 ? 'month' : 'day';
  const periods = buckets(start, opts.to, group).map(b => ({ ...b, count: 0, amount: 0, cost: 0, covered: 0 }));
  const pIndex = new Map(periods.map((b, i) => [b.t, i])), bucketKey = keyOf(group);
  const bySku = new Map(), byClient = new Map(), byPay = new Map();
  let cost = 0, covered = 0;
  for (const r of sales) {
    const k = r.subtotal ? r.total / r.subtotal : 1; // descuento repartido en las líneas
    const p = periods[pIndex.get(bucketKey(r.at))];
    if (p) { p.count++; p.amount += conv(r, r.total); }
    for (const l of r.lines) {
      const amount = conv(r, l.amount) * k, item = S.findByCode(l.sku);
      const g = bySku.get(l.sku) || { key: l.sku, item, name: l.name, amount: 0, units: 0, cost: 0, covered: 0 };
      g.amount += amount; g.units += Number(l.units) || 0;
      const c = l.cost > 0 ? conv(r, S.lineAmount(l.units, l.cost, l.costPer), r.costCurrency || S.currency())
        : item?.cost > 0 ? conv(r, S.lineAmount(l.units, item.cost, S.pricePerOf(item)), S.currency()) : null;
      if (c != null && amount > 0) { g.cost += c; g.covered += amount; cost += c; covered += amount; if (p) { p.cost += c; p.covered += amount; } }
      bySku.set(l.sku, g);
    }
    const c = r.contact?.name || 'Sin cliente', gc = byClient.get(c) || { key: c, amount: 0, count: 0 };
    gc.amount += conv(r, r.total); gc.count++; byClient.set(c, gc);
    const pay = S.PAYMENTS[r.payment] || 'Sin indicar', gp = byPay.get(pay) || { key: pay, amount: 0, count: 0 };
    gp.amount += conv(r, r.total); gp.count++; byPay.set(pay, gp);
  }
  const sort = m => [...m.values()].sort((a, b) => b.amount - a.amount);
  const salesTotal = total(sales);
  return {
    salesTotal, salesCount: sales.length, ticket: sales.length ? salesTotal / sales.length : 0, buysTotal: total(buys), buysCount: buys.length,
    cost: round2(cost), covered: round2(covered), profit: covered ? round2(covered - cost) : null, profitCoverage: salesTotal ? covered / salesTotal : 0,
    group, periods: periods.filter(p => p.count).reverse(), bySku: sort(bySku), byClient: sort(byClient), byPay: sort(byPay),
  };
}

export function computeReport(state, opts) {
  const rows = periodRows(state.history, opts);
  const moves = rows.filter(h => !h.voided && ['in', 'out', 'count'].includes(S.historyKind(h)));
  const qty = h => S.effectiveQty(h);
  const outs = moves.filter(h => S.historyKind(h) === 'out'), ins = moves.filter(h => S.historyKind(h) === 'in');
  const sum = list => list.reduce((s, h) => s + qty(h), 0);
  const remitos = periodRemitos(state.extra.remitos, opts);

  // Serie por día (o por mes si el período es largo)
  const start = startOf(opts, [...rows.map(h => h.at), ...remitos.map(r => r.at)]);
  const unit = spanDays(start, opts.to) > 92 ? 'month' : 'day';
  const daily = buckets(start, opts.to, unit).map(b => ({ ...b, in: 0, out: 0 }));
  const dIndex = new Map(daily.map((d, i) => [d.t, i])), bucketKey = keyOf(unit);
  for (const h of [...ins, ...outs]) {
    const d = daily[dIndex.get(bucketKey(h.at))];
    if (d) d[S.historyKind(h)] += qty(h);
  }

  const group = (list, keyFn) => {
    const m = new Map();
    for (const h of list) { const k = keyFn(h); if (!k) continue; const g = m.get(k) || { key: k, units: 0, count: 0, last: h.at }; g.units += qty(h); g.count++; if (h.at > g.last) g.last = h.at; m.set(k, g); }
    return [...m.values()].sort((a, b) => b.units - a.units);
  };
  const bySku = group(outs, h => h.sku).map(g => ({ ...g, item: S.findByCode(g.key) }));
  const byBrand = group(outs, h => h.brand || 'Sin marca');
  const byType = group(outs, h => h.type || 'Sin prenda');
  const byClient = group(outs.filter(h => h.contact), h => h.contact.name);
  const bySupplier = group(ins.filter(h => h.contact), h => h.contact.name);

  // Equipo
  const people = new Map();
  for (const h of rows) {
    const who = h.by || 'sin usuario', p = people.get(who) || { who, moves: 0, in: 0, out: 0, counts: 0, reverts: 0, voidedBy: 0, last: h.at };
    const k = S.historyKind(h);
    if (k === 'in' && !h.voided) { p.moves++; p.in += qty(h); }
    if (k === 'out' && !h.voided) { p.moves++; p.out += qty(h); }
    if (k === 'count' && !h.voided) { p.moves++; p.counts++; }
    if (k === 'fix' && /revertida/i.test(h.note || '')) p.reverts++;
    if (h.voided) p.voidedBy++;
    if (h.at > p.last) p.last = h.at;
    people.set(who, p);
  }

  // Controles
  const fixes = rows.filter(h => S.historyKind(h) === 'fix');
  const shortCounts = moves.filter(h => S.historyKind(h) === 'count' && h.after < h.before).map(h => ({ ...h, diff: h.before - (h.corrected?.to?.after ?? h.after) })).sort((a, b) => b.diff - a.diff);
  const noClient = outs.filter(h => !h.contact);
  const offHours = moves.filter(h => { const hr = new Date(h.at).getHours(); return hr < (opts.openHour ?? 7) || hr >= (opts.closeHour ?? 21); });
  const manual = rows.filter(h => /Ajuste|Edición manual del stock/.test(h.action + ' ' + (h.note || '')));

  // Sin movimiento en el período (con stock)
  const moved = new Set(moves.map(h => h.sku));
  const idle = state.items.filter(i => i.units > 0 && !moved.has(i.sku)).sort((a, b) => b.units - a.units);

  const sales = opts.prices ? computeSales(state, opts) : null;
  return { sales, rows, outs, ins, totalOut: sum(outs), totalIn: sum(ins), daily, unit, label: rangeLabel(start, opts.to), bySku, byBrand, byType, byClient, bySupplier, people: [...people.values()].sort((a, b) => b.moves - a.moves), fixes, shortCounts, noClient, offHours, manual, idle, remitos };
}

// ---------- Gráfico: ingresos y salidas por día o mes (un eje, dos series, leyenda, tooltip y tabla) ----------
export function dailyChart(daily, unit = 'day') {
  const W = 720, H = 220, P = { t: 12, r: 8, b: 26, l: 44 };
  const max = Math.max(1, ...daily.flatMap(d => [d.in, d.out]));
  const nice = (() => { const p = 10 ** Math.floor(Math.log10(max)); const m = max / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; })();
  const iw = W - P.l - P.r, ih = H - P.t - P.b, slot = iw / daily.length;
  const bw = Math.max(2, Math.min(14, (slot - 2 - 4) / 2));        // 2px de separación entre las dos barras
  const y = v => P.t + ih - (v / nice) * ih;
  const bar = (x, v, cls) => {
    if (v <= 0) return '';
    const top = y(v), h = P.t + ih - top, r = Math.min(4, bw / 2, h);   // extremo redondeado de 4px, base recta
    return `<path class="${cls}" d="M${x},${P.t + ih} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${P.t + ih} Z"/>`;
  };
  const ticks = [0, .25, .5, .75, 1].map(f => f * nice);
  const every = Math.ceil(daily.length / 8);
  const bars = daily.map((d, i) => {
    const cx = P.l + i * slot + slot / 2;
    return `<g class="day" data-i="${i}">
      <rect class="hit" x="${P.l + i * slot}" y="${P.t}" width="${slot}" height="${ih}"/>
      ${bar(cx - bw - 1, d.in, 'b-in')}${bar(cx + 1, d.out, 'b-out')}
      ${i % every === 0 ? `<text class="ax" x="${cx}" y="${H - 8}" text-anchor="middle">${esc(d.label)}</text>` : ''}</g>`;
  }).join('');
  const grid = ticks.map(v => `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${P.l - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v, 0)}</text>`).join('');
  const table = `<div class="table-wrap chart-table" hidden><table class="table"><thead><tr><th>${unit === 'month' ? 'Mes' : 'Día'}</th><th>Ingresos (u.)</th><th>Salidas (u.)</th></tr></thead><tbody>${daily.slice().reverse().map(d => `<tr><td>${esc(d.long)}</td><td>${fmt(d.in)}</td><td>${fmt(d.out)}</td></tr>`).join('')}</tbody></table></div>`;
  return `<div class="viz" data-daily='${esc(JSON.stringify(daily.map(({ long, in: i, out }) => ({ long, in: i, out }))))}'>
    <div class="viz-head"><div class="legend"><span><i class="sw sw-in"></i>Ingresos</span><span><i class="sw sw-out"></i>Salidas</span></div><button type="button" class="btn btn-ghost btn-sm" data-viz-table>Ver tabla</button></div>
    <div class="viz-plot"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Unidades ingresadas y salidas por ${unit === 'month' ? 'mes' : 'día'}">${grid}${bars}<line class="base" x1="${P.l}" x2="${W - P.r}" y1="${P.t + ih}" y2="${P.t + ih}"/></svg><div class="viz-tip" hidden></div></div>${table}</div>`;
}
// Tooltip del gráfico (se engancha una vez sobre el contenedor de reportes).
export function bindChart(root) {
  root.addEventListener('pointermove', e => {
    const g = e.target.closest?.('.viz .day'), viz = e.target.closest?.('.viz');
    root.querySelectorAll('.viz .day.on').forEach(x => x !== g && x.classList.remove('on'));
    if (!viz) return;
    const tip = viz.querySelector('.viz-tip');
    if (!g) { tip.hidden = true; return; }
    const d = JSON.parse(viz.dataset.daily)[Number(g.dataset.i)];
    g.classList.add('on');
    tip.innerHTML = `<strong>${esc(d.long)}</strong><span><i class="sw sw-in"></i>Ingresos <b>${fmt(d.in)} u.</b></span><span><i class="sw sw-out"></i>Salidas <b>${fmt(d.out)} u.</b></span>`;
    const box = viz.querySelector('.viz-plot').getBoundingClientRect();
    tip.hidden = false;
    const x = Math.min(Math.max(e.clientX - box.left + 12, 0), box.width - tip.offsetWidth);
    tip.style.transform = `translate(${x}px, ${Math.max(0, e.clientY - box.top - tip.offsetHeight - 10)}px)`;
  });
  root.addEventListener('pointerleave', () => root.querySelectorAll('.viz-tip').forEach(t => { t.hidden = true; }), true);
  root.addEventListener('click', e => {
    const b = e.target.closest('[data-viz-table]');
    if (!b) return;
    const t = b.closest('.viz').querySelector('.chart-table');
    t.hidden = !t.hidden;
    b.textContent = t.hidden ? 'Ver tabla' : 'Ocultar tabla';
  });
}

// Barras horizontales de una sola serie con etiqueta directa (no necesitan leyenda).
function hbars(list, { label, sub, limit = 10 }) {
  const top = list.slice(0, limit), max = Math.max(1, ...top.map(g => g.units));
  return `<div class="hbars">${top.map(g => `<div class="hbar" ${g.item ? `data-open-product="${esc(g.key)}" role="button" tabindex="0"` : ''}>
    <div class="hbar-label"><strong>${esc(label(g))}</strong>${sub ? `<span>${esc(sub(g))}</span>` : ''}</div>
    <div class="hbar-track"><span style="width:${Math.max(2, (g.units / max) * 100)}%"></span></div>
    <div class="hbar-val">${fmt(g.units)} u.<span>${dz(g.units)}</span></div></div>`).join('')}</div>`;
}
// Igual que hbars, pero en pesos.
function mbars(list, { label, sub, limit = 8 }) {
  const top = list.slice(0, limit), max = Math.max(1, ...top.map(g => g.amount));
  return `<div class="hbars">${top.map(g => `<div class="hbar" ${g.item ? `data-open-product="${esc(g.key)}" role="button" tabindex="0"` : ''}>
    <div class="hbar-label"><strong>${esc(label(g))}</strong>${sub ? `<span>${esc(sub(g))}</span>` : ''}</div>
    <div class="hbar-track"><span style="width:${Math.max(2, (g.amount / max) * 100)}%"></span></div>
    <div class="hbar-val">${money(g.amount)}</div></div>`).join('')}</div>`;
}

// Tabla de vendido / costo / ganancia / margen (en el celular cada fila es una tarjeta).
// El costo se marca con * cuando parte de lo vendido no tiene costo cargado: ganancia y margen se calculan sin esa parte.
function profitCells(g) {
  const profit = g.covered ? g.covered - g.cost : null, margin = g.covered ? profit / g.covered : null, partial = g.covered < g.amount - 0.005;
  return `<td class="num" data-l="Vendido">${money(g.amount)}</td>
    <td class="num" data-l="Costo">${g.covered ? `${money(g.cost)}${partial ? '<sup title="Hay productos sin costo cargado">*</sup>' : ''}` : '<span class="muted">Sin costo</span>'}</td>
    <td class="num ${profit < 0 ? 'warn' : ''}" data-l="Ganancia">${profit == null ? '—' : money(profit)}</td>
    <td class="num ${margin < 0 ? 'warn' : ''}" data-l="Margen">${pct(margin)}</td>`;
}
function profitTable(head, rows, foot) {
  return `<div class="table-wrap"><table class="table profit-table"><thead><tr><th>${head}</th><th class="num">Vendido</th><th class="num">Costo</th><th class="num">Ganancia</th><th class="num">Margen</th></tr></thead>
    <tbody>${rows}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ''}</table></div>`;
}

function salesSection(s, r) {
  if (!s) return '';
  if (!s.salesCount && !s.buysCount) return `<section class="panel"><div class="panel-head"><h3>${icon('cash')} Ventas con precio</h3><p>No hay ventas con precio entre el ${esc(r.label)}. Al escanear una salida, dejá encendido «Es una venta».</p></div></section>`;
  const noCost = s.profit == null, partial = !noCost && s.profitCoverage < 0.999;
  const margin = noCost ? null : s.profit / s.covered, markup = noCost || !s.cost ? null : s.profit / s.cost;
  const hint = noCost ? 'Cargá el costo de los productos para calcularla' : partial ? `sobre el ${fmt(s.profitCoverage * 100, 0)} % de lo vendido (con costo)` : 'lo vendido menos su costo';
  const unitWord = s.group === 'month' ? 'mes' : 'día';
  const totals = { amount: s.salesTotal, cost: s.cost, covered: s.covered };
  return `
  <div class="report-stats">
    <div class="stat"><span>Vendido</span><strong>${money(s.salesTotal)}</strong><small>${fmt(s.salesCount)} venta${s.salesCount === 1 ? '' : 's'} · ticket ${money(s.ticket)}</small></div>
    <div class="stat"><span>Costo de lo vendido</span><strong>${noCost ? '—' : money(s.cost)}</strong><small>${noCost ? 'Sin costos cargados' : partial ? 'solo productos con costo' : 'lo que te costó la mercadería'}</small></div>
    <div class="stat"><span>Ganancia</span><strong class="${s.profit < 0 ? 'warn' : ''}">${noCost ? '—' : money(s.profit)}</strong><small>${hint}</small></div>
    <div class="stat"><span>Margen</span><strong class="${margin < 0 ? 'warn' : ''}">${pct(margin)}</strong><small>${markup == null ? 'de cada venta' : `de cada venta · ${pct(markup)} sobre el costo`}</small></div>
  </div>

  <section class="panel"><div class="panel-head split"><div><h3>${icon('cash')} Ventas por ${unitWord}</h3><p>Vendido, costo y ganancia · ${esc(r.label)}</p></div>
    <div class="segmented seg-sm" data-rp-group role="group" aria-label="Agrupar ventas"><button type="button" data-v="day" class="${s.group === 'day' ? 'active' : ''}" aria-pressed="${s.group === 'day'}">Por día</button><button type="button" data-v="month" class="${s.group === 'month' ? 'active' : ''}" aria-pressed="${s.group === 'month'}">Por mes</button></div></div>
    ${s.periods.length ? profitTable(s.group === 'month' ? 'Mes' : 'Día',
      s.periods.map(p => `<tr><td class="pt-main"><strong>${esc(p.long)}</strong><small>${fmt(p.count)} venta${p.count === 1 ? '' : 's'}</small></td>${profitCells(p)}</tr>`).join(''),
      s.periods.length > 1 ? `<tr><td class="pt-main"><strong>Total</strong><small>${fmt(s.salesCount)} ventas</small></td>${profitCells(totals)}</tr>` : '')
      : empty('No hubo ventas con precio en el período.')}
    ${partial ? '<p class="hint">* Algunas ventas tienen productos sin costo cargado: la ganancia y el margen se calculan solo con los que tienen costo.</p>' : ''}
  </section>

  <section class="panel"><div class="panel-head"><h3>Ganancia por producto</h3><p>Lo vendido de cada producto, su costo y su margen (con descuentos)</p></div>
    ${s.bySku.length ? profitTable('Producto', s.bySku.slice(0, 25).map(g => `<tr ${g.item ? `data-open-product="${esc(g.key)}"` : ''}><td class="pt-main"><strong class="code">${esc(g.key)}</strong><small>${esc(name(g.item) || g.name || 'Producto eliminado')} · ${fmt(g.units)} u.</small></td>${profitCells(g)}</tr>`).join(''))
      + (s.bySku.length > 25 ? `<p class="hint">y ${s.bySku.length - 25} productos más. Exportá las ventas para ver todo.</p>` : '') : empty('Sin ventas con precio.')}
  </section>

  <div class="grid-2">
    <section class="panel"><div class="panel-head"><h3>Clientes por importe</h3><p>Cuánto compró cada uno</p></div>${s.byClient.length ? mbars(s.byClient, { label: g => g.key, sub: g => `${g.count} compra${g.count === 1 ? '' : 's'}` }) : empty('Sin datos.')}</section>
    <section class="panel"><div class="panel-head"><h3>Formas de pago</h3><p>Total cobrado por cada una</p></div>${s.byPay.length ? mbars(s.byPay, { label: g => g.key, sub: g => `${g.count} venta${g.count === 1 ? '' : 's'}` }) : empty('Sin datos.')}</section>
  </div>`;
}
const empty = t => `<p class="muted small" style="padding:8px 0">${esc(t)}</p>`;
const when = iso => new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function renderReport(r) {
  const people = r.people.filter(p => p.who !== 'sin usuario' || p.moves);
  const alerts = r.fixes.length + r.shortCounts.length + r.offHours.length;
  const s = r.sales;
  return `<p class="rp-caption">${icon('clock', 'sm')}<span>${esc(r.label)}</span></p>
  ${salesSection(s, r)}
  <div class="report-stats">
    <div class="stat"><span>Salidas</span><strong>${fmt(r.totalOut)} u.</strong><small>${dz(r.totalOut)} · ${fmt(r.outs.length)} movimientos</small></div>
    <div class="stat"><span>Ingresos</span><strong>${fmt(r.totalIn)} u.</strong><small>${dz(r.totalIn)} · ${fmt(r.ins.length)} movimientos${s?.buysCount ? ` · compras ${money(s.buysTotal)}` : ''}</small></div>
    <div class="stat"><span>Remitos</span><strong>${fmt(r.remitos.length)}</strong><small>${fmt(r.byClient.length)} clientes con compras</small></div>
    <div class="stat"><span>Para revisar</span><strong class="${alerts ? 'warn' : ''}">${fmt(alerts)}</strong><small>correcciones, faltantes y horarios</small></div>
  </div>

  <section class="panel"><div class="panel-head"><h3>Ingresos y salidas por ${r.unit === 'month' ? 'mes' : 'día'}</h3><p>Unidades · ${esc(r.label)}</p></div>${dailyChart(r.daily, r.unit)}</section>

  <div class="grid-2">
    <section class="panel"><div class="panel-head"><h3>Lo más vendido</h3><p>Por unidades que salieron</p></div>
      ${r.bySku.length ? hbars(r.bySku, { label: g => g.key, sub: g => name(g.item) || 'Producto eliminado' }) : empty('Todavía no hay salidas en este período.')}</section>
    <section class="panel"><div class="panel-head"><h3>Clientes</h3><p>Unidades que se llevaron</p></div>
      ${r.byClient.length ? hbars(r.byClient, { label: g => g.key, sub: g => `${g.count} salidas · última ${when(g.last)}` }) : empty('Asigná un cliente al registrar salidas para verlo acá.')}</section>
    <section class="panel"><div class="panel-head"><h3>Por marca</h3><p>Salidas</p></div>${r.byBrand.length ? hbars(r.byBrand, { label: g => g.key, limit: 8 }) : empty('Sin datos.')}</section>
    <section class="panel"><div class="panel-head"><h3>Por prenda</h3><p>Salidas</p></div>${r.byType.length ? hbars(r.byType, { label: g => g.key, limit: 8 }) : empty('Sin datos.')}</section>
  </div>

  <section class="panel"><div class="panel-head"><h3>Equipo</h3><p>Qué registró cada persona en el período</p></div>
    ${people.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Usuario</th><th class="num">Movimientos</th><th class="num">Ingresó (u.)</th><th class="num">Salió (u.)</th><th class="num">Conteos</th><th class="num">Revirtió</th><th class="num">Le anularon</th><th>Último</th></tr></thead><tbody>
      ${people.map(p => `<tr><td><strong>${p.who === 'sin usuario' ? 'Sin usuario (modo local)' : '@' + esc(p.who)}</strong></td><td class="num">${fmt(p.moves)}</td><td class="num">${fmt(p.in)}</td><td class="num">${fmt(p.out)}</td><td class="num">${fmt(p.counts)}</td><td class="num ${p.reverts ? 'warn' : ''}">${fmt(p.reverts)}</td><td class="num ${p.voidedBy ? 'warn' : ''}">${fmt(p.voidedBy)}</td><td>${esc(when(p.last))}</td></tr>`).join('')}
    </tbody></table></div>` : empty('Sin movimientos en el período.')}</section>

  <section class="panel"><div class="panel-head"><h3>${icon('shield')} Control de faltantes</h3><p>Señales para revisar. No significan que haya un error: miralas con calma.</p></div>
    <div class="checks">
      <div class="check-block"><h4>Conteos con faltante <span class="count">${r.shortCounts.length}</span></h4>
        ${r.shortCounts.length ? `<ul>${r.shortCounts.slice(0, 8).map(h => `<li data-open-product="${esc(h.sku)}"><b class="code">${esc(h.sku)}</b> faltaron <b>${fmt(h.diff)} u.</b> · ${esc(when(h.at))}${h.by ? ` · @${esc(h.by)}` : ''}</li>`).join('')}</ul>` : empty('Ningún conteo dio menos que el stock registrado.')}</div>
      <div class="check-block"><h4>Correcciones, anulaciones y reversiones <span class="count">${r.fixes.length}</span></h4>
        ${r.fixes.length ? `<ul>${r.fixes.slice(0, 8).map(h => `<li data-open-product="${esc(h.sku)}"><b class="code">${esc(h.sku)}</b> ${esc(h.action.toLowerCase())} · ${esc(when(h.at))}${h.by ? ` · @${esc(h.by)}` : ''}<br><span class="muted">${esc(h.note || '')}</span></li>`).join('')}</ul>` : empty('No hubo correcciones.')}</div>
      <div class="check-block"><h4>Salidas sin cliente <span class="count">${r.noClient.length}</span></h4>
        ${r.noClient.length ? `<p class="small">${fmt(r.noClient.reduce((s, h) => s + S.effectiveQty(h), 0))} unidades salieron sin un cliente asignado. Pedí al equipo que elija el cliente en cada salida.</p>` : empty('Todas las salidas tienen cliente.')}</div>
      <div class="check-block"><h4>Movimientos fuera de horario <span class="count">${r.offHours.length}</span></h4>
        ${r.offHours.length ? `<ul>${r.offHours.slice(0, 6).map(h => `<li data-open-product="${esc(h.sku)}"><b class="code">${esc(h.sku)}</b> ${esc(h.action.toLowerCase())} · ${esc(when(h.at))}${h.by ? ` · @${esc(h.by)}` : ''}</li>`).join('')}</ul>` : empty('Todo se registró entre las 7 y las 21 h.')}</div>
    </div></section>

  <section class="panel"><div class="panel-head"><h3>Sin movimiento</h3><p>Productos con stock que no se movieron en el período</p></div>
    ${r.idle.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Código</th><th>Producto</th><th class="num">Stock</th></tr></thead><tbody>${r.idle.slice(0, 15).map(i => { const d = S.displayQty(i); return `<tr data-open-product="${esc(i.sku)}"><td><b class="code">${esc(i.sku)}</b></td><td>${esc(name(i) || '—')}</td><td class="num">${fmt(d.value)} ${esc(d.unit)}</td></tr>`; }).join('')}</tbody></table></div>${r.idle.length > 15 ? `<p class="hint">y ${r.idle.length - 15} más.</p>` : ''}` : empty('Todos los productos con stock tuvieron movimiento.')}</section>`;
}
