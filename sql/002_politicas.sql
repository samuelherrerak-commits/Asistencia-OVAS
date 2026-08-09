-- =====================================================================
-- OVAS - Sistema de Control de Asistencia
-- sql/002_politicas.sql
-- ---------------------------------------------------------------------
-- POLÍTICAS RLS y PERMISOS para los roles anon/authenticated.
-- Permisivo: pensado para usarse con la "anon key" del navegador.
--
-- CÓMO EJECUTAR:
--   1. Corre primero sql/001_tablas.sql
--   2. Pega TODO el contenido de este archivo y pulsa "Run".
-- =====================================================================

-- ---------------------------------------------------------------------
-- Habilitar Row Level Security en las tablas de la competencia
-- ---------------------------------------------------------------------
alter table public.grupos enable row level security;
alter table public.puntos enable row level security;
alter table public.eventos enable row level security;
alter table public.sanciones enable row level security;

-- ---------------------------------------------------------------------
-- Políticas de grupos
-- ---------------------------------------------------------------------
drop policy if exists "grupos_select" on public.grupos;
create policy "grupos_select" on public.grupos for select using (true);

drop policy if exists "grupos_insert" on public.grupos;
create policy "grupos_insert" on public.grupos for insert with check (true);

drop policy if exists "grupos_update" on public.grupos;
create policy "grupos_update" on public.grupos for update using (true) with check (true);

drop policy if exists "grupos_delete" on public.grupos;
create policy "grupos_delete" on public.grupos for delete using (true);

-- ---------------------------------------------------------------------
-- Políticas de eventos
-- ---------------------------------------------------------------------
drop policy if exists "eventos_select" on public.eventos;
create policy "eventos_select" on public.eventos for select using (true);

drop policy if exists "eventos_insert" on public.eventos;
create policy "eventos_insert" on public.eventos for insert with check (true);

drop policy if exists "eventos_delete" on public.eventos;
create policy "eventos_delete" on public.eventos for delete using (true);

-- ---------------------------------------------------------------------
-- Políticas de puntos
-- ---------------------------------------------------------------------
drop policy if exists "puntos_select" on public.puntos;
create policy "puntos_select" on public.puntos for select using (true);

drop policy if exists "puntos_insert" on public.puntos;
create policy "puntos_insert" on public.puntos for insert with check (true);

-- ---------------------------------------------------------------------
-- Políticas de sanciones (tarjetas)
-- ---------------------------------------------------------------------
drop policy if exists "sanciones_select" on public.sanciones;
create policy "sanciones_select" on public.sanciones for select using (true);

drop policy if exists "sanciones_insert" on public.sanciones;
create policy "sanciones_insert" on public.sanciones for insert with check (true);

-- ---------------------------------------------------------------------
-- Cambiar el grupo de un niño desde el perfil
-- ---------------------------------------------------------------------
drop policy if exists "ninos_update" on public.ninos;
create policy "ninos_update" on public.ninos for update using (true) with check (true);

-- ---------------------------------------------------------------------
-- Permisos de acceso para los roles anon/authenticated
-- ---------------------------------------------------------------------
grant all on public.grupos to anon, authenticated;
grant all on public.eventos to anon, authenticated;
grant all on public.puntos to anon, authenticated;
grant all on public.sanciones to anon, authenticated;
grant all on public.ninos to anon, authenticated;
grant all on public.asistencias to anon, authenticated;
