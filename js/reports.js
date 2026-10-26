// Reportes (solo la dueña): ventas, ingresos, clientes, equipo y controles para detectar faltantes.
import { esc, fmt, icon, moneyIn, round2 } from './utils.js';

// Los reportes de dinero se muestran en una sola moneda: en pesos si se cobra en pesos con el dólar blue.
const money = n => moneyIn(n, S.reportCurrency());
import * as S from './store.js';

const DAY = 86400000;
const dayKey = d => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x.getTime(); };
const name = i => [i?.brand, i?.type].filter(Boolean).join(' · ');
const dz = u => `${fmt(u / 12)} doc.`;

// Movimientos válidos del período (sin anulados), con la cantidad efectiva (si se corrigió, la corregida).
export function periodRows(history, { days = 30, user = '' } = {}) {
  const from = days ? dayKey(Date.now()) - (days - 1) * DAY : 0;
  return history.filter(h => !h.lite && new Date(h.at).getTime() >= from && (!user || h.by === user));
}

// Comprobantes del período (ventas, compras y remitos).
export function periodRemitos(remitos, { days = 30, user = '' } = {}) {
  const from = days ? dayKey(Date.now()) - (days - 1) * DAY : 0;
  return remitos.filter(r => new Date(r.at).getTime() >= from && (!user || r.by === user));
}

// Ventas y compras (solo comprobantes con precios y no anulados), llevadas a la moneda de los reportes con la
// cotización que usó cada venta. La ganancia es estimada: ventas menos el costo actual de lo vendido.
function computeSales(state, opts) {
  const list = periodRemitos(state.extra.remitos, opts).filter(r => r.priced && !r.voided);
  const sales = list.filter(r => r.kind !== 'entrada'), buys = list.filter(r => r.kind === 'entrada');
  const cur = S.reportCurrency(), conv = (r, n, from = S.remitoCurrency(r)) => S.convert(Number(n) || 0, from, cur, r.fx?.rate) ?? 0;
  const total = l => round2(l.reduce((s, r) => s + conv(r, r.total), 0));
  const bySku = new Map(), byClient = new Map(), byPay = new Map();
  let costOfSold = 0, revenueWithCost = 0;
  for (const r of sales) {
    const k = r.subtotal ? r.total / r.subtotal : 1; // descuento repartido en las líneas
    for (const l of r.lines) {
      const amount = conv(r, l.amount) * k, item = S.findByCode(l.sku);
      const g = bySku.get(l.sku) || { key: l.sku, item, amount: 0, units: 0 };
      g.amount += amount; g.units += Number(l.units) || 0; bySku.set(l.sku, g);
      if (item?.cost) { costOfSold += conv(r, S.lineAmount(l.units, item.cost, S.pricePerOf(item)), S.currency()); revenueWithCost += amount; }
    }
    const c = r.contact?.name || 'Sin cliente', gc = byClient.get(c) || { key: c, amount: 0, count: 0 };
    gc.amount += conv(r, r.total); gc.count++; byClient.set(c, gc);
    const p = S.PAYMENTS[r.payment] || 'Sin indicar', gp = byPay.get(p) || { key: p, amount: 0, count: 0 };
    gp.amount += conv(r, r.total); gp.count++; byPay.set(p, gp);
  }
  const sort = m => [...m.values()].sort((a, b) => b.amount - a.amount);
  const salesTotal = total(sales);
  return {
    salesTotal, salesCount: sales.length, ticket: sales.length ? salesTotal / sales.length : 0, buysTotal: total(buys), buysCount: buys.length,
    profit: revenueWithCost ? round2(revenueWithCost - costOfSold) : null, profitCoverage: salesTotal ? revenueWithCost / salesTotal : 0,
    bySku: sort(bySku), byClient: sort(byClient), byPay: sort(byPay),
  };
}

export function computeReport(state, opts) {
  const rows = periodRows(state.history, opts);
  const moves = rows.filter(h => !h.voided && ['in', 'out', 'count'].includes(S.historyKind(h)));
  const qty = h => S.effectiveQty(h);
  const outs = moves.filter(h => S.historyKind(h) === 'out'), ins = moves.filter(h => S.historyKind(h) === 'in');
  const sum = list => list.reduce((s, h) => s + qty(h), 0);

  // Serie diaria
  const days = opts.days || Math.max(7, Math.min(90, Math.ceil((Date.now() - Math.min(...rows.map(h => new Date(h.at).getTime()), Date.now())) / DAY) + 1));
  const start = dayKey(Date.now()) - (days - 1) * DAY;
  const daily = Array.from({ length: days }, (_, i) => ({ t: start + i * DAY, in: 0, out: 0 }));
  for (const h of [...ins, ...outs]) {
    const i = Math.round((dayKey(h.at) - start) / DAY);
    if (daily[i]) daily[i][S.historyKind(h)] += qty(h);
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

  const remitos = state.extra.remitos.filter(r => new Date(r.at).getTime() >= (opts.days ? start : 0) && (!opts.user || r.by === opts.user));
  const sales = opts.prices ? computeSales(state, opts) : null;
  return { sales, rows, outs, ins, totalOut: sum(outs), totalIn: sum(ins), daily, bySku, byBrand, byType, byClient, bySupplier, people: [...people.values()].sort((a, b) => b.moves - a.moves), fixes, shortCounts, noClient, offHours, manual, idle, remitos, days };
}

// ---------- Gráfico: ingresos y salidas por día (un eje, dos series, leyenda, tooltip y tabla) ----------
export function dailyChart(daily) {
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
  const label = t => new Date(t).toLocaleDateString('es-AR', { day: 'numeric', month: 'short' });
  const bars = daily.map((d, i) => {
    const cx = P.l + i * slot + slot / 2;
    return `<g class="day" data-i="${i}">
      <rect class="hit" x="${P.l + i * slot}" y="${P.t}" width="${slot}" height="${ih}"/>
      ${bar(cx - bw - 1, d.in, 'b-in')}${bar(cx + 1, d.out, 'b-out')}
      ${i % every === 0 ? `<text class="ax" x="${cx}" y="${H - 8}" text-anchor="middle">${label(d.t)}</text>` : ''}</g>`;
  }).join('');
  const grid = ticks.map(v => `<line class="grid" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${P.l - 6}" y="${y(v) + 4}" text-anchor="end">${fmt(v, 0)}</text>`).join('');
  const table = `<div class="table-wrap chart-table" hidden><table class="table"><thead><tr><th>Día</th><th>Ingresos (u.)</th><th>Salidas (u.)</th></tr></thead><tbody>${daily.slice().reverse().map(d => `<tr><td>${esc(new Date(d.t).toLocaleDateString('es-AR', { weekday: 'short', day: 'numeric', month: 'short' }))}</td><td>${fmt(d.in)}</td><td>${fmt(d.out)}</td></tr>`).join('')}</tbody></table></div>`;
  return `<div class="viz" data-daily='${esc(JSON.stringify(daily))}'>
    <div class="viz-head"><div class="legend"><span><i class="sw sw-in"></i>Ingresos</span><span><i class="sw sw-out"></i>Salidas</span></div><button type="button" class="btn btn-ghost btn-sm" data-viz-table>Ver tabla</button></div>
    <div class="viz-plot"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Unidades ingresadas y salidas por día">${grid}${bars}<line class="base" x1="${P.l}" x2="${W - P.r}" y1="${P.t + ih}" y2="${P.t + ih}"/></svg><div class="viz-tip" hidden></div></div>${table}</div>`;
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
    tip.innerHTML = `<strong>${esc(new Date(d.t).toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' }))}</strong><span><i class="sw sw-in"></i>Ingresos <b>${fmt(d.in)} u.</b></span><span><i class="sw sw-out"></i>Salidas <b>${fmt(d.out)} u.</b></span>`;
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
function salesSection(s) {
  if (!s) return '';
  if (!s.salesCount && !s.buysCount) return `<section class="panel"><div class="panel-head"><h3>${icon('cash')} Ventas con precio</h3><p>Todavía no hay ventas con precio en este período. Al escanear una salida, dejá encendido «Es una venta».</p></div></section>`;
  const profit = s.profit == null ? '<strong>—</strong><small>Cargá el precio de costo de los productos para estimarla</small>'
    : `<strong class="${s.profit < 0 ? 'warn' : ''}">${money(s.profit)}</strong><small>${s.profitCoverage < 0.999 ? `sobre el ${fmt(s.profitCoverage * 100, 0)} % de las ventas (productos con costo)` : 'ventas menos el costo de lo vendido'}</small>`;
  return `
  <div class="report-stats">
    <div class="stat"><span>Ventas</span><strong>${money(s.salesTotal)}</strong><small>${fmt(s.salesCount)} venta${s.salesCount === 1 ? '' : 's'}</small></div>
    <div class="stat"><span>Ticket promedio</span><strong>${money(s.ticket)}</strong><small>por venta</small></div>
    <div class="stat"><span>Ganancia estimada</span>${profit}</div>
    <div class="stat"><span>Compras</span><strong>${money(s.buysTotal)}</strong><small>${fmt(s.buysCount)} compra${s.buysCount === 1 ? '' : 's'} con costo</small></div>
  </div>
  <div class="grid-2">
    <section class="panel"><div class="panel-head"><h3>Lo que más facturó</h3><p>Por importe vendido (con descuentos)</p></div>${s.bySku.length ? mbars(s.bySku, { label: g => g.key, sub: g => `${name(g.item) || 'Producto eliminado'} · ${fmt(g.units)} u.` }) : empty('Sin ventas con precio.')}</section>
    <section class="panel"><div class="panel-head"><h3>Clientes por importe</h3><p>Cuánto compró cada uno</p></div>${s.byClient.length ? mbars(s.byClient, { label: g => g.key, sub: g => `${g.count} compra${g.count === 1 ? '' : 's'}` }) : empty('Sin datos.')}</section>
    <section class="panel"><div class="panel-head"><h3>Formas de pago</h3><p>Total cobrado por cada una</p></div>${s.byPay.length ? mbars(s.byPay, { label: g => g.key, sub: g => `${g.count} venta${g.count === 1 ? '' : 's'}` }) : empty('Sin datos.')}</section>
  </div>`;
}
const empty = t => `<p class="muted small" style="padding:8px 0">${esc(t)}</p>`;
const when = iso => new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

export function renderReport(r) {
  const people = r.people.filter(p => p.who !== 'sin usuario' || p.moves);
  const alerts = r.fixes.length + r.shortCounts.length + r.offHours.length;
  return `${salesSection(r.sales)}
  <div class="report-stats">
    <div class="stat"><span>Salidas</span><strong>${fmt(r.totalOut)} u.</strong><small>${dz(r.totalOut)} · ${fmt(r.outs.length)} movimientos</small></div>
    <div class="stat"><span>Ingresos</span><strong>${fmt(r.totalIn)} u.</strong><small>${dz(r.totalIn)} · ${fmt(r.ins.length)} movimientos</small></div>
    <div class="stat"><span>Remitos</span><strong>${fmt(r.remitos.length)}</strong><small>${fmt(r.byClient.length)} clientes con compras</small></div>
    <div class="stat"><span>Para revisar</span><strong class="${alerts ? 'warn' : ''}">${fmt(alerts)}</strong><small>correcciones, faltantes y horarios</small></div>
  </div>

  <section class="panel"><div class="panel-head"><h3>Ingresos y salidas por día</h3><p>Unidades por día, últimos ${r.days} días</p></div>${dailyChart(r.daily)}</section>

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
