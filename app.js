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
  modoEscaneo: 'ENTRADA',  // 'ENTRADA' | 'SALIDA'
  html5QrCode: null,       // instancia activa del lector de cámara
  scannerRunning: false,
  ultimoEscaneo: { codigo: null, ts: 0 }, // anti-rebote
  ninoSeleccionadoId: null,
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
    reportes: 'Reportes',
  };
  document.getElementById('headerTitle').textContent = titulos[viewName] || 'OVAS';

  STATE.currentView = viewName;

  // Cargar datos frescos al entrar a cada vista
  if (viewName === 'dashboard') cargarDashboard();
  if (viewName === 'admin') cargarListaNinos();
  if (viewName === 'scanner') iniciarEscaner();
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

/* =====================================================================
   ADMINISTRADOR: LISTA Y BÚSQUEDA DE NIÑOS
===================================================================== */
async function cargarListaNinos() {
  const contenedor = document.getElementById('ninosList');
  try {
    const { data, error } = await supabaseClient
      .from(TABLES.ninos)
      .select('id, cedula, nombres, apellidos, codigo_qr, activo')
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
    return `
      <div class="nino-item" data-id="${n.id}">
        <div class="nino-avatar">${obtenerIniciales(n.nombres, n.apellidos)}</div>
        <div class="nino-info">
          <div class="nino-name">${escapeHtml(n.nombres)} ${escapeHtml(n.apellidos)}</div>
          <div class="nino-cedula">C.I. ${escapeHtml(n.cedula)}</div>
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
function abrirModalNino() {
  document.getElementById('formNino').reset();
  document.getElementById('formNino').classList.remove('hidden');
  document.getElementById('qrPreviewBox').classList.add('hidden');
  document.getElementById('modalNinoTitle').textContent = 'Registrar niño';
  document.getElementById('modalNino').classList.remove('hidden');
  refrescarIconos();
}

function cerrarModalNino() {
  document.getElementById('modalNino').classList.add('hidden');
}

async function guardarNino(e) {
  e.preventDefault();
  const btn = document.getElementById('btnGuardarNino');
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
    // Verificar que la cédula no esté ya registrada
    const { data: existente } = await supabaseClient
      .from(TABLES.ninos)
      .select('id')
      .eq('cedula', cedula)
      .maybeSingle();

    if (existente) {
      showToast('Ya existe un niño registrado con esa cédula.', 'error');
      btn.disabled = false;
      btn.innerHTML = '<i data-lucide="save"></i> Guardar';
      refrescarIconos();
      return;
    }

    // El código QR almacena únicamente el identificador único (uuid) del niño.
    // Generamos el uuid en el cliente para poder construir el QR de inmediato.
    const nuevoId = crypto.randomUUID();

    const { data, error } = await supabaseClient
      .from(TABLES.ninos)
      .insert([{
        id: nuevoId,
        cedula,
        nombres,
        apellidos,
        codigo_qr: nuevoId,
        activo: true,
      }])
      .select()
      .single();

    if (error) throw error;

    showToast('Niño registrado correctamente.', 'success');
    mostrarVistaPreviaQR(data);

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
  printArea.innerHTML = `
    <img src="${dataUrl}" style="width:280px;height:280px;" />
    <div class="print-qr-name">${escapeHtml(nombre)}</div>
    <div class="print-qr-cedula">C.I. ${escapeHtml(cedula)}</div>
  `;
  window.print();
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
    document.getElementById('perfilCedula').textContent = `C.I. ${nino.cedula}`;

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

    refrescarIconos();
  } catch (err) {
    console.error('Error cargando perfil:', err);
    showToast('No se pudo cargar el perfil del niño.', 'error');
  }
}

function cerrarModalPerfil() {
  document.getElementById('modalPerfil').classList.add('hidden');
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

/** Procesa el identificador leído: busca el niño y registra la asistencia. */
async function procesarEscaneo(codigoQR) {
  try {
    const { data: nino, error: errNino } = await supabaseClient
      .from(TABLES.ninos)
      .select('id, nombres, apellidos, activo')
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
      .select('id, cedula, nombres, apellidos')
      .eq('activo', true)
      .order('nombres', { ascending: true });
    if (errNinos) throw errNinos;

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

    const filas = [['Cédula', 'Nombre', 'Apellido', 'Entrada', 'Salida', 'Estado']];

    ninos.forEach(n => {
      const mov = porNino[n.id];
      const entrada = mov && mov.entrada ? formatearHora(mov.entrada) : '';
      const salida = mov && mov.salida ? formatearHora(mov.salida) : '';
      let estado = 'No asistió';
      if (mov && mov.entrada && !mov.salida) estado = 'Dentro del evento';
      if (mov && mov.entrada && mov.salida) estado = 'Retirado';

      filas.push([n.cedula, n.nombres, n.apellidos, entrada, salida, estado]);
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
    showToast('Datos actualizados.', 'success', 1500);
  });

  // Modal: nuevo niño
  document.getElementById('btnNuevoNino').addEventListener('click', abrirModalNino);
  document.getElementById('btnCerrarModalNino').addEventListener('click', cerrarModalNino);
  document.getElementById('formNino').addEventListener('submit', guardarNino);
  document.getElementById('btnCerrarQrPreview').addEventListener('click', cerrarModalNino);

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
  document.getElementById('btnDescargarQrPerfil').addEventListener('click', () => {
    const qrEl = document.getElementById('perfilQrCanvas');
    descargarQR('perfilQrCanvas', `QR_${qrEl.dataset.ninoNombre.replace(/\s+/g, '_')}`);
  });
  document.getElementById('btnImprimirQrPerfil').addEventListener('click', () => {
    const qrEl = document.getElementById('perfilQrCanvas');
    imprimirQR('perfilQrCanvas', qrEl.dataset.ninoNombre, qrEl.dataset.ninoCedula);
  });

  // Escáner
  document.getElementById('modeEntrada').addEventListener('click', () => setModoEscaneo('ENTRADA'));
  document.getElementById('modeSalida').addEventListener('click', () => setModoEscaneo('SALIDA'));

  // Reportes
  document.getElementById('btnExportarCSV').addEventListener('click', exportarCSV);

  // Cerrar modales tocando el fondo oscuro
  document.getElementById('modalNino').addEventListener('click', (e) => {
    if (e.target.id === 'modalNino') cerrarModalNino();
  });
  document.getElementById('modalPerfil').addEventListener('click', (e) => {
    if (e.target.id === 'modalPerfil') cerrarModalPerfil();
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
  cambiarVista('dashboard');
}

document.addEventListener('DOMContentLoaded', inicializarApp);
