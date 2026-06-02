create extension if not exists pgcrypto;

create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  cedula text not null unique,
  password_hash text not null,
  full_name text not null,
  role text not null default 'operador',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  category text not null check (
    category in ('camaras', 'lentes', 'flashes', 'tripodes', 'filtros', 'triggers', 'memorias', 'gadgets')
  ),
  serial text not null,
  location text not null,
  status text not null default 'disponible' check (
    status in ('disponible', 'paquete', 'mantenimiento', 'perdido')
  ),
  condition text not null default 'Bueno',
  notes text not null default '',
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_items_created_by_serial_key unique (created_by, serial)
);

create table if not exists public.production_packages (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  client text not null default '',
  session_date date,
  notes text not null default '',
  created_by uuid not null references public.app_users(id),
  created_at timestamptz not null default now()
);

create table if not exists public.package_items (
  package_id uuid not null references public.production_packages(id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (package_id, inventory_item_id)
);

create table if not exists public.package_checks (
  package_id uuid not null references public.production_packages(id) on delete cascade,
  inventory_item_id uuid not null references public.inventory_items(id) on delete cascade,
  mode text not null check (mode in ('salida', 'regreso')),
  checked boolean not null default false,
  checked_at timestamptz,
  checked_by uuid references public.app_users(id),
  primary key (package_id, inventory_item_id, mode)
);

create or replace function public.register_user(
  p_cedula text,
  p_password text,
  p_full_name text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_user public.app_users;
begin
  if length(trim(p_cedula)) < 6 then
    raise exception 'La cedula debe tener minimo 6 digitos';
  end if;

  if length(p_password) < 6 then
    raise exception 'La contrasena debe tener minimo 6 caracteres';
  end if;

  insert into public.app_users (cedula, password_hash, full_name)
  values (trim(p_cedula), crypt(p_password, gen_salt('bf')), trim(p_full_name))
  returning * into v_user;

  return jsonb_build_object(
    'id', v_user.id,
    'cedula', v_user.cedula,
    'full_name', v_user.full_name,
    'role', v_user.role
  );
end;
$$;

create or replace function public.login_user(
  p_cedula text,
  p_password text
)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_user public.app_users;
begin
  select *
  into v_user
  from public.app_users
  where cedula = trim(p_cedula)
    and active = true
    and password_hash = crypt(p_password, password_hash);

  if v_user.id is null then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_user.id,
    'cedula', v_user.cedula,
    'full_name', v_user.full_name,
    'role', v_user.role
  );
end;
$$;
