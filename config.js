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

const SUPABASE_URL = 'https://atdezjqbisasslakbeae.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImF0ZGV6anFiaXNhc3NsYWtiZWFlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODYxMjgyNDksImV4cCI6MjEwMTcwNDI0OX0.vAh4lOh2PIizzQ52kT0_Sk3bE6WjBPeXyTZlU5CzxvA';

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

  // Puntos que recibe el grupo de un niño por cada ENTRADA registrada
  // con el QR. Pon 0 para desactivar la asistencia como fuente de puntos.
  puntosPorAsistencia: 1,

  // Puntos que restan las tarjetas al grupo del niño.
  // Se acumulan: 3 amarillas (-15) + roja (-10) = -25.
  puntosTarjetaAmarilla: -5,
  puntosTarjetaRoja: -10,

  // Regla del puntaje: los puntos otorgados/descontados deben ser
  // múltiplos de `puntosMultiplo` y no superar `puntosMaximo`
  // (en valor absoluto) por operación.
  puntosMultiplo: 5,
  puntosMaximo: 50,

  // ==================== CARNETS ====================
  // Vigencia del plan que se imprime en el carnet ("Válido: 09 – 23 ago 2026").
  planInicio: '2026-08-09',
  planFin: '2026-08-23',

  // Prefijo del ID de carnet (ej: CAMP2026-00123).
  carnetIdPrefijo: 'CAMP2026-',

  // Bucket de Supabase Storage donde se guardan las fotos de los niños.
  bucketFotos: 'carnets',

  // Nombre del evento en el frente del carnet.
  nombreCarnet: 'OVAS 2026',
  lemaCarnet: 'Creyentes libres para amar',
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
  grupos: 'grupos',
  puntos: 'puntos',
  eventos: 'eventos',
  sanciones: 'sanciones',
};

/* =====================================================================
   URL PÚBLICA DE ARCHIVOS EN STORAGE
   ---------------------------------------------------------------------
   Los carnets usan el logo y la foto de fondo desde Supabase Storage
   (bucket público) para que se vean sin importar dónde esté alojado el
   portal (Render, local, etc.). `assetUrl` construye la URL absoluta.
===================================================================== */
function assetUrl(nombre) {
  return `${SUPABASE_URL}/storage/v1/object/public/${APP_CONFIG.bucketFotos}/${encodeURIComponent(nombre)}`;
}
