/* =====================================================================
   OVAS - Sistema de Control de Asistencia
   config.js
   ---------------------------------------------------------------------
   Aquí van las credenciales de Supabase y configuraciones generales.

   CÓMO CAMBIAR LAS CREDENCIALES DE SUPABASE:
   1. Entra a https://app.supabase.com -> tu proyecto -> Settings -> API
   2. Copia "Project URL" y pégalo en SUPABASE_URL
   3. Copia la llave "anon public" y pégala en SUPABASE_ANON_KEY
   4. Guarda este archivo. No necesitas tocar nada más.

   IMPORTANTE: la "anon key" es pública por diseño (se usa en el navegador),
   pero la seguridad real la dan las políticas RLS configuradas en
   Supabase (ver supabase_setup.sql). Nunca pongas aquí la "service_role key".
===================================================================== */

const SUPABASE_URL = 'https://nkcimoqtluagnhavtdrz.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5rY2ltb3F0bHVhZ25oYXZ0ZHJ6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwNzI4NjAsImV4cCI6MjA5NzY0ODg2MH0._U83O-JCgN-c4VvnYWmk_BP1CEXkdTh_I7IPFHaIDJo';

// Cliente global de Supabase (se usa en app.js).
// La librería @supabase/supabase-js se carga vía CDN en index.html
// y expone el objeto global `supabase`.
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* =====================================================================
   CONFIGURACIÓN GENERAL DE LA APP
===================================================================== */
const APP_CONFIG = {
  // Nombre que aparece en encabezados / impresión de QR
  nombreEvento: 'OVAS - Oratorio',

  // Tamaño del QR generado (px)
  qrSize: 260,

  // Tiempo (ms) que se muestra el mensaje de resultado tras escanear
  mensajeResultadoDuracion: 3500,

  // Tiempo mínimo (ms) entre dos lecturas del mismo código,
  // para evitar registros duplicados por lecturas repetidas de cámara
  antiRebotMs: 4000,

  // Formato de hora a mostrar en pantalla
  localeHora: 'es-VE',
};

/* =====================================================================
   CÓMO MODIFICAR LAS TABLAS / ESQUEMA
   ---------------------------------------------------------------------
   - Los nombres de tabla y columnas usados por la app están centralizados
     en el objeto TABLES de abajo. Si renombras una tabla o columna en
     Supabase, sólo necesitas actualizar este objeto (no hay nombres
     de tabla/columna sueltos repartidos en app.js).
   - Si agregas columnas nuevas, no es necesario tocar TABLES, sólo
     ajusta los formularios y los inserts en app.js donde corresponda.
===================================================================== */
const TABLES = {
  ninos: 'ninos',
  asistencias: 'asistencias',
};
