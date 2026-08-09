-- =====================================================================
-- OVAS - Sistema de Control de Asistencia
-- sql/003_carnets.sql
-- ---------------------------------------------------------------------
-- CARNETS (identidad visual Mundial 2026)
--  1) Columnas nuevas en ninos: carnet_id, foto_url y datos del reverso.
--  2) Columna "equipo" (país) en grupos para la bandera del carnet.
--  3) Bucket público de fotos en Supabase Storage + políticas.
-- Idempotente: se puede correr varias veces.
--
-- CÓMO EJECUTAR:
--   1. Corre primero sql/001_tablas.sql y sql/002_politicas.sql
--   2. Pega TODO el contenido de este archivo y pulsa "Run".
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. COLUMNAS NUEVAS EN ninos
--    - carnet_id            : código corto que se imprime en el carnet
--                             (ej: CAMP2026-00123)
--    - foto_url             : URL pública de la foto del niño en Storage
--    - alergias             : alergias conocidas ("" si ninguna)
--    - representante / tel_representante : adulto responsable + teléfono
--    - contacto_emergencia / tel_emergencia : contacto de emergencia
-- ---------------------------------------------------------------------
alter table public.ninos add column if not exists carnet_id text;
alter table public.ninos add column if not exists foto_url text;
alter table public.ninos add column if not exists alergias text;
alter table public.ninos add column if not exists representante text;
alter table public.ninos add column if not exists tel_representante text;
alter table public.ninos add column if not exists contacto_emergencia text;
alter table public.ninos add column if not exists tel_emergencia text;

-- Generar carnet_id a los niños que ya existen (no se re-scribe si ya lo tienen).
-- Formato: "CAMP2026-" + 5 caracteres derivados del uuid (estable y único).
update public.ninos
   set carnet_id = 'CAMP2026-' || upper(left(replace(id::text, '-', ''), 5))
 where carnet_id is null;

-- ---------------------------------------------------------------------
-- 2. COLUMNA "equipo" EN grupos (país que representa el grupo)
--    Valores: 'argentina' | 'portugal' | 'españa' | 'francia'
-- ---------------------------------------------------------------------
alter table public.grupos add column if not exists equipo text default 'argentina';

-- ---------------------------------------------------------------------
-- 3. STORAGE: bucket público para las fotos de los carnets
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('carnets', 'carnets', true, 5242880, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update
  set public = true,
      file_size_limit = 5242880,
      allowed_mime_types = array['image/png','image/jpeg','image/webp'];

-- Políticas del bucket (permiten subir y leer con la anon key).
drop policy if exists "carnets_select" on storage.objects;
create policy "carnets_select" on storage.objects
  for select using (bucket_id = 'carnets');

drop policy if exists "carnets_insert" on storage.objects;
create policy "carnets_insert" on storage.objects
  for insert with check (bucket_id = 'carnets');

drop policy if exists "carnets_update" on storage.objects;
create policy "carnets_update" on storage.objects
  for update using (bucket_id = 'carnets') with check (bucket_id = 'carnets');

drop policy if exists "carnets_delete" on storage.objects;
create policy "carnets_delete" on storage.objects
  for delete using (bucket_id = 'carnets');
