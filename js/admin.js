// Panel de administración: aprobar cuentas, avisos por WhatsApp y clave de administrador.
import { CONFIG } from './config.js';
import { rpc, isConfigured } from './cloud.js';
import { byId, $$, esc, icon, hydrateIcons, toast, ask, fmt, txt, busy, flashDone, shake, initInteractions, relTime, initials, waLink, animateNumber } from './utils.js';

const TOKEN_KEY = 'stockvoz_admin';
let token = sessionStorage.getItem(TOKEN_KEY);
let data = { users: [] };
const view = { status: 'pending', q: '', selected: new Set() };
const STATUS = { pending: ['Pendiente', 'badge-warn'], approved: ['Aprobado', 'badge-success'], disabled: ['Deshabilitado', 'badge-danger'] };

function show(id) { ['loginView', 'mustChangeView', 'panelView', 'notConfiguredView'].forEach(v => { byId(v).hidden = v !== id; }); }
const fmtDate = iso => (iso ? new Date(iso).toLocaleDateString('es-AR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const mb = b => `${fmt(b / 1048576, 1)} MB`;

async function call(fn, args = {}) {
  try { return await rpc(fn, { p_token: token, ...args }); }
  catch (e) {
    if (e.code === 'admin_session_invalid') { logout(false); toast(e.message, 'warn'); }
    else if (e.code === 'must_change_password') show('mustChangeView');
    throw e;
  }
}

function logout(callServer = true) {
  if (callServer && token) rpc('sv_logout', { p_token: token }).catch(() => {});
  token = null;
  sessionStorage.removeItem(TOKEN_KEY);
  show('loginView');
  setTimeout(() => byId('adminPass').focus(), 50);
}

async function load() {
  const btn = byId('refreshBtn');
  busy(btn, true);
  try {
    data = await call('sv_admin_overview');
    show('panelView');
    render();
  } catch (e) { if (e.code !== 'admin_session_invalid' && e.code !== 'must_change_password') toast(e.message, 'error'); }
  finally { busy(btn, false); }
}

function render() {
  const users = data.users || [];
  const count = s => users.filter(u => u.status === s).length;
  animateNumber(byId('kPending'), count('pending'));
  animateNumber(byId('kApproved'), count('approved'));
  animateNumber(byId('kTotal'), users.length);
  byId('kDisabled').textContent = `${count('disabled')} deshabilitados`;
  byId('kDb').textContent = mb(data.db_bytes || 0);
  byId('kDbFoot').textContent = `de 500 MB gratis · datos de stock: ${mb(data.data_bytes || 0)}`;
  byId('kDbMeter').style.width = `${Math.min(100, (data.db_bytes || 0) / (500 * 1048576) * 100)}%`;
  byId('cPending').textContent = count('pending'); byId('cApproved').textContent = count('approved');
  byId('cDisabled').textContent = count('disabled'); byId('cAll').textContent = users.length;
  byId('approveAllBtn').disabled = !count('pending');
  $$('#statusFilters .chip').forEach(c => c.classList.toggle('active', c.dataset.s === view.status));
  byId('notifyPhone').value = data.notify_phone || '';
  const nb = byId('notifyBadge');
  nb.className = `badge ${data.notify_ready ? 'badge-success' : ''}`;
  nb.textContent = data.notify_ready ? 'Activo' : 'Sin configurar';

  for (const id of view.selected) if (!users.some(u => u.id === id)) view.selected.delete(id);
  const q = view.q.toLocaleLowerCase('es-AR');
  const rows = users.filter(u => (view.status === 'all' || u.status === view.status)
    && (!q || [u.username, u.full_name, u.business, u.phone].some(v => String(v || '').toLocaleLowerCase('es-AR').includes(q))));

  byId('userList').innerHTML = rows.length
    ? `<div class="user-row head"><span></span><span>Usuario</span><span>Contacto</span><span>Datos</span><span>Estado</span><span style="text-align:right">Acciones</span></div>${rows.map(userRow).join('')}`
    : `<div class="empty"><span class="empty-icon">${icon(view.status === 'pending' ? 'check' : 'users')}</span><strong>${view.status === 'pending' ? 'No hay solicitudes pendientes' : 'Sin usuarios en esta lista'}</strong><span>${view.status === 'pending' ? 'Cuando alguien se registre, aparece acá.' : 'Probá con otro filtro.'}</span></div>`;
  renderBulk();
}

function userRow(u) {
  const [label, cls] = STATUS[u.status] || STATUS.pending;
  const sel = view.selected.has(u.id);
  const phone = String(u.phone || '').replace(/\D/g, '');
  const welcome = `Hola ${u.full_name || u.username}, tu cuenta de StockVoz (usuario "${u.username}") ya está aprobada. Ya podés ingresar y guardar tu stock en la nube.`;
  const actions = [
    u.status !== 'approved' ? `<button class="btn btn-success btn-sm" type="button" data-act="approved">${icon('check', 'sm')}Aprobar</button>` : '',
    u.status === 'approved' ? `<button class="btn btn-ghost btn-sm" type="button" data-act="disabled">${icon('lock', 'sm')}Deshabilitar</button>` : '',
    u.status === 'approved' && phone ? `<a class="icon-btn" href="${waLink(phone, welcome)}" target="_blank" rel="noopener noreferrer" title="Avisarle por WhatsApp que fue aprobado" style="color:var(--wa)">${icon('whatsapp')}</a>` : '',
    `<button class="icon-btn" type="button" data-act="reset" title="Cambiar su contraseña">${icon('key')}</button>`,
    `<button class="icon-btn danger" type="button" data-act="delete" title="Eliminar cuenta y datos">${icon('trash')}</button>`,
  ].join('');
  return `<div class="user-row ${sel ? 'selected' : ''}" data-id="${esc(u.id)}" style="${sel ? 'background:var(--primary-soft)' : ''}">
    <label class="check"><input type="checkbox" data-act="select" ${sel ? 'checked' : ''} aria-label="Seleccionar ${esc(u.username)}"><span></span></label>
    <div class="who"><span class="avatar">${esc(initials(u.full_name || u.username))}</span><div><strong>${esc(u.full_name || u.username)}</strong><span class="mono">@${esc(u.username)}${u.business ? ` · ${esc(u.business)}` : ''}</span>${u.role === 'employee' ? `<div style="margin-top:4px"><span class="badge badge-info">${icon('users', 'sm')}Empleado de @${esc(u.owner_username || '')}</span></div>` : u.team ? `<div style="margin-top:4px"><span class="badge badge-primary">${icon('users', 'sm')}Equipo: ${u.team} empleado${u.team == 1 ? '' : 's'}</span></div>` : ''}</div></div>
    <div class="u-meta small">${phone ? `<a href="${waLink(phone, `Hola ${u.full_name || ''}, te escribo por tu cuenta de StockVoz.`)}" target="_blank" rel="noopener noreferrer">${esc(u.phone)}</a>` : '<span class="muted">Sin teléfono</span>'}<div class="muted">Alta ${fmtDate(u.created_at)}</div></div>
    <div class="u-data small"><strong>${fmt(u.items)} productos</strong><div class="muted">${u.last_login_at ? `Ingresó ${relTime(u.last_login_at)}` : 'Nunca ingresó'} · ${fmt((u.bytes || 0) / 1024, 0)} KB</div></div>
    <div class="u-status"><span class="badge ${cls}">${label}</span></div>
    <div class="user-actions">${actions}</div></div>`;
}

function renderBulk() {
  const n = view.selected.size;
  byId('bulkBar').hidden = !n;
  byId('bulkCount').textContent = `${n} seleccionado${n === 1 ? '' : 's'}`;
}

async function setStatus(ids, status) {
  const r = await call('sv_admin_set_status', { p_ids: ids, p_status: status });
  toast(status === 'approved' ? `${r.count} cuenta${r.count === 1 ? '' : 's'} aprobada${r.count === 1 ? '' : 's'}` : `${r.count} cuenta${r.count === 1 ? '' : 's'} deshabilitada${r.count === 1 ? '' : 's'}`);
  view.selected.clear();
  await load();
}
async function deleteUsers(ids) {
  const names = data.users.filter(u => ids.includes(u.id)).map(u => '@' + u.username).join(', ');
  if (!(await ask({ title: `¿Eliminar ${ids.length} cuenta${ids.length === 1 ? '' : 's'}?`, message: `${names}\nSe borran la cuenta y su inventario en la nube. No se puede deshacer.`, confirm: 'Eliminar definitivamente', danger: true }))) return;
  const r = await call('sv_admin_delete_users', { p_ids: ids });
  toast(`${r.count} cuenta${r.count === 1 ? '' : 's'} eliminada${r.count === 1 ? '' : 's'}`);
  view.selected.clear();
  await load();
}
async function resetPassword(u) {
  const pass = prompt(`Nueva contraseña para @${u.username} (mínimo 6 caracteres):`);
  if (pass === null) return;
  if (pass.length < 6) return toast('La contraseña debe tener al menos 6 caracteres.', 'warn');
  await call('sv_admin_reset_password', { p_id: u.id, p_password: pass });
  toast(`Contraseña de @${u.username} actualizada. Pasásela por un medio seguro.`);
}

async function onListClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const id = el.closest('.user-row')?.dataset.id, u = data.users.find(x => x.id === id);
  if (!u) return;
  const act = el.dataset.act;
  if (act === 'select') { el.checked ? view.selected.add(id) : view.selected.delete(id); render(); return; }
  try {
    if (act === 'approved' || act === 'disabled') { busy(el, true); await setStatus([id], act); }
    else if (act === 'delete') await deleteUsers([id]);
    else if (act === 'reset') await resetPassword(u);
  } catch (err) { toast(err.message, 'error'); busy(el, false); }
}

function bind() {
  byId('loginForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('[type="submit"]'), pass = byId('adminPass').value;
    if (!pass) { shake(btn); return; }
    busy(btn, true);
    try {
      const r = await rpc('sv_admin_login', { p_password: pass });
      token = r.token;
      sessionStorage.setItem(TOKEN_KEY, token);
      byId('adminPass').value = '';
      if (r.must_change) { show('mustChangeView'); byId('mcNew').focus(); }
      else await load();
    } catch (err) { shake(btn); toast(err.message, 'error'); }
    finally { busy(btn, false); }
  });
  byId('mustChangeForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('[type="submit"]'), a = byId('mcNew').value, b = byId('mcNew2').value;
    if (a.length < 8) { shake(btn); return toast('Usá al menos 8 caracteres.', 'warn'); }
    if (a !== b) { shake(btn); return toast('Las claves no coinciden.', 'warn'); }
    busy(btn, true);
    try { await call('sv_admin_change_password', { p_new: a }); toast('Clave actualizada. ¡Bienvenido!'); await load(); }
    catch (err) { toast(err.message, 'error'); }
    finally { busy(btn, false); }
  });
  byId('passForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('[type="submit"]'), a = byId('newPass').value, b = byId('newPass2').value;
    if (a.length < 8) { shake(btn); return toast('Usá al menos 8 caracteres.', 'warn'); }
    if (a !== b) { shake(btn); return toast('Las claves no coinciden.', 'warn'); }
    busy(btn, true);
    try { await call('sv_admin_change_password', { p_new: a }); flashDone(btn); e.target.reset(); toast('Clave de administrador actualizada'); }
    catch (err) { toast(err.message, 'error'); }
    finally { busy(btn, false); }
  });
  byId('notifyForm').addEventListener('submit', async e => {
    e.preventDefault();
    const btn = e.target.querySelector('[type="submit"]'), key = txt(byId('notifyKey').value);
    busy(btn, true);
    try { await call('sv_admin_save_notify', { p_phone: byId('notifyPhone').value, p_apikey: key || null }); byId('notifyKey').value = ''; flashDone(btn); toast('Configuración guardada'); await load(); }
    catch (err) { toast(err.message, 'error'); }
    finally { busy(btn, false); }
  });
  byId('notifyTest').onclick = async e => {
    const btn = e.currentTarget;
    busy(btn, true);
    try { await call('sv_admin_test_notify'); toast('Mensaje de prueba enviado. Revisá tu WhatsApp.'); }
    catch (err) { toast(err.message, 'error'); }
    finally { busy(btn, false); }
  };
  byId('refreshBtn').onclick = load;
  byId('logoutBtn').onclick = () => logout(true);
  byId('userSearch').addEventListener('input', e => { view.q = e.target.value; render(); });
  byId('statusFilters').addEventListener('click', e => { const c = e.target.closest('[data-s]'); if (c) { view.status = c.dataset.s; view.selected.clear(); render(); } });
  byId('userList').addEventListener('click', onListClick);
  byId('bulkClear').onclick = () => { view.selected.clear(); render(); };
  byId('bulkBar').addEventListener('click', async e => {
    const b = e.target.closest('[data-bulk]');
    if (!b) return;
    const ids = [...view.selected];
    try { if (b.dataset.bulk === 'delete') await deleteUsers(ids); else await setStatus(ids, b.dataset.bulk); }
    catch (err) { toast(err.message, 'error'); }
  });
  byId('approveAllBtn').onclick = async e => {
    const ids = data.users.filter(u => u.status === 'pending').map(u => u.id);
    if (!ids.length) return;
    if (!(await ask({ title: `¿Aprobar ${ids.length} cuenta${ids.length === 1 ? '' : 's'} pendiente${ids.length === 1 ? '' : 's'}?`, message: 'Van a poder ingresar y guardar su stock en la nube.', confirm: 'Aprobar todas' }))) return;
    const btn = e.currentTarget;
    busy(btn, true);
    try { await setStatus(ids, 'approved'); } catch (err) { toast(err.message, 'error'); } finally { busy(btn, false); }
  };
  document.addEventListener('click', e => {
    const eye = e.target.closest('[data-eye]');
    if (eye) { const inp = eye.previousElementSibling; inp.type = inp.type === 'password' ? 'text' : 'password'; }
  });
}

hydrateIcons();
initInteractions();
$$('[data-year]').forEach(el => { el.textContent = new Date().getFullYear(); });
bind();
if (!isConfigured()) show('notConfiguredView');
else if (token) load();
else logout(false);
document.title = `Administración · StockVoz ${CONFIG.VERSION}`;
