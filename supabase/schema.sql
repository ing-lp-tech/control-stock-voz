-- =====================================================================
-- StockVoz · Base de datos Supabase
-- Pegá TODO este archivo en Supabase → SQL Editor → New query → Run.
-- Se puede volver a ejecutar sin perder datos (crea solo lo que falta).
--
-- ANTES DE EJECUTAR: cambiá la clave de administrador en la sección 6
-- (buscá  CAMBIA-ESTA-CLAVE ). Al entrar por primera vez a admin.html
-- la app te va a pedir que la cambies otra vez.
--
-- Diseño de bajo consumo para el plan gratuito:
--   · No usa Supabase Auth, Realtime, Storage ni Edge Functions.
--   · Una sola fila por usuario con su inventario (JSON).
--   · Las tablas están cerradas (RLS sin políticas): solo se accede
--     por las funciones de abajo, que validan usuario y sesión.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;
-- Opcional: aviso automático por WhatsApp (CallMeBot). Si falla, el resto funciona igual.
create extension if not exists pg_net;

-- ---------------------------------------------------------------------
-- 1. Tablas
-- ---------------------------------------------------------------------
create table if not exists public.sv_users (
  id              uuid primary key default gen_random_uuid(),
  username        text not null unique check (username ~ '^[a-z0-9._-]{3,30}$'),
  password_hash   text not null,
  full_name       text not null default '',
  phone           text not null default '',
  business        text not null default '',
  status          text not null default 'pending' check (status in ('pending', 'approved', 'disabled')),
  failed_attempts int  not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now(),
  approved_at     timestamptz,
  last_login_at   timestamptz
);

create table if not exists public.sv_sessions (
  token_hash text primary key,
  user_id    uuid references public.sv_users(id) on delete cascade,
  is_admin   boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists sv_sessions_user_idx on public.sv_sessions(user_id);

create table if not exists public.sv_data (
  user_id    uuid primary key references public.sv_users(id) on delete cascade,
  items      jsonb not null default '[]'::jsonb,
  history    jsonb not null default '[]'::jsonb,
  rev        int   not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.sv_config (
  key   text primary key,
  value text not null
);

-- Subcuentas (empleados): comparten el inventario de su dueño (owner_id). Seguro de re-ejecutar.
alter table public.sv_users add column if not exists owner_id uuid references public.sv_users(id) on delete cascade;
alter table public.sv_users add column if not exists role text not null default 'owner';
do $$ begin
  alter table public.sv_users add constraint sv_users_role_chk check (role in ('owner', 'employee'));
exception when duplicate_object then null; end $$;
create index if not exists sv_users_owner_idx on public.sv_users(owner_id);

-- Nadie puede leer/escribir las tablas directamente desde la API pública.
alter table public.sv_users    enable row level security;
alter table public.sv_sessions enable row level security;
alter table public.sv_data     enable row level security;
alter table public.sv_config   enable row level security;
revoke all on public.sv_users, public.sv_sessions, public.sv_data, public.sv_config from anon, authenticated;

-- ---------------------------------------------------------------------
-- 2. Funciones internas (no expuestas a la API)
-- ---------------------------------------------------------------------
create or replace function public.sv_hash_token(p_token text) returns text
language sql immutable set search_path = public, extensions as $$
  select encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
$$;

create or replace function public.sv_new_session(p_user uuid, p_admin boolean, p_hours int) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_token text := encode(extensions.gen_random_bytes(32), 'hex');
  v_exp   timestamptz := now() + make_interval(hours => p_hours);
begin
  delete from sv_sessions where expires_at < now();          -- limpieza: mantiene la tabla chica
  insert into sv_sessions(token_hash, user_id, is_admin, expires_at)
  values (sv_hash_token(v_token), p_user, p_admin, v_exp);
  return json_build_object('token', v_token, 'expires_at', v_exp);
end $$;

-- Contexto de una sesión: quién es (user_id), de quién es el inventario que usa (data_id) y su rol.
-- Un empleado usa el inventario de su dueño, y queda bloqueado si el dueño no está aprobado.
create or replace function public.sv_ctx(p_token text) returns table(user_id uuid, data_id uuid, role text)
language sql stable security definer set search_path = public, extensions as $$
  select u.id, coalesce(u.owner_id, u.id), u.role
  from sv_sessions s
  join sv_users u on u.id = s.user_id
  left join sv_users o on o.id = u.owner_id
  where s.token_hash = sv_hash_token(p_token) and s.expires_at > now() and not s.is_admin
    and u.status = 'approved' and (u.owner_id is null or o.status = 'approved')
$$;

-- Id del inventario de la sesión (el del dueño, también para sus empleados); null si no es válida.
create or replace function public.sv_uid(p_token text) returns uuid
language sql stable security definer set search_path = public, extensions as $$
  select data_id from sv_ctx(p_token)
$$;

-- Devuelve null si la sesión de admin es válida; si no, el código de error.
create or replace function public.sv_admin_guard(p_token text, p_allow_default boolean default false) returns text
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not exists (select 1 from sv_sessions where token_hash = sv_hash_token(p_token) and is_admin and expires_at > now()) then
    return 'admin_session_invalid';
  end if;
  if not p_allow_default and coalesce((select value from sv_config where key = 'admin_must_change'), 'false') = 'true' then
    return 'must_change_password';
  end if;
  return null;
end $$;

-- Envía un WhatsApp al administrador con CallMeBot (si está configurado). Nunca rompe la operación.
create or replace function public.sv_notify_admin(p_text text) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_phone text; v_key text;
begin
  select value into v_phone from sv_config where key = 'notify_phone';
  select value into v_key   from sv_config where key = 'notify_apikey';
  if coalesce(v_phone, '') = '' or coalesce(v_key, '') = '' then return false; end if;
  begin
    perform net.http_get(
      url    := 'https://api.callmebot.com/whatsapp.php',
      params := jsonb_build_object('phone', v_phone, 'text', p_text, 'apikey', v_key)
    );
    return true;
  exception when others then
    return false;
  end;
end $$;

-- ---------------------------------------------------------------------
-- 3. API pública: cuentas
-- ---------------------------------------------------------------------
create or replace function public.sv_register(p_username text, p_password text, p_full_name text default '', p_phone text default '', p_business text default '')
returns json language plpgsql security definer set search_path = public, extensions as $$
declare
  v_user text := lower(trim(coalesce(p_username, '')));
  v_name text := left(trim(coalesce(p_full_name, '')), 80);
  v_phone text := left(regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'), 20);
  v_biz text := left(trim(coalesce(p_business, '')), 80);
begin
  if v_user !~ '^[a-z0-9._-]{3,30}$' then return json_build_object('ok', false, 'error', 'invalid_username'); end if;
  if length(coalesce(p_password, '')) < 6 or length(p_password) > 72 then return json_build_object('ok', false, 'error', 'invalid_password'); end if;
  if (select count(*) from sv_users where created_at > now() - interval '1 hour') >= 20 then
    return json_build_object('ok', false, 'error', 'too_many_registrations');      -- freno anti-spam
  end if;
  if exists (select 1 from sv_users where username = v_user) then return json_build_object('ok', false, 'error', 'username_taken'); end if;

  insert into sv_users(username, password_hash, full_name, phone, business)
  values (v_user, extensions.crypt(p_password, extensions.gen_salt('bf', 10)), v_name, v_phone, v_biz);

  perform sv_notify_admin(format('StockVoz: nueva solicitud de alta. Usuario: %s | Nombre: %s | Tel: %s | Negocio: %s. Aprobala en admin.html',
    v_user, coalesce(nullif(v_name, ''), '-'), coalesce(nullif(v_phone, ''), '-'), coalesce(nullif(v_biz, ''), '-')));

  return json_build_object('ok', true, 'status', 'pending', 'username', v_user);
end $$;

create or replace function public.sv_login(p_username text, p_password text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare u sv_users; o sv_users; s json;
begin
  select * into u from sv_users where username = lower(trim(coalesce(p_username, '')));
  if u.id is null then
    perform pg_sleep(0.3);
    return json_build_object('ok', false, 'error', 'invalid_credentials');
  end if;
  if u.locked_until is not null and u.locked_until > now() then return json_build_object('ok', false, 'error', 'locked'); end if;
  if u.password_hash <> extensions.crypt(coalesce(p_password, ''), u.password_hash) then
    update sv_users set failed_attempts = failed_attempts + 1,
      locked_until = case when failed_attempts + 1 >= 5 then now() + interval '15 minutes' else null end
    where id = u.id;
    return json_build_object('ok', false, 'error', 'invalid_credentials');
  end if;

  update sv_users set failed_attempts = 0, locked_until = null,
    last_login_at = case when status = 'approved' then now() else last_login_at end
  where id = u.id;

  if u.status <> 'approved' then return json_build_object('ok', true, 'status', u.status); end if;
  -- Un empleado entra solo si la cuenta de su dueño está aprobada.
  if u.owner_id is not null then
    select * into o from sv_users where id = u.owner_id;
    if o.id is null or o.status <> 'approved' then return json_build_object('ok', true, 'status', 'disabled'); end if;
  end if;
  s := sv_new_session(u.id, false, 24 * 30);
  return json_build_object('ok', true, 'status', 'approved', 'token', s->>'token', 'expires_at', s->>'expires_at',
    'user', json_build_object('username', u.username, 'full_name', u.full_name, 'role', u.role,
      'business', coalesce(nullif(o.business, ''), nullif(u.business, ''), ''),
      'owner', case when o.id is null then null else json_build_object('username', o.username, 'full_name', o.full_name) end));
end $$;

create or replace function public.sv_logout(p_token text) returns json
language sql security definer set search_path = public, extensions as $$
  delete from sv_sessions where token_hash = sv_hash_token(p_token);
  select json_build_object('ok', true);
$$;

-- ---------------------------------------------------------------------
-- 4. API pública: datos del inventario (1 fila por usuario)
-- ---------------------------------------------------------------------
-- Datos extra del negocio (clientes y proveedores, remitos). Seguro de re-ejecutar.
alter table public.sv_data add column if not exists extra jsonb not null default '{}'::jsonb;

-- ---- Ayudas internas para empleados: el servidor decide qué ven y calcula el stock ----
-- Movimientos que llegan y todavía no están guardados (se ignoran los "resumidos").
create or replace function public.sv_new_entries(p_existing jsonb, p_incoming jsonb) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(jsonb_agg(x order by x->>'at'), '[]'::jsonb)
  from jsonb_array_elements(coalesce(p_incoming, '[]'::jsonb)) x
  where not coalesce((x->>'lite')::boolean, false)
    and coalesce(x->>'id', '') <> ''
    and (x->>'id') not in (select coalesce(y->>'id', '') from jsonb_array_elements(coalesce(p_existing, '[]'::jsonb)) y)
$$;

-- Historial al guardar un empleado: se agregan sus movimientos nuevos (firmados con su usuario); nada existente se toca.
create or replace function public.sv_emp_history(p_existing jsonb, p_new jsonb, p_user text) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(jsonb_agg(e order by e->>'at' desc), '[]'::jsonb) from (
    select e from (
      select (x - 'voided' - 'corrected' - 'lite') || jsonb_build_object('by', p_user) as e from jsonb_array_elements(p_new) x
      union all
      select y from jsonb_array_elements(coalesce(p_existing, '[]'::jsonb)) y
    ) u order by e->>'at' desc limit 1000
  ) t
$$;

-- Stock al guardar un empleado: se parte del stock guardado y se aplican SOLO sus movimientos nuevos.
-- Así nadie puede cambiar cantidades sin dejar un movimiento registrado con su nombre.
create or replace function public.sv_emp_items(p_existing jsonb, p_incoming jsonb, p_new jsonb) returns jsonb
language plpgsql immutable set search_path = public as $$
declare v_map jsonb := '{}'::jsonb; it jsonb; e jsonb; v_sku text; v_units numeric;
begin
  for it in select value from jsonb_array_elements(coalesce(p_existing, '[]'::jsonb)) loop
    if coalesce(it->>'sku', '') <> '' then v_map := v_map || jsonb_build_object(it->>'sku', it); end if;
  end loop;
  -- Datos del producto (marca, prenda, etiquetas…) pueden venir del empleado; el stock y los precios no
  -- (los precios de venta y de costo los pone solo el dueño: se conservan los guardados).
  for it in select value from jsonb_array_elements(coalesce(p_incoming, '[]'::jsonb)) loop
    v_sku := it->>'sku';
    if coalesce(v_sku, '') = '' then continue; end if;
    if v_map ? v_sku then
      v_map := jsonb_set(v_map, array[v_sku],
        (it - 'units' - 'price' - 'cost' - 'pricePer' - 'priceManual' - 'priceArs')
        || (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from jsonb_each(v_map->v_sku) where key in ('price', 'cost', 'pricePer', 'priceManual', 'priceArs'))
        || jsonb_build_object('units', coalesce(v_map->v_sku->'units', '0'::jsonb)));
    elsif exists (select 1 from jsonb_array_elements(p_new) x where x->>'sku' = v_sku) then
      v_map := v_map || jsonb_build_object(v_sku, (it - 'price' - 'cost' - 'pricePer' - 'priceManual' - 'priceArs') || jsonb_build_object('units', 0));   -- producto nuevo
    end if;
  end loop;
  for e in select value from jsonb_array_elements(coalesce(p_new, '[]'::jsonb)) loop
    v_sku := e->>'sku';
    if not (v_map ? v_sku) or jsonb_typeof(e->'before') is distinct from 'number' or jsonb_typeof(e->'after') is distinct from 'number' then continue; end if;
    v_units := coalesce((v_map->v_sku->>'units')::numeric, 0);
    if e->>'kind' = 'count' then v_units := (e->>'after')::numeric;
    elsif coalesce((e->>'abs')::boolean, false) then continue;            -- un empleado no fija el stock a mano
    elsif e->>'kind' in ('in', 'out', 'fix') then v_units := v_units + (e->>'after')::numeric - (e->>'before')::numeric;
    else continue;
    end if;
    v_map := jsonb_set(v_map, array[v_sku, 'units'], to_jsonb(round(greatest(v_units, 0), 2)));
  end loop;
  return coalesce((select jsonb_agg(value) from jsonb_each(v_map)), '[]'::jsonb);
end $$;

-- Lista por id: se agregan los elementos nuevos; los existentes no se modifican.
create or replace function public.sv_union_by_id(p_existing jsonb, p_incoming jsonb, p_user text default null) returns jsonb
language sql immutable set search_path = public as $$
  select coalesce(jsonb_agg(e), '[]'::jsonb) from (
    select y as e from jsonb_array_elements(coalesce(p_existing, '[]'::jsonb)) y
    union all
    select case when p_user is null then x else x || jsonb_build_object('by', p_user) end
    from jsonb_array_elements(coalesce(p_incoming, '[]'::jsonb)) x
    where coalesce(x->>'id', '') <> ''
      and (x->>'id') not in (select coalesce(z->>'id', '') from jsonb_array_elements(coalesce(p_existing, '[]'::jsonb)) z)
  ) t
$$;

-- p_known_rev: la versión que ya tiene el dispositivo. Si no cambió, responde casi vacío (ahorra transferencia).
-- Empleados: reciben el stock (sin el precio de costo), los clientes/proveedores, solo SUS movimientos de las
-- últimas 24 h y SUS remitos.
-- Del resto del historial solo se envía lo mínimo para avisar si una etiqueta numerada ya se escaneó.
create or replace function public.sv_pull(p_token text, p_known_rev int default -1)
returns json language plpgsql stable security definer set search_path = public, extensions as $$
declare v_uid uuid; v_data uuid; v_role text; v_user text; d sv_data;
begin
  select c.user_id, c.data_id, c.role into v_uid, v_data, v_role from sv_ctx(p_token) c;
  if v_data is null then return json_build_object('ok', false, 'error', 'session_invalid'); end if;
  select * into d from sv_data where user_id = v_data;
  if d.user_id is null then return json_build_object('ok', true, 'rev', 0, 'items', '[]'::json, 'history', '[]'::json, 'extra', '{}'::json); end if;
  if d.rev = p_known_rev then return json_build_object('ok', true, 'rev', d.rev, 'unchanged', true); end if;
  if v_role <> 'employee' then
    return json_build_object('ok', true, 'rev', d.rev, 'items', d.items, 'history', d.history, 'extra', d.extra, 'updated_at', d.updated_at);
  end if;
  select username into v_user from sv_users where id = v_uid;
  return json_build_object('ok', true, 'rev', d.rev, 'updated_at', d.updated_at, 'role', 'employee',
    'items', (select coalesce(jsonb_agg(i - 'cost'), '[]'::jsonb) from jsonb_array_elements(coalesce(d.items, '[]'::jsonb)) i),
    'history', (select coalesce(jsonb_agg(
        case when e->>'by' = v_user and (e->>'at')::timestamptz > now() - interval '1 day' then e
             else jsonb_build_object('id', e->'id', 'at', e->'at', 'kind', e->'kind', 'sku', e->'sku', 'serial', e->'serial', 'voided', e->'voided', 'lite', true) end
        order by e->>'at' desc), '[]'::jsonb)
      from jsonb_array_elements(d.history) e
      where (e->>'by' = v_user and (e->>'at')::timestamptz > now() - interval '1 day') or (e ? 'serial')),
    'extra', coalesce(d.extra, '{}'::jsonb) || jsonb_build_object('remitos',
      (select coalesce(jsonb_agg(r), '[]'::jsonb) from jsonb_array_elements(coalesce(d.extra->'remitos', '[]'::jsonb)) r where r->>'by' = v_user)));
end $$;

-- Guarda solo si nadie más guardó desde p_base_rev (evita pisar cambios de otro dispositivo).
-- Dueño: guarda todo tal cual. Empleado: el servidor agrega sus movimientos y recalcula el stock.
drop function if exists public.sv_push(text, jsonb, jsonb, int);
create or replace function public.sv_push(p_token text, p_items jsonb, p_history jsonb, p_base_rev int, p_extra jsonb default null)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid; v_data uuid; v_role text; v_user text; d sv_data; v_rev int; v_new jsonb;
  v_items jsonb := p_items; v_history jsonb := p_history; v_extra jsonb := p_extra;
begin
  select c.user_id, c.data_id, c.role into v_uid, v_data, v_role from sv_ctx(p_token) c;
  if v_data is null then return json_build_object('ok', false, 'error', 'session_invalid'); end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_typeof(p_history) <> 'array' or (p_extra is not null and jsonb_typeof(p_extra) <> 'object') then
    return json_build_object('ok', false, 'error', 'invalid_payload');
  end if;
  if pg_column_size(p_items) + pg_column_size(p_history) + coalesce(pg_column_size(p_extra), 0) > 3500000 then
    return json_build_object('ok', false, 'error', 'payload_too_large');
  end if;
  select * into d from sv_data where user_id = v_data;
  if d.user_id is not null and d.rev <> p_base_rev then
    return json_build_object('ok', false, 'error', 'conflict', 'rev', d.rev);
  end if;

  if v_role = 'employee' then
    select username into v_user from sv_users where id = v_uid;
    v_new := sv_new_entries(d.history, p_history);
    v_history := sv_emp_history(d.history, v_new, v_user);
    v_items := sv_emp_items(d.items, p_items, v_new);
    v_extra := coalesce(d.extra, '{}'::jsonb) || jsonb_build_object(
      'contacts', sv_union_by_id(d.extra->'contacts', p_extra->'contacts'),
      'remitos', sv_union_by_id(d.extra->'remitos', p_extra->'remitos', v_user),
      'remitoSeq', greatest(coalesce((d.extra->>'remitoSeq')::int, 0), coalesce((p_extra->>'remitoSeq')::int, 0)));
  end if;

  insert into sv_data as t (user_id, items, history, extra, rev, updated_at)
  values (v_data, v_items, v_history, coalesce(v_extra, '{}'::jsonb), 1, now())
  on conflict (user_id) do update
    set items = excluded.items, history = excluded.history, extra = coalesce(v_extra, t.extra), rev = t.rev + 1, updated_at = now()
    where t.rev = p_base_rev
  returning rev into v_rev;

  if v_rev is null then
    return json_build_object('ok', false, 'error', 'conflict', 'rev', (select rev from sv_data where user_id = v_data));
  end if;
  return json_build_object('ok', true, 'rev', v_rev);
end $$;

-- ---------------------------------------------------------------------
-- 4b. API pública: equipo (empleados de una cuenta). Solo el dueño.
-- ---------------------------------------------------------------------
create or replace function public.sv_team_list(p_token text)
returns json language plpgsql stable security definer set search_path = public, extensions as $$
declare v_uid uuid; v_role text;
begin
  select c.user_id, c.role into v_uid, v_role from sv_ctx(p_token) c;
  if v_uid is null then return json_build_object('ok', false, 'error', 'session_invalid'); end if;
  if v_role <> 'owner' then return json_build_object('ok', false, 'error', 'owner_only'); end if;
  return json_build_object('ok', true,
    'max', coalesce((select value::int from sv_config where key = 'max_team'), 10),
    'members', coalesce((select json_agg(json_build_object('id', id, 'username', username, 'full_name', full_name, 'status', status,
        'created_at', created_at, 'last_login_at', last_login_at) order by created_at)
      from sv_users where owner_id = v_uid), '[]'::json));
end $$;

create or replace function public.sv_team_add(p_token text, p_username text, p_password text, p_full_name text default '')
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid; v_role text; v_user text := lower(trim(coalesce(p_username, ''))); v_max int; v_biz text;
begin
  select c.user_id, c.role into v_uid, v_role from sv_ctx(p_token) c;
  if v_uid is null then return json_build_object('ok', false, 'error', 'session_invalid'); end if;
  if v_role <> 'owner' then return json_build_object('ok', false, 'error', 'owner_only'); end if;
  if v_user !~ '^[a-z0-9._-]{3,30}$' then return json_build_object('ok', false, 'error', 'invalid_username'); end if;
  if length(coalesce(p_password, '')) < 6 or length(p_password) > 72 then return json_build_object('ok', false, 'error', 'invalid_password'); end if;
  v_max := coalesce((select value::int from sv_config where key = 'max_team'), 10);
  if (select count(*) from sv_users where owner_id = v_uid) >= v_max then return json_build_object('ok', false, 'error', 'team_full', 'max', v_max); end if;
  if exists (select 1 from sv_users where username = v_user) then return json_build_object('ok', false, 'error', 'username_taken'); end if;
  select business into v_biz from sv_users where id = v_uid;
  insert into sv_users(username, password_hash, full_name, business, status, approved_at, owner_id, role)
  values (v_user, extensions.crypt(p_password, extensions.gen_salt('bf', 10)), left(trim(coalesce(p_full_name, '')), 80), coalesce(v_biz, ''),
          'approved', now(), v_uid, 'employee');
  return json_build_object('ok', true, 'username', v_user);
end $$;

-- p_status: 'approved' | 'disabled' | null (sin cambio) · p_password: null = sin cambio
create or replace function public.sv_team_update(p_token text, p_id uuid, p_status text default null, p_password text default null)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid; v_role text;
begin
  select c.user_id, c.role into v_uid, v_role from sv_ctx(p_token) c;
  if v_uid is null then return json_build_object('ok', false, 'error', 'session_invalid'); end if;
  if v_role <> 'owner' then return json_build_object('ok', false, 'error', 'owner_only'); end if;
  if not exists (select 1 from sv_users where id = p_id and owner_id = v_uid) then return json_build_object('ok', false, 'error', 'not_found'); end if;
  if p_status is not null then
    if p_status not in ('approved', 'disabled') then return json_build_object('ok', false, 'error', 'invalid_status'); end if;
    update sv_users set status = p_status where id = p_id;
    if p_status = 'disabled' then delete from sv_sessions where user_id = p_id; end if;
  end if;
  if p_password is not null then
    if length(p_password) < 6 or length(p_password) > 72 then return json_build_object('ok', false, 'error', 'invalid_password'); end if;
    update sv_users set password_hash = extensions.crypt(p_password, extensions.gen_salt('bf', 10)), failed_attempts = 0, locked_until = null where id = p_id;
    delete from sv_sessions where user_id = p_id;
  end if;
  return json_build_object('ok', true);
end $$;

create or replace function public.sv_team_remove(p_token text, p_id uuid)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_uid uuid; v_role text; v_count int;
begin
  select c.user_id, c.role into v_uid, v_role from sv_ctx(p_token) c;
  if v_uid is null then return json_build_object('ok', false, 'error', 'session_invalid'); end if;
  if v_role <> 'owner' then return json_build_object('ok', false, 'error', 'owner_only'); end if;
  delete from sv_users where id = p_id and owner_id = v_uid;
  get diagnostics v_count = row_count;
  return json_build_object('ok', true, 'count', v_count);
end $$;

-- ---------------------------------------------------------------------
-- 5. API de administración (admin.html)
-- ---------------------------------------------------------------------
create or replace function public.sv_admin_login(p_password text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_hash text; v_fails int; v_locked timestamptz; s json;
begin
  select value into v_hash from sv_config where key = 'admin_hash';
  if v_hash is null then return json_build_object('ok', false, 'error', 'admin_not_configured'); end if;
  v_fails  := coalesce((select value::int from sv_config where key = 'admin_failed'), 0);
  v_locked := (select value::timestamptz from sv_config where key = 'admin_locked_until');
  if v_locked is not null and v_locked > now() then return json_build_object('ok', false, 'error', 'locked'); end if;

  if v_hash <> extensions.crypt(coalesce(p_password, ''), v_hash) then
    v_fails := v_fails + 1;
    insert into sv_config values ('admin_failed', v_fails::text) on conflict (key) do update set value = excluded.value;
    if v_fails >= 5 then
      insert into sv_config values ('admin_locked_until', (now() + interval '15 minutes')::text) on conflict (key) do update set value = excluded.value;
      update sv_config set value = '0' where key = 'admin_failed';
    end if;
    perform pg_sleep(0.4);
    return json_build_object('ok', false, 'error', 'invalid_credentials');
  end if;

  delete from sv_config where key in ('admin_failed', 'admin_locked_until');
  s := sv_new_session(null, true, 12);
  return json_build_object('ok', true, 'token', s->>'token', 'expires_at', s->>'expires_at',
    'must_change', coalesce((select value from sv_config where key = 'admin_must_change'), 'false') = 'true');
end $$;

-- Todo lo que necesita el panel en UNA sola llamada.
create or replace function public.sv_admin_overview(p_token text)
returns json language plpgsql stable security definer set search_path = public, extensions as $$
declare v_err text := sv_admin_guard(p_token);
begin
  if v_err is not null then return json_build_object('ok', false, 'error', v_err); end if;
  return json_build_object(
    'ok', true,
    'users', coalesce((
      select json_agg(row_to_json(t) order by t.status = 'pending' desc, t.created_at desc) from (
        select u.id, u.username, u.full_name, u.phone, u.business, u.status, u.created_at, u.approved_at, u.last_login_at,
               u.role, o.username as owner_username, (select count(*) from sv_users e where e.owner_id = u.id) as team,
               coalesce(jsonb_array_length(d.items), 0) as items, d.updated_at as data_updated_at,
               coalesce(pg_column_size(d.items) + pg_column_size(d.history), 0) as bytes
        from sv_users u left join sv_data d on d.user_id = u.id left join sv_users o on o.id = u.owner_id
      ) t), '[]'::json),
    'db_bytes', pg_database_size(current_database()),
    'data_bytes', coalesce((select sum(pg_column_size(items) + pg_column_size(history) + pg_column_size(extra)) from sv_data), 0),
    'notify_phone', coalesce((select value from sv_config where key = 'notify_phone'), ''),
    'notify_ready', coalesce((select value from sv_config where key = 'notify_apikey'), '') <> ''
  );
end $$;

create or replace function public.sv_admin_set_status(p_token text, p_ids jsonb, p_status text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_err text := sv_admin_guard(p_token); v_count int;
begin
  if v_err is not null then return json_build_object('ok', false, 'error', v_err); end if;
  if p_status not in ('pending', 'approved', 'disabled') then return json_build_object('ok', false, 'error', 'invalid_status'); end if;
  update sv_users set status = p_status,
    approved_at = case when p_status = 'approved' then coalesce(approved_at, now()) else approved_at end,
    failed_attempts = 0, locked_until = null
  where id::text in (select jsonb_array_elements_text(p_ids));
  get diagnostics v_count = row_count;
  if p_status <> 'approved' then
    delete from sv_sessions where user_id::text in (select jsonb_array_elements_text(p_ids));
  end if;
  return json_build_object('ok', true, 'count', v_count);
end $$;

create or replace function public.sv_admin_delete_users(p_token text, p_ids jsonb)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_err text := sv_admin_guard(p_token); v_count int;
begin
  if v_err is not null then return json_build_object('ok', false, 'error', v_err); end if;
  delete from sv_users where id::text in (select jsonb_array_elements_text(p_ids));
  get diagnostics v_count = row_count;
  return json_build_object('ok', true, 'count', v_count);
end $$;

create or replace function public.sv_admin_reset_password(p_token text, p_id uuid, p_password text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_err text := sv_admin_guard(p_token);
begin
  if v_err is not null then return json_build_object('ok', false, 'error', v_err); end if;
  if length(coalesce(p_password, '')) < 6 or length(p_password) > 72 then return json_build_object('ok', false, 'error', 'invalid_password'); end if;
  update sv_users set password_hash = extensions.crypt(p_password, extensions.gen_salt('bf', 10)), failed_attempts = 0, locked_until = null where id = p_id;
  delete from sv_sessions where user_id = p_id;
  return json_build_object('ok', true);
end $$;

create or replace function public.sv_admin_change_password(p_token text, p_new text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_err text := sv_admin_guard(p_token, true);
begin
  if v_err is not null then return json_build_object('ok', false, 'error', v_err); end if;
  if length(coalesce(p_new, '')) < 8 or length(p_new) > 72 then return json_build_object('ok', false, 'error', 'admin_password_short'); end if;
  if p_new = 'CAMBIA-ESTA-CLAVE' then return json_build_object('ok', false, 'error', 'admin_password_short'); end if;
  update sv_config set value = extensions.crypt(p_new, extensions.gen_salt('bf', 10)) where key = 'admin_hash';
  insert into sv_config values ('admin_must_change', 'false') on conflict (key) do update set value = 'false';
  delete from sv_sessions where is_admin and token_hash <> sv_hash_token(p_token);   -- cierra otras sesiones de admin
  return json_build_object('ok', true);
end $$;

-- p_apikey null = conservar la actual · '' = borrarla
create or replace function public.sv_admin_save_notify(p_token text, p_phone text, p_apikey text default null)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_err text := sv_admin_guard(p_token);
begin
  if v_err is not null then return json_build_object('ok', false, 'error', v_err); end if;
  insert into sv_config values ('notify_phone', regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g'))
    on conflict (key) do update set value = excluded.value;
  if p_apikey is not null then
    insert into sv_config values ('notify_apikey', trim(p_apikey)) on conflict (key) do update set value = excluded.value;
  end if;
  return json_build_object('ok', true);
end $$;

create or replace function public.sv_admin_test_notify(p_token text)
returns json language plpgsql security definer set search_path = public, extensions as $$
declare v_err text := sv_admin_guard(p_token);
begin
  if v_err is not null then return json_build_object('ok', false, 'error', v_err); end if;
  if not sv_notify_admin('StockVoz: mensaje de prueba. Las notificaciones de nuevas cuentas funcionan.') then
    return json_build_object('ok', false, 'error', 'notify_not_ready');
  end if;
  return json_build_object('ok', true);
end $$;

-- ---------------------------------------------------------------------
-- 6. Configuración inicial  ← CAMBIÁ LA CLAVE ANTES DE EJECUTAR
-- ---------------------------------------------------------------------
insert into public.sv_config(key, value)
values ('admin_hash', extensions.crypt('CAMBIA-ESTA-CLAVE', extensions.gen_salt('bf', 10)))
on conflict (key) do nothing;
insert into public.sv_config(key, value) values ('admin_must_change', 'true') on conflict (key) do nothing;
-- Tu número para recibir avisos (también se puede cambiar desde admin.html).
insert into public.sv_config(key, value) values ('notify_phone', '5491162021005') on conflict (key) do nothing;
-- Máximo de empleados por cuenta (se puede cambiar: update public.sv_config set value = '20' where key = 'max_team';)
insert into public.sv_config(key, value) values ('max_team', '10') on conflict (key) do nothing;

-- ---------------------------------------------------------------------
-- 7. Permisos: solo las funciones públicas quedan accesibles
-- ---------------------------------------------------------------------
revoke all on function public.sv_hash_token(text) from public, anon, authenticated;
revoke all on function public.sv_new_session(uuid, boolean, int) from public, anon, authenticated;
revoke all on function public.sv_uid(text) from public, anon, authenticated;
revoke all on function public.sv_ctx(text) from public, anon, authenticated;
revoke all on function public.sv_new_entries(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.sv_emp_history(jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.sv_emp_items(jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.sv_union_by_id(jsonb, jsonb, text) from public, anon, authenticated;
revoke all on function public.sv_admin_guard(text, boolean) from public, anon, authenticated;
revoke all on function public.sv_notify_admin(text) from public, anon, authenticated;

grant execute on function public.sv_register(text, text, text, text, text) to anon, authenticated;
grant execute on function public.sv_login(text, text) to anon, authenticated;
grant execute on function public.sv_logout(text) to anon, authenticated;
grant execute on function public.sv_pull(text, int) to anon, authenticated;
grant execute on function public.sv_push(text, jsonb, jsonb, int, jsonb) to anon, authenticated;
grant execute on function public.sv_team_list(text) to anon, authenticated;
grant execute on function public.sv_team_add(text, text, text, text) to anon, authenticated;
grant execute on function public.sv_team_update(text, uuid, text, text) to anon, authenticated;
grant execute on function public.sv_team_remove(text, uuid) to anon, authenticated;
grant execute on function public.sv_admin_login(text) to anon, authenticated;
grant execute on function public.sv_admin_overview(text) to anon, authenticated;
grant execute on function public.sv_admin_set_status(text, jsonb, text) to anon, authenticated;
grant execute on function public.sv_admin_delete_users(text, jsonb) to anon, authenticated;
grant execute on function public.sv_admin_reset_password(text, uuid, text) to anon, authenticated;
grant execute on function public.sv_admin_change_password(text, text) to anon, authenticated;
grant execute on function public.sv_admin_save_notify(text, text, text) to anon, authenticated;
grant execute on function public.sv_admin_test_notify(text) to anon, authenticated;

-- Recarga la API para que vea las funciones nuevas.
notify pgrst, 'reload schema';

-- Listo. Si querés olvidar la clave de admin y volver a empezar:
--   update public.sv_config set value = extensions.crypt('NUEVA-CLAVE', extensions.gen_salt('bf', 10)) where key = 'admin_hash';
