// RutaCuadre PWA — control de rutas de distribución, entregas, cobros, devoluciones y liquidación.
import * as fb from '../vendor/firebase-sdk.js';
import { firebaseConfig, DOMINIO_USUARIOS, USAR_EMULADOR } from './config.js';
import { parseDir, optimizar, costoParadas, kmDe, kmTxt, lblDir } from './geo.js';
import { extraerLineas, interpretar } from './importar.js';
import { leerFotos } from './ocr.js';

// ---------- utilidades ----------
const app = document.getElementById('app');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const int = v => { const n = parseInt(String(v ?? '').replace(/\D/g, ''), 10); return isFinite(n) ? n : 0; };
const fmt = n => '$' + Math.round(n || 0).toLocaleString('es-CO');
const clone = o => JSON.parse(JSON.stringify(o ?? null));
const hoy = () => { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
const hora = iso => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }); };
const fechaHora = iso => { if (!iso) return ''; const d = new Date(iso); return d.toLocaleDateString('es-CO') + ' ' + hora(iso); };
const fechaTxt = f => { if (!f) return ''; const [y, m, d] = f.split('-'); return `${d}/${m}/${y}`; };
const ls = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch (e) { } } };
const normUsuario = u => String(u || '').trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, '.');
const nuevoId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const conLimite = (p, ms = 20000) => Promise.race([p, sleep(ms).then(() => { throw { code: 'timeout' }; })]);

const ESTADOS = { pendiente: { t: 'Pendiente' }, entregado: { t: 'Entregado' }, parcial: { t: 'Parcial' }, rechazado: { t: 'Rechazado' }, no_visitado: { t: 'No visitado' } };
const RUTA_EST = { cargue: 'Por cargar', en_ruta: 'En ruta', liquidada: 'Liquidada' };
const ROLES = { admin: 'Administrador', oficina: 'Oficina', conductor: 'Conductor' };
const MOTIVOS = {
  parcial: ['Cliente pidió menos', 'Producto averiado', 'Producto vencido', 'Faltante en el cargue', 'Sin dinero suficiente', 'Precio no coincide', 'Otro'],
  rechazado: ['No hizo el pedido', 'Sin dinero', 'Producto averiado', 'Producto vencido', 'Precio no coincide', 'Pedido duplicado', 'Otro'],
  no_visitado: ['Local cerrado', 'Dirección errada', 'No se encontró al cliente', 'Zona insegura', 'No alcanzó el tiempo', 'Otro']
};
const GASTOS = ['Peaje', 'Combustible', 'Parqueadero', 'Alimentación', 'Cargue/descargue', 'Otro'];
const DENOM = [100000, 50000, 20000, 10000, 5000, 2000, 1000];
const FORM_VIEWS = ['parada', 'liquidar', 'nueva', 'gastos', 'ajustes'];
const MAX_FOTOS = 3;
const chip = e => `<span class="chip st-${esc(e)}">${esc(ESTADOS[e]?.t ?? e)}</span>`;
const rchip = e => `<span class="chip st-${esc(e)}">${esc(RUTA_EST[e] || e)}</span>`;

const ICON = {
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M3 7l9-4 9 4-9 4-9-4z"/><path d="M3 7v10l9 4 9-4V7"/><path d="M12 11v10"/></svg>',
  coin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.6"/><path d="M6 9.5v5M18 9.5v5"/></svg>',
  hand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h3l4 3h5a2 2 0 000-4h-4"/><path d="M7 14V9a2 2 0 012-2h6l3 3v3"/><path d="M2 21h20"/></svg>',
  truck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M2 6h11v10H2z"/><path d="M13 9h4l4 4v3h-8z"/><circle cx="6" cy="18" r="2"/><circle cx="17" cy="18" r="2"/></svg>'
};

// ---------- estado ----------
const S = {
  fbApp: null, auth: null, db: null, auth2: null,
  user: null, perfil: null, fase: 'cargando', // cargando | config | instalar | login | app
  rutas: [], rutasReady: false, config: {}, usuarios: [], usuariosReady: false,
  mode: '', view: '', rutaId: null, paradas: [], paradasReady: false,
  draft: null, liq: null, nueva: null, rep: null, confirmDel: null,
  pendientes: { rutas: false, paradas: false }, online: navigator.onLine,
  gps: null, instalando: false, loginErr: '', installEvt: null
};
let unsub = { rutas: null, paradas: null, perfil: null, config: null, usuarios: null };
const ruta = () => S.rutas.find(r => r.id === S.rutaId) || null;
const esOficina = () => S.perfil && (S.perfil.rol === 'admin' || S.perfil.rol === 'oficina');
const esAdmin = () => S.perfil && S.perfil.rol === 'admin';
const D = p => fb.doc(S.db, p);
const C = p => fb.collection(S.db, p);

function errTxt(e) {
  const c = (e && e.code) || '';
  const M = {
    'permission-denied': 'Firebase rechazó la operación por permisos. Revisa que las reglas de Firestore (archivo firestore.rules) estén pegadas y publicadas en Firestore Database › Reglas.',
    'failed-precondition': 'La base de datos Firestore no está lista. Créala en Firestore Database › Crear base de datos.',
    'not-found': 'No se encontró la base de datos Firestore. Créala en Firestore Database › Crear base de datos.',
    'timeout': 'Firebase no respondió. Revisa la conexión a internet y que la base de datos Firestore esté creada.',
    'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'La apiKey de js/config.js no es válida. Copia de nuevo la configuración desde Firebase.',
    'auth/invalid-api-key': 'La apiKey de js/config.js no es válida. Copia de nuevo la configuración desde Firebase.',
    'auth/configuration-not-found': 'Falta activar Authentication en Firebase (Authentication › Comenzar) y el método Correo electrónico/contraseña.',
    'auth/unauthorized-domain': 'Agrega el dominio de la app en Firebase › Authentication › Configuración › Dominios autorizados.',
    'unavailable': 'Sin conexión con el servidor.',
    'auth/invalid-credential': 'Usuario o clave incorrectos.',
    'auth/sin-acceso': 'Ese usuario no existe en RutaCuadre. Los usuarios se crean dentro de la app (el administrador al instalar; los conductores en la pestaña Conductores), no en la consola de Firebase.',
    'auth/wrong-password': 'Usuario o clave incorrectos.',
    'auth/user-not-found': 'Usuario o clave incorrectos.',
    'auth/too-many-requests': 'Demasiados intentos. Espera unos minutos.',
    'auth/network-request-failed': 'Sin conexión a internet.',
    'auth/weak-password': 'La clave debe tener al menos 6 caracteres.',
    'auth/email-already-in-use': 'Ese usuario ya existe.',
    'auth/requires-recent-login': 'Vuelve a escribir tu clave actual.',
    'auth/operation-not-allowed': 'Activa "Correo electrónico/contraseña" en Firebase Authentication.',
    'auth/invalid-email': 'El usuario tiene caracteres no permitidos.'
  };
  return M[c] || ((e && e.message) ? e.message + (c ? ` (${c})` : '') : String(e || 'Error'));
}

// Escritura que no bloquea la pantalla sin señal: Firestore la guarda en el celular y la sube al volver la conexión.
function w(p) {
  const pr = Promise.resolve(p);
  pr.catch(e => { console.error(e); toast('No se guardó: ' + errTxt(e)); });
  return Promise.race([pr.catch(() => { }), sleep(1200)]);
}

// ---------- Firebase ----------
function configurado() { return firebaseConfig && firebaseConfig.apiKey && !/PEGA_AQUI/.test(firebaseConfig.apiKey); }

async function boot() {
  registrarSW();
  window.addEventListener('online', () => { S.online = true; updateNet(); });
  window.addEventListener('offline', () => { S.online = false; updateNet(); });
  if (!configurado()) { S.fase = 'config'; render(); return; }
  S.fbApp = fb.initializeApp(firebaseConfig);
  S.auth = fb.getAuth(S.fbApp);
  try {
    S.db = fb.initializeFirestore(S.fbApp, { localCache: fb.persistentLocalCache({ tabManager: fb.persistentMultipleTabManager() }) });
  } catch (e) { console.warn('Sin caché persistente', e); S.db = fb.initializeFirestore(S.fbApp, {}); }
  if (USAR_EMULADOR) { fb.connectAuthEmulator(S.auth, 'http://127.0.0.1:9099'); fb.connectFirestoreEmulator(S.db, '127.0.0.1', 8080); }
  fb.onAuthStateChanged(S.auth, user => {
    S.user = user;
    if (S.instalando) return;
    detenerTodo();
    if (!user) { S.perfil = null; if (S.fase === 'instalar') return; revisarInstalacion(); return; }
    S.fase = 'cargando'; render();
    unsub.perfil = fb.onSnapshot(D('usuarios/' + user.uid), snap => {
      if (!snap.exists()) {
        if (S.instalando) return;
        S.loginErr = 'Tu usuario no tiene perfil en RutaCuadre. Pide a la oficina que lo revise.';
        fb.signOut(S.auth); return;
      }
      const p = snap.data();
      if (!p.activo) { S.loginErr = 'Tu usuario está desactivado. Habla con la oficina.'; fb.signOut(S.auth); return; }
      S.perfil = Object.assign({ uid: user.uid }, p);
      if (S.fase !== 'app') iniciarSesion();
      else updateCtx();
    }, e => { S.loginErr = errTxt(e); fb.signOut(S.auth); });
  });
}

async function revisarInstalacion() {
  S.fase = 'cargando'; render();
  try {
    const s = await Promise.race([fb.getDoc(D('config/instalacion')), sleep(8000).then(() => { throw { code: 'unavailable' }; })]);
    S.fase = s.exists() ? 'login' : 'instalar';
  } catch (e) {
    console.error('Revisión de instalación', e);
    S.fase = 'login';
    S.loginErr = S.loginErr || (e.code === 'unavailable' ? 'Sin conexión con Firebase. Revisa internet y que la base de datos Firestore esté creada.' : errTxt(e));
  }
  render();
}

function detenerTodo() {
  Object.keys(unsub).forEach(k => { if (unsub[k]) { unsub[k](); unsub[k] = null; } });
  S.rutas = []; S.rutasReady = false; S.paradas = []; S.paradasReady = false; S.rutaId = null; S.usuarios = []; S.usuariosReady = false;
  S.draft = null; S.liq = null; S.nueva = null; S.rep = null;
}

function iniciarSesion() {
  ['rutas', 'paradas', 'config', 'usuarios'].forEach(k => { if (unsub[k]) { unsub[k](); unsub[k] = null; } });
  S.fase = 'app'; S.loginErr = '';
  S.mode = esOficina() ? 'oficina' : 'conductor';
  S.view = S.mode === 'oficina' ? 'rutas' : '';
  unsub.config = fb.onSnapshot(D('config/app'), s => { S.config = s.exists() ? clone(s.data()) : {}; if (!FORM_VIEWS.includes(S.view)) render(); }, () => { });
  const q = esOficina()
    ? fb.query(C('rutas'), fb.orderBy('fecha', 'desc'), fb.limit(200))
    : fb.query(C('rutas'), fb.where('conductorUid', '==', S.user.uid), fb.where('abierta', '==', true));
  unsub.rutas = fb.onSnapshot(q, { includeMetadataChanges: true }, snap => {
    const teniaRuta = !!ruta();
    S.rutas = snap.docs.map(d => Object.assign({ id: d.id }, clone(d.data())));
    S.rutas.sort((a, b) => (b.fecha || '').localeCompare(a.fecha || '') || (b.creada || '').localeCompare(a.creada || ''));
    S.rutasReady = true; S.pendientes.rutas = snap.metadata.hasPendingWrites; updateNet();
    if (S.mode === 'conductor' && !S.rutaId && S.view !== 'nueva') {
      const saved = ls.get('rc_ruta_' + S.user.uid);
      const r = S.rutas.find(x => x.id === saved) || (S.rutas.length === 1 ? S.rutas[0] : null);
      if (r) { selectRuta(r.id, 'paradas'); return; }
    }
    if (!FORM_VIEWS.includes(S.view) || (S.rutaId && !teniaRuta && ruta())) render(); else updateCtx();
  }, e => { toast('No se pudieron leer las rutas: ' + errTxt(e)); });
  if (esOficina()) {
    unsub.usuarios = fb.onSnapshot(C('usuarios'), snap => {
      S.usuarios = snap.docs.map(d => Object.assign({ uid: d.id }, clone(d.data()))).filter(u => !u.reemplazadoPor).sort((a, b) => (a.nombre || '').localeCompare(b.nombre || ''));
      S.usuariosReady = true;
      if (!FORM_VIEWS.includes(S.view)) render();
    }, () => { });
  }
  render();
}

function selectRuta(id, view) {
  if (unsub.paradas) { unsub.paradas(); unsub.paradas = null; }
  S.rutaId = id; S.paradas = []; S.paradasReady = false; S.view = view;
  if (S.mode === 'conductor') ls.set('rc_ruta_' + S.user.uid, id);
  if (!id) { render(); return; }
  unsub.paradas = fb.onSnapshot(C('rutas/' + id + '/paradas'), { includeMetadataChanges: true }, snap => {
    S.paradas = snap.docs.map(d => Object.assign({ id: d.id }, clone(d.data()))).sort((a, b) => (a.orden || 0) - (b.orden || 0));
    S.paradasReady = true; S.pendientes.paradas = snap.metadata.hasPendingWrites; updateNet();
    if (!FORM_VIEWS.includes(S.view)) render();
  }, e => toast('No se pudieron leer las paradas: ' + errTxt(e)));
  render();
}

function updateNet() {
  const n = document.getElementById('net'); if (!n) return;
  n.hidden = S.fase !== 'app';
  const pend = S.pendientes.rutas || S.pendientes.paradas;
  n.className = 'net' + (!S.online ? ' off' : pend ? ' sync' : '');
  n.textContent = !S.online ? (pend ? 'Sin señal · cambios guardados en el celular' : 'Sin señal') : (pend ? 'Sincronizando…' : 'En línea');
}

// ---------- cálculos ----------
function valorFactura(p) { return (p.items || []).reduce((a, i) => a + i.cant * i.precio, 0); }
function entregadoDe(p, k) { if (!p.estado || p.estado === 'pendiente') return 0; return int(p.entregado && p.entregado[k]); }
function valorEntregado(p) { return (p.items || []).reduce((a, i, k) => a + entregadoDe(p, k) * i.precio, 0); }
function sumaPago(p) { const g = p.pago || {}; return int(g.efectivo) + int(g.transferencia) + int(g.credito); }

function totales(r, paradas) {
  const t = { n: paradas.length, pendiente: 0, entregado: 0, parcial: 0, rechazado: 0, no_visitado: 0, facturado: 0, vEntregado: 0, efectivo: 0, transferencia: 0, credito: 0, vDevuelto: 0, vDevGest: 0, carteraEf: 0, carteraTr: 0, gastos: 0, base: int(r && r.base) };
  const dev = {}, carga = {};
  for (const p of paradas) {
    const e = p.estado || 'pendiente'; t[e]++;
    t.facturado += valorFactura(p);
    if (e !== 'pendiente') { t.vEntregado += valorEntregado(p); const g = p.pago || {}; t.efectivo += int(g.efectivo); t.transferencia += int(g.transferencia); t.credito += int(g.credito); }
    (p.items || []).forEach((i, k) => {
      const key = i.ref ? 'R:' + String(i.ref).toUpperCase() : 'P:' + String(i.producto).toLowerCase();
      carga[key] = carga[key] || { ref: i.ref, producto: i.producto, cant: 0 }; carga[key].cant += i.cant;
      const d = i.cant - entregadoDe(p, k);
      if (d > 0) {
        dev[key] = dev[key] || { ref: i.ref, producto: i.producto, cant: 0, valor: 0, sinGestion: 0 };
        dev[key].cant += d; dev[key].valor += d * i.precio; t.vDevuelto += d * i.precio;
        if (e === 'pendiente') dev[key].sinGestion += d; else t.vDevGest += d * i.precio;
      }
    });
  }
  for (const c of (r && r.cartera) || []) { if (c.forma === 'transferencia') t.carteraTr += int(c.valor); else t.carteraEf += int(c.valor); }
  for (const g of (r && r.gastos) || []) t.gastos += int(g.valor);
  t.efectivoEsperado = t.base + t.efectivo + t.carteraEf - t.gastos;
  t.devoluciones = Object.values(dev).sort((a, b) => a.producto.localeCompare(b.producto));
  t.carga = Object.values(carga).sort((a, b) => a.producto.localeCompare(b.producto));
  t.gestionadas = t.n - t.pendiente;
  return t;
}

// ---------- mapas ----------
const ciudadDe = r => (r && r.ciudad) || S.config.ciudad || 'Barranquilla';
const dirCompleta = (p, r) => `${p.direccion}, ${ciudadDe(r)}, Colombia`;
const gmapsUno = (p, r) => 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + encodeURIComponent(dirCompleta(p, r));
const wazeUno = (p, r) => 'https://waze.com/ul?navigate=yes&q=' + encodeURIComponent(dirCompleta(p, r));
function gmapsVarias(ps, r) {
  const lista = ps.slice(0, 10), dest = lista[lista.length - 1], way = lista.slice(0, -1);
  return 'https://www.google.com/maps/dir/?api=1&travelmode=driving&destination=' + encodeURIComponent(dirCompleta(dest, r)) + (way.length ? '&waypoints=' + encodeURIComponent(way.map(p => dirCompleta(p, r)).join('|')) : '');
}
function esquema(ps, start, regreso) {
  const pts = ps.map((p, k) => ({ n: p.orden != null ? p.orden : k + 1, u: parseDir(p.direccion), e: p.estado || 'pendiente' })).filter(x => x.u);
  if (pts.length < 2) return '';
  const all = pts.map(x => x.u).concat(start ? [start] : []);
  const minX = Math.min(...all.map(u => u.carrera)), maxX = Math.max(...all.map(u => u.carrera));
  const minY = Math.min(...all.map(u => u.calle)), maxY = Math.max(...all.map(u => u.calle));
  const W = 640, H = 360, P = 34;
  const sx = (W - 2 * P) / Math.max(maxX - minX, 1), sy = (H - 2 * P) / Math.max(maxY - minY, 1);
  const X = u => P + (u.carrera - minX) * sx, Y = u => H - P - (u.calle - minY) * sy;
  const seq = (start ? [start] : []).concat(pts.map(x => x.u)).concat(start && regreso ? [start] : []);
  let path = '';
  for (let k = 1; k < seq.length; k++) { const a = seq[k - 1], b = seq[k]; path += `M${X(a).toFixed(1)},${Y(a).toFixed(1)} L${X(b).toFixed(1)},${Y(a).toFixed(1)} L${X(b).toFixed(1)},${Y(b).toFixed(1)} `; }
  return `<figure class="esq"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Esquema del recorrido por calles y carreras">
    <path d="${path}" class="esq-ruta"/>
    ${start ? `<rect x="${X(start) - 9}" y="${Y(start) - 9}" width="18" height="18" rx="3" class="esq-bod"/><text x="${X(start)}" y="${Y(start) + 4}" class="esq-tb">B</text>` : ''}
    ${pts.map(x => `<circle cx="${X(x.u).toFixed(1)}" cy="${Y(x.u).toFixed(1)}" r="11" class="esq-pt esq-${x.e}"/><text x="${X(x.u).toFixed(1)}" y="${(Y(x.u) + 4).toFixed(1)}" class="esq-t">${x.n}</text>`).join('')}
  </svg><figcaption class="small muted">Esquema por calles (vertical) y carreras (horizontal). No es un mapa a escala: muestra el orden del recorrido.${start ? ' B = punto de partida.' : ''}</figcaption></figure>`;
}

async function reoptimizar() {
  const r = ruta(); if (!r) return;
  const gest = S.paradas.filter(p => p.estado && p.estado !== 'pendiente').sort((a, b) => (a.hora || '').localeCompare(b.hora || ''));
  const pend = S.paradas.filter(p => !p.estado || p.estado === 'pendiente');
  if (pend.length < 2) { toast('No hay suficientes paradas pendientes para reordenar.'); return; }
  const desde = gest.length ? parseDir(gest[gest.length - 1].direccion) : parseDir(r.bodega);
  const antes = costoParadas(pend, desde, r.regreso);
  const ord = optimizar(pend.map((p, i) => ({ i, u: parseDir(p.direccion) })), desde, r.regreso);
  const nuevo = gest.concat(ord.map(i => pend[i]));
  const despues = costoParadas(ord.map(i => pend[i]), desde, r.regreso);
  const b = fb.writeBatch(S.db); let n = 0;
  nuevo.forEach((p, k) => { if (p.orden !== k + 1) { b.update(D('rutas/' + r.id + '/paradas/' + p.id), { orden: k + 1 }); n++; } });
  if (n) await w(b.commit());
  toast(antes - despues > 0.5 ? `Ruta reordenada. Lo que falta: ${kmTxt(despues)} (antes ${kmTxt(antes)}).` : 'El orden de lo que falta ya era el más corto.');
}

// ---------- render ----------
function updateCtx() {
  const c = document.getElementById('ctx'); const r = ruta();
  let t = '';
  if (S.fase === 'app') {
    const nombre = S.perfil ? S.perfil.nombre : '';
    if (S.mode === 'conductor') t = r ? `${r.codigo} · ${nombre}` : nombre;
    else t = (S.config.empresa ? S.config.empresa + ' · ' : '') + nombre + (r && ['ruta', 'liquidar'].includes(S.view) ? ' · ' + r.codigo : '');
  }
  c.textContent = t;
  document.getElementById('btnSalir').hidden = S.fase !== 'app';
  document.getElementById('btnCuenta').hidden = S.fase !== 'app';
  document.getElementById('btnInstalar').hidden = !S.installEvt;
  updateNet();
}

function render() {
  updateCtx();
  const tabs = document.getElementById('tabs'); tabs.hidden = true;
  let html = '';
  if (S.fase === 'cargando') { app.className = 'wrap narrow'; html = `<div class="empty">Cargando…</div>`; }
  else if (S.fase === 'config') { app.className = 'wrap narrow'; html = vConfig(); }
  else if (S.fase === 'instalar') { app.className = 'wrap narrow'; html = vInstalar(); }
  else if (S.fase === 'login') { app.className = 'wrap narrow'; html = vLogin(); }
  else if (S.mode === 'conductor') { app.className = 'wrap narrow'; html = vConductor(); }
  else { app.className = 'wrap'; html = vOficina(); }
  // conserva lo que se estaba escribiendo cuando la vista se redibuja por datos que llegan
  const mismaVista = S._ultimaVista === S.mode + '/' + S.view + '/' + S.fase && !S.limpiar;
  const previo = {};
  if (mismaVista) app.querySelectorAll('input[id]:not([type=file]):not([type=checkbox]),select[id],textarea[id]').forEach(el => { if (!el.dataset.f && !el.dataset.l && !el.dataset.n) previo[el.id] = el.value; });
  const foco = mismaVista && document.activeElement && document.activeElement.id;
  app.innerHTML = html;
  if (mismaVista) Object.entries(previo).forEach(([id, v]) => { const el = document.getElementById(id); if (el && el.tagName !== 'BUTTON') el.value = v; });
  if (foco) { const el = document.getElementById(foco); if (el && el.focus) el.focus(); }
  S._ultimaVista = S.mode + '/' + S.view + '/' + S.fase; S.limpiar = false;
  afterRender();
}

function afterRender() {
  document.querySelectorAll('canvas[data-firma]').forEach(initFirma);
  if (S.view === 'nueva') updatePreview();
  if (S.view === 'liquidar') updateLiq();
  if (S.view === 'parada') updateParadaCalc();
}

// ---------- acceso ----------
function vConfig() {
  return `<div class="card auth"><div class="eyebrow">Configuración pendiente</div><h1>Conecta RutaCuadre con Firebase</h1>
  <p>Abre el archivo <span class="mono">js/config.js</span> y pega la configuración de tu proyecto de Firebase. El manual de instalación explica cada paso.</p></div>`;
}
function vInstalar() {
  return `<div class="card auth"><div class="eyebrow">Primera vez</div><h1>Crea el administrador</h1>
  <p class="small muted">Este usuario controla la app: crea conductores, rutas y liquida. Solo se hace una vez.</p>
  <label class="f">Nombre de la empresa<input type="text" id="i-empresa" autocomplete="organization"></label>
  <label class="f">Tu nombre<input type="text" id="i-nombre" autocomplete="name"></label>
  <label class="f">Usuario<input type="text" id="i-usuario" autocomplete="username" autocapitalize="none" placeholder="Ej: admin"></label>
  <label class="f">Clave (mínimo 6 caracteres)<input type="password" id="i-clave" autocomplete="new-password"></label>
  <div class="err" id="iErr">${esc(S.loginErr)}</div>
  <button class="btn primary block" data-act="instalarApp">Crear administrador</button></div>`;
}
function vLogin() {
  return `<div class="card auth"><div class="eyebrow">Distribución y liquidación de ruta</div><h1>Iniciar sesión</h1>
  <form id="fLogin" style="display:flex;flex-direction:column;gap:12px">
  <label class="f">Usuario<input type="text" id="l-usuario" autocomplete="username" autocapitalize="none" value="${esc(ls.get('rc_ultimo_usuario') || '')}"></label>
  <label class="f">Clave<input type="password" id="l-clave" autocomplete="current-password"></label>
  <div class="err" id="lErr">${esc(S.loginErr)}</div>
  <button class="btn primary block" type="submit">Entrar</button></form>
  <p class="small muted">¿Olvidaste la clave? Pide a la oficina que te asigne una nueva.</p></div>`;
}

async function instalarApp() {
  const v = id => document.getElementById(id).value.trim();
  const empresa = v('i-empresa'), nombre = v('i-nombre'), usuario = normUsuario(v('i-usuario')), clave = document.getElementById('i-clave').value;
  const err = document.getElementById('iErr');
  const fallo = m => { S.loginErr = m; const el = document.getElementById('iErr'); if (el) el.textContent = m; };
  if (!empresa || !nombre) { fallo('Escribe el nombre de la empresa y tu nombre.'); return; }
  if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) { fallo('El usuario debe tener de 3 a 30 letras o números, sin espacios.'); return; }
  if (clave.length < 6) { fallo('La clave debe tener al menos 6 caracteres.'); return; }
  const btn = document.querySelector('[data-act="instalarApp"]'); btn.disabled = true; btn.textContent = 'Creando…';
  err.textContent = '';
  S.instalando = true;
  let cred = null;
  try {
    const email = `${usuario}@${DOMINIO_USUARIOS}`;
    btn.textContent = 'Creando usuario…';
    cred = await conLimite(fb.createUserWithEmailAndPassword(S.auth, email, clave));
    const uid = cred.user.uid, ahora = new Date().toISOString();
    btn.textContent = 'Guardando en la base de datos…';
    const b = fb.writeBatch(S.db);
    b.set(D('usuarios/' + uid), { nombre, usuario, rol: 'admin', activo: true, creado: ahora, placa: '', telefono: '' });
    b.set(D('accesos/' + usuario), { email, uid });
    b.set(D('config/instalacion'), { fecha: ahora, empresa });
    await conLimite(b.commit());
    await conLimite(fb.setDoc(D('config/app'), { empresa, ciudad: 'Barranquilla', bodega: '' }));
    ls.set('rc_ultimo_usuario', usuario);
    S.instalando = false; S.loginErr = '';
    const s = await fb.getDoc(D('usuarios/' + uid));
    S.user = cred.user; S.perfil = Object.assign({ uid }, s.data());
    if (unsub.perfil) unsub.perfil();
    unsub.perfil = fb.onSnapshot(D('usuarios/' + uid), snap => { if (!snap.exists() || !snap.data().activo) { fb.signOut(S.auth); return; } S.perfil = Object.assign({ uid }, snap.data()); updateCtx(); }, () => { });
    iniciarSesion();
    toast('Administrador creado. Bienvenido a RutaCuadre.');
  } catch (e) {
    console.error('Instalación', e);
    // si se alcanzó a crear el acceso pero falló la base de datos, se borra para poder reintentar con el mismo usuario
    if (cred && cred.user) { try { await fb.deleteUser(cred.user); } catch (x) { console.warn('No se pudo borrar el acceso incompleto', x); } }
    try { if (S.auth.currentUser) await fb.signOut(S.auth); } catch (x) { }
    S.instalando = false;
    fallo('No se pudo crear el administrador. ' + errTxt(e));
    btn.disabled = false; btn.textContent = 'Crear administrador';
  }
}

async function entrar() {
  const usuario = normUsuario(document.getElementById('l-usuario').value), clave = document.getElementById('l-clave').value;
  const err = document.getElementById('lErr');
  if (!usuario || !clave) { err.textContent = 'Escribe usuario y clave.'; return; }
  const btn = document.querySelector('#fLogin button[type=submit]'); btn.disabled = true; btn.textContent = 'Entrando…';
  try {
    const a = await fb.getDoc(D('accesos/' + usuario));
    if (!a.exists()) throw { code: 'auth/sin-acceso' };
    S.loginErr = '';
    ls.set('rc_ultimo_usuario', usuario);
    await fb.signInWithEmailAndPassword(S.auth, a.data().email, clave);
  } catch (e) { console.error('Ingreso', e); S.loginErr = errTxt(e); err.textContent = S.loginErr; btn.disabled = false; btn.textContent = 'Entrar'; }
}

function vCuentaModal() {
  const p = S.perfil;
  return `<div class="modal-in"><div class="row between"><h2>Mi cuenta</h2><button class="btn sm" data-act="cerrarModal">Cerrar</button></div>
    <div class="small"><b>${esc(p.nombre)}</b> · usuario <span class="mono">${esc(p.usuario)}</span> · ${ROLES[p.rol]}</div>
    <h3>Cambiar clave</h3>
    <label class="f">Clave actual<input type="password" id="c-actual" autocomplete="current-password"></label>
    <label class="f">Clave nueva (mínimo 6)<input type="password" id="c-nueva" autocomplete="new-password"></label>
    <label class="f">Repite la clave nueva<input type="password" id="c-nueva2" autocomplete="new-password"></label>
    <div class="err" id="cErr"></div>
    <button class="btn primary" data-act="cambiarClave">Cambiar clave</button></div>`;
}
async function cambiarClave() {
  const a = document.getElementById('c-actual').value, n = document.getElementById('c-nueva').value, n2 = document.getElementById('c-nueva2').value, err = document.getElementById('cErr');
  if (n.length < 6) { err.textContent = 'La clave nueva debe tener al menos 6 caracteres.'; return; }
  if (n !== n2) { err.textContent = 'Las claves nuevas no coinciden.'; return; }
  try {
    await fb.reauthenticateWithCredential(S.auth.currentUser, fb.EmailAuthProvider.credential(S.auth.currentUser.email, a));
    await fb.updatePassword(S.auth.currentUser, n);
    cerrarModal(); toast('Clave cambiada.');
  } catch (e) { err.textContent = errTxt(e); }
}

// ---------- conductor ----------
function vConductor() {
  if (!S.rutasReady) return `<div class="empty">Cargando tus rutas…</div>`;
  if (S.view === 'nueva') return S.config.conductoresCrean === false ? (S.view = '', vElegirRuta()) : vNueva();
  if (S.rutaId && !ruta() && S.rutaNueva === S.rutaId) return `<div class="empty">Abriendo tu ruta…</div>`;
  if (!S.rutaId || !ruta()) return vElegirRuta();
  const r = ruta();
  showTabs();
  switch (S.view) {
    case 'cargue': return vCargue(r);
    case 'parada': return vParadaForm(r);
    case 'gastos': return vGastos(r);
    case 'resumen': return vResumen(r);
    default: S.view = 'paradas'; return vParadas(r);
  }
}
function showTabs() {
  const tabs = document.getElementById('tabs'); tabs.hidden = false;
  const v = S.view === 'parada' ? 'paradas' : S.view;
  const T = [['paradas', 'Paradas', ICON.list], ['cargue', 'Cargue', ICON.box], ['gastos', 'Gastos', ICON.coin], ['resumen', 'Entregar', ICON.hand]];
  tabs.innerHTML = `<div class="tabs-in">${T.map(([k, l, i]) => `<button class="tab ${v === k ? 'on' : ''}" data-act="cview" data-v="${k}">${i}${l}</button>`).join('')}</div>`;
}
function vElegirRuta() {
  return `<div style="display:flex;flex-direction:column;gap:6px"><div class="eyebrow">${esc(S.perfil.nombre)}</div><h1>Tus rutas abiertas</h1></div>
  ${S.rutas.length ? `<div class="stops">${S.rutas.map(r => `
    <button class="stop" data-act="elegir" data-v="${esc(r.id)}">
      <div class="n">${ICON.truck}</div>
      <div class="who"><b>${esc(r.codigo)} · ${fechaTxt(r.fecha)}</b><span>${esc(r.vehiculo || '')} · ${r.nParadas || 0} paradas</span><span>${esc(r.remitente || '')}</span></div>
      <div class="amt">${rchip(r.estado)}</div>
    </button>`).join('')}</div>`
    : `<div class="empty">No tienes rutas abiertas.${S.config.conductoresCrean === false ? ' Cuando la oficina te asigne una, aparecerá aquí.' : ''}</div>`}
  ${S.config.conductoresCrean === false ? '' : `<div class="next"><div class="eyebrow">¿Te entregaron la planilla en la bodega?</div><div class="small">Tómale una foto y la app arma tu ruta con los clientes ordenados por cercanía.</div><button class="btn primary" data-act="nuevaConductor">Crear ruta desde la planilla</button></div>`}`;
}
function cabeceraRuta(r, t) {
  const pct = k => t.n ? (t[k] / t.n * 100) : 0;
  return `<div class="card">
    <div class="row between"><div><div class="eyebrow">${esc(r.codigo)} · ${fechaTxt(r.fecha)}</div><h2>${t.gestionadas} de ${t.n} paradas</h2></div>${rchip(r.estado)}</div>
    <div class="progress" aria-label="Avance de la ruta"><i style="width:${pct('entregado')}%;background:var(--accent)"></i><i style="width:${pct('parcial')}%;background:var(--warn)"></i><i style="width:${pct('rechazado')}%;background:var(--bad)"></i><i style="width:${pct('no_visitado')}%;background:var(--slate)"></i></div>
    <div class="grid3 small">
      <div class="sum-line"><span class="muted">Efectivo cobrado</span><b>${fmt(t.efectivo)}</b></div>
      <div class="sum-line"><span class="muted">Transferencias</span><b>${fmt(t.transferencia)}</b></div>
      <div class="sum-line"><span class="muted">Devolución</span><b>${fmt(t.vDevGest)}</b></div>
    </div>
    <div class="row">${S.rutas.length > 1 ? `<button class="btn sm ghost" data-act="cambiarRuta">Cambiar de ruta</button>` : ''}${S.config.conductoresCrean === false ? '' : `<button class="btn sm ghost" data-act="nuevaConductor">Otra planilla</button>`}</div>
  </div>`;
}
function vParadas(r) {
  const t = totales(r, S.paradas);
  let h = '';
  if (r.estado === 'cargue') h += `<div class="banner warn"><div><b>Confirma el cargue antes de salir.</b> Cuenta la mercancía y confírmala en la pestaña Cargue. Así no respondes por faltantes que venían de bodega.</div></div>`;
  h += cabeceraRuta(r, t);
  if (!S.paradasReady) return h + `<div class="empty">Cargando paradas…</div>`;
  const pend = S.paradas.filter(p => !p.estado || p.estado === 'pendiente');
  if (pend.length && r.estado === 'en_ruta') {
    const sig = pend[0];
    h += `<div class="next"><div class="eyebrow">Siguiente parada · ${sig.orden}</div>
      <div><b>${esc(sig.cliente)}</b><div class="small">${esc(sig.direccion || '')} · Fact. ${esc(sig.factura || '—')}</div>
      <div class="small" style="margin-top:6px"><b>Mercancía a entregar · ${fmt(valorFactura(sig))}</b></div>${listaMercancia(sig)}</div>
      <div class="row">
        <a class="btn sm primary" href="${gmapsUno(sig, r)}" target="_blank" rel="noopener">Ir con Google Maps</a>
        <a class="btn sm" href="${wazeUno(sig, r)}" target="_blank" rel="noopener">Waze</a>
        ${pend.length > 1 ? `<a class="btn sm" href="${gmapsVarias(pend, r)}" target="_blank" rel="noopener">Ruta de las próximas ${Math.min(pend.length, 10)}</a>` : ''}
        ${pend.length > 2 ? `<button class="btn sm ghost" data-act="reoptimizar">Reordenar lo que falta</button>` : ''}
      </div></div>`;
  }
  h += `<div class="stops">` + S.paradas.map(p => {
    const e = p.estado || 'pendiente';
    const v = e === 'pendiente' ? valorFactura(p) : valorEntregado(p);
    return `<button class="stop s-${e}" data-act="abrir" data-v="${esc(p.id)}">
      <div class="n">${p.orden}</div>
      <div class="who"><b>${esc(p.cliente)}</b><span>${esc(p.direccion || '')}</span><span class="mono">Fact. ${esc(p.factura || '—')}${p.hora ? ' · ' + hora(p.hora) : ''}</span></div>
      <div class="amt">${fmt(v)}${chip(e)}</div>
      <div class="merc-wrap">${listaMercancia(p)}</div>
    </button>${e !== 'pendiente' && p.telefono ? `<div class="row" style="justify-content:flex-end;margin-top:-4px"><a class="btn sm ghost" href="${waLink(p, r)}" target="_blank" rel="noopener">Enviar comprobante por WhatsApp</a></div>` : ''}`;
  }).join('') + `</div>`;
  return h;
}
// Mercancía de la parada: lo que hay que entregar, o lo entregado y devuelto si ya se gestionó.
function listaMercancia(p) {
  const e = p.estado || 'pendiente';
  const filas = (p.items || []).map((i, k) => {
    if (e === 'pendiente') return `<li><b class="num">${i.cant}</b><span>${esc(i.producto)}</span></li>`;
    const en = entregadoDe(p, k), dv = i.cant - en;
    return `<li class="${dv ? 'dev' : ''}"><b class="num">${en}${dv ? `<small>/${i.cant}</small>` : ''}</b><span>${esc(i.producto)}${dv ? ` <em>devuelve ${dv}</em>` : ''}</span></li>`;
  }).join('');
  const unid = (p.items || []).reduce((a, i) => a + i.cant, 0);
  return `<ul class="merc" aria-label="Mercancía">${filas}</ul>${(p.items || []).length > 1 ? `<span class="merc-tot">${unid} unidades en total</span>` : ''}`;
}
function waLink(p, r) {
  let tel = String(p.telefono || '').replace(/\D/g, '');
  if (tel.length === 10) tel = '57' + tel;
  const g = p.pago || {};
  const devs = (p.items || []).map((i, k) => ({ i, d: i.cant - entregadoDe(p, k) })).filter(x => x.d > 0).map(x => `${x.d} ${x.i.producto}`);
  const lines = [
    `Hola ${p.cliente}, este es el comprobante de entrega${S.config.empresa ? ' de ' + S.config.empresa : ''}.`,
    `Ruta ${r.codigo} · Factura ${p.factura || '-'} · ${fechaHora(p.hora)}`,
    `Estado: ${ESTADOS[p.estado].t}`,
    `Valor recibido: ${fmt(valorEntregado(p))}`,
    int(g.efectivo) ? `Pagó en efectivo: ${fmt(g.efectivo)}` : '',
    int(g.transferencia) ? `Pagó por transferencia: ${fmt(g.transferencia)}` : '',
    int(g.credito) ? `Queda a crédito: ${fmt(g.credito)}` : '',
    devs.length ? `Devuelto: ${devs.join(', ')}` : '',
    p.motivo ? `Motivo: ${p.motivo}` : '',
    p.recibe ? `Recibió: ${p.recibe}` : ''
  ].filter(Boolean);
  return 'https://wa.me/' + tel + '?text=' + encodeURIComponent(lines.join('\n'));
}

// ---- formulario de parada ----
function pedirGPS() {
  S.gps = null;
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(
    pos => { S.gps = { lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6), prec: Math.round(pos.coords.accuracy || 0), t: new Date().toISOString() }; const el = document.getElementById('gpsTxt'); if (el) el.textContent = `Ubicación tomada (±${S.gps.prec} m).`; },
    () => { const el = document.getElementById('gpsTxt'); if (el) el.textContent = 'No se pudo tomar la ubicación. La parada se guarda igual.'; },
    { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
}
function abrirParada(id) {
  const r = ruta();
  if (r.estado === 'cargue') { toast('Primero confirma el cargue.'); S.view = 'cargue'; render(); return; }
  if (r.estado === 'liquidada') { toast('Esta ruta ya fue liquidada.'); return; }
  const p = S.paradas.find(x => x.id === id); if (!p) return;
  const d = clone(p);
  d.estado = d.estado || 'pendiente';
  d.entregado = (d.items || []).map((i, k) => d.entregado && d.entregado[k] != null ? int(d.entregado[k]) : i.cant);
  d.pago = d.pago || { efectivo: 0, transferencia: 0, credito: 0 };
  d.fotos = d.fotos || []; d.fotosNuevas = [];
  S.draft = d; S.draftErr = ''; S.view = 'parada'; pedirGPS(); render(); window.scrollTo(0, 0);
}
function thumbsNuevas(lista, act) {
  return lista.map((f, k) => `<div class="thumb"><img src="${f}" alt="Foto ${k + 1}"><button data-act="${act}" data-v="${k}" aria-label="Quitar foto">✕</button></div>`).join('');
}
function vParadaForm(r) {
  const d = S.draft; if (!d) { S.view = 'paradas'; return vParadas(r); }
  const e = d.estado, editable = e === 'parcial', conPago = e === 'entregado' || e === 'parcial', motivos = MOTIVOS[e];
  const nFotos = d.fotos.length + d.fotosNuevas.length;
  return `
  <div class="row between"><button class="btn sm ghost" data-act="cview" data-v="paradas">← Paradas</button><span class="eyebrow">Parada ${d.orden} de ${S.paradas.length}</span></div>
  <div class="card">
    <div><h2>${esc(d.cliente)}</h2><div class="muted">${esc(d.direccion || '')}</div>
    <div class="row small" style="margin-top:4px"><span class="mono">Factura ${esc(d.factura || '—')}</span>${d.telefono ? `<span class="mono">Tel. ${esc(d.telefono)}</span>` : ''}<span class="mono">Valor ${fmt(valorFactura(d))}</span></div></div>
    <div class="row"><a class="btn sm" href="${gmapsUno(d, r)}" target="_blank" rel="noopener">Cómo llegar · Google Maps</a><a class="btn sm" href="${wazeUno(d, r)}" target="_blank" rel="noopener">Waze</a>${d.telefono ? `<a class="btn sm" href="tel:${esc(String(d.telefono).replace(/\D/g, ''))}">Llamar</a>` : ''}</div>
  </div>
  <div class="card">
    <h3>¿Qué pasó en este cliente?</h3>
    <div class="estados">${['entregado', 'parcial', 'rechazado', 'no_visitado'].map(k => `<button class="pick e-${k} ${e === k ? 'on' : ''}" data-act="estado" data-v="${k}">${ESTADOS[k].t}${k === 'entregado' ? ' completo' : k === 'rechazado' ? ' todo' : ''}</button>`).join('')}</div>
    ${motivos ? `<label class="f">Motivo ${e === 'parcial' ? 'de la devolución' : ''}
      <select id="f-motivo" data-f="motivo"><option value="">Elige un motivo…</option>${motivos.map(m => `<option ${d.motivo === m ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select></label>` : ''}
  </div>
  ${e !== 'pendiente' ? `
  <div class="card">
    <h3>Mercancía</h3>
    ${editable ? `<p class="small muted">Escribe cuántas unidades recibió el cliente de cada producto. El resto queda como devolución.</p>` : ''}
    <div class="tablewrap"><table>
      <thead><tr><th>Producto</th><th class="r">Pedido</th><th class="r">Recibió</th><th class="r">Devuelve</th></tr></thead>
      <tbody>${d.items.map((i, k) => `<tr>
        <td>${esc(i.producto)}<div class="mono muted">${esc(i.ref || '')} · ${fmt(i.precio)}</div></td>
        <td class="r num">${i.cant}</td>
        <td class="r">${editable ? `<input type="text" inputmode="numeric" class="qty" id="f-ent-${k}" data-f="ent" data-k="${k}" value="${d.entregado[k]}" aria-label="Unidades recibidas de ${esc(i.producto)}">` : `<span class="num">${d.entregado[k]}</span>`}</td>
        <td class="r num" id="dev-${k}">${i.cant - d.entregado[k]}</td></tr>`).join('')}</tbody>
    </table></div>
    <div class="sum-line"><span class="muted">Valor recibido por el cliente</span><b id="c-ventr">${fmt(valorEntregado(d))}</b></div>
    <div class="sum-line"><span class="muted">Valor devuelto</span><b id="c-vdev">${fmt(valorFactura(d) - valorEntregado(d))}</b></div>
  </div>` : ''}
  ${conPago ? `
  <div class="card">
    <div class="row between"><h3>Cobro</h3><button class="btn sm" data-act="todoEfectivo">Todo en efectivo</button></div>
    <div class="grid3">
      <label class="f">Efectivo<input type="text" inputmode="numeric" id="f-ef" data-f="pago.efectivo" value="${int(d.pago.efectivo)}"></label>
      <label class="f">Transferencia<input type="text" inputmode="numeric" id="f-tr" data-f="pago.transferencia" value="${int(d.pago.transferencia)}"></label>
      <label class="f">Crédito autorizado<input type="text" inputmode="numeric" id="f-cr" data-f="pago.credito" value="${int(d.pago.credito)}"></label>
    </div>
    <label class="f" id="wrap-ref" ${int(d.pago.transferencia) ? '' : 'hidden'}>Referencia o número del comprobante de transferencia<input type="text" id="f-ref" data-f="refTransf" value="${esc(d.refTransf || '')}"></label>
    <div class="sum-line"><span class="muted">Por cobrar</span><b id="c-cobrar">${fmt(valorEntregado(d))}</b></div>
    <div class="sum-line"><span class="muted">Registrado</span><b id="c-reg">${fmt(sumaPago(d))}</b></div>
    <div id="c-dif"></div>
  </div>
  <div class="card">
    <h3>Recibe</h3>
    <label class="f">Nombre de quien recibe<input type="text" id="f-recibe" data-f="recibe" value="${esc(d.recibe || '')}" autocomplete="off"></label>
    <div class="sig"><div class="row between small"><span class="muted">Firma del cliente</span><button class="btn sm ghost" data-act="borrarFirma" data-v="firma">Borrar firma</button></div>
    <canvas data-firma="firma" data-target="draft" aria-label="Espacio para la firma del cliente"></canvas></div>
  </div>` : ''}
  ${e !== 'pendiente' ? `<div class="card">
    <h3>Fotos y novedad</h3>
    <p class="small muted">Comprobante de transferencia, producto averiado o la fachada del local cerrado. Hasta ${MAX_FOTOS} fotos.</p>
    <div class="thumbs">${d.fotos.length ? `<button class="btn sm" data-act="verFotos" data-v="${esc(d.fotos.join(','))}">Ver ${d.fotos.length} ${d.fotos.length === 1 ? 'foto guardada' : 'fotos guardadas'}</button>` : ''}${thumbsNuevas(d.fotosNuevas, 'quitarFoto')}</div>
    ${nFotos < MAX_FOTOS ? `<label class="btn sm" style="align-self:flex-start">Tomar o subir foto<input type="file" accept="image/*" capture="environment" id="f-foto" hidden></label>` : ''}
    <label class="f">Novedad (opcional)<textarea id="f-nov" data-f="novedad" placeholder="Ej: caja con golpe, cliente pide entregar antes de las 10">${esc(d.novedad || '')}</textarea></label>
    <div class="small muted" id="gpsTxt">${S.gps ? `Ubicación tomada (±${S.gps.prec} m).` : 'Tomando la ubicación del celular…'}</div>
  </div>` : ''}
  <div class="err" id="draftErr">${esc(S.draftErr || '')}</div>
  <div class="row"><button class="btn primary block" data-act="guardarParada" ${e === 'pendiente' ? 'disabled' : ''}>Guardar parada</button></div>`;
}
function updateParadaCalc() {
  const d = S.draft; if (!d) return;
  d.items.forEach((i, k) => { const c = document.getElementById('dev-' + k); if (c) c.textContent = i.cant - d.entregado[k]; });
  const ve = valorEntregado(d), set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set('c-ventr', fmt(ve)); set('c-vdev', fmt(valorFactura(d) - ve)); set('c-cobrar', fmt(ve)); set('c-reg', fmt(sumaPago(d)));
  const dif = document.getElementById('c-dif');
  if (dif) {
    const x = sumaPago(d) - ve;
    dif.innerHTML = x === 0 ? `<div class="banner ok"><div>El cobro cuadra con lo entregado.</div></div>`
      : `<div class="banner ${x < 0 ? 'warn' : 'bad'}"><div>${x < 0 ? `Faltan <b>${fmt(-x)}</b> por registrar.` : `Registraste <b>${fmt(x)}</b> de más.`}</div></div>`;
  }
  const wr = document.getElementById('wrap-ref'); if (wr) wr.hidden = !int(d.pago.transferencia);
}
function setEstado(v) {
  const d = S.draft;
  if (v === 'entregado') d.entregado = d.items.map(i => i.cant);
  else if (v === 'rechazado' || v === 'no_visitado') d.entregado = d.items.map(() => 0);
  else if (v === 'parcial' && d.estado !== 'parcial') d.entregado = d.items.map(i => i.cant);
  if (d.estado !== v) d.motivo = '';
  d.estado = v;
  d.pago = { efectivo: valorEntregado(d), transferencia: 0, credito: 0 };
  if (v === 'rechazado' || v === 'no_visitado') { d.recibe = ''; d.firma = ''; d.refTransf = ''; }
  S.draftErr = '';
  render();
}
async function guardarParada() {
  const d = S.draft, ve = valorEntregado(d);
  let err = '';
  if (d.estado === 'pendiente') err = 'Elige qué pasó en este cliente.';
  else if (MOTIVOS[d.estado] && !d.motivo) err = 'Elige el motivo.';
  else if (d.estado === 'parcial' && d.entregado.some((x, k) => x > d.items[k].cant)) err = 'Una cantidad recibida es mayor que la pedida.';
  else if (d.estado === 'parcial' && ve === valorFactura(d)) err = 'No hay devolución: marca la parada como entregado completo.';
  else if (d.estado === 'parcial' && ve === 0) err = 'El cliente no recibió nada: marca la parada como rechazado.';
  else if ((d.estado === 'entregado' || d.estado === 'parcial') && sumaPago(d) !== ve) err = 'El cobro no cuadra: efectivo + transferencia + crédito debe ser igual al valor recibido.';
  else if (int(d.pago.transferencia) && !String(d.refTransf || '').trim()) err = 'Escribe la referencia de la transferencia.';
  else if ((d.estado === 'entregado' || d.estado === 'parcial') && !String(d.recibe || '').trim()) err = 'Escribe el nombre de quien recibe.';
  else if ((d.estado === 'entregado' || d.estado === 'parcial') && !d.firma) err = 'Falta la firma del cliente.';
  if (err) { S.draftErr = err; const el = document.getElementById('draftErr'); if (el) { el.textContent = err; el.scrollIntoView({ block: 'center' }); } return; }
  const rid = S.rutaId, ahora = new Date().toISOString();
  const ids = [];
  for (const data of d.fotosNuevas) {
    const id = nuevoId(); ids.push(id);
    w(fb.setDoc(D(`rutas/${rid}/fotos/${id}`), { paradaId: d.id, tipo: 'parada', data, fecha: ahora, autorUid: S.user.uid }));
  }
  const upd = {
    estado: d.estado, entregado: d.entregado.map(int), motivo: d.motivo || '',
    pago: { efectivo: int(d.pago.efectivo), transferencia: int(d.pago.transferencia), credito: int(d.pago.credito) },
    refTransf: String(d.refTransf || '').trim(), recibe: String(d.recibe || '').trim(), firma: d.firma || '',
    novedad: String(d.novedad || '').trim(), hora: ahora, gps: S.gps || null, fotos: d.fotos.concat(ids)
  };
  const orden = d.orden, estado = d.estado;
  S.draft = null; S.view = 'paradas';
  await w(fb.updateDoc(D(`rutas/${rid}/paradas/${d.id}`), upd));
  toast(`Parada ${orden} guardada: ${ESTADOS[estado].t.toLowerCase()}.${S.online ? '' : ' Se enviará al volver la señal.'}`);
  render(); window.scrollTo(0, 0);
}

// ---- cargue ----
function vCargue(r) {
  const t = totales(r, S.paradas), conf = r.cargue && r.cargue.confirmado;
  return `<div style="display:flex;flex-direction:column;gap:6px"><div class="eyebrow">${esc(r.codigo)} · ${esc(r.vehiculo || '')}</div><h1>Cargue del vehículo</h1></div>
  ${conf ? `<div class="banner ok"><div><b>Cargue confirmado</b> el ${fechaHora(r.cargue.hora)}.${r.cargue.novedad ? ' Novedad: ' + esc(r.cargue.novedad) : ''}</div></div>`
      : `<div class="banner info"><div>Cuenta cada producto antes de salir. Si algo no coincide, escríbelo en la novedad para que la oficina lo sepa.</div></div>`}
  <div class="card">
    <div class="tablewrap"><table><thead><tr><th>Producto</th><th>Ref.</th><th class="r">Unidades</th></tr></thead>
    <tbody>${t.carga.map(c => `<tr><td>${esc(c.producto)}</td><td class="mono">${esc(c.ref || '')}</td><td class="r num">${c.cant}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Sin productos.</td></tr>'}</tbody>
    <tfoot><tr><td colspan="2">${S.paradas.length} clientes · valor total ${fmt(t.facturado)}</td><td class="r num">${t.carga.reduce((a, c) => a + c.cant, 0)}</td></tr></tfoot></table></div>
    ${!conf && r.creadaPorConductor && r.creadaPor === S.user.uid && r.estado === 'cargue' ? `<div class="row small"><span class="muted">¿La planilla se leyó mal?</span>${S.confirmDel === r.id ? `<button class="btn danger solid sm" data-act="borrarRuta">Sí, descartar la ruta</button><button class="btn sm" data-act="cancelDel">No</button>` : `<button class="btn danger sm" data-act="pedirDel">Descartar y volver a empezar</button>`}</div>` : ''}
    ${conf || r.estado === 'liquidada' ? '' : `<label class="f">Novedad en el cargue (opcional)<textarea id="f-cnov" placeholder="Ej: llegaron 46 cajas de aceite, no 48"></textarea></label>
    <button class="btn primary block" data-act="confirmarCargue">Recibí esta mercancía conforme</button>`}
  </div>`;
}

// ---- gastos y cartera ----
function vGastos(r) {
  const gastos = r.gastos || [], cartera = r.cartera || [], cerrada = r.estado === 'liquidada';
  return `<div style="display:flex;flex-direction:column;gap:6px"><div class="eyebrow">${esc(r.codigo)}</div><h1>Gastos y cobros de cartera</h1></div>
  <div class="card">
    <h3>Gastos de ruta</h3>
    <p class="small muted">Se descuentan del efectivo que entregas. Toma foto del recibo.</p>
    ${gastos.length ? `<div class="tablewrap"><table><tbody>${gastos.map((g, k) => `<tr><td>${esc(g.concepto)}${g.nota ? `<div class="small muted">${esc(g.nota)}</div>` : ''}${g.foto ? `<button class="btn sm ghost" data-act="verFotos" data-v="${esc(g.foto)}">Ver recibo</button>` : ''}</td><td class="r num">${fmt(g.valor)}</td><td class="r">${cerrada ? '' : `<button class="btn sm ghost" data-act="delGasto" data-v="${k}">Quitar</button>`}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>Total</td><td class="r num">${fmt(gastos.reduce((a, g) => a + int(g.valor), 0))}</td><td></td></tr></tfoot></table></div>` : `<div class="empty small">Sin gastos registrados.</div>`}
    ${cerrada ? '' : `<div class="grid3">
      <label class="f">Concepto<select id="g-concepto">${GASTOS.map(g => `<option>${g}</option>`).join('')}</select></label>
      <label class="f">Valor<input type="text" inputmode="numeric" id="g-valor" placeholder="0"></label>
      <label class="f">N.º de recibo o nota<input type="text" id="g-nota"></label>
    </div>
    <div class="row"><div class="thumbs" id="g-thumbs">${S.fotoGasto ? thumbsNuevas([S.fotoGasto], 'quitarFotoGasto') : ''}</div>
    ${S.fotoGasto ? '' : `<label class="btn sm">Foto del recibo<input type="file" accept="image/*" capture="environment" id="g-foto" hidden></label>`}</div>
    <button class="btn" data-act="addGasto">Agregar gasto</button>`}
  </div>
  <div class="card">
    <h3>Cobros de cartera</h3>
    <p class="small muted">Pagos de facturas anteriores que un cliente te entregó en la ruta. Van aparte de las entregas del día.</p>
    ${cartera.length ? `<div class="tablewrap"><table><tbody>${cartera.map((c, k) => `<tr><td>${esc(c.cliente)}<div class="mono muted">Fact. ${esc(c.factura || '—')} · ${c.forma === 'transferencia' ? 'Transferencia ' + esc(c.ref || '') : 'Efectivo'}</div></td><td class="r num">${fmt(c.valor)}</td><td class="r">${cerrada ? '' : `<button class="btn sm ghost" data-act="delCartera" data-v="${k}">Quitar</button>`}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty small">Sin cobros de cartera.</div>`}
    ${cerrada ? '' : `<div class="grid2">
      <label class="f">Cliente<input type="text" id="k-cliente"></label>
      <label class="f">Factura que paga<input type="text" id="k-factura"></label>
      <label class="f">Valor<input type="text" inputmode="numeric" id="k-valor" placeholder="0"></label>
      <label class="f">Forma de pago<select id="k-forma"><option value="efectivo">Efectivo</option><option value="transferencia">Transferencia</option></select></label>
      <label class="f">Referencia de transferencia<input type="text" id="k-ref"></label>
    </div><button class="btn" data-act="addCartera">Agregar cobro</button>`}
  </div>`;
}

// ---- resumen para entregar ----
function vResumen(r) {
  const t = totales(r, S.paradas), liq = r.liquidacion;
  let h = `<div style="display:flex;flex-direction:column;gap:6px"><div class="eyebrow">${esc(r.codigo)} · ${fechaTxt(r.fecha)}</div><h1>${r.estado === 'liquidada' ? 'Ruta liquidada' : 'Lo que debes entregar'}</h1></div>`;
  if (t.pendiente && r.estado !== 'liquidada') h += `<div class="banner warn"><div><b>Tienes ${t.pendiente} ${t.pendiente === 1 ? 'parada pendiente' : 'paradas pendientes'}.</b> Márcalas antes de llegar a la oficina, aunque sea como "No visitado".</div></div>`;
  if (liq) h += `<div class="banner ${liq.diferencia < 0 ? 'bad' : 'ok'}"><div>Liquidada el ${fechaHora(liq.fecha)} por ${esc(liq.recibidoPor)}. Diferencia en efectivo: <b>${liq.diferencia === 0 ? 'ninguna' : (liq.diferencia < 0 ? 'faltante ' : 'sobrante ') + fmt(Math.abs(liq.diferencia))}</b>.</div></div>`;
  h += `<div class="kpis">
    <div class="kpi hl"><span class="l">Efectivo a entregar</span><span class="v">${fmt(t.efectivoEsperado)}</span></div>
    <div class="kpi"><span class="l">Transferencias</span><span class="v">${fmt(t.transferencia + t.carteraTr)}</span></div>
    <div class="kpi"><span class="l">Crédito</span><span class="v">${fmt(t.credito)}</span></div>
    <div class="kpi"><span class="l">Devolución</span><span class="v">${fmt(t.vDevGest)}</span></div>
  </div>
  <div class="card"><h3>Cómo se calcula el efectivo</h3>
    ${t.base ? `<div class="sum-line"><span class="muted">Base entregada al salir</span><span>${fmt(t.base)}</span></div>` : ''}
    <div class="sum-line"><span class="muted">Efectivo de entregas</span><span>${fmt(t.efectivo)}</span></div>
    <div class="sum-line"><span class="muted">Efectivo de cartera</span><span>${fmt(t.carteraEf)}</span></div>
    <div class="sum-line"><span class="muted">Menos gastos de ruta</span><span>− ${fmt(t.gastos)}</span></div>
    <div class="sum-line big"><span>Total</span><span>${fmt(t.efectivoEsperado)}</span></div>
  </div>
  <div class="card"><h3>Mercancía de devolución</h3>
    ${t.devoluciones.length ? `<div class="tablewrap"><table><thead><tr><th>Producto</th><th class="r">Unid.</th><th class="r">Valor</th></tr></thead><tbody>${t.devoluciones.map(x => `<tr><td>${esc(x.producto)}${x.sinGestion ? `<div class="small" style="color:var(--warn)">${x.sinGestion} sin gestionar (parada pendiente)</div>` : ''}</td><td class="r num">${x.cant}</td><td class="r num">${fmt(x.valor)}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty small">No hay devolución.</div>`}
  </div>
  <div class="row"><button class="btn" data-act="pdf">Descargar planilla PDF</button>${puedeCompartir() ? `<button class="btn" data-act="pdfShare">Compartir planilla</button>` : ''}</div>`;
  return h;
}

// ---------- oficina ----------
function vOficina() {
  const T = [['rutas', 'Rutas'], ['nueva', 'Nueva ruta'], ['conductores', 'Conductores'], ['reportes', 'Reportes'], ['ajustes', 'Ajustes']];
  const nav = `<div class="otabs">${T.map(([k, l]) => `<button class="otab ${S.view === k || (k === 'rutas' && ['ruta', 'liquidar'].includes(S.view)) ? 'on' : ''}" data-act="oview" data-v="${k}">${l}</button>`).join('')}</div>`;
  let body;
  switch (S.view) {
    case 'nueva': body = vNueva(); break;
    case 'ruta': body = vRutaOficina(); break;
    case 'liquidar': body = vLiquidar(); break;
    case 'reportes': body = vReportes(); break;
    case 'conductores': body = vConductores(); break;
    case 'ajustes': body = vAjustes(); break;
    default: S.view = 'rutas'; body = vRutas();
  }
  return nav + body;
}
function vRutas() {
  if (!S.rutasReady) return `<div class="empty">Cargando rutas…</div>`;
  const abiertas = S.rutas.filter(r => r.estado !== 'liquidada').length;
  return `<div class="row between"><div><div class="eyebrow">${abiertas} abiertas · ${S.rutas.length - abiertas} liquidadas</div><h1>Rutas</h1></div><button class="btn primary" data-act="oview" data-v="nueva">+ Nueva ruta</button></div>
  ${S.rutas.length ? `<div class="tablewrap"><table>
    <thead><tr><th>Ruta</th><th>Fecha</th><th>Conductor</th><th class="hide-sm">Vehículo</th><th class="r">Paradas</th><th class="r hide-sm">Valor</th><th>Estado</th></tr></thead>
    <tbody>${S.rutas.map(r => `<tr style="cursor:pointer" data-act="verRuta" data-v="${esc(r.id)}">
      <td class="mono">${esc(r.codigo)}${r.creadaPorConductor ? ' <span class="pill">Del conductor</span>' : ''}</td><td>${fechaTxt(r.fecha)}</td><td>${esc(r.conductor)}</td><td class="hide-sm">${esc(r.vehiculo || '')}</td>
      <td class="r num">${r.nParadas || 0}</td><td class="r num hide-sm">${fmt(r.total)}</td><td>${rchip(r.estado)}</td></tr>`).join('')}</tbody></table></div>`
      : `<div class="empty">Aún no hay rutas. Crea la primera desde un PDF de la empresa o pegando el listado desde Excel.</div>`}`;
}
function vRutaOficina() {
  const r = ruta(); if (!r) return `<div class="empty">Cargando la ruta… <button class="btn sm" data-act="oview" data-v="rutas">Volver a rutas</button></div>`;
  const t = totales(r, S.paradas), del = S.confirmDel === r.id;
  let h = `<div class="row between"><div><div class="eyebrow">${fechaTxt(r.fecha)} · ${esc(r.vehiculo || '')} · ${esc(r.remitente || '')}</div><h1>${esc(r.codigo)} · ${esc(r.conductor)}</h1></div>${rchip(r.estado)}</div>`;
  h += `<div class="kpis">
    <div class="kpi"><span class="l">Avance</span><span class="v">${t.gestionadas}/${t.n}</span></div>
    <div class="kpi"><span class="l">Entregado</span><span class="v">${fmt(t.vEntregado)}</span></div>
    <div class="kpi"><span class="l">Efectivo esperado</span><span class="v">${fmt(t.efectivoEsperado)}</span></div>
    <div class="kpi"><span class="l">Transferencias</span><span class="v">${fmt(t.transferencia + t.carteraTr)}</span></div>
    <div class="kpi"><span class="l">Devolución</span><span class="v">${fmt(t.vDevGest)}</span></div>
  </div>`;
  if (r.creadaPorConductor) h += `<div class="banner info"><div class="row between" style="width:100%"><span>Ruta creada por el conductor desde la planilla${(r.planillaFotos || []).length ? '. Compara la lista con la foto' : ''}.</span>${(r.planillaFotos || []).length ? `<button class="btn sm" data-act="verFotos" data-v="${esc(r.planillaFotos.join(','))}">Ver foto de la planilla</button>` : ''}</div></div>`;
  h += `<div class="banner ${r.cargue && r.cargue.confirmado ? 'ok' : 'warn'}"><div>${r.cargue && r.cargue.confirmado ? `Cargue confirmado por el conductor el ${fechaHora(r.cargue.hora)}.${r.cargue.novedad ? ` <b>Novedad:</b> ${esc(r.cargue.novedad)}` : ''}` : 'El conductor aún no ha confirmado el cargue.'}</div></div>`;
  {
    const start = parseDir(r.bodega), esq = esquema(S.paradas, start, r.regreso);
    const pendN = S.paradas.filter(p => !p.estado || p.estado === 'pendiente').length;
    h += `<div class="card"><div class="row between"><h3>Recorrido</h3><span class="small muted">${esc(ciudadDe(r))}${r.bodega ? ' · Sale de ' + esc(r.bodega) : ''} · ${kmTxt(costoParadas(S.paradas, start, r.regreso))}</span></div>
      ${esq || '<div class="small muted">No hay suficientes direcciones reconocidas para dibujar el recorrido.</div>'}
      ${r.estado !== 'liquidada' && pendN > 2 ? `<div class="row"><button class="btn sm" data-act="reoptimizar">Optimizar orden de las ${pendN} paradas pendientes</button></div>` : ''}</div>`;
  }
  h += `<div class="card"><div class="row between"><h3>Paradas</h3><span class="small muted">Se actualiza en vivo</span></div>
  <div class="tablewrap"><table><thead><tr><th>#</th><th>Cliente</th><th>Factura</th><th>Estado</th><th class="r">Factura</th><th class="r">Entregado</th><th class="r hide-sm">Efectivo</th><th class="r hide-sm">Transf.</th><th class="r hide-sm">Crédito</th><th>Detalle</th></tr></thead>
  <tbody>${S.paradas.map(p => {
    const e = p.estado || 'pendiente', g = p.pago || {}; return `<tr>
    <td class="num">${p.orden}</td><td>${esc(p.cliente)}<div class="small muted">${esc(p.direccion || '')}</div></td><td class="mono">${esc(p.factura || '')}</td><td>${chip(e)}</td>
    <td class="r num">${fmt(valorFactura(p))}</td><td class="r num">${e === 'pendiente' ? '—' : fmt(valorEntregado(p))}</td>
    <td class="r num hide-sm">${e === 'pendiente' ? '' : fmt(g.efectivo)}</td><td class="r num hide-sm">${e === 'pendiente' ? '' : fmt(g.transferencia)}${g.transferencia ? `<div class="mono muted">${esc(p.refTransf || '')}</div>` : ''}</td><td class="r num hide-sm">${e === 'pendiente' ? '' : fmt(g.credito)}</td>
    <td class="small">${p.hora ? hora(p.hora) + ' · ' : ''}${esc(p.motivo || '')}${p.recibe ? ` Recibió ${esc(p.recibe)}` : ''}${p.novedad ? `<div style="color:var(--warn)">${esc(p.novedad)}</div>` : ''}
      <div class="row" style="gap:4px;margin-top:4px">${(p.fotos || []).length ? `<button class="btn sm ghost" data-act="verFotos" data-v="${esc(p.fotos.join(','))}">Fotos (${p.fotos.length})</button>` : ''}${p.firma ? `<button class="btn sm ghost" data-act="verFirma" data-v="${esc(p.id)}">Firma</button>` : ''}${p.gps ? `<a class="btn sm ghost" href="https://www.google.com/maps?q=${p.gps.lat},${p.gps.lng}" target="_blank" rel="noopener">Ubicación</a>` : ''}</div></td></tr>`;
  }).join('') || `<tr><td colspan="10" class="muted">${S.paradasReady ? 'Sin paradas.' : 'Cargando…'}</td></tr>`}</tbody></table></div></div>`;
  if ((r.gastos || []).length || (r.cartera || []).length) {
    h += `<div class="grid2">
      <div class="card"><h3>Gastos (${fmt(t.gastos)})</h3>${(r.gastos || []).map(g => `<div class="sum-line small"><span>${esc(g.concepto)} <span class="muted">${esc(g.nota || '')}</span>${g.foto ? ` <button class="btn sm ghost" data-act="verFotos" data-v="${esc(g.foto)}">Recibo</button>` : ''}</span><span>${fmt(g.valor)}</span></div>`).join('') || '<span class="muted small">Sin gastos.</span>'}</div>
      <div class="card"><h3>Cartera (${fmt(t.carteraEf + t.carteraTr)})</h3>${(r.cartera || []).map(c => `<div class="sum-line small"><span>${esc(c.cliente)} <span class="mono muted">${esc(c.factura || '')} · ${c.forma}</span></span><span>${fmt(c.valor)}</span></div>`).join('') || '<span class="muted small">Sin cobros.</span>'}</div>
    </div>`;
  }
  if (r.estado === 'liquidada') h += vLiqResumen(r);
  h += `<div class="row">
    ${r.estado !== 'liquidada' ? `<button class="btn primary" data-act="irLiquidar">Liquidar ruta</button>` : ''}
    <button class="btn" data-act="pdf">Planilla PDF</button>
    <button class="btn" data-act="csv">Exportar a Excel (CSV)</button>
    <span style="flex:1"></span>
    ${del ? `<span class="small err">Se borrarán la ruta, sus ${S.paradas.length} paradas y las fotos.</span><button class="btn danger solid sm" data-act="borrarRuta">Sí, eliminar</button><button class="btn sm" data-act="cancelDel">Cancelar</button>`
      : `<button class="btn danger sm" data-act="pedirDel">Eliminar ruta</button>`}
  </div>`;
  return h;
}
function vLiqResumen(r) {
  const l = r.liquidacion; if (!l) return '';
  const difD = (l.devoluciones || []).filter(x => x.contado !== x.esperado);
  return `<div class="card"><div class="row between"><h3>Liquidación</h3><span class="small muted">${fechaHora(l.fecha)}</span></div>
    <div class="grid3">
      <div class="sum-line"><span class="muted">Esperado</span><b>${fmt(l.esperado)}</b></div>
      <div class="sum-line"><span class="muted">Contado</span><b>${fmt(l.contado)}</b></div>
      <div class="sum-line"><span class="muted">Diferencia</span><b style="color:${l.diferencia < 0 ? 'var(--bad)' : l.diferencia > 0 ? 'var(--warn)' : 'var(--accent)'}">${l.diferencia === 0 ? 'Cuadra' : (l.diferencia < 0 ? 'Faltante ' : 'Sobrante ') + fmt(Math.abs(l.diferencia))}</b></div>
    </div>
    <div class="small">Entregó <b>${esc(l.entregadoPor)}</b> · Recibió <b>${esc(l.recibidoPor)}</b>${l.transfVerificadas ? ' · Transferencias verificadas en banco' : ''}</div>
    ${difD.length ? `<div class="banner warn"><div><b>Diferencias en devolución:</b> ${difD.map(x => `${esc(x.producto)} (esperado ${x.esperado}, llegó ${x.contado})`).join('; ')}</div></div>` : `<div class="small muted">La mercancía devuelta coincide con lo esperado.</div>`}
    ${l.observaciones ? `<div class="small"><b>Observaciones:</b> ${esc(l.observaciones)}</div>` : ''}
  </div>`;
}

// ---- liquidación ----
function irLiquidar() {
  const r = ruta(), t = totales(r, S.paradas);
  S.liq = { billetes: {}, monedas: 0, devol: Object.fromEntries(t.devoluciones.map(x => [x.ref + '|' + x.producto, x.cant])), entregadoPor: r.conductor || '', recibidoPor: S.perfil.nombre || '', observaciones: '', transfVerificadas: false, firmaEntrega: '', firmaRecibe: '', err: '' };
  S.view = 'liquidar'; render(); window.scrollTo(0, 0);
}
function vLiquidar() {
  const r = ruta(), L = S.liq; if (!r || !L) { S.view = 'rutas'; return vRutas(); }
  const t = totales(r, S.paradas);
  return `<div class="row between"><div><div class="eyebrow">${esc(r.codigo)} · ${esc(r.conductor)}</div><h1>Liquidación de ruta</h1></div><button class="btn sm" data-act="verRuta" data-v="${esc(r.id)}">← Volver a la ruta</button></div>
  ${t.pendiente ? `<div class="banner bad"><div><b>Hay ${t.pendiente} paradas pendientes.</b> El conductor debe marcarlas (entregado, rechazado o no visitado) antes de cerrar la liquidación.</div></div>` : ''}
  ${S.pendientes.paradas || S.pendientes.rutas ? `<div class="banner warn"><div>Hay cambios del conductor que todavía se están sincronizando. Espera a que diga "En línea" antes de cerrar.</div></div>` : ''}
  <div class="grid2">
    <div class="card">
      <h3>1. Conteo de efectivo</h3>
      <div class="denom small muted"><span>Denominación</span><span>Cantidad</span><span class="tot">Subtotal</span></div>
      ${DENOM.map(d => `<div class="denom"><span>${fmt(d)}</span><input type="text" inputmode="numeric" class="qty" id="l-b${d}" data-l="b" data-v="${d}" value="${L.billetes[d] || ''}" placeholder="0" aria-label="Billetes de ${fmt(d)}"><span class="tot" id="lt-${d}">${fmt((L.billetes[d] || 0) * d)}</span></div>`).join('')}
      <div class="denom"><span>Monedas (total)</span><input type="text" inputmode="numeric" class="qty" id="l-mon" data-l="monedas" value="${L.monedas || ''}" placeholder="0"><span class="tot" id="lt-mon">${fmt(L.monedas)}</span></div>
    </div>
    <div class="card">
      <h3>2. Cuadre</h3>
      ${t.base ? `<div class="sum-line"><span class="muted">Base</span><span>${fmt(t.base)}</span></div>` : ''}
      <div class="sum-line"><span class="muted">Efectivo de entregas</span><span>${fmt(t.efectivo)}</span></div>
      <div class="sum-line"><span class="muted">Efectivo de cartera</span><span>${fmt(t.carteraEf)}</span></div>
      <div class="sum-line"><span class="muted">Gastos de ruta</span><span>− ${fmt(t.gastos)}</span></div>
      <div class="sum-line big"><span>Esperado</span><span>${fmt(t.efectivoEsperado)}</span></div>
      <div class="sum-line big"><span>Contado</span><span id="l-contado">$0</span></div>
      <div id="l-dif"></div>
      <hr style="border:0;border-top:1px solid var(--line);width:100%">
      <div class="sum-line"><span class="muted">Transferencias (ventas + cartera)</span><b>${fmt(t.transferencia + t.carteraTr)}</b></div>
      <label class="row small"><input type="checkbox" id="l-tv" data-l="tv" ${L.transfVerificadas ? 'checked' : ''}> Verifiqué las transferencias en el banco</label>
      <div class="sum-line"><span class="muted">Ventas a crédito</span><b>${fmt(t.credito)}</b></div>
    </div>
  </div>
  <div class="card">
    <h3>3. Mercancía devuelta</h3>
    <p class="small muted">Cuenta físicamente lo que trajo el conductor. Si no coincide, queda registrado en la liquidación.</p>
    ${t.devoluciones.length ? `<div class="tablewrap"><table><thead><tr><th>Producto</th><th class="r">Esperado</th><th class="r">Llegó</th><th class="r">Diferencia</th></tr></thead>
    <tbody>${t.devoluciones.map(x => { const k = x.ref + '|' + x.producto; return `<tr><td>${esc(x.producto)}<div class="mono muted">${esc(x.ref || '')}</div></td><td class="r num">${x.cant}</td>
      <td class="r"><input type="text" inputmode="numeric" class="qty" id="l-d-${esc(k)}" data-l="d" data-v="${esc(k)}" value="${L.devol[k] ?? x.cant}"></td><td class="r num" id="ld-${esc(k)}">0</td></tr>`; }).join('')}</tbody></table></div>`
      : `<div class="empty small">No hay devolución en esta ruta.</div>`}
  </div>
  <div class="card">
    <h3>4. Firmas</h3>
    <div class="grid2">
      <div class="sig"><label class="f">Entrega (conductor)<input type="text" id="l-ep" data-l="ep" value="${esc(L.entregadoPor)}"></label>
        <div class="row between small"><span class="muted">Firma del conductor</span><button class="btn sm ghost" data-act="borrarFirma" data-v="firmaEntrega">Borrar</button></div>
        <canvas data-firma="firmaEntrega" data-target="liq"></canvas></div>
      <div class="sig"><label class="f">Recibe (oficina)<input type="text" id="l-rp" data-l="rp" value="${esc(L.recibidoPor)}"></label>
        <div class="row between small"><span class="muted">Firma de quien recibe</span><button class="btn sm ghost" data-act="borrarFirma" data-v="firmaRecibe">Borrar</button></div>
        <canvas data-firma="firmaRecibe" data-target="liq"></canvas></div>
    </div>
    <label class="f">Observaciones<textarea id="l-obs" data-l="obs">${esc(L.observaciones)}</textarea></label>
  </div>
  <div class="err" id="liqErr">${esc(L.err)}</div>
  <button class="btn primary block" data-act="cerrarLiq" ${t.pendiente ? 'disabled' : ''}>Cerrar liquidación</button>`;
}
function contadoLiq() { const L = S.liq; return DENOM.reduce((a, d) => a + int(L.billetes[d]) * d, 0) + int(L.monedas); }
function updateLiq() {
  const r = ruta(), L = S.liq; if (!r || !L) return;
  const t = totales(r, S.paradas);
  DENOM.forEach(d => { const el = document.getElementById('lt-' + d); if (el) el.textContent = fmt(int(L.billetes[d]) * d); });
  const m = document.getElementById('lt-mon'); if (m) m.textContent = fmt(L.monedas);
  const c = contadoLiq(), x = c - t.efectivoEsperado;
  const ct = document.getElementById('l-contado'); if (ct) ct.textContent = fmt(c);
  const dif = document.getElementById('l-dif');
  if (dif) dif.innerHTML = x === 0 ? `<div class="banner ok"><div><b>El efectivo cuadra.</b></div></div>` : `<div class="banner ${x < 0 ? 'bad' : 'warn'}"><div><b>${x < 0 ? 'Faltante' : 'Sobrante'}: ${fmt(Math.abs(x))}</b></div></div>`;
  t.devoluciones.forEach(dv => { const k = dv.ref + '|' + dv.producto; const el = document.getElementById('ld-' + k); if (el) { const diff = int(L.devol[k] ?? dv.cant) - dv.cant; el.textContent = diff === 0 ? '0' : (diff > 0 ? '+' : '') + diff; el.style.color = diff ? 'var(--bad)' : ''; } });
}
async function cerrarLiq() {
  const r = ruta(), L = S.liq, t = totales(r, S.paradas);
  let err = '';
  if (t.pendiente) err = 'Hay paradas pendientes.';
  else if (!String(L.recibidoPor).trim()) err = 'Escribe el nombre de quien recibe en oficina.';
  else if (!String(L.entregadoPor).trim()) err = 'Escribe el nombre del conductor que entrega.';
  else if (!L.firmaRecibe || !L.firmaEntrega) err = 'Faltan las dos firmas.';
  if (err) { L.err = err; document.getElementById('liqErr').textContent = err; return; }
  const contado = contadoLiq();
  const liquidacion = {
    fecha: new Date().toISOString(), esperado: t.efectivoEsperado, contado, diferencia: contado - t.efectivoEsperado,
    billetes: Object.fromEntries(DENOM.map(d => [String(d), int(L.billetes[d])])), monedas: int(L.monedas),
    transferencias: t.transferencia + t.carteraTr, transfVerificadas: !!L.transfVerificadas, credito: t.credito, gastos: t.gastos,
    devoluciones: t.devoluciones.map(x => ({ ref: x.ref || '', producto: x.producto, esperado: x.cant, contado: int(L.devol[x.ref + '|' + x.producto] ?? x.cant), valor: x.valor })),
    entregadoPor: L.entregadoPor.trim(), recibidoPor: L.recibidoPor.trim(), observaciones: L.observaciones.trim(),
    firmaEntrega: L.firmaEntrega, firmaRecibe: L.firmaRecibe, liquidadoPorUid: S.user.uid
  };
  const btn = document.querySelector('[data-act="cerrarLiq"]'); if (btn) { btn.disabled = true; btn.textContent = 'Cerrando…'; }
  await w(fb.updateDoc(D('rutas/' + r.id), { estado: 'liquidada', abierta: false, liquidacion }));
  S.liq = null; S.view = 'ruta'; toast('Liquidación cerrada.'); render(); window.scrollTo(0, 0);
}

// ---- nueva ruta ----
const ENCABEZADOS = 'Cliente\tDirección\tTeléfono\tFactura\tReferencia\tProducto\tCantidad\tPrecio unitario';
function conductoresActivos() { return S.usuarios.filter(u => u.rol === 'conductor' && u.activo); }
function nuevaBase() {
  const cod = (S.mode === 'conductor' ? 'C' : 'R') + '-' + hoy().replace(/-/g, '') + '-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  return { codigo: cod, fecha: hoy(), conductorUid: S.mode === 'conductor' ? S.user.uid : '', vehiculo: S.mode === 'conductor' ? (S.perfil.placa || '') : '', remitente: S.mode === 'conductor' ? '' : (S.config.empresa || ''), base: '', ciudad: S.config.ciudad || 'Barranquilla', bodega: S.config.bodega || '', regreso: true, texto: '', err: '', orden: null, modo: 'opt', _key: '', fotosPlanilla: [] };
}
function bloqueListado(N) {
  const cond = S.mode === 'conductor';
  return `<div class="card">
    <div class="row between"><h3>${cond ? '1. Planilla' : 'Listado de clientes y mercancía'}</h3><div class="row">
      <label class="btn sm primary">Tomar foto de la planilla<input type="file" id="n-cam" accept="image/*" capture="environment" hidden></label>
      <label class="btn sm">Subir PDF o fotos<input type="file" id="n-file" accept="application/pdf,.pdf,image/*" multiple hidden></label>
      ${cond ? '' : '<button class="btn sm ghost" data-act="copiarEnc">Copiar encabezados</button>'}</div></div>
    <div id="impStatus"></div>
    <details class="small muted"><summary>Consejos para la foto</summary>
      Una foto por página, con la hoja plana y completa dentro de la foto. Buena luz, sin sombras ni reflejos, y el celular derecho sobre la hoja. Si la planilla tiene varias páginas, elige todas las fotos juntas en "Subir PDF o fotos".</details>
    ${cond ? `<details class="small"><summary>Ver o pegar el listado como texto</summary>` : `<p class="small muted">Toma una foto de la planilla, importa el PDF que entrega la empresa, o copia las filas desde Excel y pégalas aquí. Una fila por producto, en este orden: <span class="mono">Cliente · Dirección · Teléfono · Factura · Referencia · Producto · Cantidad · Precio unitario</span>. Las filas con la misma factura se agrupan en una sola parada y la app las ordena para recorrer menos distancia.</p>`}
    <textarea id="n-texto" data-n="texto" style="min-height:160px;font-family:var(--f-mono);font-size:13px" placeholder="Pega aquí las filas copiadas de Excel">${esc(N.texto)}</textarea>
    ${cond ? '</details>' : ''}
    <div id="preview"></div>
  </div>`;
}
function vNueva() {
  const N = S.nueva || (S.nueva = nuevaBase());
  if (S.mode === 'conductor') {
    return `<div class="row between"><button class="btn sm ghost" data-act="cancelarNueva">← Volver</button><span class="eyebrow">${esc(S.perfil.nombre)}</span></div>
    <div style="display:flex;flex-direction:column;gap:6px"><h1>Crear mi ruta desde la planilla</h1>
    <p class="small muted">Tómale una foto a la planilla que te entregaron en la bodega. La app arma la lista de clientes, la ordena por cercanía y la oficina la ve al instante.</p></div>
    ${bloqueListado(N)}
    <div class="card"><h3>2. Datos de la ruta</h3><div class="grid2">
      <label class="f">Vehículo / placa<input type="text" id="n-vehiculo" data-n="vehiculo" value="${esc(N.vehiculo)}"></label>
      <label class="f">Empresa que despacha<input type="text" id="n-remitente" data-n="remitente" value="${esc(N.remitente)}" placeholder="Ej: Distribuidora La Costa"></label>
      <label class="f">Base en efectivo que te dieron<input type="text" inputmode="numeric" id="n-base" data-n="base" value="${esc(N.base)}" placeholder="0"></label>
      <label class="f">Punto de partida (bodega)<input type="text" id="n-bodega" data-n="bodega" value="${esc(N.bodega)}" placeholder="Ej: Cl 30 #44-50"></label>
    </div>
    <label class="row small"><input type="checkbox" id="n-regreso" data-n="regreso" ${N.regreso ? 'checked' : ''}> Regreso a la bodega al terminar</label></div>
    <div class="err" id="nErr">${esc(N.err)}</div>
    <button class="btn primary block" data-act="crearRuta">Crear mi ruta</button>`;
  }
  const cs = conductoresActivos();
  return `<div><div class="eyebrow">Oficina</div><h1>Nueva ruta</h1></div>
  ${S.usuariosReady && !cs.length ? `<div class="banner warn"><div>No hay conductores activos. Créalos en la pestaña <b>Conductores</b> antes de crear la ruta.</div></div>` : ''}
  <div class="card"><div class="grid3">
    <label class="f">Código de ruta<input type="text" id="n-codigo" data-n="codigo" value="${esc(N.codigo)}"></label>
    <label class="f">Fecha<input type="date" id="n-fecha" data-n="fecha" value="${esc(N.fecha)}"></label>
    <label class="f">Conductor<select id="n-conductor" data-n="conductorUid"><option value="">Elige el conductor…</option>${cs.map(u => `<option value="${esc(u.uid)}" ${N.conductorUid === u.uid ? 'selected' : ''}>${esc(u.nombre)}${u.placa ? ' · ' + esc(u.placa) : ''}</option>`).join('')}</select></label>
    <label class="f">Vehículo / placa<input type="text" id="n-vehiculo" data-n="vehiculo" value="${esc(N.vehiculo)}"></label>
    <label class="f">Empresa que despacha<input type="text" id="n-remitente" data-n="remitente" value="${esc(N.remitente)}"></label>
    <label class="f">Base en efectivo (para cambio)<input type="text" inputmode="numeric" id="n-base" data-n="base" value="${esc(N.base)}" placeholder="0"></label>
    <label class="f">Ciudad<input type="text" id="n-ciudad" data-n="ciudad" value="${esc(N.ciudad)}"></label>
    <label class="f">Punto de partida (bodega)<input type="text" id="n-bodega" data-n="bodega" value="${esc(N.bodega)}" placeholder="Ej: Cl 30 #44-50"></label>
  </div>
  <label class="row small"><input type="checkbox" id="n-regreso" data-n="regreso" ${N.regreso ? 'checked' : ''}> El vehículo regresa a la bodega al terminar</label>
  </div>
  ${bloqueListado(N)}
  <div class="err" id="nErr">${esc(N.err)}</div>
  <button class="btn primary block" data-act="crearRuta">Crear ruta</button>`;
}
function parsePlanilla(txt) {
  const lines = String(txt || '').split(/\r?\n/).filter(l => l.trim());
  const errs = [], grupos = new Map();
  lines.forEach((l, i) => {
    const c = (l.includes('\t') ? l.split('\t') : l.split(';')).map(x => x.trim());
    if (i === 0 && /cliente/i.test(c[0])) return;
    if (c.length < 8) { errs.push(`Fila ${i + 1}: tiene ${c.length} columnas y se esperan 8.`); return; }
    const [cliente, direccion, telefono, factura, ref, producto, cant, precio] = c;
    const q = int(cant), pr = int(precio);
    if (!cliente || !producto || !q) { errs.push(`Fila ${i + 1}: falta cliente, producto o cantidad.`); return; }
    const key = (factura || cliente).toUpperCase();
    if (!grupos.has(key)) grupos.set(key, { cliente, direccion, telefono, factura, items: [] });
    grupos.get(key).items.push({ ref, producto, cant: q, precio: pr });
  });
  return { paradas: [...grupos.values()].map((g, k) => Object.assign(g, { orden: k + 1 })), errs };
}
function serializar(paradas) {
  const lim = v => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
  return ENCABEZADOS + '\n' + paradas.flatMap(p => p.items.map(i => [p.cliente, p.direccion, p.telefono, p.factura, i.ref, i.producto, int(i.cant), int(i.precio)].map(lim).join('\t'))).join('\n');
}
function vEditarParada(idx) {
  const p = parsePlanilla(S.nueva.texto).paradas[idx]; if (!p) return '';
  return `<div class="modal-in"><div class="row between"><h2>Revisar cliente</h2><button class="btn sm" data-act="cerrarModal">Cancelar</button></div>
    <p class="small muted">Compara con la planilla y corrige lo que haga falta.</p>
    <div class="grid2">
      <label class="f">Cliente<input type="text" id="e-cliente" value="${esc(p.cliente)}"></label>
      <label class="f">Factura<input type="text" id="e-factura" value="${esc(p.factura)}"></label>
      <label class="f">Dirección<input type="text" id="e-direccion" value="${esc(p.direccion)}"></label>
      <label class="f">Teléfono<input type="text" inputmode="tel" id="e-telefono" value="${esc(p.telefono)}"></label>
    </div>
    <h3>Productos</h3>
    <div id="e-items" style="display:flex;flex-direction:column;gap:8px">${p.items.map((it, k) => filaItem(it, k)).join('')}</div>
    <button class="btn sm" data-act="eAgregarItem" style="align-self:flex-start">+ Agregar producto</button>
    <div class="err" id="eErr"></div>
    <div class="row between"><button class="btn danger sm" data-act="eEliminar" data-v="${idx}">Quitar este cliente</button><button class="btn primary" data-act="eGuardar" data-v="${idx}">Guardar cambios</button></div>
  </div>`;
}
function filaItem(it, k) {
  return `<div class="e-item" style="display:grid;grid-template-columns:1fr 70px 100px 34px;gap:6px;align-items:end">
    <label class="f">Producto${k === 0 ? '' : ''}<input type="text" class="e-prod" value="${esc((it.ref ? it.ref + ' · ' : '') + it.producto)}"></label>
    <label class="f">Cant.<input type="text" inputmode="numeric" class="e-cant" value="${int(it.cant) || ''}"></label>
    <label class="f">Precio unit.<input type="text" inputmode="numeric" class="e-precio" value="${int(it.precio) || ''}"></label>
    <button class="btn sm ghost" data-act="eQuitarItem" aria-label="Quitar producto" style="padding:8px">✕</button></div>`;
}
function guardarEdicion(idx) {
  const { paradas } = parsePlanilla(S.nueva.texto); const p = paradas[idx]; if (!p) return;
  const v = id => document.getElementById(id).value.trim();
  const items = [...document.querySelectorAll('#e-items .e-item')].map(row => {
    const t = row.querySelector('.e-prod').value.trim(); const m = t.match(/^(\S+)\s·\s(.+)$/);
    return { ref: m ? m[1] : '', producto: m ? m[2] : t, cant: int(row.querySelector('.e-cant').value), precio: int(row.querySelector('.e-precio').value) };
  }).filter(i => i.producto || i.cant);
  const err = document.getElementById('eErr');
  if (!v('e-cliente')) { err.textContent = 'Escribe el nombre del cliente.'; return; }
  if (!items.length) { err.textContent = 'El cliente debe tener al menos un producto, o quítalo.'; return; }
  if (items.some(i => !i.producto || !i.cant)) { err.textContent = 'Cada producto necesita nombre y cantidad.'; return; }
  const factura = v('e-factura');
  if (factura && paradas.some((x, k) => k !== idx && (x.factura || '').toUpperCase() === factura.toUpperCase())) { err.textContent = 'Otro cliente ya tiene esa factura.'; return; }
  Object.assign(p, { cliente: v('e-cliente'), factura, direccion: v('e-direccion'), telefono: v('e-telefono'), items });
  conservarOrden(paradas, null);
  cerrarModal(); toast('Cambios guardados.');
}
function conservarOrden(paradas, quitar) {
  const N = S.nueva;
  const ordenActual = (N.orden && N.orden.length === paradas.length + (quitar != null ? 0 : 0)) ? N.orden.slice() : paradas.map((p, i) => i);
  let lista = paradas;
  let orden = ordenActual;
  if (quitar != null) { lista = paradas.filter((p, i) => i !== quitar); orden = ordenActual.filter(i => i !== quitar).map(i => i > quitar ? i - 1 : i); }
  N.texto = serializar(lista);
  const ta = document.getElementById('n-texto'); if (ta) ta.value = N.texto;
  N.orden = orden; N._key = N.texto + '|' + N.bodega + '|' + N.regreso;
  updatePreview();
}
function updatePreview() {
  const el = document.getElementById('preview'); if (!el || !S.nueva) return;
  const { paradas, errs } = parsePlanilla(S.nueva.texto);
  if (!paradas.length && !errs.length) { el.innerHTML = ''; return; }
  const total = paradas.reduce((a, p) => a + valorFactura(p), 0);
  const N = S.nueva, start = parseDir(N.bodega), key = N.texto + '|' + N.bodega + '|' + N.regreso;
  if (N._key !== key || !N.orden || N.orden.length !== paradas.length) {
    N._key = key; if (N.modo === 'manual') N.modo = 'opt';
    N.orden = N.modo === 'opt' ? optimizar(paradas.map((p, i) => ({ i, u: parseDir(p.direccion) })), start, N.regreso) : paradas.map((p, i) => i);
  }
  const ord = N.orden.map(i => paradas[i]);
  const cLista = costoParadas(paradas, start, N.regreso), cOrd = costoParadas(ord, start, N.regreso);
  const noRec = paradas.filter(p => !parseDir(p.direccion)).length;
  const bloque = `<div class="card" style="padding:12px;gap:10px">
    <div class="row between"><h3>Orden del recorrido</h3><div class="row">
      <button class="btn sm ${N.modo === 'opt' ? 'primary' : ''}" data-act="nOptimizar">Optimizar por cercanía</button>
      <button class="btn sm ${N.modo === 'lista' ? 'primary' : ''}" data-act="nLista">Orden del listado</button></div></div>
    <div class="grid3 small">
      <div class="sum-line"><span class="muted">Recorrido estimado</span><b>${kmTxt(cOrd)}</b></div>
      <div class="sum-line"><span class="muted">En el orden del listado</span><b>${kmTxt(cLista)}</b></div>
      <div class="sum-line"><span class="muted">Ahorro</span><b style="color:var(--accent)">${cLista - cOrd > 0.5 ? kmTxt(cLista - cOrd) : '—'}</b></div>
    </div>
    ${!start ? `<div class="banner info"><div>Escribe el punto de partida para que el recorrido empiece desde la bodega.${N.bodega ? ' No reconocí esa dirección.' : ''}</div></div>` : ''}
    ${noRec ? `<div class="banner warn"><div><b>${noRec} ${noRec === 1 ? 'dirección no reconocida' : 'direcciones no reconocidas'}.</b> Quedan al final; súbelas a mano al lugar que corresponda.</div></div>` : ''}
    ${esquema(ord.map((p, k) => ({ direccion: p.direccion, orden: k + 1 })), start, N.regreso)}
    <div class="tablewrap"><table><thead><tr><th>#</th><th>Cliente</th><th>Dirección</th><th class="r hide-sm">Productos</th><th class="r">Valor</th><th>Mover</th><th></th></tr></thead>
    <tbody>${N.orden.map((i, k) => { const p = paradas[i], u = parseDir(p.direccion); return `<tr><td class="num">${k + 1}</td><td>${esc(p.cliente)}<div class="mono muted">${esc(p.factura)}</div></td>
      <td>${esc(p.direccion)}<div class="small ${u ? 'muted hide-sm' : 'nodir'}">${u ? lblDir(u) : 'No reconocida'}</div></td><td class="r num hide-sm">${p.items.length}</td><td class="r num">${fmt(valorFactura(p))}</td>
      <td><div class="ord"><button class="btn sm" data-act="nMover" data-v="${k},-1" ${k === 0 ? 'disabled' : ''} aria-label="Subir">↑</button><button class="btn sm" data-act="nMover" data-v="${k},1" ${k === N.orden.length - 1 ? 'disabled' : ''} aria-label="Bajar">↓</button></div></td><td><button class="btn sm" data-act="nEditar" data-v="${i}">Editar</button></td></tr>`; }).join('')}</tbody></table></div>
  </div>`;
  el.innerHTML = `${errs.length ? `<div class="banner bad"><div>${errs.slice(0, 5).map(esc).join('<br>')}${errs.length > 5 ? `<br>y ${errs.length - 5} errores más.` : ''}</div></div>` : ''}
  ${paradas.length ? `<div class="banner ok"><div><b>${paradas.length} paradas</b> · ${paradas.reduce((a, p) => a + p.items.length, 0)} líneas de producto · valor ${fmt(total)}</div></div>${bloque}` : ''}`;
}
async function crearRuta() {
  const N = S.nueva, parsed = parsePlanilla(N.texto), errs = parsed.errs;
  const paradas = (N.orden && N.orden.length === parsed.paradas.length ? N.orden.map(i => parsed.paradas[i]) : parsed.paradas).map((p, k) => Object.assign({}, p, { orden: k + 1 }));
  const errEl = document.getElementById('nErr');
  const fail = m => { N.err = m; errEl.textContent = m; };
  const id = N.codigo.trim().replace(/[^\w-]/g, '-');
  const porConductor = S.mode === 'conductor';
  const cond = porConductor ? { uid: S.user.uid, nombre: S.perfil.nombre, placa: S.perfil.placa || '' } : S.usuarios.find(u => u.uid === N.conductorUid);
  if (!id) return fail('Escribe el código de la ruta.');
  if (S.rutas.some(r => r.id === id)) return fail('Ya existe una ruta con ese código.');
  if (!cond) return fail('Elige el conductor.');
  if (!paradas.length) return fail(porConductor ? 'Toma la foto de la planilla primero.' : 'Importa el PDF o pega el listado de clientes.');
  if (errs.length) return fail('Corrige las filas con error antes de crear la ruta.');
  if (paradas.length > 450) return fail('Una ruta admite hasta 450 paradas.');
  const btn = document.querySelector('[data-act="crearRuta"]'); btn.disabled = true; btn.textContent = 'Creando ruta…';
  try {
    const fotosIds = (N.fotosPlanilla || []).map(() => nuevoId());
    const b = fb.writeBatch(S.db);
    b.set(D('rutas/' + id), {
      codigo: N.codigo.trim(), fecha: N.fecha, conductorUid: cond.uid, conductor: cond.nombre, vehiculo: N.vehiculo.trim() || cond.placa || '', remitente: N.remitente.trim(),
      base: int(N.base), ciudad: N.ciudad.trim() || 'Barranquilla', bodega: N.bodega.trim(), regreso: !!N.regreso,
      kmEstimado: +kmDe(costoParadas(paradas, parseDir(N.bodega), N.regreso)).toFixed(1),
      estado: 'cargue', abierta: true, creada: new Date().toISOString(), creadaPor: S.user.uid, creadaPorConductor: porConductor, planillaFotos: fotosIds, cargue: null, gastos: [], cartera: [], liquidacion: null,
      nParadas: paradas.length, total: paradas.reduce((a, p) => a + valorFactura(p), 0)
    });
    for (const p of paradas) b.set(D('rutas/' + id + '/paradas/p' + String(p.orden).padStart(3, '0')), Object.assign({ estado: 'pendiente' }, p));
    await w(b.commit());
    const ahora = new Date().toISOString();
    (N.fotosPlanilla || []).forEach((data, k) => w(fb.setDoc(D(`rutas/${id}/fotos/${fotosIds[k]}`), { paradaId: '', tipo: 'planilla', data, fecha: ahora, autorUid: S.user.uid })));
    S.nueva = null;
    if (porConductor) { toast('Ruta creada. Ahora confirma el cargue.'); S.rutaNueva = id; selectRuta(id, 'cargue'); }
    else { toast(`Ruta creada y asignada a ${cond.nombre}.`); selectRuta(id, 'ruta'); }
    window.scrollTo(0, 0);
  } catch (e) { btn.disabled = false; btn.textContent = 'Crear ruta'; fail('No se pudo crear la ruta. ' + errTxt(e)); }
}
async function borrarRuta() {
  const r = ruta(); if (!r) return;
  try {
    const [ps, fs] = await Promise.all([fb.getDocs(C('rutas/' + r.id + '/paradas')), fb.getDocs(C('rutas/' + r.id + '/fotos'))]);
    const refs = ps.docs.map(d => D('rutas/' + r.id + '/paradas/' + d.id)).concat(fs.docs.map(d => D('rutas/' + r.id + '/fotos/' + d.id)));
    for (let i = 0; i < refs.length; i += 400) { const b = fb.writeBatch(S.db); refs.slice(i, i + 400).forEach(x => b.delete(x)); await w(b.commit()); }
    await w(fb.deleteDoc(D('rutas/' + r.id)));
    S.confirmDel = null; selectRuta(null, S.mode === 'conductor' ? '' : 'rutas'); toast(S.mode === 'conductor' ? 'Ruta descartada.' : 'Ruta eliminada.');
  } catch (e) { toast('No se pudo eliminar: ' + errTxt(e)); }
}

// ---- importar PDF ----
let pdfjsPromise = null;
function cargarScript(src) { return new Promise((res, rej) => { const el = document.createElement('script'); el.src = src; el.onload = res; el.onerror = () => rej(new Error('No se pudo cargar el lector de PDF.')); document.head.appendChild(el); }); }
function cargarPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = cargarScript('vendor/pdf.min.js').then(() => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdf.worker.min.js'; return window.pdfjsLib; });
    pdfjsPromise.catch(() => { pdfjsPromise = null; });
  }
  return pdfjsPromise;
}
const limpiaCelda = v => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim();
function barra(p) { return `<div class="progress" style="margin-top:6px"><i style="width:${Math.round(p * 100)}%;background:var(--accent)"></i></div>`; }
function aplicarFilas(o, extra, origen) {
  const st = document.getElementById('impStatus');
  const tsv = o.filas.map(f => [f.cliente, f.direccion, f.telefono, f.factura, f.referencia, f.producto, int(f.cantidad), int(f.precio)].map(limpiaCelda).join('\t'));
  const habia = !!S.nueva.texto.trim();
  S.nueva.texto = ENCABEZADOS + '\n' + tsv.join('\n'); S.nueva.modo = 'opt'; S.nueva._key = '';
  const ta = document.getElementById('n-texto'); if (ta) ta.value = S.nueva.texto;
  updatePreview();
  const av = extra.concat(o.avisos);
  const sinPrecio = o.filas.filter(f => !int(f.precio)).length; if (sinPrecio) av.push(`${sinPrecio} filas quedaron sin precio.`);
  const noDir = [...new Set(o.filas.filter(f => !parseDir(f.direccion)).map(f => f.cliente))];
  if (noDir.length) av.push(`Dirección incompleta o no reconocida: ${noDir.join(', ')}.`);
  st.innerHTML = `<div class="banner ok"><div><b>Leí ${o.clientes} clientes y ${o.filas.length} líneas de producto${origen === 'foto' ? ' de la foto' : ''}.</b> ${habia ? 'Reemplazaron el listado que había. ' : ''}${origen === 'foto' ? 'Compara con la hoja las direcciones, teléfonos, cantidades y precios antes de crear la ruta; puedes corregirlos en el cuadro.' : 'Revisa los datos en el cuadro antes de crear la ruta; puedes corregirlos ahí mismo.'}</div></div>
    ${av.length ? `<div class="banner warn"><div><b>Para revisar:</b><br>${av.slice(0, 10).map(esc).join('<br>')}</div></div>` : ''}`;
}
async function pdfAImagenes(pdf, max, info) {
  const out = [];
  const n = Math.min(pdf.numPages, max);
  for (let i = 1; i <= n; i++) {
    info(`El PDF es escaneado. Preparando página ${i} de ${n}…`);
    const pg = await pdf.getPage(i), vp0 = pg.getViewport({ scale: 1 });
    const vp = pg.getViewport({ scale: Math.min(3, 2200 / vp0.width) });
    const cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
    const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height);
    await pg.render({ canvasContext: cx, viewport: vp }).promise;
    out.push(await new Promise(r => cv.toBlob(r, 'image/png')));
  }
  return out;
}
async function ocrConProgreso(imagenes, info) {
  const t0 = Date.now();
  const r = await leerFotos(imagenes, m => {
    const pag = m.n > 1 ? ` (foto ${m.i} de ${m.n})` : '';
    if (m.paso === 'cargar') info(`Preparando el lector de fotos. La primera vez descarga unos 6 MB…${barra(m.p || 0)}`);
    else if (m.paso === 'preparar') info(`Mejorando la imagen${pag}…`);
    else info(`Leyendo la planilla${pag}… ${Math.round((m.p || 0) * 100)}%${barra(m.p || 0)}`);
  });
  console.info('OCR', r.confianza, 'confianza', Date.now() - t0, 'ms');
  return r;
}
async function importarArchivos(files) {
  const st = document.getElementById('impStatus'); if (!st || !files.length) return;
  const info = (m, cls = 'info') => { st.innerHTML = `<div class="banner ${cls}"><div style="width:100%">${m}</div></div>`; };
  const bloquear = on => document.querySelectorAll('#n-cam,#n-file').forEach(x => { x.disabled = on; x.parentElement.classList.toggle('disabled', on); });
  bloquear(true);
  try {
    const pdfs = files.filter(f => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
    const fotos = files.filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|webp|heic)$/i.test(f.name));
    if (!pdfs.length && !fotos.length) { info('Elige un PDF o una foto (JPG o PNG).', 'warn'); return; }
    if (pdfs.length && fotos.length) { info('Elige un PDF o fotos, no los dos a la vez.', 'warn'); return; }
    if (pdfs.length > 1) { info('Elige un solo PDF a la vez.', 'warn'); return; }
    let lineas = [], extra = [], origen = 'pdf', conf = 100;
    if (pdfs.length) {
      info('Abriendo el PDF…');
      const lib = await cargarPdfjs();
      const pdf = await lib.getDocument({ data: new Uint8Array(await pdfs[0].arrayBuffer()) }).promise;
      const r = await extraerLineas(pdf, 30, (i, n) => info(`Leyendo página ${i} de ${n}…`));
      if (r.total > r.paginas) extra.push(`El PDF tiene ${r.total} páginas; se leyeron las primeras ${r.paginas}.`);
      if (r.escaneado) {
        if (pdf.numPages > 10) extra.push('Del PDF escaneado se leyeron las primeras 10 páginas.');
        const imgs = await pdfAImagenes(pdf, 10, info);
        const o = await ocrConProgreso(imgs, info); lineas = o.lineas; conf = o.confianza; origen = 'foto';
      } else lineas = r.lineas;
      if (S.nueva) S.nueva.fotosPlanilla = [];
    } else {
      if (fotos.length > 10) { info('Elige hasta 10 fotos a la vez.', 'warn'); return; }
      const o = await ocrConProgreso(fotos, info); lineas = o.lineas; conf = o.confianza; origen = 'foto';
      try { S.nueva.fotosPlanilla = []; for (const f of fotos.slice(0, 5)) S.nueva.fotosPlanilla.push(await comprimirFoto(f, 1800, 330000)); } catch (x) { console.warn('Foto de planilla', x); }
    }
    const o = interpretar(lineas);
    if (!o.filas.length) {
      info(`<b>No reconocí productos ${origen === 'foto' ? 'en la foto' : 'en este PDF'}.</b> ${origen === 'foto' ? 'Toma la foto más de cerca, con buena luz y la hoja plana. ' : 'Su formato es distinto al esperado. '}También puedes copiar el listado a Excel y pegarlo aquí.<details style="margin-top:6px"><summary>Ver el texto que leí</summary><pre class="mono" style="white-space:pre-wrap;max-height:240px;overflow:auto">${esc(lineas.join('\n').slice(0, 6000))}</pre></details>`, 'warn');
      return;
    }
    if (origen === 'foto' && conf < 70) extra.unshift('La foto se leyó con dificultad. Si ves muchos errores, tómala de nuevo más de cerca y con mejor luz.');
    aplicarFilas(o, extra, origen);
  } catch (e) { console.error(e); info('No se pudo leer el archivo. ' + esc(e.message || e), 'bad'); }
  finally { bloquear(false); }
}

// ---- conductores y usuarios ----
function auth2() {
  if (!S.auth2) {
    const a2 = fb.initializeApp(firebaseConfig, 'secundaria');
    S.auth2 = fb.initializeAuth(a2, { persistence: fb.inMemoryPersistence });
    if (USAR_EMULADOR) fb.connectAuthEmulator(S.auth2, 'http://127.0.0.1:9099');
  }
  return S.auth2;
}
async function crearCuentaAuth(usuario, clave) {
  const a2 = auth2();
  let email = `${usuario}@${DOMINIO_USUARIOS}`, cred;
  try { cred = await conLimite(fb.createUserWithEmailAndPassword(a2, email, clave)); }
  catch (e) {
    if (e.code !== 'auth/email-already-in-use') throw e;
    email = `${usuario}.${Date.now().toString(36)}@${DOMINIO_USUARIOS}`;
    cred = await conLimite(fb.createUserWithEmailAndPassword(a2, email, clave));
  }
  const uid = cred.user.uid;
  const deshacer = async () => { try { await fb.deleteUser(cred.user); } catch (x) { console.warn(x); } try { await fb.signOut(a2); } catch (x) { } };
  const listo = async () => { try { await fb.signOut(a2); } catch (x) { } };
  return { uid, email, deshacer, listo };
}
function vConductores() {
  const puedeEditar = u => esAdmin() || u.rol === 'conductor';
  const lista = S.usuarios;
  return `<div class="row between"><div><div class="eyebrow">${lista.filter(u => u.rol === 'conductor' && u.activo).length} conductores activos</div><h1>Conductores y usuarios</h1></div></div>
  <div class="tablewrap"><table><thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th class="hide-sm">Placa</th><th class="hide-sm">Teléfono</th><th>Estado</th><th></th></tr></thead>
  <tbody>${lista.map(u => `<tr><td>${esc(u.nombre)}</td><td class="mono">${esc(u.usuario)}</td><td>${ROLES[u.rol] || u.rol}</td><td class="hide-sm">${esc(u.placa || '')}</td><td class="hide-sm">${esc(u.telefono || '')}</td>
    <td><span class="pill ${u.activo ? 'on' : 'off'}">${u.activo ? 'Activo' : 'Bloqueado'}</span></td>
    <td>${u.uid !== S.user.uid && puedeEditar(u) ? `<div class="row" style="gap:4px"><button class="btn sm" data-act="toggleUsuario" data-v="${esc(u.uid)}">${u.activo ? 'Bloquear' : 'Activar'}</button><button class="btn sm" data-act="resetUsuario" data-v="${esc(u.uid)}">Nueva clave</button></div>` : ''}</td></tr>`).join('') || `<tr><td colspan="7" class="muted">${S.usuariosReady ? 'Sin usuarios.' : 'Cargando…'}</td></tr>`}</tbody></table></div>
  <div class="card" style="max-width:620px">
    <h3>Nuevo ${esAdmin() ? 'usuario' : 'conductor'}</h3>
    <div class="grid2">
      <label class="f">Nombre completo<input type="text" id="u-nombre"></label>
      <label class="f">Usuario para entrar<input type="text" id="u-usuario" autocapitalize="none" placeholder="Ej: carlos.perez"></label>
      <label class="f">Clave inicial (mínimo 6)<input type="text" id="u-clave" autocomplete="off"></label>
      ${esAdmin() ? `<label class="f">Rol<select id="u-rol"><option value="conductor">Conductor</option><option value="oficina">Oficina</option><option value="admin">Administrador</option></select></label>` : ''}
      <label class="f">Placa del vehículo<input type="text" id="u-placa"></label>
      <label class="f">Teléfono<input type="text" inputmode="tel" id="u-tel"></label>
    </div>
    <div class="err" id="uErr"></div>
    <button class="btn primary" data-act="crearUsuario">Crear usuario</button>
    <p class="small muted">Entrégale al conductor su usuario y clave. Al entrar puede cambiar la clave en "Mi cuenta".</p>
  </div>`;
}
async function crearUsuario() {
  const v = id => (document.getElementById(id) || {}).value || '';
  const nombre = v('u-nombre').trim(), usuario = normUsuario(v('u-usuario')), clave = v('u-clave'), rol = esAdmin() ? v('u-rol') : 'conductor';
  const err = document.getElementById('uErr');
  if (!nombre) { err.textContent = 'Escribe el nombre.'; return; }
  if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) { err.textContent = 'El usuario debe tener de 3 a 30 letras o números, sin espacios.'; return; }
  if (clave.length < 6) { err.textContent = 'La clave debe tener al menos 6 caracteres.'; return; }
  const btn = document.querySelector('[data-act="crearUsuario"]'); btn.disabled = true; btn.textContent = 'Creando…';
  try {
    const ex = await fb.getDoc(D('accesos/' + usuario));
    if (ex.exists()) throw { code: 'auth/email-already-in-use' };
    const cta = await crearCuentaAuth(usuario, clave);
    try {
      const b = fb.writeBatch(S.db);
      b.set(D('usuarios/' + cta.uid), { nombre, usuario, rol, activo: true, placa: v('u-placa').trim(), telefono: v('u-tel').trim(), creado: new Date().toISOString(), creadoPor: S.user.uid });
      b.set(D('accesos/' + usuario), { email: cta.email, uid: cta.uid });
      await conLimite(b.commit());
    } catch (e) { await cta.deshacer(); throw e; }
    await cta.listo();
    toast(`Usuario ${usuario} creado.`); S.limpiar = true; render();
  } catch (e) { console.error('Crear usuario', e); err.textContent = 'No se pudo crear el usuario. ' + errTxt(e); btn.disabled = false; btn.textContent = 'Crear usuario'; }
}
function vResetModal(u) {
  return `<div class="modal-in"><div class="row between"><h2>Nueva clave</h2><button class="btn sm" data-act="cerrarModal">Cancelar</button></div>
  <p class="small">Asigna una clave nueva a <b>${esc(u.nombre)}</b> (usuario <span class="mono">${esc(u.usuario)}</span>). Sus rutas abiertas siguen asignadas.</p>
  <label class="f">Clave nueva (mínimo 6)<input type="text" id="r-clave" autocomplete="off"></label>
  <div class="err" id="rErr"></div>
  <button class="btn primary" data-act="confirmReset" data-v="${esc(u.uid)}">Asignar clave</button></div>`;
}
async function restablecerClave(uidViejo) {
  const u = S.usuarios.find(x => x.uid === uidViejo), clave = document.getElementById('r-clave').value, err = document.getElementById('rErr');
  if (clave.length < 6) { err.textContent = 'La clave debe tener al menos 6 caracteres.'; return; }
  const btn = document.querySelector('[data-act="confirmReset"]'); btn.disabled = true; btn.textContent = 'Asignando…';
  try {
    // Firebase no permite cambiar la clave de otro usuario desde la app: se crea un acceso nuevo y se traspasan sus datos y rutas.
    const cta = await crearCuentaAuth(u.usuario, clave);
    const { uid, email } = cta;
    const datos = Object.assign({}, u); delete datos.uid;
    const abiertas = await fb.getDocs(fb.query(C('rutas'), fb.where('conductorUid', '==', uidViejo), fb.where('abierta', '==', true)));
    const b = fb.writeBatch(S.db);
    b.set(D('usuarios/' + uid), Object.assign(datos, { activo: true, reemplaza: uidViejo, actualizado: new Date().toISOString() }));
    b.update(D('usuarios/' + uidViejo), { activo: false, reemplazadoPor: uid });
    b.set(D('accesos/' + u.usuario), { email, uid });
    abiertas.docs.forEach(d => b.update(D('rutas/' + d.id), { conductorUid: uid }));
    try { await conLimite(b.commit()); } catch (e) { await cta.deshacer(); throw e; }
    await cta.listo();
    cerrarModal(); toast(`Clave nueva asignada a ${u.nombre}.`);
  } catch (e) { err.textContent = errTxt(e); btn.disabled = false; btn.textContent = 'Asignar clave'; }
}

// ---- reportes ----
async function cargarReportes() {
  S.rep = { loading: true }; render();
  try {
    const out = [];
    for (const r of S.rutas) { const snap = await fb.getDocs(C('rutas/' + r.id + '/paradas')); out.push({ r, paradas: snap.docs.map(d => Object.assign({ id: d.id }, clone(d.data()))) }); }
    S.rep = { loading: false, data: out };
  } catch (e) { S.rep = { loading: false, err: errTxt(e) }; }
  if (S.view === 'reportes') render();
}
function vReportes() {
  const R = S.rep;
  const head = `<div class="row between"><div><div class="eyebrow">Últimas ${S.rutas.length} rutas</div><h1>Reportes</h1></div><button class="btn sm" data-act="recargarRep">Actualizar</button></div>`;
  if (!R || R.loading) return head + `<div class="empty">Calculando reportes…</div>`;
  if (R.err) return head + `<div class="banner bad"><div>No se pudieron cargar los reportes. ${esc(R.err)}</div></div>`;
  const tot = { n: 0, ok: 0, parc: 0, ve: 0, vd: 0 }, motivos = {}, clientes = {}, cond = {};
  for (const { r, paradas } of R.data) {
    const t = totales(r, paradas);
    tot.n += t.n - t.pendiente; tot.ok += t.entregado; tot.parc += t.parcial; tot.ve += t.vEntregado; tot.vd += t.vDevGest;
    const c = cond[r.conductor] = cond[r.conductor] || { rutas: 0, n: 0, ok: 0, dif: 0, liq: 0 };
    c.rutas++; c.n += t.n - t.pendiente; c.ok += t.entregado + t.parcial;
    if (r.liquidacion) { c.dif += r.liquidacion.diferencia; c.liq++; }
    for (const p of paradas) {
      if (p.motivo && p.estado !== 'entregado') motivos[p.motivo] = (motivos[p.motivo] || 0) + 1;
      if (['rechazado', 'parcial', 'no_visitado'].includes(p.estado)) { const k = p.cliente; clientes[k] = clientes[k] || { n: 0, valor: 0 }; clientes[k].n++; clientes[k].valor += valorFactura(p) - valorEntregado(p); }
    }
  }
  const efect = tot.n ? Math.round((tot.ok + tot.parc) / tot.n * 100) : 0;
  const mot = Object.entries(motivos).sort((a, b) => b[1] - a[1]), maxM = mot.length ? mot[0][1] : 1;
  const cli = Object.entries(clientes).sort((a, b) => b[1].n - a[1].n || b[1].valor - a[1].valor).slice(0, 10);
  return head + `<div class="kpis">
    <div class="kpi"><span class="l">Paradas gestionadas</span><span class="v">${tot.n}</span></div>
    <div class="kpi"><span class="l">Efectividad de entrega</span><span class="v">${efect}%</span></div>
    <div class="kpi"><span class="l">Valor entregado</span><span class="v">${fmt(tot.ve)}</span></div>
    <div class="kpi"><span class="l">Valor devuelto</span><span class="v">${fmt(tot.vd)}</span></div>
  </div>
  <div class="grid2">
    <div class="card"><h3>Motivos de devolución y no entrega</h3>
      ${mot.length ? mot.map(([m, n]) => `<div class="bar"><span class="lab" title="${esc(m)}">${esc(m)}</span><span class="t"><i style="width:${n / maxM * 100}%"></i></span><span class="num" style="text-align:right">${n}</span></div>`).join('') : '<div class="empty small">Sin devoluciones registradas.</div>'}
    </div>
    <div class="card"><h3>Clientes con más novedades</h3>
      ${cli.length ? `<div class="tablewrap"><table><thead><tr><th>Cliente</th><th class="r">Veces</th><th class="r">Valor devuelto</th></tr></thead><tbody>${cli.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r num">${v.n}</td><td class="r num">${fmt(v.valor)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="empty small">Sin novedades.</div>'}
    </div>
  </div>
  <div class="card"><h3>Por conductor</h3>
    <div class="tablewrap"><table><thead><tr><th>Conductor</th><th class="r">Rutas</th><th class="r">Paradas</th><th class="r">Efectividad</th><th class="r">Liquidadas</th><th class="r">Diferencia acumulada</th></tr></thead>
    <tbody>${Object.entries(cond).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r num">${v.rutas}</td><td class="r num">${v.n}</td><td class="r num">${v.n ? Math.round(v.ok / v.n * 100) : 0}%</td><td class="r num">${v.liq}</td>
      <td class="r num" style="color:${v.dif < 0 ? 'var(--bad)' : v.dif > 0 ? 'var(--warn)' : ''}">${v.dif === 0 ? '$0' : (v.dif < 0 ? '− ' : '+ ') + fmt(Math.abs(v.dif))}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Sin datos.</td></tr>'}</tbody></table></div>
  </div>`;
}

// ---- ajustes ----
function vAjustes() {
  const c = S.config, dis = esAdmin() ? '' : 'disabled';
  return `<div><div class="eyebrow">Oficina</div><h1>Ajustes</h1></div>
  <div class="card" style="max-width:560px">
    <h3>Empresa y valores por defecto</h3>
    <label class="f">Nombre de la empresa<input type="text" id="a-empresa" value="${esc(c.empresa || '')}" ${dis}></label>
    <label class="f">Ciudad por defecto<input type="text" id="a-ciudad" value="${esc(c.ciudad || 'Barranquilla')}" ${dis}></label>
    <label class="f">Punto de partida por defecto (bodega)<input type="text" id="a-bodega" value="${esc(c.bodega || '')}" placeholder="Ej: Cl 30 #44-50" ${dis}></label>
    <label class="row small"><input type="checkbox" id="a-ccrean" ${c.conductoresCrean === false ? '' : 'checked'} ${dis}> Los conductores pueden crear su ruta con la foto de la planilla</label>
    ${esAdmin() ? `<button class="btn primary" data-act="guardarAjustes">Guardar</button>` : `<p class="small muted">Solo el administrador puede cambiar estos datos.</p>`}
  </div>
  <div class="card" style="max-width:560px">
    <h3>Instalar la app en el celular</h3>
    <p class="small"><b>Android (Chrome):</b> abre el enlace, toca el menú ⋮ y elige "Instalar app" o "Agregar a la pantalla principal".</p>
    <p class="small"><b>iPhone (Safari):</b> abre el enlace, toca Compartir y elige "Agregar a inicio".</p>
    <p class="small muted">Instalada, la app abre sin barra del navegador y funciona sin señal: lo que el conductor registre se guarda en el celular y se envía cuando vuelve la conexión.</p>
  </div>`;
}

// ---------- fotos ----------
function cargarImagen(file) { return new Promise((res, rej) => { const img = new Image(); img.onload = () => res(img); img.onerror = () => rej(new Error('No se pudo abrir la foto.')); img.src = URL.createObjectURL(file); }); }
async function comprimirFoto(file, maxLado = 1280, maxChars = 200000) {
  let src = null;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { src = await cargarImagen(file); }
  let lado = maxLado, data = '';
  for (let intento = 0; intento < 4; intento++) {
    const r = Math.min(1, lado / Math.max(src.width, src.height));
    const cv = document.createElement('canvas'); cv.width = Math.round(src.width * r); cv.height = Math.round(src.height * r);
    cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height);
    for (const q of [0.7, 0.55, 0.42]) { data = cv.toDataURL('image/jpeg', q); if (data.length <= maxChars) return data; }
    lado = Math.round(lado * 0.75);
  }
  return data;
}
async function verFotos(ids) {
  const m = abrirModal(`<div class="modal-in"><div class="row between"><h2>Fotos</h2><button class="btn sm" data-act="cerrarModal">Cerrar</button></div><div id="fotosBody" class="empty">Cargando fotos…</div></div>`);
  const body = m.querySelector('#fotosBody');
  try {
    const snaps = await Promise.all(ids.map(id => fb.getDoc(D(`rutas/${S.rutaId}/fotos/${id}`))));
    const ok = snaps.filter(s => s.exists());
    body.className = '';
    body.innerHTML = ok.length ? ok.map(s => `<img class="foto-grande" src="${s.data().data}" alt="Foto"><div class="small muted">${fechaHora(s.data().fecha)}</div>`).join('') : '<div class="empty">Las fotos aún no han llegado. Si el conductor está sin señal, se verán cuando se conecte.</div>';
  } catch (e) { body.textContent = 'No se pudieron cargar las fotos: ' + errTxt(e); }
}
function verFirma(pid) {
  const p = S.paradas.find(x => x.id === pid); if (!p || !p.firma) return;
  abrirModal(`<div class="modal-in"><div class="row between"><h2>Firma · ${esc(p.cliente)}</h2><button class="btn sm" data-act="cerrarModal">Cerrar</button></div><img class="foto-grande" src="${p.firma}" alt="Firma"><div class="small">Recibió: ${esc(p.recibe || '')} · ${fechaHora(p.hora)}</div></div>`);
}
function abrirModal(html) { const m = document.getElementById('modal'); m.className = 'modal'; m.innerHTML = html; m.hidden = false; return m; }
function cerrarModal() { const m = document.getElementById('modal'); m.hidden = true; m.innerHTML = ''; }

// ---------- firmas ----------
function initFirma(cv) {
  const key = cv.dataset.firma, target = () => cv.dataset.target === 'liq' ? S.liq : S.draft;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const wd = cv.clientWidth || 300, ht = cv.clientHeight || 150;
  cv.width = Math.round(wd * dpr); cv.height = Math.round(ht * dpr);
  const ctx = cv.getContext('2d');
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--paper-ink').trim() || '#111';
  const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim() || '#fff';
  const clear = () => { ctx.fillStyle = paper; ctx.fillRect(0, 0, cv.width, cv.height); };
  clear();
  ctx.lineWidth = 2.2 * dpr; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = ink;
  const o = target();
  if (o && o[key]) { const img = new Image(); img.onload = () => ctx.drawImage(img, 0, 0, cv.width, cv.height); img.src = o[key]; }
  let drawing = false, last = null;
  const pos = e => { const b = cv.getBoundingClientRect(); return [(e.clientX - b.left) * cv.width / b.width, (e.clientY - b.top) * cv.height / b.height]; };
  cv.addEventListener('pointerdown', e => { drawing = true; last = pos(e); cv.setPointerCapture(e.pointerId); ctx.beginPath(); ctx.arc(last[0], last[1], ctx.lineWidth / 2, 0, Math.PI * 2); ctx.fillStyle = ink; ctx.fill(); });
  cv.addEventListener('pointermove', e => { if (!drawing) return; const p = pos(e); ctx.beginPath(); ctx.moveTo(last[0], last[1]); ctx.lineTo(p[0], p[1]); ctx.stroke(); last = p; });
  const end = () => { if (!drawing) return; drawing = false; const t = target(); if (t) t[key] = cv.toDataURL('image/png'); };
  cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
  cv._clear = () => { clear(); const t = target(); if (t) t[key] = ''; };
}

// ---------- exportar ----------
function descargar(nombre, blob) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = nombre;
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 5000);
}
function puedeCompartir() { try { return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.pdf', { type: 'application/pdf' })] })); } catch (e) { return false; } }
function csvRuta() {
  const r = ruta(), q = v => { const s = String(v ?? ''); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = [['Ruta', 'Fecha', 'Conductor', 'Vehículo', 'Orden', 'Cliente', 'Dirección', 'Factura', 'Estado', 'Referencia', 'Producto', 'Cant. pedida', 'Cant. entregada', 'Cant. devuelta', 'Precio', 'Valor entregado', 'Valor devuelto', 'Motivo', 'Recibió', 'Hora', 'Efectivo factura', 'Transferencia factura', 'Ref. transferencia', 'Crédito factura', 'Novedad', 'GPS']];
  for (const p of S.paradas) {
    const g = p.pago || {}, e = p.estado || 'pendiente';
    (p.items || []).forEach((i, k) => {
      const en = entregadoDe(p, k);
      rows.push([r.codigo, r.fecha, r.conductor, r.vehiculo, p.orden, p.cliente, p.direccion, p.factura, ESTADOS[e].t, i.ref, i.producto, i.cant, en, i.cant - en, i.precio, en * i.precio, (i.cant - en) * i.precio, p.motivo || '', p.recibe || '', p.hora ? fechaHora(p.hora) : '',
        k === 0 ? int(g.efectivo) : '', k === 0 ? int(g.transferencia) : '', k === 0 ? (p.refTransf || '') : '', k === 0 ? int(g.credito) : '', k === 0 ? (p.novedad || '') : '', k === 0 && p.gps ? `${p.gps.lat},${p.gps.lng}` : '']);
    });
  }
  return '﻿' + rows.map(x => x.map(q).join(';')).join('\r\n');
}
function pdfRuta() {
  const J = window.jspdf && window.jspdf.jsPDF;
  if (!J) { toast('El generador de PDF no cargó. Recarga la app.'); return null; }
  const r = ruta(), t = totales(r, S.paradas);
  const doc = new J({ unit: 'pt', format: 'letter', orientation: 'landscape' });
  const W = doc.internal.pageSize.getWidth();
  doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.text((S.config.empresa ? S.config.empresa + ' · ' : '') + 'Planilla de ruta ' + r.codigo, 36, 40);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
  doc.text(`Fecha: ${fechaTxt(r.fecha)}   Conductor: ${r.conductor}   Vehículo: ${r.vehiculo || '-'}   Despacha: ${r.remitente || '-'}   Estado: ${RUTA_EST[r.estado]}`, 36, 58);
  doc.text(`Cargue: ${r.cargue && r.cargue.confirmado ? 'confirmado ' + fechaHora(r.cargue.hora) + (r.cargue.novedad ? ' · Novedad: ' + r.cargue.novedad : '') : 'sin confirmar'}`, 36, 72);
  doc.text(`Ciudad: ${ciudadDe(r)}   Partida: ${r.bodega || '-'}   Recorrido estimado: ${kmTxt(costoParadas(S.paradas, parseDir(r.bodega), r.regreso)).replace('≈ ', 'aprox. ')}`, 36, 86);
  const head = { fillColor: [19, 36, 28], textColor: 255, fontStyle: 'bold' };
  doc.autoTable({
    startY: 98, headStyles: head, styles: { fontSize: 8, cellPadding: 3 }, columnStyles: { 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' }, 8: { halign: 'right' } },
    head: [['#', 'Cliente', 'Factura', 'Estado', 'Valor factura', 'Entregado', 'Efectivo', 'Transf.', 'Crédito', 'Motivo / recibió']],
    body: S.paradas.map(p => { const g = p.pago || {}, e = p.estado || 'pendiente'; return [p.orden, p.cliente, p.factura || '', ESTADOS[e].t, fmt(valorFactura(p)), e === 'pendiente' ? '-' : fmt(valorEntregado(p)), fmt(g.efectivo), fmt(g.transferencia), fmt(g.credito), [p.motivo, p.recibe ? 'Recibió ' + p.recibe : '', p.hora ? hora(p.hora) : ''].filter(Boolean).join(' · ')]; }),
    foot: [['', 'Totales', '', '', fmt(t.facturado), fmt(t.vEntregado), fmt(t.efectivo), fmt(t.transferencia), fmt(t.credito), '']], footStyles: { fillColor: [230, 236, 232], textColor: 20, fontStyle: 'bold' }
  });
  let y = doc.lastAutoTable.finalY + 16;
  const half = (W - 72 - 16) / 2;
  doc.autoTable({ startY: y, margin: { left: 36, right: 36 + half + 16 }, headStyles: head, styles: { fontSize: 8 }, head: [['Devolución', 'Unid.', 'Valor']], body: t.devoluciones.length ? t.devoluciones.map(x => [x.producto, x.cant, fmt(x.valor)]) : [['Sin devolución', '', '']] });
  const y1 = doc.lastAutoTable.finalY;
  doc.autoTable({
    startY: y, margin: { left: 36 + half + 16, right: 36 }, headStyles: head, styles: { fontSize: 8 }, head: [['Cuadre de efectivo', 'Valor']],
    body: [['Base', fmt(t.base)], ['Efectivo de entregas', fmt(t.efectivo)], ['Efectivo de cartera', fmt(t.carteraEf)], ['Gastos de ruta', '- ' + fmt(t.gastos)], ['Efectivo esperado', fmt(t.efectivoEsperado)],
    ...(r.liquidacion ? [['Efectivo contado', fmt(r.liquidacion.contado)], ['Diferencia', (r.liquidacion.diferencia < 0 ? 'Faltante ' : r.liquidacion.diferencia > 0 ? 'Sobrante ' : '') + fmt(Math.abs(r.liquidacion.diferencia))]] : []),
    ['Transferencias (ventas + cartera)', fmt(t.transferencia + t.carteraTr)], ['Crédito', fmt(t.credito)]]
  });
  y = Math.max(y1, doc.lastAutoTable.finalY) + 16;
  if ((r.gastos || []).length || (r.cartera || []).length) {
    doc.autoTable({ startY: y, headStyles: head, styles: { fontSize: 8 }, head: [['Tipo', 'Detalle', 'Valor']], body: [...(r.gastos || []).map(g => ['Gasto', g.concepto + (g.nota ? ' · ' + g.nota : ''), fmt(g.valor)]), ...(r.cartera || []).map(c => ['Cartera', `${c.cliente} · Fact. ${c.factura || '-'} · ${c.forma}${c.ref ? ' ' + c.ref : ''}`, fmt(c.valor)])] });
    y = doc.lastAutoTable.finalY + 16;
  }
  if (r.liquidacion) {
    const l = r.liquidacion;
    if (y > doc.internal.pageSize.getHeight() - 140) { doc.addPage(); y = 40; }
    doc.setFont('helvetica', 'bold'); doc.text('Liquidación ' + fechaHora(l.fecha), 36, y); doc.setFont('helvetica', 'normal');
    if (l.observaciones) doc.text('Observaciones: ' + l.observaciones, 36, y + 14, { maxWidth: W - 72 });
    const yy = y + 28;
    try { if (l.firmaEntrega) doc.addImage(l.firmaEntrega, 'PNG', 36, yy, 180, 60); if (l.firmaRecibe) doc.addImage(l.firmaRecibe, 'PNG', 300, yy, 180, 60); } catch (e) { }
    doc.text('Entregó: ' + l.entregadoPor, 36, yy + 74); doc.text('Recibió: ' + l.recibidoPor, 300, yy + 74);
  }
  const pages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(120); doc.text(`RutaCuadre · ${r.codigo} · página ${i} de ${pages}`, 36, doc.internal.pageSize.getHeight() - 18); }
  return doc.output('blob');
}

// ---------- toast ----------
let toastT;
function toast(m) { const t = document.getElementById('toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 3600); }

// ---------- eventos ----------
document.addEventListener('submit', e => { if (e.target.id === 'fLogin') { e.preventDefault(); entrar(); } });
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const a = el.dataset.act, v = el.dataset.v;
  switch (a) {
    case 'salir': {
      const pend = S.pendientes.rutas || S.pendientes.paradas;
      if ((S.draft || S.liq || pend) && !el.dataset.ok) {
        el.dataset.ok = '1'; el.textContent = pend ? 'Hay cambios sin enviar. ¿Salir?' : '¿Salir sin guardar?';
        if (pend) toast('Espera a tener señal para que se envíen tus cambios antes de cerrar sesión.');
        setTimeout(() => { el.textContent = 'Salir'; delete el.dataset.ok; }, 4000); break;
      }
      fb.signOut(S.auth); break;
    }
    case 'cuenta': abrirModal(vCuentaModal()); break;
    case 'cambiarClave': cambiarClave(); break;
    case 'cerrarModal': cerrarModal(); break;
    case 'instalarApp': instalarApp(); break;
    case 'instalar': if (S.installEvt) { S.installEvt.prompt(); S.installEvt = null; updateCtx(); } break;
    case 'elegir': selectRuta(v, 'paradas'); break;
    case 'cambiarRuta': selectRuta(null, ''); ls.set('rc_ruta_' + S.user.uid, null); break;
    case 'cview': if (S.view === 'parada' && v !== 'parada') S.draft = null; S.view = v; render(); window.scrollTo(0, 0); break;
    case 'abrir': abrirParada(v); break;
    case 'estado': setEstado(v); break;
    case 'todoEfectivo': {
      const d = S.draft; d.pago = { efectivo: valorEntregado(d), transferencia: 0, credito: 0 }; d.refTransf = '';
      ['f-ef', 'f-tr', 'f-cr'].forEach((id, i) => { const x = document.getElementById(id); if (x) x.value = [d.pago.efectivo, 0, 0][i]; }); updateParadaCalc(); break;
    }
    case 'borrarFirma': { const cv = document.querySelector(`canvas[data-firma="${v}"]`); if (cv && cv._clear) cv._clear(); break; }
    case 'quitarFoto': S.draft.fotosNuevas.splice(+v, 1); render(); break;
    case 'quitarFotoGasto': S.fotoGasto = null; render(); break;
    case 'guardarParada': guardarParada(); break;
    case 'confirmarCargue': {
      const nov = (document.getElementById('f-cnov') || {}).value || '';
      el.disabled = true;
      await w(fb.updateDoc(D('rutas/' + S.rutaId), { estado: 'en_ruta', cargue: { confirmado: true, hora: new Date().toISOString(), novedad: nov.trim() } }));
      toast('Cargue confirmado. Buena ruta.'); S.view = 'paradas'; render(); break;
    }
    case 'addGasto': {
      const valor = int(document.getElementById('g-valor').value);
      if (!valor) { toast('Escribe el valor del gasto.'); break; }
      let foto = null;
      if (S.fotoGasto) { foto = nuevoId(); w(fb.setDoc(D(`rutas/${S.rutaId}/fotos/${foto}`), { paradaId: '', tipo: 'gasto', data: S.fotoGasto, fecha: new Date().toISOString(), autorUid: S.user.uid })); }
      const g = { concepto: document.getElementById('g-concepto').value, valor, nota: document.getElementById('g-nota').value.trim(), hora: new Date().toISOString(), foto };
      S.fotoGasto = null;
      await w(fb.updateDoc(D('rutas/' + S.rutaId), { gastos: [...(ruta().gastos || []), g] }));
      toast('Gasto agregado.'); render(); break;
    }
    case 'delGasto': { const arr = [...(ruta().gastos || [])]; arr.splice(+v, 1); await w(fb.updateDoc(D('rutas/' + S.rutaId), { gastos: arr })); render(); break; }
    case 'addCartera': {
      const cliente = document.getElementById('k-cliente').value.trim(), valor = int(document.getElementById('k-valor').value), forma = document.getElementById('k-forma').value, ref = document.getElementById('k-ref').value.trim();
      if (!cliente || !valor) { toast('Escribe el cliente y el valor.'); break; }
      if (forma === 'transferencia' && !ref) { toast('Escribe la referencia de la transferencia.'); break; }
      const c = { cliente, factura: document.getElementById('k-factura').value.trim(), valor, forma, ref, hora: new Date().toISOString() };
      await w(fb.updateDoc(D('rutas/' + S.rutaId), { cartera: [...(ruta().cartera || []), c] }));
      toast('Cobro de cartera agregado.'); render(); break;
    }
    case 'delCartera': { const arr = [...(ruta().cartera || [])]; arr.splice(+v, 1); await w(fb.updateDoc(D('rutas/' + S.rutaId), { cartera: arr })); render(); break; }
    case 'pdf': { const r = ruta(), b = pdfRuta(); if (b) descargar(`Planilla_${r.codigo}.pdf`, b); break; }
    case 'pdfShare': {
      const r = ruta(), b = pdfRuta(); if (!b) break;
      try { await navigator.share({ files: [new File([b], `Planilla_${r.codigo}.pdf`, { type: 'application/pdf' })], title: 'Planilla ' + r.codigo }); } catch (err) { if (err.name !== 'AbortError') descargar(`Planilla_${r.codigo}.pdf`, b); }
      break;
    }
    case 'csv': { const r = ruta(); descargar(`Entregas_${r.codigo}.csv`, new Blob([csvRuta()], { type: 'text/csv;charset=utf-8' })); break; }
    case 'oview':
      S.confirmDel = null;
      if (S.rutaId) selectRuta(null, v); else S.view = v;
      if (v === 'reportes') { cargarReportes(); break; }
      render(); window.scrollTo(0, 0); break;
    case 'verRuta': S.confirmDel = null; S.liq = null; if (S.rutaId !== v) selectRuta(v, 'ruta'); else { S.view = 'ruta'; render(); } window.scrollTo(0, 0); break;
    case 'irLiquidar': irLiquidar(); break;
    case 'cerrarLiq': cerrarLiq(); break;
    case 'pedirDel': S.confirmDel = S.rutaId; render(); break;
    case 'cancelDel': S.confirmDel = null; render(); break;
    case 'borrarRuta': borrarRuta(); break;
    case 'crearRuta': crearRuta(); break;
    case 'nuevaConductor': if (unsub.paradas) { unsub.paradas(); unsub.paradas = null; } S.rutaId = null; S.nueva = null; S.view = 'nueva'; render(); window.scrollTo(0, 0); break;
    case 'cancelarNueva': S.nueva = null; S.view = ''; { const saved = ls.get('rc_ruta_' + S.user.uid); const r = S.rutas.find(x => x.id === saved); if (r) { selectRuta(r.id, 'paradas'); break; } } render(); break;
    case 'nEditar': abrirModal(vEditarParada(+v)); break;
    case 'eAgregarItem': document.getElementById('e-items').insertAdjacentHTML('beforeend', filaItem({ ref: '', producto: '', cant: '', precio: '' }, 1)); break;
    case 'eQuitarItem': el.closest('.e-item').remove(); break;
    case 'eGuardar': guardarEdicion(+v); break;
    case 'eEliminar': { if (!el.dataset.ok) { el.dataset.ok = '1'; el.textContent = '¿Seguro? Toca otra vez'; break; } const { paradas } = parsePlanilla(S.nueva.texto); conservarOrden(paradas, +v); cerrarModal(); toast('Cliente quitado de la lista.'); break; }
    case 'nOptimizar': S.nueva.modo = 'opt'; S.nueva._key = ''; updatePreview(); break;
    case 'nLista': S.nueva.modo = 'lista'; S.nueva._key = ''; updatePreview(); break;
    case 'nMover': { const [k, d] = v.split(',').map(Number); const o = S.nueva.orden, j = k + d; if (j < 0 || j >= o.length) break; [o[k], o[j]] = [o[j], o[k]]; S.nueva.modo = 'manual'; updatePreview(); break; }
    case 'reoptimizar': el.disabled = true; await reoptimizar(); el.disabled = false; break;
    case 'copiarEnc': try { await navigator.clipboard.writeText(ENCABEZADOS); toast('Encabezados copiados. Pégalos en la fila 1 de Excel.'); } catch (err) { toast('Encabezados: ' + ENCABEZADOS.replace(/\t/g, ', ')); } break;
    case 'recargarRep': cargarReportes(); break;
    case 'verFotos': verFotos(v.split(',').filter(Boolean)); break;
    case 'verFirma': verFirma(v); break;
    case 'crearUsuario': crearUsuario(); break;
    case 'toggleUsuario': { const u = S.usuarios.find(x => x.uid === v); if (u) { await w(fb.updateDoc(D('usuarios/' + v), { activo: !u.activo })); toast(u.activo ? `${u.nombre} bloqueado.` : `${u.nombre} activado.`); } break; }
    case 'resetUsuario': { const u = S.usuarios.find(x => x.uid === v); if (u) abrirModal(vResetModal(u)); break; }
    case 'confirmReset': restablecerClave(v); break;
    case 'guardarAjustes': {
      const val = id => document.getElementById(id).value.trim();
      await w(fb.setDoc(D('config/app'), { empresa: val('a-empresa'), ciudad: val('a-ciudad') || 'Barranquilla', bodega: val('a-bodega'), conductoresCrean: document.getElementById('a-ccrean').checked }));
      toast('Ajustes guardados.'); break;
    }
    case 'actualizarApp': { const reg = await navigator.serviceWorker.getRegistration(); if (reg && reg.waiting) reg.waiting.postMessage('activar'); break; }
  }
});
document.getElementById('modal').addEventListener('click', e => { if (e.target.id === 'modal') cerrarModal(); });

document.addEventListener('input', e => {
  const el = e.target;
  if (el.dataset.f && S.draft) {
    const d = S.draft, f = el.dataset.f;
    if (f === 'ent') { const k = +el.dataset.k; d.entregado[k] = Math.min(int(el.value), d.items[k].cant); if (!int(d.pago.transferencia) && !int(d.pago.credito)) { d.pago.efectivo = valorEntregado(d); const x = document.getElementById('f-ef'); if (x) x.value = d.pago.efectivo; } }
    else if (f.startsWith('pago.')) d.pago[f.slice(5)] = int(el.value);
    else d[f] = el.value;
    updateParadaCalc();
  }
  if (el.dataset.l && S.liq) {
    const L = S.liq, f = el.dataset.l;
    if (f === 'b') L.billetes[el.dataset.v] = int(el.value);
    else if (f === 'monedas') L.monedas = int(el.value);
    else if (f === 'd') L.devol[el.dataset.v] = int(el.value);
    else if (f === 'ep') L.entregadoPor = el.value;
    else if (f === 'rp') L.recibidoPor = el.value;
    else if (f === 'obs') L.observaciones = el.value;
    else if (f === 'tv') L.transfVerificadas = el.checked;
    updateLiq();
  }
  if (el.dataset.n && S.nueva) {
    const k = el.dataset.n; S.nueva[k] = el.type === 'checkbox' ? el.checked : el.value;
    if (k === 'conductorUid') { const u = S.usuarios.find(x => x.uid === el.value); const vh = document.getElementById('n-vehiculo'); if (u && u.placa && vh && !vh.value) { vh.value = u.placa; S.nueva.vehiculo = u.placa; } }
    if (k === 'texto' || k === 'bodega' || k === 'regreso') updatePreview();
  }
});
document.addEventListener('change', async e => {
  const el = e.target;
  if (el.id === 'n-file' || el.id === 'n-cam') { const fl = [...el.files]; el.value = ''; importarArchivos(fl); return; }
  if (el.id === 'f-foto' && el.files[0] && S.draft) {
    const f = el.files[0]; el.value = '';
    try { toast('Procesando foto…'); S.draft.fotosNuevas.push(await comprimirFoto(f)); render(); } catch (err) { toast(err.message || 'No se pudo usar la foto.'); }
    return;
  }
  if (el.id === 'g-foto' && el.files[0]) {
    const f = el.files[0]; el.value = '';
    const keep = { c: (document.getElementById('g-concepto') || {}).value, v: (document.getElementById('g-valor') || {}).value, n: (document.getElementById('g-nota') || {}).value };
    try { S.fotoGasto = await comprimirFoto(f); render(); const set = (id, x) => { const i = document.getElementById(id); if (i && x != null) i.value = x; }; set('g-concepto', keep.c); set('g-valor', keep.v); set('g-nota', keep.n); } catch (err) { toast(err.message || 'No se pudo usar la foto.'); }
    return;
  }
  if (el.dataset.l === 'tv' && S.liq) S.liq.transfVerificadas = el.checked;
  if (el.dataset.f === 'motivo' && S.draft) S.draft.motivo = el.value;
  if (el.dataset.n && S.nueva && el.tagName === 'SELECT') el.dispatchEvent(new Event('input', { bubbles: true }));
});

// ---------- instalación como app y actualizaciones ----------
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); S.installEvt = e; updateCtx(); });
function registrarSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js').then(reg => {
    if (!reg) return;
    const avisar = () => {
      const u = document.getElementById('update');
      u.innerHTML = `<div class="banner info" style="box-shadow:0 6px 24px rgba(0,0,0,.2)"><div class="row between" style="width:100%"><span>Hay una versión nueva de RutaCuadre.</span><button class="btn sm primary" data-act="actualizarApp">Actualizar</button></div></div>`;
      u.hidden = false;
    };
    if (reg.waiting && navigator.serviceWorker.controller) avisar();
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing; if (!nw) return;
      nw.addEventListener('statechange', () => { if (nw.state === 'installed' && navigator.serviceWorker.controller) avisar(); });
    });
    setInterval(() => reg.update().catch(() => { }), 60 * 60 * 1000);
  }).catch(e => console.warn('SW', e));
  let recargando = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (recargando) return; recargando = true; location.reload(); });
}

boot();
