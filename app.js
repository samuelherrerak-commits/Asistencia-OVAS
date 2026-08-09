/* =====================================================================
   OVAS - Sistema de Control de Asistencia
   app.js
   ---------------------------------------------------------------------
   Lógica completa de la aplicación: conexión a Supabase, CRUD de niños,
   generación e impresión de QR, lectura de cámara (escáner), registro
   de asistencias, dashboard, búsquedas y reportes CSV.

   CÓMO FUNCIONA LA CÁMARA EN IPHONE (Safari/iOS):
   - Safari en iOS requiere HTTPS (o localhost) para dar acceso a la
     cámara. Si despliegas esto en un hosting sin HTTPS, la cámara
     NO funcionará.
   - La librería html5-qrcode internamente usa getUserMedia(). En iOS
     es importante iniciar el escáner únicamente tras una interacción
     directa del usuario (tap), por eso el escáner se arranca cuando
     el usuario entra a la pestaña "Escanear", nunca automáticamente
     en segundo plano.
   - Se solicita la cámara trasera con { facingMode: "environment" }.
     Si el dispositivo no la tiene (ej. iPad sin trasera), la librería
     cae automáticamente a la disponible.
   - iOS Safari no permite múltiples streams de cámara simultáneos:
     por eso el escáner se detiene (Html5Qrcode.stop()) al salir de
     la pestaña, evitando dejar la cámara "colgada".

   CÓMO CAMBIAR CREDENCIALES DE SUPABASE:
   Ver config.js (SUPABASE_URL / SUPABASE_ANON_KEY).

   CÓMO MODIFICAR TABLAS:
   Los nombres de tabla están centralizados en TABLES (config.js).
   Los nombres de columnas usados aquí siguen el esquema de
   supabase_setup.sql: ninos(id, cedula, nombres, apellidos, codigo_qr,
   fecha_registro, activo) y asistencias(id, nino_id, tipo_movimiento,
   fecha, hora, registrado_en).
===================================================================== */

/* =====================================================================
   ESTADO GLOBAL
===================================================================== */
const STATE = {
  currentView: 'dashboard',
  ninosCache: [],          // cache local de niños para búsquedas rápidas
  gruposCache: [],         // cache local de grupos de la competencia
  eventosCache: [],        // cache local de eventos (juegos/actividades)
  modoEscaneo: 'ENTRADA',  // 'ENTRADA' | 'SALIDA' | 'PUNTOS'
  html5QrCode: null,       // instancia activa del lector de cámara
  scannerRunning: false,
  ultimoEscaneo: { codigo: null, ts: 0 }, // anti-rebote
  ninoSeleccionadoId: null,
  grupoScanId: null,       // grupo detectado al escanear en modo PUNTOS
  tarjetaNinoId: null,     // niño detectado al escanear en modo TARJETA
  tarjetaTipo: 'AMARILLA', // 'AMARILLA' | 'ROJA'
  fotoArchivo: null,       // archivo de foto elegido en el formulario (sin subir aún)
};

/* =====================================================================
   UTILIDADES GENERALES
===================================================================== */

/** Muestra un mensaje flotante (toast) en la parte superior. */
function showToast(mensaje, tipo = 'success', duracion = 3000) {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast ${tipo}`;
  toast.textContent = mensaje;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, duracion);
}

/** Formatea una fecha/hora ISO a hora legible, ej: "08:05 AM". */
function formatearHora(fechaISO) {
  const d = new Date(fechaISO);
  return d.toLocaleTimeString(APP_CONFIG.localeHora, { hour: '2-digit', minute: '2-digit', hour12: true });
}

/** Formatea una fecha ISO a "dd/mm/yyyy". */
function formatearFecha(fechaISO) {
  const d = new Date(fechaISO);
  return d.toLocaleDateString(APP_CONFIG.localeHora);
}

/** Devuelve la fecha de HOY en formato YYYY-MM-DD (zona horaria local). */
function fechaHoyISO() {
  const d = new Date();
  const tzOffset = d.getTimezoneOffset() * 60000;
  return new Date(d - tzOffset).toISOString().slice(0, 10);
}

/** Obtiene iniciales de un nombre completo, ej: "Juan Pérez" -> "JP". */
function obtenerIniciales(nombres, apellidos) {
  const n = (nombres || '').trim().charAt(0).toUpperCase();
  const a = (apellidos || '').trim().charAt(0).toUpperCase();
  return `${n}${a}` || '?';
}

/** Re-renderiza los íconos lucide nuevos que se hayan insertado en el DOM. */
function refrescarIconos() {
  if (window.lucide) lucide.createIcons();
}

/* =====================================================================
   NAVEGACIÓN ENTRE VISTAS
===================================================================== */
function cambiarVista(viewName) {
  // Si salimos de la vista de escáner, detener la cámara (importante en iOS).
  if (STATE.currentView === 'scanner' && viewName !== 'scanner') {
    detenerEscaner();
  }

  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById(`view-${viewName}`).classList.remove('hidden');

  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.querySelector(`.nav-btn[data-view="${viewName}"]`).classList.add('active');

  const titulos = {
    dashboard: 'OVAS',
    scanner: 'Escanear QR',
    admin: 'Niños registrados',
    grupos: 'Grupos',
    competencia: 'Competencia',
    reportes: 'Reportes',
    carnets: 'Carnets',
  };
  document.getElementById('headerTitle').textContent = titulos[viewName] || 'OVAS';

  STATE.currentView = viewName;

  // Cargar datos frescos al entrar a cada vista
  if (viewName === 'dashboard') cargarDashboard();
  if (viewName === 'admin') cargarListaNinos();
  if (viewName === 'grupos') cargarGrupos();
  if (viewName === 'scanner') iniciarEscaner();
  if (viewName === 'competencia') cargarCompetencia();
  if (viewName === 'carnets') cargarVistaCarnets();
  if (viewName === 'reportes') {
    const inputFecha = document.getElementById('reportDate');
    if (!inputFecha.value) inputFecha.value = fechaHoyISO();
  }

  refrescarIconos();
}

/* =====================================================================
   DASHBOARD
===================================================================== */
async function cargarDashboard() {
  try {
    const hoy = fechaHoyISO();
    await cargarGrupos();

    // Total de niños activos
    const { count: totalNinos, error: errTotal } = await supabaseClient
      .from(TABLES.ninos)
      .select('*', { count: 'exact', head: true })
      .eq('activo', true);
    if (errTotal) throw errTotal;

    // Asistencias de hoy
    const { data: asistenciasHoy, error: errAsist } = await supabaseClient
      .from(TABLES.asistencias)
      .select('id, nino_id, tipo_movimiento, hora, registrado_en, ninos(nombres, apellidos)')
      .eq('fecha', hoy)
      .order('registrado_en', { ascending: false });
    if (errAsist) throw errAsist;

    const entradas = asistenciasHoy.filter(a => a.tipo_movimiento === 'ENTRADA');
    const salidas = asistenciasHoy.filter(a => a.tipo_movimiento === 'SALIDA');

    // "Dentro" = niños cuyo último movimiento de HOY es ENTRADA
    const ultimoPorNino = new Map();
    // Recorremos en orden cronológico ascendente para quedarnos con el último real
    [...asistenciasHoy].reverse().forEach(a => ultimoPorNino.set(a.nino_id, a.tipo_movimiento));
    const dentro = [...ultimoPorNino.values()].filter(v => v === 'ENTRADA').length;

    document.getElementById('statTotalNinos').textContent = totalNinos ?? 0;
    document.getElementById('statEntradasHoy').textContent = entradas.length;
    document.getElementById('statSalidasHoy').textContent = salidas.length;
    document.getElementById('statDentro').textContent = dentro;

    // Últimos movimientos (máximo 12)
    const contenedor = document.getElementById('ultimosMovimientos');
    if (asistenciasHoy.length === 0) {
      contenedor.innerHTML = '<p class="empty-state">Aún no hay movimientos registrados hoy.</p>';
    } else {
      contenedor.innerHTML = asistenciasHoy.slice(0, 12).map(a => {
        const esEntrada = a.tipo_movimiento === 'ENTRADA';
        const nombre = a.ninos ? `${a.ninos.nombres} ${a.ninos.apellidos}` : 'Niño eliminado';
        return `
          <div class="movement-item">
            <div class="movement-icon ${esEntrada ? 'entrada' : 'salida'}">
              <i data-lucide="${esEntrada ? 'log-in' : 'log-out'}"></i>
            </div>
            <div class="movement-info">
              <div class="movement-name">${escapeHtml(nombre)}</div>
              <div class="movement-type">${esEntrada ? 'Entrada' : 'Salida'}</div>
            </div>
            <div class="movement-time">${formatearHora(a.registrado_en)}</div>
          </div>
        `;
      }).join('');
    }

    refrescarIconos();

    // Mini tabla de posiciones (top 3 grupos)
    await cargarMiniRanking();
  } catch (err) {
    console.error('Error cargando dashboard:', err);
    showToast('No se pudo cargar el dashboard. Revisa tu conexión.', 'error');
  }
}

/** Escapa HTML para prevenir inyección al insertar nombres en el DOM. */
function escapeHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto ?? '';
  return div.innerHTML;
}

/** Genera el ID corto de carnet (ej: CAMP2026-00123) a partir del uuid. */
function generarCarnetId(id) {
  const prefijo = APP_CONFIG.carnetIdPrefijo || 'CAMP2026-';
  const hex = String(id).replace(/-/g, '').slice(0, 5).toUpperCase();
  return `${prefijo}${hex}`;
}

/** Formatea la vigencia del plan, ej: "09 – 23 ago 2026". */
function formatearVigencia() {
  try {
    const inicio = new Date(`${APP_CONFIG.planInicio}T00:00:00`);
    const fin = new Date(`${APP_CONFIG.planFin}T00:00:00`);
    const diaInicio = inicio.getDate();
    const diaFin = fin.getDate();
    const mesFin = fin.toLocaleDateString('es', { month: 'short' }).replace(/\./g, '');
    return `${diaInicio} – ${diaFin} ${mesFin} ${fin.getFullYear()}`;
  } catch (e) {
    return `${APP_CONFIG.planInicio} – ${APP_CONFIG.planFin}`;
  }
}

/* =====================================================================
   GRUPOS DE LA COMPETENCIA
===================================================================== */

/** Carga los grupos desde Supabase, actualiza la cache y los selects. */
async function cargarGrupos() {
  try {
    const { data, error } = await supabaseClient
      .from(TABLES.grupos)
      .select('id, nombre, color, codigo_qr, edad_min, edad_max')
      .order('nombre', { ascending: true });
    if (error) throw error;
    STATE.gruposCache = data || [];

    // Poblar los selects de grupo (formulario de niño, perfil, puntos)
    ['inputGrupo', 'perfilGrupoSelect'].forEach(id => {
      const sel = document.getElementById(id);
      if (!sel) return;
      const actual = sel.value;
      sel.innerHTML = '<option value="">Sin grupo</option>' +
        STATE.gruposCache.map(g => `<option value="${g.id}">${escapeHtml(g.nombre)}</option>`).join('');
      sel.value = actual;
    });

    pintarListaGrupos();
  } catch (err) {
    console.error('Error cargando grupos:', err);
  }
}

/** Devuelve el rango de edades legible de un grupo, ej: "6–8 años". */
function rangoEdades(grupo) {
  if (grupo && (grupo.edad_min != null || grupo.edad_max != null)) {
    return `${grupo.edad_min ?? '?'}–${grupo.edad_max ?? '?'} años`;
  }
  return 'Sin rango de edades';
}

/** Busca el grupo cuyo rango cubre la edad. Si hay varios, elige el de
 *  rango más ajustado (menor diferencia edad_max - edad_min). */
function obtenerGrupoPorEdad(edad) {
  const numero = parseInt(edad, 10);
  if (!Number.isFinite(numero)) return null;
  const candidatos = STATE.gruposCache.filter(g =>
    g.edad_min != null && g.edad_max != null &&
    numero >= g.edad_min && numero <= g.edad_max
  );
  if (candidatos.length === 0) return null;
  return candidatos
    .slice()
    .sort((a, b) => (a.edad_max - a.edad_min) - (b.edad_max - b.edad_min))[0];
}

/** Pinta la lista de grupos de la pestaña Grupos. */
function pintarListaGrupos() {
  const contenedor = document.getElementById('gruposList');
  if (!contenedor) return;
  if (STATE.gruposCache.length === 0) {
    contenedor.innerHTML = '<p class="empty-state">No hay grupos creados. Crea el primero arriba.</p>';
    return;
  }
  contenedor.innerHTML = STATE.gruposCache.map(g => {
    return `
    <div class="grupo-card liquid-glass">
      <div class="grupo-card-head">
        <span class="grupo-badge" style="--gcolor:${escapeHtml(g.color)}">
          ${escapeHtml(g.nombre)}
        </span>
        <span class="grupo-edades"><i data-lucide="calendar-range"></i> ${escapeHtml(rangoEdades(g))}</span>
      </div>
      <div class="grupo-card-actions">
        <button class="secondary-btn small-btn" data-ver-qr="${g.id}"><i data-lucide="qr-code"></i> Ver QR</button>
        <button class="secondary-btn small-btn" data-editar-grupo="${g.id}"><i data-lucide="pencil"></i> Editar</button>
        <button class="secondary-btn small-btn danger" data-eliminar-grupo="${g.id}"><i data-lucide="trash-2"></i> Eliminar</button>
      </div>
    </div>
  `;
  }).join('');

  contenedor.querySelectorAll('[data-ver-qr]').forEach(b => b.addEventListener('click', () => verQRGrupo(b.dataset.verQr)));
  contenedor.querySelectorAll('[data-editar-grupo]').forEach(b => b.addEventListener('click', () => abrirModalEditarGrupo(b.dataset.editarGrupo)));
  contenedor.querySelectorAll('[data-eliminar-grupo]').forEach(b => b.addEventListener('click', () => eliminarGrupo(b.dataset.eliminarGrupo)));
  refrescarIconos();
}

async function guardarGrupo(e) {
  e.preventDefault();
  const nombre = document.getElementById('inputGrupoNombre').value.trim();
  const color = document.getElementById('inputGrupoColor').value;
  const edadMin = document.getElementById('inputGrupoEdadMin').value;
  const edadMax = document.getElementById('inputGrupoEdadMax').value;
  if (!nombre) {
    showToast('Escribe un nombre para el grupo.', 'warning');
    return;
  }
  const btn = document.getElementById('btnGuardarGrupoNuevo');
  btn.disabled = true;
  try {
    const nuevoId = crypto.randomUUID();
    const { error } = await supabaseClient
      .from(TABLES.grupos)
      .insert([{
        id: nuevoId,
        nombre,
        color,
        codigo_qr: `G-${nuevoId}`,
        edad_min: edadMin ? parseInt(edadMin, 10) : null,
        edad_max: edadMax ? parseInt(edadMax, 10) : null,
      }]);
    if (error) throw error;
    showToast('Grupo creado.', 'success');
    document.getElementById('formGrupo').reset();
    await cargarGrupos();
  } catch (err) {
    console.error('Error creando grupo:', err);
    showToast('No se pudo crear el grupo (¿nombre duplicado?).', 'error');
  } finally {
    btn.disabled = false;
  }
}

function abrirModalEditarGrupo(grupoId) {
  const grupo = STATE.gruposCache.find(g => g.id === grupoId);
  if (!grupo) return;
  document.getElementById('editGrupoId').value = grupo.id;
  document.getElementById('editGrupoNombre').value = grupo.nombre;
  document.getElementById('editGrupoColor').value = grupo.color || '#8b5cf6';
  document.getElementById('editGrupoEdadMin').value = grupo.edad_min ?? '';
  document.getElementById('editGrupoEdadMax').value = grupo.edad_max ?? '';
  document.getElementById('modalGrupoEdit').classList.remove('hidden');
  refrescarIconos();
}

function cerrarModalEditarGrupo() {
  document.getElementById('modalGrupoEdit').classList.add('hidden');
}

async function guardarEdicionGrupo(e) {
  e.preventDefault();
  const id = document.getElementById('editGrupoId').value;
  const nombre = document.getElementById('editGrupoNombre').value.trim();
  const color = document.getElementById('editGrupoColor').value;
  const edadMin = document.getElementById('editGrupoEdadMin').value;
  const edadMax = document.getElementById('editGrupoEdadMax').value;
  if (!nombre) {
    showToast('Escribe un nombre para el grupo.', 'warning');
    return;
  }
  const btn = document.getElementById('btnGuardarEdicionGrupo');
  btn.disabled = true;
  try {
    const { error } = await supabaseClient
      .from(TABLES.grupos)
      .update({
        nombre,
        color,
        edad_min: edadMin ? parseInt(edadMin, 10) : null,
        edad_max: edadMax ? parseInt(edadMax, 10) : null,
      })
      .eq('id', id);
    if (error) throw error;
    showToast('Grupo actualizado.', 'success');
    cerrarModalEditarGrupo();
    await cargarGrupos();
  } catch (err) {
    console.error('Error editando grupo:', err);
    showToast('No se pudo actualizar el grupo.', 'error');
  } finally {
    btn.disabled = false;
  }
}

/** Genera y muestra el QR del grupo en su modal (ver/descargar/imprimir). */
function verQRGrupo(grupoId) {
  const grupo = STATE.gruposCache.find(g => g.id === grupoId);
  if (!grupo) return;
  const canvasEl = document.getElementById('grupoQrCanvas');
  canvasEl.innerHTML = '';
  new QRCode(canvasEl, {
    text: grupo.codigo_qr || `G-${grupo.id}`,
    width: APP_CONFIG.qrSize,
    height: APP_CONFIG.qrSize,
    correctLevel: QRCode.CorrectLevel.M,
  });
  document.getElementById('grupoQrNombre').textContent = `${grupo.nombre} · ${rangoEdades(grupo)}`;
  document.getElementById('modalGrupoQr').dataset.grupoId = grupo.id;
  document.getElementById('modalGrupoQr').classList.remove('hidden');
  refrescarIconos();
}

function cerrarModalGrupoQr() {
  document.getElementById('modalGrupoQr').classList.add('hidden');
}

function descargarQRGrupo() {
  const modal = document.getElementById('modalGrupoQr');
  const grupo = STATE.gruposCache.find(g => g.id === modal.dataset.grupoId);
  descargarQR('grupoQrCanvas', `QR_GRUPO_${(grupo ? grupo.nombre : 'grupo').replace(/\s+/g, '_')}`);
}

function imprimirQRGrupo() {
  const modal = document.getElementById('modalGrupoQr');
  const grupo = STATE.gruposCache.find(g => g.id === modal.dataset.grupoId);
  const contenedor = document.getElementById('grupoQrCanvas');
  const dataUrl = obtenerImagenQRDeContenedor(contenedor);
  if (!dataUrl) {
    showToast('No se encontró el código QR para imprimir.', 'error');
    return;
  }
  const printArea = document.getElementById('printArea');
  printArea.className = 'print-area';
  printArea.innerHTML = `
    <img src="${dataUrl}" style="width:280px;height:280px;" />
    <div class="print-qr-name">${escapeHtml(grupo ? grupo.nombre : 'Grupo')}</div>
    <div class="print-qr-cedula">${escapeHtml(grupo ? rangoEdades(grupo) : '')}</div>
  `;
  window.print();
}

async function eliminarGrupo(grupoId) {
  const grupo = STATE.gruposCache.find(g => g.id === grupoId);
  if (!grupo) return;
  if (!confirm(`¿Eliminar el grupo "${grupo.nombre}"?\nLos niños quedarán sin grupo y sus puntos se eliminarán.`)) return;
  try {
    const { error } = await supabaseClient
      .from(TABLES.grupos)
      .delete()
      .eq('id', grupoId);
    if (error) throw error;
    showToast('Grupo eliminado.', 'success');
    await cargarGrupos();
  } catch (err) {
    console.error('Error eliminando grupo:', err);
    showToast('No se pudo eliminar el grupo.', 'error');
  }
}

/* =====================================================================
   COMPETENCIA: PUNTOS Y RANKING
===================================================================== */

/** Suma los puntos registrados por grupo: { [grupo_id]: total }. */
async function obtenerPuntosPorGrupo() {
  const { data: puntos, error } = await supabaseClient
    .from(TABLES.puntos)
    .select('grupo_id, puntos');
  if (error) throw error;
  const totales = {};
  (puntos || []).forEach(p => {
    totales[p.grupo_id] = (totales[p.grupo_id] || 0) + (p.puntos || 0);
  });
  return totales;
}

/** Widget compacto del dashboard: los 3 primeros grupos. */
async function cargarMiniRanking() {
  const contenedor = document.getElementById('miniRanking');
  try {
    if (STATE.gruposCache.length === 0) {
      contenedor.innerHTML = '<p class="empty-state">Aún no hay grupos creados. Crea uno desde la pestaña Competencia.</p>';
      return;
    }
    const totales = await obtenerPuntosPorGrupo();
    const medallas = ['🥇', '🥈', '🥉'];
    const tabla = STATE.gruposCache
      .map(g => ({ ...g, total: totales[g.id] || 0 }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 3);

    contenedor.innerHTML = tabla.map((g, idx) => `
      <div class="mini-ranking-item">
        <span class="mini-ranking-pos">${medallas[idx]}</span>
        <span class="grupo-badge" style="--gcolor:${escapeHtml(g.color)}">${escapeHtml(g.nombre)}</span>
        <span class="mini-ranking-total">${g.total} pts</span>
      </div>
    `).join('');
  } catch (err) {
    console.error('Error cargando mini ranking:', err);
    contenedor.innerHTML = '<p class="empty-state">No se pudo cargar el marcador.</p>';
  }
}

/** Vista completa de competencia: ranking de grupos + historial de puntos. */
async function cargarCompetencia() {
  try {
    await Promise.all([cargarGrupos(), cargarEventos()]);
    const grupos = STATE.gruposCache;
    const rankingEl = document.getElementById('rankingList');

    // Valores visibles de las tarjetas según la configuración
    pintarValoresTarjeta();

    if (grupos.length === 0) {
      rankingEl.innerHTML = '<p class="empty-state">No hay grupos creados. Créalos desde la pestaña "Grupos".</p>';
      document.getElementById('puntosHistorial').innerHTML = '<p class="empty-state">Aún no hay movimientos de puntos.</p>';
      document.getElementById('tarjetasHistorial').innerHTML = '<p class="empty-state">Sin tarjetas registradas.</p>';
      return;
    }

    const totales = await obtenerPuntosPorGrupo();
    const tabla = grupos
      .map(g => ({ ...g, total: totales[g.id] || 0 }))
      .sort((a, b) => b.total - a.total);

    const medallas = ['🥇', '🥈', '🥉'];
    rankingEl.innerHTML = tabla.map((g, idx) => `
      <div class="ranking-item liquid-glass ${idx === 0 ? 'first' : ''}">
        <div class="ranking-pos">${medallas[idx] || (idx + 1)}</div>
        <span class="grupo-badge" style="--gcolor:${escapeHtml(g.color)}">${escapeHtml(g.nombre)}</span>
        <div class="ranking-total">${g.total} <span>pts</span></div>
      </div>
    `).join('');

    // Historial de puntos (últimos 20 movimientos)
    const { data: historial, error: errHist } = await supabaseClient
      .from(TABLES.puntos)
      .select('puntos, motivo, creado_en, grupos(nombre, color)')
      .order('creado_en', { ascending: false })
      .limit(20);
    if (errHist) throw errHist;

    const histEl = document.getElementById('puntosHistorial');
    if (!historial || historial.length === 0) {
      histEl.innerHTML = '<p class="empty-state">Aún no hay movimientos de puntos.</p>';
    } else {
      histEl.innerHTML = historial.map(h => {
        const nombre = h.grupos ? h.grupos.nombre : 'Grupo eliminado';
        const color = h.grupos ? h.grupos.color : '#8b5cf6';
        const positivo = (h.puntos || 0) >= 0;
        return `
          <div class="movement-item">
            <div class="movement-icon ${positivo ? 'entrada' : 'salida'}">
              <i data-lucide="${positivo ? 'trending-up' : 'trending-down'}"></i>
            </div>
            <div class="movement-info">
              <div class="movement-name">
                <span class="grupo-badge mini" style="--gcolor:${escapeHtml(color)}">${escapeHtml(nombre)}</span>
              </div>
              <div class="movement-type">${escapeHtml(h.motivo)} · ${formatearFecha(h.creado_en)}</div>
            </div>
            <div class="movement-time">${h.puntos > 0 ? '+' : ''}${h.puntos}</div>
          </div>
        `;
      }).join('');
    }

    // Historial de tarjetas (últimas 15)
    const { data: tarjetas, error: errTarjetas } = await supabaseClient
      .from(TABLES.sanciones)
      .select('id, tipo, motivo, creado_en, grupos(nombre, color), ninos(nombres, apellidos)')
      .order('creado_en', { ascending: false })
      .limit(15);
    if (errTarjetas) throw errTarjetas;

    const tarjetasEl = document.getElementById('tarjetasHistorial');
    if (!tarjetas || tarjetas.length === 0) {
      tarjetasEl.innerHTML = '<p class="empty-state">Sin tarjetas registradas.</p>';
    } else {
      tarjetasEl.innerHTML = tarjetas.map(t => {
        const esAmarilla = t.tipo === 'AMARILLA';
        const nombreGrupo = t.grupos ? t.grupos.nombre : 'Grupo eliminado';
        const colorGrupo = t.grupos ? t.grupos.color : '#8b5cf6';
        const nombreNino = t.ninos ? `${t.ninos.nombres} ${t.ninos.apellidos}` : 'Niño eliminado';
        return `
          <div class="tarjeta-item ${esAmarilla ? 'amarilla' : 'roja'}">
            <div class="tarjeta-icon"><i data-lucide="${esAmarilla ? 'minus-circle' : 'x-circle'}"></i></div>
            <div class="tarjeta-info">
              <div class="tarjeta-name">${escapeHtml(nombreNino)}</div>
              <div class="tarjeta-sub">
                <span class="grupo-badge mini" style="--gcolor:${escapeHtml(colorGrupo)}">${escapeHtml(nombreGrupo)}</span>
                · ${escapeHtml(t.motivo)} · ${formatearFecha(t.creado_en)}
              </div>
            </div>
            <div class="tarjeta-pts ${esAmarilla ? 'amarilla' : 'roja'}">${esAmarilla ? '-5' : '-10'}</div>
          </div>
        `;
      }).join('');
    }

    refrescarIconos();
  } catch (err) {
    console.error('Error cargando competencia:', err);
    showToast('No se pudo cargar la competencia.', 'error');
  }
}

/* ---- Asignación de puntos (solo por escaneo de QR de grupo) ---- */

/** Valida que la cantidad sea múltiplo de puntosMultiplo y |cantidad| <= puntosMaximo. */
function validarPuntos(cantidad) {
  if (!Number.isFinite(cantidad)) return { ok: false, mensaje: 'Ingresa una cantidad válida.' };
  const abs = Math.abs(cantidad);
  if (abs > APP_CONFIG.puntosMaximo) return { ok: false, mensaje: `El máximo permitido es ${APP_CONFIG.puntosMaximo} puntos.` };
  if (abs % APP_CONFIG.puntosMultiplo !== 0) return { ok: false, mensaje: `Los puntos deben ser múltiplos de ${APP_CONFIG.puntosMultiplo}.` };
  return { ok: true };
}

/* =====================================================================
   EVENTOS (juegos / actividades para asignar puntos)
===================================================================== */
async function cargarEventos() {
  try {
    const { data, error } = await supabaseClient
      .from(TABLES.eventos)
      .select('id, nombre, creado_en')
      .order('nombre', { ascending: true });
    if (error) throw error;
    STATE.eventosCache = data || [];

    const selEventoScan = document.getElementById('inputEventoScan');
    if (selEventoScan) {
      const actual = selEventoScan.value;
      selEventoScan.innerHTML = '<option value="">Sin evento</option>' +
        STATE.eventosCache.map(ev => `<option value="${ev.id}">${escapeHtml(ev.nombre)}</option>`).join('');
      selEventoScan.value = actual;
    }

    const lista = document.getElementById('eventosList');
    if (lista) {
      if (STATE.eventosCache.length === 0) {
        lista.innerHTML = '<p class="empty-state">No hay eventos creados.</p>';
      } else {
        lista.innerHTML = STATE.eventosCache.map(ev => `
          <div class="evento-item">
            <div class="evento-icon"><i data-lucide="flag"></i></div>
            <div class="evento-nombre">${escapeHtml(ev.nombre)}</div>
            <button class="icon-btn small danger" data-eliminar-evento="${ev.id}" title="Eliminar evento">
              <i data-lucide="trash-2"></i>
            </button>
          </div>
        `).join('');
        lista.querySelectorAll('[data-eliminar-evento]').forEach(btn => {
          btn.addEventListener('click', () => eliminarEvento(btn.dataset.eliminarEvento));
        });
      }
    }
    refrescarIconos();
  } catch (err) {
    console.error('Error cargando eventos:', err);
  }
}

function abrirModalEventos() {
  document.getElementById('formEvento').reset();
  document.getElementById('modalEventos').classList.remove('hidden');
  cargarEventos();
  refrescarIconos();
}

function cerrarModalEventos() {
  document.getElementById('modalEventos').classList.add('hidden');
}

async function guardarEvento(e) {
  e.preventDefault();
  const nombre = document.getElementById('inputEventoNombre').value.trim();
  if (!nombre) {
    showToast('Escribe un nombre para el evento.', 'warning');
    return;
  }
  const btn = document.getElementById('btnGuardarEvento');
  btn.disabled = true;
  try {
    const { error } = await supabaseClient
      .from(TABLES.eventos)
      .insert([{ nombre }]);
    if (error) throw error;
    showToast('Evento creado.', 'success');
    document.getElementById('formEvento').reset();
    await cargarEventos();
  } catch (err) {
    console.error('Error creando evento:', err);
    showToast('No se pudo crear el evento (¿nombre duplicado?).', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function eliminarEvento(eventoId) {
  if (!confirm('¿Eliminar este evento?')) return;
  try {
    const { error } = await supabaseClient
      .from(TABLES.eventos)
      .delete()
      .eq('id', eventoId);
    if (error) throw error;
    showToast('Evento eliminado.', 'success');
    await cargarEventos();
  } catch (err) {
    console.error('Error eliminando evento:', err);
    showToast('No se pudo eliminar el evento.', 'error');
  }
}

/* =====================================================================
   TARJETAS AMARILLAS Y ROJAS (sanciones que penalizan al grupo)
   El niño se identifica escaneando su QR (o abriendo su perfil).
===================================================================== */
/** Marca el tipo de tarjeta activo en el modal. */
function setTipoTarjetaUI(tipo) {
  STATE.tarjetaTipo = tipo === 'ROJA' ? 'ROJA' : 'AMARILLA';
  const am = document.getElementById('tipoTarjetaAmarilla');
  const ro = document.getElementById('tipoTarjetaRoja');
  am.classList.toggle('active', tipo === 'AMARILLA');
  ro.classList.toggle('active', tipo === 'ROJA');
}

/** Llena los valores visibles de las tarjetas según la configuración. */
function pintarValoresTarjeta() {
  const pares = [['valAmarilla', 'valAmarilla2'], ['valRoja', 'valRoja2']];
  pares.forEach(([c1, c2]) => {
    const el = document.getElementById(c1);
    if (el) el.textContent = `${APP_CONFIG.puntosTarjetaAmarilla} pts`;
    const el2 = document.getElementById(c2);
    if (el2) el2.textContent = `${APP_CONFIG.puntosTarjetaAmarilla} pts`;
  });
  const roja = document.getElementById('valRoja');
  if (roja) roja.textContent = `${APP_CONFIG.puntosTarjetaRoja} pts`;
  const roja2 = document.getElementById('valRoja2');
  if (roja2) roja2.textContent = `${APP_CONFIG.puntosTarjetaRoja} pts`;
}

/** Abre el modal de tarjeta para el niño indicado (por defecto el escaneado). */
async function abrirModalTarjeta(tipo, ninoId) {
  setTipoTarjetaUI(tipo || STATE.tarjetaTipo);
  document.getElementById('formTarjeta').reset();
  document.getElementById('modalTarjetaTitle').textContent =
    STATE.tarjetaTipo === 'ROJA' ? 'Tarjeta roja' : 'Tarjeta amarilla';
  document.getElementById('inputTarjetaMotivo').placeholder =
    STATE.tarjetaTipo === 'ROJA'
      ? 'Ej: Comportamiento grave durante la actividad'
      : 'Ej: Bajo rendimiento en la actividad';

  if (ninoId) {
    STATE.tarjetaNinoId = ninoId;
    const nino = STATE.ninosCache.find(n => n.id === ninoId);
    if (nino) await mostrarNinoTarjeta(nino);
  } else if (!STATE.tarjetaNinoId) {
    limpiarNinoTarjeta();
  }

  document.getElementById('modalTarjeta').classList.remove('hidden');
  refrescarIconos();
}

/** Muestra los datos del niño identificado en el modal. */
async function mostrarNinoTarjeta(nino) {
  document.getElementById('tarjetaNinoNombre').textContent = `${nino.nombres} ${nino.apellidos}`;
  document.getElementById('tarjetaNinoSub').textContent =
    `C.I. ${nino.cedula}${nino.edad != null ? ` · ${nino.edad} años` : ''}`;
  document.getElementById('tarjetaNinoAvatar').textContent = obtenerIniciales(nino.nombres, nino.apellidos);
  const info = document.getElementById('tarjetaNinoInfo');
  info.classList.remove('hidden');
  info.innerHTML = await resumenInfoTarjeta(nino);
}

function limpiarNinoTarjeta() {
  document.getElementById('tarjetaNinoNombre').textContent = 'Escanea un niño';
  document.getElementById('tarjetaNinoSub').textContent = '';
  document.getElementById('tarjetaNinoAvatar').textContent = '?';
  const info = document.getElementById('tarjetaNinoInfo');
  info.classList.add('hidden');
  info.innerHTML = '';
}

function cerrarModalTarjeta() {
  document.getElementById('modalTarjeta').classList.add('hidden');
  STATE.tarjetaNinoId = null;
  limpiarNinoTarjeta();
}

/** Abre el modal de tarjeta con el niño del perfil ya seleccionado. */
async function abrirModalTarjetaPerfil(tipo) {
  await abrirModalTarjeta(tipo, STATE.ninoSeleccionadoId);
}

/** Construye el resumen del niño dentro del modal de tarjeta (grupo + amarillas). */
async function resumenInfoTarjeta(nino) {
  const grupo = STATE.gruposCache.find(g => g.id === nino.grupo_id);
  let amarillas = 0;
  try {
    const { data } = await supabaseClient
      .from(TABLES.sanciones)
      .select('id')
      .eq('nino_id', nino.id)
      .eq('tipo', 'AMARILLA');
    amarillas = (data || []).length;
  } catch (e) {
    console.warn('No se pudieron contar amarillas:', e);
  }
  return `
    <div>
      <strong>Grupo:</strong>
      ${grupo
        ? `<span class="grupo-badge mini" style="--gcolor:${escapeHtml(grupo.color)}">${escapeHtml(grupo.nombre)}</span>`
        : '<span class="grupo-badge mini sin-grupo">Sin grupo</span>'}
    </div>
    <div><strong>Amarillas acumuladas:</strong> ${amarillas} de 3</div>
  `;
}

async function guardarTarjeta(e) {
  e.preventDefault();
  const ninoId = STATE.tarjetaNinoId;
  const motivo = document.getElementById('inputTarjetaMotivo').value.trim();
  if (!ninoId) {
    showToast('Escanea el QR de un niño primero.', 'warning');
    return;
  }
  if (!motivo) {
    showToast('Escribe el motivo de la tarjeta.', 'warning');
    return;
  }
  const btn = document.getElementById('btnGuardarTarjeta');
  btn.disabled = true;
  try {
    let nino = STATE.ninosCache.find(n => n.id === ninoId);
    if (!nino) {
      // El niño escaneado puede no estar en la cache (p. ej. escaneado recién)
      const { data, error: errNino } = await supabaseClient
        .from(TABLES.ninos)
        .select('id, grupo_id')
        .eq('id', ninoId)
        .maybeSingle();
      if (errNino) throw errNino;
      nino = data;
    }
    const tipo = STATE.tarjetaTipo;
    const puntosTarjeta = tipo === 'ROJA'
      ? APP_CONFIG.puntosTarjetaRoja
      : APP_CONFIG.puntosTarjetaAmarilla;
    const grupoId = nino && nino.grupo_id ? nino.grupo_id : null;

    // Registro la sanción (por niño, guardando el grupo al momento de la tarjeta)
    const { error: errSan } = await supabaseClient
      .from(TABLES.sanciones)
      .insert([{ nino_id: ninoId, grupo_id: grupoId, tipo, motivo, fecha: fechaHoyISO() }]);
    if (errSan) throw errSan;

    // Penalizo al grupo actual del niño
    if (grupoId) {
      const { error: errPts } = await supabaseClient
        .from(TABLES.puntos)
        .insert([{
          grupo_id: grupoId,
          puntos: puntosTarjeta,
          motivo: `Tarjeta ${tipo === 'ROJA' ? 'roja' : 'amarilla'}: ${motivo}`,
          fecha: fechaHoyISO(),
        }]);
      if (errPts) throw errPts;
    }

    showToast(`Tarjeta ${tipo === 'ROJA' ? 'roja' : 'amarilla'} aplicada (${puntosTarjeta} pts).`, 'success');
    cerrarModalTarjeta();
    cargarCompetencia();
    if (STATE.ninoSeleccionadoId) abrirPerfilNino(STATE.ninoSeleccionadoId);
  } catch (err) {
    console.error('Error aplicando tarjeta:', err);
    showToast('No se pudo aplicar la tarjeta.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="alert-triangle"></i> Aplicar tarjeta';
    refrescarIconos();
  }
}

/* =====================================================================
   ESCÁNER EN MODO PUNTOS (QR de grupo)
===================================================================== */
async function guardarScanPuntos(e) {
  e.preventDefault();
  const grupoId = STATE.grupoScanId;
  const cantidad = parseInt(document.getElementById('inputScanPuntos').value, 10);
  const eventoId = document.getElementById('inputEventoScan').value || null;
  const motivo = document.getElementById('inputScanMotivo').value.trim();

  if (!grupoId) {
    showToast('Escanea el QR de un grupo primero.', 'warning');
    return;
  }
  const val = validarPuntos(cantidad);
  if (!val.ok) {
    showToast(val.mensaje, 'warning');
    return;
  }
  if (!motivo) {
    showToast('Escribe un motivo (o elige un evento).', 'warning');
    return;
  }

  const btn = document.getElementById('btnGuardarScanPuntos');
  btn.disabled = true;
  try {
    const { error } = await supabaseClient
      .from(TABLES.puntos)
      .insert([{ grupo_id: grupoId, puntos: cantidad, motivo, evento_id: eventoId, fecha: fechaHoyISO() }]);
    if (error) throw error;
    showToast(cantidad > 0 ? 'Puntos otorgados al grupo.' : 'Puntos restados al grupo.', 'success');
    document.getElementById('modalScanPuntos').classList.add('hidden');
    document.getElementById('formScanPuntos').reset();
    STATE.grupoScanId = null;
    await cargarCompetencia();
  } catch (err) {
    console.error('Error guardando puntos por escaneo:', err);
    showToast('No se pudieron guardar los puntos.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="trophy"></i> Guardar puntos';
    refrescarIconos();
  }
}

function cerrarModalScanPuntos() {
  document.getElementById('modalScanPuntos').classList.add('hidden');
  document.getElementById('formScanPuntos').reset();
  STATE.grupoScanId = null;
}

/* =====================================================================
   ADMINISTRADOR: LISTA Y BÚSQUEDA DE NIÑOS
===================================================================== */
async function cargarListaNinos() {
  const contenedor = document.getElementById('ninosList');
  try {
    await cargarGrupos();
    const { data, error } = await supabaseClient
      .from(TABLES.ninos)
      .select('id, cedula, nombres, apellidos, codigo_qr, grupo_id, edad, activo')
      .eq('activo', true)
      .order('nombres', { ascending: true });

    if (error) throw error;

    STATE.ninosCache = data || [];
    await pintarListaNinosConEstado(STATE.ninosCache);
  } catch (err) {
    console.error('Error cargando niños:', err);
    contenedor.innerHTML = '<p class="empty-state">Error al cargar la lista. Verifica tu conexión.</p>';
  }
}

/** Pinta la lista de niños, marcando con un punto si están dentro/fuera hoy. */
async function pintarListaNinosConEstado(lista) {
  const contenedor = document.getElementById('ninosList');

  if (lista.length === 0) {
    contenedor.innerHTML = '<p class="empty-state">No se encontraron niños.</p>';
    return;
  }

  // Obtenemos el último movimiento de hoy para cada niño visible, en una sola consulta.
  const hoy = fechaHoyISO();
  const ids = lista.map(n => n.id);
  let estadoPorNino = {};
  try {
    const { data: movimientos } = await supabaseClient
      .from(TABLES.asistencias)
      .select('nino_id, tipo_movimiento, registrado_en')
      .in('nino_id', ids)
      .eq('fecha', hoy)
      .order('registrado_en', { ascending: true });

    (movimientos || []).forEach(m => { estadoPorNino[m.nino_id] = m.tipo_movimiento; });
  } catch (e) {
    console.warn('No se pudo obtener estado de niños:', e);
  }

  contenedor.innerHTML = lista.map(n => {
    const dentro = estadoPorNino[n.id] === 'ENTRADA';
    const grupoNino = STATE.gruposCache.find(g => g.id === n.grupo_id);
    return `
      <div class="nino-item" data-id="${n.id}">
        <div class="nino-avatar">${obtenerIniciales(n.nombres, n.apellidos)}</div>
        <div class="nino-info">
          <div class="nino-name">${escapeHtml(n.nombres)} ${escapeHtml(n.apellidos)}</div>
          <div class="nino-cedula">C.I. ${escapeHtml(n.cedula)}${n.edad != null ? ` · ${n.edad} años` : ''}</div>
          ${grupoNino
            ? `<span class="grupo-badge mini" style="--gcolor:${escapeHtml(grupoNino.color)}">${escapeHtml(grupoNino.nombre)}</span>`
            : '<span class="grupo-badge mini sin-grupo">Sin grupo</span>'}
        </div>
        <div class="nino-status-dot ${dentro ? 'dentro' : 'fuera'}" title="${dentro ? 'Dentro' : 'Fuera'}"></div>
      </div>
    `;
  }).join('');

  document.querySelectorAll('.nino-item').forEach(item => {
    item.addEventListener('click', () => abrirPerfilNino(item.dataset.id));
  });

  refrescarIconos();
}

/** Filtra la cache local de niños por nombre, apellido o cédula. */
function filtrarNinos(texto) {
  const q = texto.trim().toLowerCase();
  if (!q) {
    pintarListaNinosConEstado(STATE.ninosCache);
    return;
  }
  const filtrados = STATE.ninosCache.filter(n =>
    n.nombres.toLowerCase().includes(q) ||
    n.apellidos.toLowerCase().includes(q) ||
    n.cedula.toLowerCase().includes(q)
  );
  pintarListaNinosConEstado(filtrados);
}

/* =====================================================================
   MODAL: REGISTRAR NUEVO NIÑO
===================================================================== */
/** Limpia la foto elegida en el formulario (preview + estado). */
function limpiarFotoPreview() {
  STATE.fotoArchivo = null;
  const prev = document.getElementById('fotoPreview');
  if (prev) prev.innerHTML = '<span class="foto-preview-ph"><i data-lucide="camera"></i></span>';
  const btnQuitar = document.getElementById('btnQuitarFoto');
  if (btnQuitar) btnQuitar.classList.add('hidden');
  const inputFoto = document.getElementById('inputFoto');
  if (inputFoto) inputFoto.value = '';
}

/** Muestra la foto elegida en el preview del formulario. */
function mostrarFotoPreview(file) {
  const url = URL.createObjectURL(file);
  const prev = document.getElementById('fotoPreview');
  prev.innerHTML = `<img src="${url}" alt="Foto del niño" />`;
  document.getElementById('btnQuitarFoto').classList.remove('hidden');
}

/** Redimensiona una imagen a JPEG (máx. maxLado px) para subirla liviana. */
function redimensionarImagen(file, maxLado = 512) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const escala = Math.min(1, maxLado / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * escala));
      const h = Math.max(1, Math.round(img.height * escala));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => {
        URL.revokeObjectURL(url);
        if (blob) resolve(blob);
        else reject(new Error('No se pudo procesar la imagen'));
      }, 'image/jpeg', 0.85);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('La imagen no es válida'));
    };
    img.src = url;
  });
}

/** Sube la foto del niño al bucket y devuelve su URL pública. */
async function subirFotoNino(ninoId, file) {
  const blob = await redimensionarImagen(file);
  const ruta = `${ninoId}.jpg`;
  const { error } = await supabaseClient.storage
    .from(APP_CONFIG.bucketFotos)
    .upload(ruta, blob, { upsert: true, contentType: 'image/jpeg' });
  if (error) throw error;
  const { data } = supabaseClient.storage.from(APP_CONFIG.bucketFotos).getPublicUrl(ruta);
  return data.publicUrl;
}

function abrirModalNino() {
  document.getElementById('editNinoId').value = '';
  document.getElementById('formNino').reset();
  document.getElementById('formNino').classList.remove('hidden');
  document.getElementById('qrPreviewBox').classList.add('hidden');
  document.getElementById('modalNinoTitle').textContent = 'Registrar niño';
  limpiarFotoPreview();
  // Pre-asignar el grupo según la edad que ya esté escrita
  const edadRaw = document.getElementById('inputEdad').value;
  if (edadRaw !== '') {
    const grupo = obtenerGrupoPorEdad(edadRaw);
    document.getElementById('inputGrupo').value = grupo ? grupo.id : '';
  }
  document.getElementById('modalNino').classList.remove('hidden');
  refrescarIconos();
}

function cerrarModalNino() {
  document.getElementById('modalNino').classList.add('hidden');
  limpiarFotoPreview();
}

/** Abre el formulario con los datos de un niño para editarlos. */
async function abrirModalEditarNino(ninoId) {
  const modal = document.getElementById('modalNino');
  document.getElementById('qrPreviewBox').classList.add('hidden');
  document.getElementById('formNino').classList.remove('hidden');
  document.getElementById('modalNinoTitle').textContent = 'Editar niño';

  const { data: nino, error } = await supabaseClient
    .from(TABLES.ninos)
    .select('*')
    .eq('id', ninoId)
    .single();
  if (error || !nino) {
    showToast('No se pudo cargar el niño.', 'error');
    return;
  }

  document.getElementById('editNinoId').value = nino.id;
  document.getElementById('inputCedula').value = nino.cedula || '';
  document.getElementById('inputNombres').value = nino.nombres || '';
  document.getElementById('inputApellidos').value = nino.apellidos || '';
  document.getElementById('inputEdad').value = nino.edad ?? '';
  document.getElementById('inputGrupo').value = nino.grupo_id || '';
  document.getElementById('inputAlergias').value = nino.alergias || '';
  document.getElementById('inputRepresentante').value = nino.representante || '';
  document.getElementById('inputTelRepresentante').value = nino.tel_representante || '';
  document.getElementById('inputContactoEmergencia').value = nino.contacto_emergencia || '';
  document.getElementById('inputTelEmergencia').value = nino.tel_emergencia || '';

  limpiarFotoPreview();
  if (nino.foto_url) {
    document.getElementById('fotoPreview').innerHTML =
      `<img src="${escapeHtml(nino.foto_url)}" alt="Foto del niño" />`;
    document.getElementById('btnQuitarFoto').classList.remove('hidden');
  }

  modal.classList.remove('hidden');
  refrescarIconos();
}

async function guardarNino(e) {
  e.preventDefault();
  const btn = document.getElementById('btnGuardarNino');
  const editId = document.getElementById('editNinoId').value || null;
  const cedula = document.getElementById('inputCedula').value.trim();
  const nombres = document.getElementById('inputNombres').value.trim();
  const apellidos = document.getElementById('inputApellidos').value.trim();

  if (!cedula || !nombres || !apellidos) {
    showToast('Completa todos los campos.', 'warning');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Guardando...';

  try {
    // Verificar que la cédula no esté ya registrada (salvo al editarse a sí mismo)
    const { data: existente } = await supabaseClient
      .from(TABLES.ninos)
      .select('id')
      .eq('cedula', cedula)
      .maybeSingle();

    if (existente && existente.id !== editId) {
      showToast('Ya existe un niño registrado con esa cédula.', 'error');
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="save"></i> Guardar';
      refrescarIconos();
      return;
    }

    const grupoId = document.getElementById('inputGrupo').value || null;
    const edadRaw = document.getElementById('inputEdad').value;
    const edad = edadRaw !== '' ? parseInt(edadRaw, 10) : null;

    const datos = {
      cedula,
      nombres,
      apellidos,
      grupo_id: grupoId,
      edad,
      alergias: document.getElementById('inputAlergias').value.trim(),
      representante: document.getElementById('inputRepresentante').value.trim(),
      tel_representante: document.getElementById('inputTelRepresentante').value.trim(),
      contacto_emergencia: document.getElementById('inputContactoEmergencia').value.trim(),
      tel_emergencia: document.getElementById('inputTelEmergencia').value.trim(),
    };

    // La foto se sube a Storage con el id del niño como nombre de archivo.
    const nuevoId = editId || crypto.randomUUID();
    if (STATE.fotoArchivo) {
      datos.foto_url = await subirFotoNino(nuevoId, STATE.fotoArchivo);
    }

    if (editId) {
      const { error } = await supabaseClient
        .from(TABLES.ninos)
        .update(datos)
        .eq('id', editId);
      if (error) throw error;
      showToast('Niño actualizado correctamente.', 'success');
      cerrarModalNino();
      cargarListaNinos();
      if (STATE.currentView === 'competencia') cargarCompetencia();
    } else {
      // El código QR almacena únicamente el identificador único (uuid) del niño.
      // Generamos el uuid en el cliente para poder construir el QR de inmediato.
      const { data, error } = await supabaseClient
        .from(TABLES.ninos)
        .insert([{
          id: nuevoId,
          cedula,
          nombres,
          apellidos,
          codigo_qr: nuevoId,
          carnet_id: generarCarnetId(nuevoId),
          grupo_id: grupoId,
          edad,
          activo: true,
          ...datos,
        }])
        .select()
        .single();

      if (error) throw error;

      showToast('Niño registrado correctamente.', 'success');
      mostrarVistaPreviaQR(data);
    }

  } catch (err) {
    console.error('Error guardando niño:', err);
    showToast('No se pudo guardar el niño. Intenta de nuevo.', 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="save"></i> Guardar';
    refrescarIconos();
  }
}

/** Genera y muestra el QR del niño recién creado, con opciones de imprimir/descargar. */
function mostrarVistaPreviaQR(nino) {
  document.getElementById('formNino').classList.add('hidden');
  const qrBox = document.getElementById('qrPreviewBox');
  qrBox.classList.remove('hidden');

  const canvasEl = document.getElementById('qrcodeCanvas');
  canvasEl.innerHTML = '';
  new QRCode(canvasEl, {
    text: nino.codigo_qr,
    width: APP_CONFIG.qrSize,
    height: APP_CONFIG.qrSize,
    correctLevel: QRCode.CorrectLevel.M,
  });

  document.getElementById('qrPreviewName').textContent = `${nino.nombres} ${nino.apellidos} - C.I. ${nino.cedula}`;

  // Guardamos referencia para los botones de descargar/imprimir
  qrBox.dataset.ninoId = nino.id;
  qrBox.dataset.ninoNombre = `${nino.nombres} ${nino.apellidos}`;
  qrBox.dataset.ninoCedula = nino.cedula;

  // Refrescamos la lista en segundo plano para que aparezca el nuevo niño
  cargarListaNinos();
}

/** Extrae la imagen (canvas o img) generada por QRCode.js dentro de un contenedor. */
function obtenerImagenQRDeContenedor(contenedorEl) {
  const canvas = contenedorEl.querySelector('canvas');
  if (canvas) return canvas.toDataURL('image/png');
  const img = contenedorEl.querySelector('img');
  if (img) return img.src;
  return null;
}

function descargarQR(contenedorId, nombreArchivo) {
  const contenedor = document.getElementById(contenedorId);
  const dataUrl = obtenerImagenQRDeContenedor(contenedor);
  if (!dataUrl) {
    showToast('No se encontró el código QR para descargar.', 'error');
    return;
  }
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = `${nombreArchivo}.png`;
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function imprimirQR(contenedorId, nombre, cedula) {
  const contenedor = document.getElementById(contenedorId);
  const dataUrl = obtenerImagenQRDeContenedor(contenedor);
  if (!dataUrl) {
    showToast('No se encontró el código QR para imprimir.', 'error');
    return;
  }
  const printArea = document.getElementById('printArea');
  printArea.className = 'print-area';
  printArea.innerHTML = `
    <img src="${dataUrl}" style="width:280px;height:280px;" />
    <div class="print-qr-name">${escapeHtml(nombre)}</div>
    <div class="print-qr-cedula">C.I. ${escapeHtml(cedula)}</div>
  `;
  window.print();
}

/* =====================================================================
   CARNETS MUNDIAL 2026
   ---------------------------------------------------------------------
   Genera el frente y reverso del carnet con los datos reales de cada
   niño y su QR de asistencia. La impresión arma hojas A4 (rejilla 2×3)
   con frentes y reversos alineados para imprimir a doble cara.
===================================================================== */
/** Dibuja el QR de asistencia dentro de cada .qr-real[data-qr] de una raíz. */
function dibujarQRsEn(raiz) {
  raiz.querySelectorAll('.qr-real[data-qr]').forEach(el => {
    new QRCode(el, {
      text: el.dataset.qr,
      width: 64,
      height: 64,
      correctLevel: QRCode.CorrectLevel.M,
    });
  });
}

function construirCarnetFront(nino, grupo) {
  const grupoNombre = (grupo && grupo.nombre) ? grupo.nombre : 'Sin grupo';
  const fotoHtml = nino.foto_url
    ? `<img src="${escapeHtml(nino.foto_url)}" alt="Foto" onerror="this.classList.add('broken')">`
    : '';
  const edadTexto = nino.edad != null ? `${nino.edad} años` : '—';
  const carnetId = nino.carnet_id || generarCarnetId(nino.id);
  const nombreCompleto = `${nino.nombres} ${nino.apellidos}`.trim();
  const qrTexto = nino.codigo_qr || nino.id;

  return `
  <div class="carnet">
    <div class="front">
      <div class="bg-photo"></div>
      <div class="top-band">
        <div class="watermark-26">26</div>
        <div class="eyebrow">${escapeHtml(APP_CONFIG.lemaCarnet)}</div>
        <div class="camp-title">${escapeHtml(APP_CONFIG.nombreCarnet)}</div>
        <div class="logo-slot">
          <img src="assets/LOGO MUNDIAL.png" alt="Mundial 2026" onerror="this.closest('.logo-slot').classList.add('no-logo')">
          <span class="logo-ph">LOGO<br>OFICIAL<br>MUNDIAL 2026</span>
        </div>
      </div>
      <div class="content">
        <div class="photo-frame">
          <div class="photo-inner">
            ${fotoHtml}
            <div class="photo-ph">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.7 0 4.9-2.2 4.9-4.9S14.7 2.2 12 2.2 7.1 4.4 7.1 7.1 9.3 12 12 12zm0 2.5c-3.3 0-9.8 1.6-9.8 4.9v2.4h19.6v-2.4c0-3.3-6.5-4.9-9.8-4.9z"/></svg>
              <span>FOTO</span>
            </div>
          </div>
        </div>
        <div class="data-stack">
          <div class="field-label name-label">Nombre y apellido</div>
          <div class="child-name">${escapeHtml(nombreCompleto)}</div>
          <div class="mini-fields">
            <div class="pill age">
              <div class="field-label">Edad</div>
              <div class="field-value">${escapeHtml(edadTexto)}</div>
            </div>
            <div class="pill team">
              <div>
                <div class="field-label">Grupo</div>
                <div class="field-value">${escapeHtml(grupoNombre)}</div>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="bottom-band">
        <div class="id-block">
          <div class="field-label">ID Carnet</div>
          <div class="id-code">${escapeHtml(carnetId)}</div>
          <div class="id-validity">Válido: ${escapeHtml(formatearVigencia())}</div>
        </div>
        <div class="qr-block">
          <div class="qr-real" data-qr="${escapeHtml(qrTexto)}"></div>
          <div class="qr-caption">Escanear<br>asistencia</div>
        </div>
      </div>
    </div>
  </div>`;
}

function construirCarnetBack(nino) {
  const carnetId = nino.carnet_id || generarCarnetId(nino.id);
  const valor = (v) => (v && String(v).trim() ? String(v).trim() : '—');

  return `
  <div class="carnet">
    <div class="back">
      <div class="top-band">
        <div class="watermark-26">26</div>
        <div class="camp-name">${escapeHtml(APP_CONFIG.nombreCarnet)}</div>
        <div class="card-tag">Carnet Oficial</div>
      </div>
      <div class="body">
        <div class="note-line">Este carnet incluye código QR de asistencia en el frente.</div>
        <div class="row">
          <div class="field">
            <div class="field-label">Representante</div>
            <div class="field-value">${escapeHtml(valor(nino.representante))}</div>
          </div>
          <div class="field alt">
            <div class="field-label">Teléfono</div>
            <div class="field-value">${escapeHtml(valor(nino.tel_representante))}</div>
          </div>
        </div>
        <div class="row">
          <div class="field">
            <div class="field-label">Contacto de emergencia</div>
            <div class="field-value">${escapeHtml(valor(nino.contacto_emergencia))}</div>
          </div>
          <div class="field alt">
            <div class="field-label">Teléfono</div>
            <div class="field-value">${escapeHtml(valor(nino.tel_emergencia))}</div>
          </div>
        </div>
        <div class="row">
          <div class="field">
            <div class="field-label">Alergias</div>
            <div class="field-value">${escapeHtml(valor(nino.alergias))}</div>
          </div>
        </div>
        <div class="row" style="border-bottom:none;">
          <div class="field">
            <div class="field-label">Vigencia</div>
            <div class="field-value" style="font-size:1.2mm;">${escapeHtml(formatearVigencia())}</div>
          </div>
          <div class="field alt">
            <div class="field-label">ID Carnet</div>
            <div class="field-value" style="font-size:1.2mm;">${escapeHtml(carnetId)}</div>
          </div>
        </div>
      </div>
      <div class="footer-band">
        <div class="sig-line"></div>
        <div class="sig-label">Firma / Sello del campamento</div>
      </div>
    </div>
  </div>`;
}

/** Construye una hoja A4 con hasta 6 carnets de la misma cara. */
function construirHojaCarnets(ninos, cara) {
  const celdas = ninos.map(n => {
    const grupo = STATE.gruposCache.find(g => g.id === n.grupo_id);
    const html = cara === 'front' ? construirCarnetFront(n, grupo) : construirCarnetBack(n);
    return `<div class="print-sheet-cell">${html}</div>`;
  });
  while (celdas.length < 6) celdas.push('<div class="print-sheet-cell"></div>');
  return `<div class="print-sheet ${cara === 'back' ? 'backs' : ''}">${celdas.join('')}</div>`;
}

async function cargarVistaCarnets() {
  await cargarGrupos();
  const sel = document.getElementById('carnetsGrupoSelect');
  const actual = sel.value;
  sel.innerHTML = '<option value="">Todos los grupos</option>' +
    STATE.gruposCache.map(g => `<option value="${g.id}">${escapeHtml(g.nombre)}</option>`).join('');
  sel.value = actual;
  await pintarListaCarnets();
}

async function pintarListaCarnets() {
  const contenedor = document.getElementById('carnetsList');
  const grupoId = document.getElementById('carnetsGrupoSelect').value;
  try {
    let query = supabaseClient
      .from(TABLES.ninos)
      .select('*')
      .eq('activo', true)
      .order('nombres', { ascending: true });
    if (grupoId) query = query.eq('grupo_id', grupoId);
    const { data, error } = await query;
    if (error) throw error;

    if (!data || data.length === 0) {
      contenedor.innerHTML = '<p class="empty-state">No hay niños en este grupo.</p>';
      return;
    }

    contenedor.innerHTML = data.map(n => {
      const grupo = STATE.gruposCache.find(g => g.id === n.grupo_id);
      const foto = n.foto_url
        ? `<img src="${escapeHtml(n.foto_url)}" alt="Foto" />`
        : '<i data-lucide="user"></i>';
      return `
        <div class="carnet-item">
          <div class="carnet-item-thumb">${foto}</div>
          <div class="carnet-item-info">
            <div class="carnet-item-name">${escapeHtml(n.nombres)} ${escapeHtml(n.apellidos)}</div>
            <div class="carnet-item-sub">${n.edad != null ? `${n.edad} años` : ''}${grupo ? ` · ${escapeHtml(grupo.nombre)}` : ''}</div>
          </div>
          <div class="carnet-item-actions">
            <button class="secondary-btn small-btn" data-ver-carnet="${n.id}"><i data-lucide="eye"></i> Ver</button>
            <button class="secondary-btn small-btn" data-imp-carnet="${n.id}"><i data-lucide="printer"></i> Imprimir</button>
          </div>
        </div>
      `;
    }).join('');

    contenedor.querySelectorAll('[data-ver-carnet]').forEach(b =>
      b.addEventListener('click', () => verCarnet(b.dataset.verCarnet)));
    contenedor.querySelectorAll('[data-imp-carnet]').forEach(b =>
      b.addEventListener('click', () => imprimirCarnetIndividual(b.dataset.impCarnet)));

    refrescarIconos();
  } catch (err) {
    console.error('Error cargando carnets:', err);
    contenedor.innerHTML = '<p class="empty-state">Error al cargar los carnets.</p>';
  }
}

async function verCarnet(ninoId) {
  try {
    const { data: nino, error } = await supabaseClient
      .from(TABLES.ninos)
      .select('*')
      .eq('id', ninoId)
      .single();
    if (error || !nino) throw error || new Error('Sin datos');

    const grupo = STATE.gruposCache.find(g => g.id === nino.grupo_id);
    const stage = document.getElementById('carnetPreviewStage');
    stage.innerHTML = `
      <div class="carnet-preview-side">
        <div class="carnet-preview-col">
          <span class="carnet-label">Frente</span>
          ${construirCarnetFront(nino, grupo)}
        </div>
        <div class="carnet-preview-col">
          <span class="carnet-label">Reverso</span>
          ${construirCarnetBack(nino)}
        </div>
      </div>
    `;
    dibujarQRsEn(stage);
    document.getElementById('modalCarnet').dataset.ninoId = ninoId;
    document.getElementById('modalCarnetTitle').textContent = `Carnet · ${nino.nombres} ${nino.apellidos}`;
    document.getElementById('modalCarnet').classList.remove('hidden');
    refrescarIconos();
  } catch (err) {
    console.error('Error abriendo carnet:', err);
    showToast('No se pudo abrir el carnet.', 'error');
  }
}

function cerrarModalCarnet() {
  document.getElementById('modalCarnet').classList.add('hidden');
}

async function imprimirCarnetIndividual(ninoId) {
  try {
    const { data: nino, error } = await supabaseClient
      .from(TABLES.ninos)
      .select('*')
      .eq('id', ninoId)
      .single();
    if (error || !nino) throw error || new Error('Sin datos');

    const printArea = document.getElementById('printArea');
    printArea.className = 'print-area carnets';
    printArea.innerHTML = construirHojaCarnets([nino], 'front') + construirHojaCarnets([nino], 'back');
    dibujarQRsEn(printArea);
    window.print();
  } catch (err) {
    console.error('Error imprimiendo carnet:', err);
    showToast('No se pudo imprimir el carnet.', 'error');
  }
}

async function imprimirCarnetsGrupo() {
  const grupoId = document.getElementById('carnetsGrupoSelect').value;
  const btn = document.getElementById('btnImprimirCarnetsGrupo');
  btn.disabled = true;
  try {
    let query = supabaseClient
      .from(TABLES.ninos)
      .select('*')
      .eq('activo', true)
      .order('nombres', { ascending: true });
    if (grupoId) query = query.eq('grupo_id', grupoId);
    const { data, error } = await query;
    if (error) throw error;
    if (!data || data.length === 0) {
      showToast('No hay niños para imprimir.', 'warning');
      return;
    }

    let html = '';
    for (let i = 0; i < data.length; i += 6) {
      const bloque = data.slice(i, i + 6);
      html += construirHojaCarnets(bloque, 'front');
      html += construirHojaCarnets(bloque, 'back');
    }

    const printArea = document.getElementById('printArea');
    printArea.className = 'print-area carnets';
    printArea.innerHTML = html;
    dibujarQRsEn(printArea);
    window.print();
  } catch (err) {
    console.error('Error imprimiendo carnets:', err);
    showToast('No se pudieron imprimir los carnets.', 'error');
  } finally {
    btn.disabled = false;
  }
}

function imprimirCarnetDesdeModal() {
  const id = document.getElementById('modalCarnet').dataset.ninoId;
  if (!id) return;
  cerrarModalCarnet();
  imprimirCarnetIndividual(id);
}

/* =====================================================================
   PERFIL DEL NIÑO
===================================================================== */
async function abrirPerfilNino(ninoId) {
  STATE.ninoSeleccionadoId = ninoId;
  const modal = document.getElementById('modalPerfil');
  modal.classList.remove('hidden');

  document.getElementById('perfilNombre').textContent = 'Cargando...';
  document.getElementById('perfilCedula').textContent = '';
  document.getElementById('perfilHistorial').innerHTML = '<p class="empty-state">Cargando historial...</p>';
  document.getElementById('perfilQrCanvas').innerHTML = '';

  try {
    const { data: nino, error: errNino } = await supabaseClient
      .from(TABLES.ninos)
      .select('*')
      .eq('id', ninoId)
      .single();
    if (errNino) throw errNino;

    document.getElementById('perfilNombre').textContent = `${nino.nombres} ${nino.apellidos}`;
    document.getElementById('perfilCedula').textContent = `C.I. ${nino.cedula}${nino.edad != null ? ` · ${nino.edad} años` : ''}`;

    const perfilFotoEl = document.getElementById('perfilFoto');
    if (nino.foto_url) {
      perfilFotoEl.innerHTML = `<img src="${escapeHtml(nino.foto_url)}" alt="Foto" />`;
    } else {
      perfilFotoEl.innerHTML = '<span class="perfil-foto-ph"><i data-lucide="user"></i></span>';
    }

    const grupoActual = STATE.gruposCache.find(g => g.id === nino.grupo_id);
    const grupoBadge = document.getElementById('perfilGrupoBadge');
    if (grupoActual) {
      grupoBadge.textContent = grupoActual.nombre;
      grupoBadge.style.setProperty('--gcolor', grupoActual.color);
    } else {
      grupoBadge.textContent = 'Sin grupo';
      grupoBadge.style.removeProperty('--gcolor');
    }
    document.getElementById('perfilGrupoSelect').value = nino.grupo_id || '';

    const qrEl = document.getElementById('perfilQrCanvas');
    new QRCode(qrEl, {
      text: nino.codigo_qr,
      width: 180,
      height: 180,
      correctLevel: QRCode.CorrectLevel.M,
    });
    qrEl.dataset.ninoNombre = `${nino.nombres} ${nino.apellidos}`;
    qrEl.dataset.ninoCedula = nino.cedula;

    const { data: historial, error: errHist } = await supabaseClient
      .from(TABLES.asistencias)
      .select('tipo_movimiento, fecha, hora, registrado_en')
      .eq('nino_id', ninoId)
      .order('registrado_en', { ascending: false });
    if (errHist) throw errHist;

    // Estado actual = movimiento más reciente en general
    const estadoBox = document.getElementById('perfilEstadoBox');
    const estadoTexto = document.getElementById('perfilEstadoTexto');
    if (!historial || historial.length === 0) {
      estadoBox.className = 'perfil-estado-box sin-movimientos';
      estadoTexto.textContent = 'Sin movimientos registrados';
    } else {
      const ultimo = historial[0];
      const dentro = ultimo.tipo_movimiento === 'ENTRADA';
      estadoBox.className = `perfil-estado-box ${dentro ? 'dentro' : 'fuera'}`;
      estadoTexto.textContent = dentro
        ? `🟢 Dentro del OVAS — Entrada: ${formatearHora(ultimo.registrado_en)}`
        : `🔴 Retirado — Salida: ${formatearHora(ultimo.registrado_en)}`;
    }

    const histContenedor = document.getElementById('perfilHistorial');
    if (!historial || historial.length === 0) {
      histContenedor.innerHTML = '<p class="empty-state">Sin movimientos registrados.</p>';
    } else {
      histContenedor.innerHTML = historial.map(h => `
        <div class="historial-item">
          <span class="h-fecha">${formatearFecha(h.registrado_en)}</span>
          <span class="h-tipo ${h.tipo_movimiento === 'ENTRADA' ? 'entrada' : 'salida'}">
            ${h.tipo_movimiento === 'ENTRADA' ? 'Entrada' : 'Salida'}
          </span>
          <span class="h-fecha">${formatearHora(h.registrado_en)}</span>
        </div>
      `).join('');
    }

    // Historial de tarjetas del niño
    const { data: sanciones, error: errSan } = await supabaseClient
      .from(TABLES.sanciones)
      .select('id, tipo, motivo, creado_en')
      .eq('nino_id', ninoId)
      .order('creado_en', { ascending: false });
    if (errSan) throw errSan;

    const tarjetasEl = document.getElementById('perfilTarjetas');
    if (!sanciones || sanciones.length === 0) {
      tarjetasEl.innerHTML = '<p class="empty-state">Sin tarjetas.</p>';
    } else {
      tarjetasEl.innerHTML = sanciones.map(s => {
        const esAmarilla = s.tipo === 'AMARILLA';
        return `
          <div class="tarjeta-item ${esAmarilla ? 'amarilla' : 'roja'}">
            <div class="tarjeta-icon"><i data-lucide="${esAmarilla ? 'minus-circle' : 'x-circle'}"></i></div>
            <div class="tarjeta-info">
              <div class="tarjeta-name">${esAmarilla ? 'Tarjeta amarilla' : 'Tarjeta roja'}</div>
              <div class="tarjeta-sub">${escapeHtml(s.motivo)} · ${formatearFecha(s.creado_en)}</div>
            </div>
            <div class="tarjeta-pts ${esAmarilla ? 'amarilla' : 'roja'}">${esAmarilla ? '-5' : '-10'}</div>
          </div>
        `;
      }).join('');
    }

    refrescarIconos();
  } catch (err) {
    console.error('Error cargando perfil:', err);
    showToast('No se pudo cargar el perfil del niño.', 'error');
  }
}

function cerrarModalPerfil() {
  document.getElementById('modalPerfil').classList.add('hidden');
}

/** Cambia el grupo de un niño desde el perfil. */
async function cambiarGrupo() {
  const ninoId = STATE.ninoSeleccionadoId;
  if (!ninoId) return;
  const nuevoGrupo = document.getElementById('perfilGrupoSelect').value || null;
  const btn = document.getElementById('btnGuardarGrupo');
  btn.disabled = true;
  try {
    const { error } = await supabaseClient
      .from(TABLES.ninos)
      .update({ grupo_id: nuevoGrupo })
      .eq('id', ninoId);
    if (error) throw error;
    showToast('Grupo actualizado.', 'success');
    cargarListaNinos();
    if (STATE.currentView === 'competencia') cargarCompetencia();
  } catch (err) {
    console.error('Error cambiando grupo:', err);
    showToast('No se pudo cambiar el grupo.', 'error');
  } finally {
    btn.disabled = false;
  }
}

/* =====================================================================
   ESCÁNER QR
   ---------------------------------------------------------------------
   Usa la librería html5-qrcode (CDN) para leer la cámara del iPhone.
===================================================================== */

function setModoEscaneo(modo) {
  STATE.modoEscaneo = modo;
  document.getElementById('modeEntrada').classList.toggle('active', modo === 'ENTRADA');
  document.getElementById('modeSalida').classList.toggle('active', modo === 'SALIDA');
  document.getElementById('modePuntos').classList.toggle('active', modo === 'PUNTOS');
  document.getElementById('modeTarjeta').classList.toggle('active', modo === 'TARJETA');
  const hintPuntos = document.getElementById('puntosModeHint');
  if (hintPuntos) hintPuntos.classList.toggle('hidden', modo !== 'PUNTOS');
  const hintTarjeta = document.getElementById('tarjetaModeHint');
  if (hintTarjeta) hintTarjeta.classList.toggle('hidden', modo !== 'TARJETA');
}

async function iniciarEscaner() {
  if (STATE.scannerRunning) return;

  const lectorEl = document.getElementById('qr-reader');
  lectorEl.innerHTML = '';
  ocultarResultadoEscaneo();

  STATE.html5QrCode = new Html5Qrcode('qr-reader');

  const config = {
    fps: 10,
    qrbox: { width: 240, height: 240 },
    // Pedimos explícitamente cámara trasera (environment) para iPhone.
    aspectRatio: 1.0,
  };

  try {
    await STATE.html5QrCode.start(
      { facingMode: 'environment' },
      config,
      onLecturaExitosa,
      () => { /* errores de lectura frame-a-frame: se ignoran silenciosamente */ }
    );
    STATE.scannerRunning = true;
  } catch (err) {
    console.error('Error iniciando cámara:', err);
    showToast('No se pudo acceder a la cámara. Revisa los permisos en Safari (Ajustes > Safari > Cámara).', 'error', 5000);
  }
}

async function detenerEscaner() {
  if (STATE.html5QrCode && STATE.scannerRunning) {
    try {
      await STATE.html5QrCode.stop();
      STATE.html5QrCode.clear();
    } catch (err) {
      console.warn('Error deteniendo cámara:', err);
    }
  }
  STATE.scannerRunning = false;
}

/** Callback que se ejecuta cada vez que html5-qrcode detecta un código QR. */
async function onLecturaExitosa(textoDecodificado) {
  // Anti-rebote: evita procesar el mismo QR varias veces seguidas
  // mientras la cámara sigue enfocándolo (la cámara escanea ~10 veces/seg).
  const ahora = Date.now();
  if (
    textoDecodificado === STATE.ultimoEscaneo.codigo &&
    (ahora - STATE.ultimoEscaneo.ts) < APP_CONFIG.antiRebotMs
  ) {
    return;
  }
  STATE.ultimoEscaneo = { codigo: textoDecodificado, ts: ahora };

  await procesarEscaneo(textoDecodificado);
}

/** Procesa el identificador leído: grupo (PUNTOS), niño (TARJETA) o asistencia (ENTRADA/SALIDA). */
async function procesarEscaneo(codigoQR) {
  try {
    // QR de grupo: el modo PUNTOS abre el modal para escribir puntos manualmente
    if (STATE.modoEscaneo === 'PUNTOS') {
      if (typeof codigoQR === 'string' && codigoQR.startsWith('G-')) {
        const grupo = STATE.gruposCache.find(g => (g.codigo_qr || `G-${g.id}`) === codigoQR);
        if (!grupo) {
          mostrarResultadoEscaneo('error', 'Grupo no reconocido', 'Este QR no corresponde a ningún grupo.');
          return;
        }
        STATE.grupoScanId = grupo.id;
        document.getElementById('scanPuntosGrupoBadge').textContent = grupo.nombre;
        document.getElementById('scanPuntosGrupoBadge').style.setProperty('--gcolor', grupo.color || '#8b5cf6');
        document.getElementById('formScanPuntos').reset();
        const selEvento = document.getElementById('inputEventoScan');
        selEvento.innerHTML = '<option value="">Sin evento</option>' +
          STATE.eventosCache.map(ev => `<option value="${ev.id}">${escapeHtml(ev.nombre)}</option>`).join('');
        document.getElementById('modalScanPuntos').classList.remove('hidden');
        refrescarIconos();
        return;
      }
      mostrarResultadoEscaneo('error', 'QR no es de un grupo', 'Este código no es un QR de grupo. Escanea uno con el prefijo G-.');
      return;
    }

    // QR de niño: el modo TARJETA abre el modal de tarjeta amarilla/roja
    if (STATE.modoEscaneo === 'TARJETA') {
      const { data: nino, error: errNino } = await supabaseClient
        .from(TABLES.ninos)
        .select('id, cedula, nombres, apellidos, grupo_id, edad, activo')
        .eq('codigo_qr', codigoQR)
        .maybeSingle();
      if (errNino) throw errNino;
      if (!nino) {
        mostrarResultadoEscaneo('error', 'QR no reconocido', 'Este código no corresponde a ningún niño registrado.');
        return;
      }
      if (!nino.activo) {
        mostrarResultadoEscaneo('warning', `${nino.nombres} ${nino.apellidos}`, 'Este registro está inactivo.');
        return;
      }
      await abrirModalTarjeta(STATE.tarjetaTipo, nino.id);
      return;
    }

    const { data: nino, error: errNino } = await supabaseClient
      .from(TABLES.ninos)
      .select('id, nombres, apellidos, grupo_id, activo')
      .eq('codigo_qr', codigoQR)
      .maybeSingle();

    if (errNino) throw errNino;

    if (!nino) {
      mostrarResultadoEscaneo('error', 'QR no reconocido', 'Este código no corresponde a ningún niño registrado.');
      return;
    }

    if (!nino.activo) {
      mostrarResultadoEscaneo('warning', `${nino.nombres} ${nino.apellidos}`, 'Este registro está inactivo.');
      return;
    }

    const hoy = fechaHoyISO();

    // Obtenemos el último movimiento de HOY para este niño
    const { data: ultimosMov, error: errUltimo } = await supabaseClient
      .from(TABLES.asistencias)
      .select('tipo_movimiento, registrado_en')
      .eq('nino_id', nino.id)
      .eq('fecha', hoy)
      .order('registrado_en', { ascending: false })
      .limit(1);

    if (errUltimo) throw errUltimo;

    const ultimoMovimiento = ultimosMov && ultimosMov.length > 0 ? ultimosMov[0].tipo_movimiento : null;
    const tipoSolicitado = STATE.modoEscaneo; // ENTRADA o SALIDA

    // ---------------- VALIDACIONES ----------------
    if (tipoSolicitado === 'ENTRADA' && ultimoMovimiento === 'ENTRADA') {
      mostrarResultadoEscaneo('warning', `${nino.nombres} ${nino.apellidos}`, 'Ya tiene una entrada registrada. No se permite doble entrada.');
      return;
    }

    if (tipoSolicitado === 'SALIDA' && ultimoMovimiento === null) {
      mostrarResultadoEscaneo('warning', `${nino.nombres} ${nino.apellidos}`, 'No se puede registrar salida: el niño no tiene entrada registrada hoy.');
      return;
    }

    if (tipoSolicitado === 'SALIDA' && ultimoMovimiento === 'SALIDA') {
      mostrarResultadoEscaneo('warning', `${nino.nombres} ${nino.apellidos}`, 'Este niño ya salió. No se permite doble salida.');
      return;
    }

    // ---------------- REGISTRO ----------------
    const ahoraDate = new Date();
    const { data: registro, error: errInsert } = await supabaseClient
      .from(TABLES.asistencias)
      .insert([{
        nino_id: nino.id,
        tipo_movimiento: tipoSolicitado,
        fecha: hoy,
        hora: ahoraDate.toTimeString().slice(0, 8),
      }])
      .select()
      .single();

    if (errInsert) throw errInsert;

    // Puntos de competencia: cada ENTRADA le suma al grupo del niño
    // (solo de ahora en adelante, nunca retroactivo).
    if (tipoSolicitado === 'ENTRADA' && APP_CONFIG.puntosPorAsistencia > 0 && nino.grupo_id) {
      try {
        const { error: errPuntos } = await supabaseClient
          .from(TABLES.puntos)
          .insert([{
            grupo_id: nino.grupo_id,
            puntos: APP_CONFIG.puntosPorAsistencia,
            motivo: 'Asistencia',
            fecha: hoy,
          }]);
        if (errPuntos) console.warn('No se pudo registrar punto de asistencia:', errPuntos);
      } catch (e) {
        console.warn('No se pudo registrar punto de asistencia:', e);
      }
    }

    const horaTexto = formatearHora(registro.registrado_en);
    const etiqueta = tipoSolicitado === 'ENTRADA' ? 'Entrada registrada' : 'Salida registrada';
    mostrarResultadoEscaneo('success', `${nino.nombres} ${nino.apellidos}`, `${etiqueta} ${horaTexto}`);

  } catch (err) {
    console.error('Error procesando escaneo:', err);
    mostrarResultadoEscaneo('error', 'Error', 'No se pudo registrar el movimiento. Revisa tu conexión.');
  }
}

function mostrarResultadoEscaneo(tipo, nombre, detalle) {
  const box = document.getElementById('scanResultBox');
  const icono = document.getElementById('scanResultIcon');

  box.classList.remove('hidden', 'error', 'warning');
  if (tipo === 'error') box.classList.add('error');
  if (tipo === 'warning') box.classList.add('warning');

  const iconos = { success: 'check-circle-2', error: 'x-circle', warning: 'alert-triangle' };
  icono.setAttribute('data-lucide', iconos[tipo] || 'check-circle-2');

  document.getElementById('scanResultName').textContent = nombre;
  document.getElementById('scanResultDetail').textContent = detalle;

  refrescarIconos();

  clearTimeout(STATE._scanResultTimeout);
  STATE._scanResultTimeout = setTimeout(ocultarResultadoEscaneo, APP_CONFIG.mensajeResultadoDuracion);
}

function ocultarResultadoEscaneo() {
  document.getElementById('scanResultBox').classList.add('hidden');
}

/* =====================================================================
   REPORTES: EXPORTAR ASISTENCIA DEL DÍA (CSV / Excel)
===================================================================== */
async function exportarCSV() {
  const fecha = document.getElementById('reportDate').value || fechaHoyISO();
  const btn = document.getElementById('btnExportarCSV');
  btn.disabled = true;

  try {
    // Todos los niños activos
    const { data: ninos, error: errNinos } = await supabaseClient
      .from(TABLES.ninos)
      .select('id, cedula, nombres, apellidos, grupo_id')
      .eq('activo', true)
      .order('nombres', { ascending: true });
    if (errNinos) throw errNinos;

    // Mapa de grupos (id -> nombre) para incluir la columna en el reporte
    const { data: grupos, error: errGrupos } = await supabaseClient
      .from(TABLES.grupos)
      .select('id, nombre');
    if (errGrupos) throw errGrupos;
    const mapaGrupos = {};
    (grupos || []).forEach(g => { mapaGrupos[g.id] = g.nombre; });

    // Todos los movimientos de la fecha elegida
    const { data: movimientos, error: errMov } = await supabaseClient
      .from(TABLES.asistencias)
      .select('nino_id, tipo_movimiento, registrado_en')
      .eq('fecha', fecha)
      .order('registrado_en', { ascending: true });
    if (errMov) throw errMov;

    // Agrupamos: primera ENTRADA y primera SALIDA (o la más relevante) por niño
    const porNino = {};
    (movimientos || []).forEach(m => {
      if (!porNino[m.nino_id]) porNino[m.nino_id] = { entrada: null, salida: null };
      if (m.tipo_movimiento === 'ENTRADA' && !porNino[m.nino_id].entrada) {
        porNino[m.nino_id].entrada = m.registrado_en;
      }
      if (m.tipo_movimiento === 'SALIDA') {
        porNino[m.nino_id].salida = m.registrado_en; // se queda con la última salida
      }
    });

    const filas = [['Cédula', 'Nombre', 'Apellido', 'Grupo', 'Entrada', 'Salida', 'Estado']];

    ninos.forEach(n => {
      const mov = porNino[n.id];
      const entrada = mov && mov.entrada ? formatearHora(mov.entrada) : '';
      const salida = mov && mov.salida ? formatearHora(mov.salida) : '';
      let estado = 'No asistió';
      if (mov && mov.entrada && !mov.salida) estado = 'Dentro del evento';
      if (mov && mov.entrada && mov.salida) estado = 'Retirado';

      filas.push([n.cedula, n.nombres, n.apellidos, mapaGrupos[n.grupo_id] || '', entrada, salida, estado]);
    });

    descargarComoCSV(filas, `asistencia_${fecha}.csv`);
    showToast('Reporte descargado correctamente.', 'success');

  } catch (err) {
    console.error('Error exportando reporte:', err);
    showToast('No se pudo generar el reporte.', 'error');
  } finally {
    btn.disabled = false;
  }
}

/** Convierte un array de filas (array de arrays) a un archivo CSV y dispara la descarga. */
function descargarComoCSV(filas, nombreArchivo) {
  const csvContent = filas.map(fila =>
    fila.map(celda => {
      const texto = String(celda ?? '');
      // Escapamos comillas y envolvemos en comillas si contiene coma, comilla o salto de línea
      if (/[",\n]/.test(texto)) {
        return `"${texto.replace(/"/g, '""')}"`;
      }
      return texto;
    }).join(',')
  ).join('\n');

  // BOM para que Excel detecte UTF-8 correctamente (tildes, ñ)
  const blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = nombreArchivo;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/* =====================================================================
   EVENT LISTENERS / INICIALIZACIÓN
===================================================================== */
function inicializarEventListeners() {
  // Navegación inferior
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => cambiarVista(btn.dataset.view));
  });

  // Refrescar (header)
  document.getElementById('btnRefresh').addEventListener('click', () => {
    if (STATE.currentView === 'dashboard') cargarDashboard();
    if (STATE.currentView === 'admin') cargarListaNinos();
    if (STATE.currentView === 'grupos') cargarGrupos();
    if (STATE.currentView === 'competencia') cargarCompetencia();
    if (STATE.currentView === 'carnets') cargarVistaCarnets();
    showToast('Datos actualizados.', 'success', 1500);
  });

  // Modal: nuevo niño
  document.getElementById('btnNuevoNino').addEventListener('click', abrirModalNino);
  document.getElementById('btnCerrarModalNino').addEventListener('click', cerrarModalNino);
  document.getElementById('formNino').addEventListener('submit', guardarNino);
  document.getElementById('btnCerrarQrPreview').addEventListener('click', cerrarModalNino);

  // Foto del niño
  document.getElementById('inputFoto').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) {
      STATE.fotoArchivo = file;
      mostrarFotoPreview(file);
    }
  });
  document.getElementById('btnQuitarFoto').addEventListener('click', limpiarFotoPreview);

  // Al escribir la edad se asigna automáticamente el grupo del rango
  document.getElementById('inputEdad').addEventListener('input', (e) => {
    const grupo = obtenerGrupoPorEdad(e.target.value);
    const sel = document.getElementById('inputGrupo');
    sel.value = grupo ? grupo.id : '';
  });

  document.getElementById('btnDescargarQR').addEventListener('click', () => {
    const qrBox = document.getElementById('qrPreviewBox');
    descargarQR('qrcodeCanvas', `QR_${qrBox.dataset.ninoNombre.replace(/\s+/g, '_')}`);
  });
  document.getElementById('btnImprimirQR').addEventListener('click', () => {
    const qrBox = document.getElementById('qrPreviewBox');
    imprimirQR('qrcodeCanvas', qrBox.dataset.ninoNombre, qrBox.dataset.ninoCedula);
  });

  // Búsqueda
  document.getElementById('searchInput').addEventListener('input', (e) => filtrarNinos(e.target.value));

  // Modal perfil
  document.getElementById('btnCerrarModalPerfil').addEventListener('click', cerrarModalPerfil);
  document.getElementById('btnGuardarGrupo').addEventListener('click', cambiarGrupo);
  document.getElementById('btnDescargarQrPerfil').addEventListener('click', () => {
    const qrEl = document.getElementById('perfilQrCanvas');
    descargarQR('perfilQrCanvas', `QR_${qrEl.dataset.ninoNombre.replace(/\s+/g, '_')}`);
  });
  document.getElementById('btnImprimirQrPerfil').addEventListener('click', () => {
    const qrEl = document.getElementById('perfilQrCanvas');
    imprimirQR('perfilQrCanvas', qrEl.dataset.ninoNombre, qrEl.dataset.ninoCedula);
  });

  // Perfil: acciones del carnet
  document.getElementById('btnVerCarnetPerfil').addEventListener('click', () => {
    if (STATE.ninoSeleccionadoId) verCarnet(STATE.ninoSeleccionadoId);
  });
  document.getElementById('btnImprimirCarnetPerfil').addEventListener('click', () => {
    if (STATE.ninoSeleccionadoId) imprimirCarnetIndividual(STATE.ninoSeleccionadoId);
  });
  document.getElementById('btnEditarNinoPerfil').addEventListener('click', () => {
    if (STATE.ninoSeleccionadoId) {
      cerrarModalPerfil();
      abrirModalEditarNino(STATE.ninoSeleccionadoId);
    }
  });
  document.getElementById('btnPonerAmarilla').addEventListener('click', () => abrirModalTarjetaPerfil('AMARILLA'));
  document.getElementById('btnPonerRoja').addEventListener('click', () => abrirModalTarjetaPerfil('ROJA'));

  // Escáner
  document.getElementById('modeEntrada').addEventListener('click', () => setModoEscaneo('ENTRADA'));
  document.getElementById('modeSalida').addEventListener('click', () => setModoEscaneo('SALIDA'));
  document.getElementById('modePuntos').addEventListener('click', () => setModoEscaneo('PUNTOS'));
  document.getElementById('modeTarjeta').addEventListener('click', () => setModoEscaneo('TARJETA'));

  // Reportes
  document.getElementById('btnExportarCSV').addEventListener('click', exportarCSV);

  // Competencia: los puntos y las tarjetas se asignan escaneando QR
  document.getElementById('btnEscanearPuntosGrupo').addEventListener('click', () => {
    setModoEscaneo('PUNTOS');
    cambiarVista('scanner');
  });

  // Grupos
  document.getElementById('formGrupo').addEventListener('submit', guardarGrupo);
  document.getElementById('btnGestionarEventos').addEventListener('click', abrirModalEventos);

  // Tarjetas (competencia): llevan al escáner en modo Tarjeta
  document.getElementById('btnTarjetaAmarilla').addEventListener('click', () => {
    STATE.tarjetaTipo = 'AMARILLA';
    setModoEscaneo('TARJETA');
    cambiarVista('scanner');
  });
  document.getElementById('btnTarjetaRoja').addEventListener('click', () => {
    STATE.tarjetaTipo = 'ROJA';
    setModoEscaneo('TARJETA');
    cambiarVista('scanner');
  });
  document.getElementById('btnCerrarModalTarjeta').addEventListener('click', cerrarModalTarjeta);
  document.getElementById('formTarjeta').addEventListener('submit', guardarTarjeta);
  document.getElementById('tipoTarjetaAmarilla').addEventListener('click', () => setTipoTarjetaUI('AMARILLA'));
  document.getElementById('tipoTarjetaRoja').addEventListener('click', () => setTipoTarjetaUI('ROJA'));

  // Modal scan puntos (desde QR de grupo)
  document.getElementById('btnCerrarModalScanPuntos').addEventListener('click', cerrarModalScanPuntos);
  document.getElementById('formScanPuntos').addEventListener('submit', guardarScanPuntos);

  // Modal eventos
  document.getElementById('btnCerrarModalEventos').addEventListener('click', cerrarModalEventos);
  document.getElementById('formEvento').addEventListener('submit', guardarEvento);

  // Modal editar grupo
  document.getElementById('btnCerrarModalGrupoEdit').addEventListener('click', cerrarModalEditarGrupo);
  document.getElementById('formGrupoEdit').addEventListener('submit', guardarEdicionGrupo);

  // Modal QR grupo
  document.getElementById('btnCerrarModalGrupoQr').addEventListener('click', cerrarModalGrupoQr);
  document.getElementById('btnDescargarQRGrupo').addEventListener('click', descargarQRGrupo);
  document.getElementById('btnImprimirQRGrupo').addEventListener('click', imprimirQRGrupo);

  // Carnets
  document.getElementById('carnetsGrupoSelect').addEventListener('change', pintarListaCarnets);
  document.getElementById('btnImprimirCarnetsGrupo').addEventListener('click', imprimirCarnetsGrupo);
  document.getElementById('btnCerrarModalCarnet').addEventListener('click', cerrarModalCarnet);
  document.getElementById('btnImprimirCarnetModal').addEventListener('click', imprimirCarnetDesdeModal);

  // Chips de puntos rápidos (escriben la cantidad en el campo indicado)
  document.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip-puntos');
    if (!chip) return;
    const campo = document.getElementById(chip.dataset.campo);
    if (!campo) return;
    campo.value = chip.dataset.puntos;
  });

  // Cerrar modales tocando el fondo oscuro
  const modalesFondo = [
    ['modalNino', cerrarModalNino],
    ['modalPerfil', cerrarModalPerfil],
    ['modalScanPuntos', cerrarModalScanPuntos],
    ['modalEventos', cerrarModalEventos],
    ['modalTarjeta', cerrarModalTarjeta],
    ['modalGrupoEdit', cerrarModalEditarGrupo],
    ['modalGrupoQr', cerrarModalGrupoQr],
    ['modalCarnet', cerrarModalCarnet],
  ];
  modalesFondo.forEach(([id, fn]) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('click', (e) => { if (e.target === el) fn(); });
  });

  // Si el usuario cambia de pestaña/app en iOS, liberamos la cámara
  // para evitar que quede "colgada" en segundo plano.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && STATE.scannerRunning) {
      detenerEscaner();
    } else if (!document.hidden && STATE.currentView === 'scanner' && !STATE.scannerRunning) {
      iniciarEscaner();
    }
  });
}

function inicializarApp() {
  refrescarIconos();
  inicializarEventListeners();
  cargarGrupos();
  cargarEventos();
  cargarListaNinos();
  cambiarVista('dashboard');
}

document.addEventListener('DOMContentLoaded', inicializarApp);
