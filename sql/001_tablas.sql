-- =====================================================================
-- OVAS - Sistema de Control de Asistencia
-- sql/001_tablas.sql
-- ---------------------------------------------------------------------
-- CREACIÓN DE TABLAS (e idempotente: se puede correr varias veces).
-- Incluye la columna `edad` de los niños.
--
-- CÓMO EJECUTAR:
--   1. Entra a https://app.supabase.com -> tu proyecto -> SQL Editor
--   2. Pega TODO el contenido de este archivo y pulsa "Run".
--
-- Después de este archivo corre también sql/002_politicas.sql.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABLA: ninos
-- ---------------------------------------------------------------------
create table if not exists public.ninos (
  id uuid primary key default gen_random_uuid(),
  cedula text not null,
  nombres text not null,
  apellidos text not null,
  codigo_qr text not null,
  edad integer,
  fecha_registro timestamptz default now(),
  activo boolean default true
);

-- ---------------------------------------------------------------------
-- 2. TABLA: asistencias
-- ---------------------------------------------------------------------
create table if not exists public.asistencias (
  id bigint generated always as identity primary key,
  nino_id uuid references public.ninos(id) on delete cascade,
  tipo_movimiento text not null,           -- 'ENTRADA' | 'SALIDA'
  fecha date not null,
  hora time not null,
  registrado_en timestamptz default now()
);

-- ---------------------------------------------------------------------
-- 3. TABLA: grupos  (equipos de la competencia con rango de edades)
-- ---------------------------------------------------------------------
create table if not exists public.grupos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null unique,
  color text not null default '#8b5cf6',
  codigo_qr text,
  edad_min integer,
  edad_max integer,
  creado_en timestamptz default now()
);

-- ---------------------------------------------------------------------
-- 4. TABLA: eventos  (actividades/juegos que dan puntos)
-- ---------------------------------------------------------------------
create table if not exists public.eventos (
  id uuid primary key default gen_random_uuid(),
  nombre text not null unique,
  creado_en timestamptz default now()
);

-- ---------------------------------------------------------------------
-- 5. TABLA: puntos
--    - puntos > 0 : el grupo ganó puntos
--    - puntos < 0 : el grupo perdió puntos
--    - motivo     : razón (evento, tarjeta, asistencia, etc.)
-- ---------------------------------------------------------------------
create table if not exists public.puntos (
  id uuid primary key default gen_random_uuid(),
  grupo_id uuid references public.grupos(id) on delete cascade,
  evento_id uuid references public.eventos(id) on delete set null,
  puntos integer not null,
  motivo text not null,
  fecha date not null default current_date,
  creado_en timestamptz default now()
);

-- ---------------------------------------------------------------------
-- 6. TABLA: sanciones  (tarjetas amarillas y rojas)
--    - Se emiten POR NIÑO pero penalizan al grupo (grupo_id se guarda
--      en el momento de la sanción; si el niño cambia de grupo, la
--      penalización queda en el grupo donde ocurrió).
-- ---------------------------------------------------------------------
create table if not exists public.sanciones (
  id uuid primary key default gen_random_uuid(),
  nino_id uuid references public.ninos(id) on delete cascade,
  grupo_id uuid references public.grupos(id) on delete set null,
  tipo text not null,                      -- 'AMARILLA' | 'ROJA'
  motivo text not null,
  fecha date not null default current_date,
  creado_en timestamptz default now()
);

-- ---------------------------------------------------------------------
-- 7. Columnas nuevas en tablas que ya existían (seguridad para re-correr)
-- ---------------------------------------------------------------------
alter table public.ninos add column if not exists grupo_id uuid references public.grupos(id) on delete set null;
alter table public.ninos add column if not exists edad integer;
alter table public.grupos add column if not exists codigo_qr text;
alter table public.grupos add column if not exists edad_min integer;
alter table public.grupos add column if not exists edad_max integer;
alter table public.puntos add column if not exists evento_id uuid references public.eventos(id) on delete set null;

-- QR de los grupos ya existentes: codifica "G-" + id para distinguirlo
-- de los QR de niños en el escáner.
update public.grupos set codigo_qr = 'G-' || id where codigo_qr is null;

-- ---------------------------------------------------------------------
-- 8. Índices para consultas rápidas
-- ---------------------------------------------------------------------
create index if not exists idx_asistencias_nino_fecha on public.asistencias(nino_id, fecha);
create index if not exists idx_asistencias_fecha on public.asistencias(fecha);
create index if not exists idx_puntos_grupo_fecha on public.puntos(grupo_id, fecha);
create index if not exists idx_sanciones_nino on public.sanciones(nino_id);
create index if not exists idx_sanciones_fecha on public.sanciones(fecha);
