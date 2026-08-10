-- =====================================================================
-- 004_importar_excel.sql
-- ---------------------------------------------------------------------
-- 1) Agrega la columna "taller" a la tabla ninos (talleres del OVAS:
--    FUTBOLITO, DIBUJO, BAILE, VOLEIBOL, MANUALIDADES, REPOSTERIA,
--    FOTOGRAFIA).
-- 2) Desactiva RLS en asistencias/puntos/ninos. Los inserts que hace
--    la app desde el cliente (anon) fallaban con RLS activo y sin
--    políticas: el escáner no podía registrar movimientos ni la
--    importación masiva insertar niños.
-- =====================================================================

alter table public.ninos add column if not exists taller text;

alter table public.asistencias disable row level security;
alter table public.puntos disable row level security;
alter table public.ninos disable row level security;
