// Nube (Supabase): cuentas con aprobación y sincronización de bajo consumo.
// · Sin supabase-js: llamadas directas a funciones RPC (pocas y livianas).
// · Los cambios se agrupan y se suben unos segundos después del último movimiento.
// · Al volver a la app solo se pregunta "¿cambió algo?" (respuesta mínima si no hubo cambios).
import { CONFIG } from './config.js';
import { state, persist, replaceAll, mergeData, rebase, markSynced, clearUndo, setActor } from './store.js';
import { readJSON, writeJSON } from './utils.js';

const SESSION_KEY = 'stockvoz_session';

const MESSAGES = {
  invalid_credentials: 'Usuario o contraseña incorrectos.',
  locked: 'Demasiados intentos fallidos. Esperá 15 minutos.',
  username_taken: 'Ese usuario ya existe. Elegí otro.',
  invalid_username: 'El usuario debe tener de 3 a 30 caracteres: letras minúsculas, números, punto, guion o guion bajo.',
  invalid_password: 'La contraseña debe tener entre 6 y 72 caracteres.',
  too_many_registrations: 'Hay demasiadas solicitudes nuevas. Probá de nuevo en un rato.',
  session_invalid: 'Tu sesión venció o tu cuenta fue deshabilitada. Ingresá de nuevo.',
  conflict: 'Hay cambios más nuevos en otro dispositivo.',
  payload_too_large: 'El inventario supera el tamaño permitido para la nube.',
  invalid_payload: 'Datos inválidos.',
  admin_session_invalid: 'La sesión de administrador venció. Ingresá de nuevo.',
  admin_not_configured: 'Falta ejecutar supabase/schema.sql (no hay clave de administrador).',
  must_change_password: 'Cambiá la clave de administrador para continuar.',
  admin_password_short: 'La nueva clave debe tener al menos 8 caracteres y no puede ser la de ejemplo.',
  notify_not_ready: 'Completá el número y la API key de CallMeBot primero.',
  invalid_status: 'Estado inválido.',
  owner_only: 'Solo el dueño de la cuenta puede hacer esto.',
  team_full: 'Llegaste al máximo de empleados de tu cuenta.',
  not_found: 'No se encontró ese empleado.',
  schema_missing: 'Supabase todavía no tiene las funciones de StockVoz. Ejecutá supabase/schema.sql en el SQL Editor.',
  network: 'No hay conexión con la nube. Tus datos siguen guardados en este dispositivo.',
  not_configured: 'La nube no está configurada (completá js/config.js).',
};
export class CloudError extends Error {
  constructor(code, data) { super(MESSAGES[code] || code); this.code = code; this.data = data; }
}

export const isConfigured = () => /^https:\/\/\S+/.test(CONFIG.SUPABASE_URL || '') && (CONFIG.SUPABASE_ANON_KEY || '').length > 20;

export async function rpc(fn, args = {}, { keepalive = false } = {}) {
  if (!isConfigured()) throw new CloudError('not_configured');
  const key = CONFIG.SUPABASE_ANON_KEY;
  const headers = { 'Content-Type': 'application/json', apikey: key };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`; // clave "anon" clásica (JWT)
  let res;
  try {
    res = await fetch(`${CONFIG.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args), keepalive });
  } catch { throw new CloudError('network'); }
  let data = null;
  try { data = await res.json(); } catch { /* sin cuerpo */ }
  if (!res.ok) {
    if (data?.code === 'PGRST202' || data?.code === '42883') throw new CloudError('schema_missing');
    throw new CloudError(data?.message || `Error ${res.status} de Supabase`);
  }
  if (data && data.ok === false) throw new CloudError(data.error, data);
  return data;
}

// ---------- Estado y avisos para la interfaz ----------
let session = readJSON(SESSION_KEY, null);
let syncState = 'idle'; // idle | syncing | error | offline
let lastError = '';
let hooks = { conflict: async () => 'merge', sessionLost: () => {}, notify: () => {} };
const listeners = new Set();
export const onStatus = fn => { listeners.add(fn); return () => listeners.delete(fn); };
export const setHooks = h => { hooks = { ...hooks, ...h }; };
export const getSession = () => session;
// Las cuentas sin sesión (modo local) y los dueños tienen todos los permisos; los empleados, no.
export const isOwner = () => !session || session.role !== 'employee';
// De quién es el inventario que se usa: el del dueño, también cuando entra un empleado.
const dataKey = () => session?.owner?.username || session?.username;
export const getStatus = () => ({ configured: isConfigured(), session, syncState, lastError, dirty: state.cloud.dirty, lastSyncAt: state.cloud.lastSyncAt });
const emit = () => listeners.forEach(fn => fn(getStatus()));
function setSync(s, err = '') { syncState = s; lastError = err; emit(); }
function saveSession(s) {
  session = s;
  if (s) writeJSON(SESSION_KEY, s); else { try { localStorage.removeItem(SESSION_KEY); } catch { /* sin almacenamiento */ } }
  emit();
}

// ---------- Cuentas ----------
export const register = f => rpc('sv_register', { p_username: f.username, p_password: f.password, p_full_name: f.fullName, p_phone: f.phone, p_business: f.business });

export async function login(username, password) {
  const r = await rpc('sv_login', { p_username: username, p_password: password });
  if (r.status !== 'approved') return r;
  saveSession({ token: r.token, username: r.user.username, fullName: r.user.full_name, role: r.user.role || 'owner', business: r.user.business || '', owner: r.user.owner || null, expiresAt: r.expires_at });
  setActor(r.user.username);
  try { await initialSync(); } catch (e) { setSync(e.code === 'network' ? 'offline' : 'error', e.message); }
  restrictForEmployee();
  return r;
}

// Un empleado no guarda en su dispositivo el historial del negocio: solo sus movimientos y lo mínimo de etiquetas.
// (Si antes usó ese dispositivo la dueña, el historial completo se borra de este navegador.)
function restrictForEmployee() {
  if (session?.role !== 'employee') return;
  const me = session.username;
  const before = state.history.length;
  state.history = state.history.filter(h => h.lite || h.by === me);
  state.extra.remitos = state.extra.remitos.filter(x => x.by === me);
  if (state.history.length !== before) persist();
}

export async function logout({ wipe = false } = {}) {
  if (session && state.cloud.dirty) { try { await pushNow(); } catch { /* se intentó */ } }
  const token = session?.token;
  saveSession(null);
  setActor('');
  setSync('idle');
  if (token) rpc('sv_logout', { p_token: token }).catch(() => {});
  return wipe;
}

function sessionLost() {
  saveSession(null);
  setActor('');
  setSync('idle');
  hooks.sessionLost();
}

// ---------- Sincronización ----------
function applyRemote(remote) {
  state.cloud.owner = dataKey();
  state.cloud.rev = remote.rev || 0;
  state.cloud.dirty = false;
  state.cloud.pending = [];
  state.cloud.removed = [];
  state.cloud.lastSyncAt = new Date().toISOString();
  replaceAll(remote.items || [], remote.history || [], remote.extra || {});
}

// Primer encuentro entre los datos de este dispositivo y los de la nube.
async function initialSync() {
  setSync('syncing');
  const remote = await rpc('sv_pull', { p_token: session.token, p_known_rev: -1 });
  const c = state.cloud, user = dataKey(), prevOwner = c.owner;
  const localHas = state.items.length > 0 || state.history.length > 0;

  if (prevOwner && prevOwner !== user && localHas) {
    // Los datos locales son de otra cuenta: se guarda una copia en este navegador y se cargan los de esta cuenta.
    writeJSON(`stockvoz_backup_${prevOwner}`, { at: new Date().toISOString(), items: state.items, history: state.history });
    applyRemote(remote);
  } else if (!remote.rev) {
    c.owner = user; c.rev = 0; c.dirty = localHas; persist();
    if (localHas) await pushNow(); else setSync('idle');
  } else if (!localHas) {
    applyRemote(remote);
  } else if (prevOwner === user && !c.dirty) {
    if (remote.rev !== c.rev) applyRemote(remote);
  } else if (prevOwner === user && c.rev === remote.rev) {
    await pushNow();
  } else if (prevOwner === user) {
    rebase(remote); // hubo cambios de otro dispositivo o de otro usuario: se combinan solos
    await pushNow();
  } else {
    await resolveConflict(remote); // datos de este dispositivo que nunca se subieron a esta cuenta: se pregunta
  }
  if (syncState === 'syncing') setSync('idle');
}

async function resolveConflict(remote) {
  const choice = await hooks.conflict(remote);
  if (choice === 'cloud') { applyRemote(remote); setSync('idle'); return; }
  state.cloud.owner = dataKey();
  state.cloud.rev = remote.rev;
  if (choice === 'merge') mergeData(remote.items, remote.history, remote.extra); // marca cambios pendientes
  state.cloud.dirty = true;
  persist();
  await pushNow();
}

let inflight = null, again = false, pushTimer = null;
async function pushOnce({ keepalive }) {
  setSync('syncing');
  state.cloud.dirty = false; // si hay cambios durante la subida se vuelven a marcar
  const sent = [...state.cloud.pending], removed = [...state.cloud.removed];
  const body = { p_token: session.token, p_items: state.items, p_history: state.history.slice(0, CONFIG.CLOUD_HISTORY_LIMIT), p_base_rev: state.cloud.rev, p_extra: state.extra };
  try {
    const json = JSON.stringify(body);
    const r = await rpc('sv_push', body, { keepalive: keepalive && json.length < 60000 });
    state.cloud.rev = r.rev;
    state.cloud.owner = dataKey();
    state.cloud.lastSyncAt = new Date().toISOString();
    markSynced(sent, removed);
    clearUndo(); // ya está en la nube: para arreglar errores se usa "Corregir"
    persist();
    setSync('idle');
  } catch (e) {
    state.cloud.dirty = true;
    persist();
    if (e.code === 'conflict') setTimeout(conflictFlow, 0);
    else if (e.code === 'session_invalid') sessionLost();
    else setSync(e.code === 'network' ? 'offline' : 'error', e.message);
  }
}
async function conflictFlow() {
  if (!session) return;
  try { rebase(await rpc('sv_pull', { p_token: session.token, p_known_rev: -1 })); await pushNow(); }
  catch (e) { if (e.code === 'session_invalid') sessionLost(); else setSync('error', e.message); }
}

export function pushNow({ keepalive = false } = {}) {
  clearTimeout(pushTimer);
  if (!session?.token || !state.cloud.dirty) return Promise.resolve();
  if (inflight) { again = true; return inflight; }
  inflight = pushOnce({ keepalive }).finally(() => {
    inflight = null;
    if (again || (state.cloud.dirty && syncState === 'idle')) { again = false; schedulePush(); }
  });
  return inflight;
}

export function schedulePush() {
  if (!session?.token || !state.cloud.dirty) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => pushNow(), CONFIG.SYNC_DELAY_MS);
  emit();
}

let lastPullAt = 0;
export async function syncNow({ force = false } = {}) {
  if (!session?.token) return;
  if (!navigator.onLine) { setSync('offline', MESSAGES.network); return; }
  if (state.cloud.dirty) return pushNow();
  if (!force && Date.now() - lastPullAt < CONFIG.PULL_INTERVAL_MS) return;
  lastPullAt = Date.now();
  setSync('syncing');
  try {
    const r = await rpc('sv_pull', { p_token: session.token, p_known_rev: state.cloud.rev });
    if (!r.unchanged) applyRemote(r);
    else { state.cloud.lastSyncAt = new Date().toISOString(); persist(); }
    setSync('idle');
  } catch (e) {
    if (e.code === 'session_invalid') sessionLost();
    else setSync(e.code === 'network' ? 'offline' : 'error', e.message);
  }
}

// ---------- Equipo (empleados de la cuenta) ----------
export const team = {
  list: () => rpc('sv_team_list', { p_token: session?.token }),
  add: f => rpc('sv_team_add', { p_token: session?.token, p_username: f.username, p_password: f.password, p_full_name: f.fullName }),
  setStatus: (id, status) => rpc('sv_team_update', { p_token: session?.token, p_id: id, p_status: status, p_password: null }),
  setPassword: (id, password) => rpc('sv_team_update', { p_token: session?.token, p_id: id, p_status: null, p_password: password }),
  remove: id => rpc('sv_team_remove', { p_token: session?.token, p_id: id }),
};

export function start() {
  setActor(session?.username || '');
  restrictForEmployee();
  window.addEventListener('online', () => syncNow({ force: true }));
  window.addEventListener('offline', () => session && setSync('offline', MESSAGES.network));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { if (state.cloud.dirty) pushNow({ keepalive: true }); }
    else syncNow();
  });
  // Con la app abierta, cada minuto se pregunta si alguien del equipo hizo cambios (respuesta mínima si no hubo).
  setInterval(() => { if (session && document.visibilityState === 'visible') syncNow({ force: true }); }, CONFIG.TEAM_POLL_MS || 60000);
  if (session) syncNow({ force: true });
}
