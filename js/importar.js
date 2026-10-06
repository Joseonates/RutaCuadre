// Lector de planillas en PDF sin IA.
// 1) extraerLineas: arma líneas de texto a partir de las posiciones que entrega pdf.js.
// 2) interpretar: reconoce clientes, facturas, direcciones, teléfonos y líneas de producto por patrones.

export async function extraerLineas(pdf, maxPaginas = 30, avance = () => {}) {
  const n = Math.min(pdf.numPages, maxPaginas);
  const lineas = [];
  let chars = 0;
  for (let i = 1; i <= n; i++) {
    avance(i, n);
    const pg = await pdf.getPage(i);
    const tc = await pg.getTextContent();
    const filas = new Map();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 3);
      if (!filas.has(y)) filas.set(y, []);
      filas.get(y).push({ x: it.transform[4], s: it.str.trim(), w: it.width || 0 });
    }
    const ys = [...filas.keys()].sort((a, b) => b - a);
    // une filas separadas por 1 unidad (texto con ligera diferencia de altura)
    const grupos = [];
    for (const y of ys) {
      const g = grupos[grupos.length - 1];
      if (g && g.y - y <= 1) { g.items.push(...filas.get(y)); g.y = y; }
      else grupos.push({ y, items: [...filas.get(y)] });
    }
    for (const g of grupos) {
      g.items.sort((a, b) => a.x - b.x);
      let out = '', fin = null;
      for (const it of g.items) {
        if (fin !== null) out += (it.x - fin > 12) ? ' | ' : ' ';
        out += it.s; fin = it.x + it.w;
      }
      chars += out.replace(/\s|\|/g, '').length;
      lineas.push(out);
    }
    lineas.push('');
  }
  return { lineas, paginas: n, total: pdf.numPages, escaneado: chars / n < 80 };
}

const reDinero = /^\$?\s*-?\d{1,3}(?:[.,]\d{3})+(?:[.,]\d{1,2})?$|^\$?\s*-?\d+(?:[.,]\d{1,2})?$/;
function numero(s) {
  let t = String(s).replace(/[$\s]/g, '');
  if (/^-?\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t)) t = t.replace(/,/g, '');
  else t = t.replace(',', '.');
  const n = parseFloat(t);
  return isFinite(n) ? n : NaN;
}
const esNum = s => reDinero.test(String(s).trim());
const tieneLetras = s => /[A-Za-zÁÉÍÓÚÑáéíóúñ]{2,}/.test(s);
const reCodigo = /^[A-Z0-9][A-Z0-9.\-\/]{1,15}$/i;

function cuadra(c, u, t) { return c > 0 && u > 0 && Math.abs(c * u - t) <= Math.max(2, t * 0.01); }

function lineaProducto(celdas, linea) {
  let cs = celdas.map(c => c.trim()).filter(Boolean);
  if (cs.length === 1) {
    // texto sin columnas: intenta "COD Descripción 12 11.500 138.000"
    const m = linea.match(/^(?:([A-Z0-9][A-Z0-9\-\/]{1,14})\s+)?(.+?)\s+(\d{1,5}(?:[.,]\d{1,2})?)\s+\$?\s?([\d.,]+)\s+\$?\s?([\d.,]+)\s*$/);
    if (!m || !cuadra(numero(m[3]), numero(m[4]), numero(m[5]))) return null;
    cs = [m[1], m[2], m[3], m[4], m[5]].filter(Boolean);
  }
  // montos con espacio en vez de punto de miles ("$2 100" → "$2.100")
  cs = cs.map(c => /^\$?\s?\d{1,3}(?: \d{3})+$/.test(c) ? c.replace(/ (?=\d{3})/g, '.') : c);
  let codigo = '';
  const pareceCodigo = c => reCodigo.test(c) && !esNum(c) && (/\d/.test(c) && /[A-Z]/i.test(c) || /^[A-Z0-9]+[-\/.][A-Z0-9]+$/.test(c));
  if (cs.length >= 3 && pareceCodigo(cs[0]) && tieneLetras(cs[1])) codigo = cs.shift();
  const idxTexto = cs.findIndex(c => tieneLetras(c) && !esNum(c));
  if (idxTexto < 0) return null;
  const lead = [];
  for (let k = 0; k < idxTexto; k++) {
    if (k === 0 && !codigo && reCodigo.test(cs[0]) && /\d/.test(cs[0]) && /[A-Z]/i.test(cs[0])) codigo = cs[0];
    else if (esNum(cs[k])) lead.push({ s: cs[k], n: numero(cs[k]) });
    else return null;
  }
  let k = idxTexto;
  const desc = [];
  for (; k < cs.length && !esNum(cs[k]); k++) desc.push(cs[k]);
  const nums = cs.slice(k).filter(esNum).map(numero);
  const producto = desc.join(' ').trim();
  if (!producto || /^(c[oó]digo|descripci[oó]n|producto|referencia|art[ií]culo)$/i.test(producto)) return null;
  const ok = (c, u, t, dudoso) => ({ codigo, producto, cantidad: Math.round(c), precio: Math.round(u), total: Math.round(t), dudoso: !!dudoso });
  const entero = c => Number.isFinite(c) && Math.abs(c - Math.round(c)) < 0.001 && c > 0 && c < 100000;
  // 1) terna cantidad × unitario = total en las columnas finales
  for (let a = 0; a + 2 < nums.length; a++) if (cuadra(nums[a], nums[a + 1], nums[a + 2])) {
    if (!codigo && lead.length === 1) codigo = lead[0].s; // número inicial era un código
    return ok(nums[a], nums[a + 1], nums[a + 2]);
  }
  // 2) cantidad al inicio de la línea y unitario + total al final
  if (lead.length) {
    const c = lead[lead.length - 1].n;
    if (lead.length === 2 && !codigo) codigo = lead[0].s;
    for (let a = 0; a + 1 < nums.length; a++) if (cuadra(c, nums[a], nums[a + 1])) return ok(c, nums[a], nums[a + 1]);
    if (entero(c) && nums.length === 1 && nums[0] > 0) return ok(c, nums[0], c * nums[0], true);
    if (entero(c) && nums.length >= 2) return ok(c, nums[0], c * nums[0], true);
    return null;
  }
  // 3) sin terna que cuadre: cantidad y valor al final
  if (nums.length >= 2 && entero(nums[0]) && nums[1] > 0) return ok(nums[0], nums[1], nums[0] * nums[1], true);
  return null;
}

const reIgnorar = /^(sub\s*total|total|valor total|gran total|recibido|firma|despach[oó]|elabor[oó]|p[aá]gina \d)/i;
const reClienteNum = /^\s*(\d{1,3})\s*[.)\-]\s+(.+)$/;
const reClienteEtq = /\b(?:cliente|raz[oó]n social|se[nñ]or(?:es)?)\s*:\s*([^|·]+)/i;
const reFactura = /\b(?:factura|fact\.?|fra\.?|remisi[oó]n|pedido|documento|doc\.)\s*(?:de venta\s*)?(?:n[°º.o]*\s*)?[:#]?\s*([A-Z]{0,5}[\s-]?\d[\dA-Z\-]{1,})/i;
const reFV = /\b(FV|FE|FAC|FC|REM)[\s-]?(\d{2,}[\dA-Z\-]*)\b/;
const reDireccionEtq = /\b(?:direcci[oó]n|dir\.)\s*(?::|\|)?\s*([^|·]+)/i;
const reVia = /\b((?:avenida|av\.?|ak|ac|calle|cll?\.?|carrera|cra\.?|kra\.?|kr\.?|cr\.?|diagonal|dg\.?|transversal|tv\.?|km\.?|kil[oó]metro)\s*\d[^|·]*)/i;
const reTelEtq = /\b(?:tel[eé]?f?o?n?o?s?|tel\.?|cel(?:ular)?\.?|m[oó]vil|whatsapp)\s*[:|]?\s*(\+?57\s?)?([\d][\d\s\-]{6,14}\d)/i;
const reCel = /\b(3\d{2}[\s-]?\d{3}[\s-]?\d{4})\b/;

function limpiarNombre(s) {
  return s.split('|')[0]
    .replace(/\b(C\.?C\.?|NIT|N\.I\.T\.?|CED(?:ULA)?\.?)\s*[:#]?\s*[\d.\-]+.*$/i, '')
    .replace(/\s{2,}/g, ' ').trim().replace(/[.,;:-]+$/, '');
}
// En fotos, el símbolo # a veces se lee como 4, 41, %* o *. Se corrige solo cuando el número resultante sería imposible.
export function corregirNumeral(dir) {
  const via = '(?:avenida|av\\.?|ak|ac|calle|cll?\\.?|carrera|cra\\.?|kra\\.?|kr\\.?|cr\\.?|diagonal|dg\\.?|transversal|tv\\.?)';
  const re = new RegExp('^(' + via + '\\s*\\d{1,3}\\s?(?:[A-H](?![a-z]))?(?:\\s?bis)?(?:\\s?[A-H](?![a-z]))?(?:\\s?(?:sur|este))?)\\s+(?:(%\\*|\\*|%|H|tt|ff|[4892]\\s)\\s*|(41|82|4|8|9|2)(?=\\d))(\\d{1,3}\\s?[A-H]?\\s*[-.]\\s*\\d{1,3}.*)$', 'i');
  dir = String(dir).replace(/^C1(?=\d)/, 'Cl ').replace(/^(\S+\s*\d{1,3}\S*\s+#?\s*\d{1,3}[A-H]?)\.(\d{1,3})\b/i, '$1-$2');
  const m = dir.match(re);
  if (!m) return dir;
  const [, ini, simbolo, pref, resto] = m;
  if (simbolo) return `${ini} #${resto}`;
  const pegado = parseInt(pref + resto, 10);
  if (pref.length === 2 && parseInt(pref[1] + resto, 10) < 200 && pref !== '41' && pref !== '82') return `${ini} #${pref[1]}${resto}`;
  if (pegado < 200) return dir;              // p. ej. "Cl 58 45-30" es válido y no se toca
  return `${ini} #${resto}`;
}
function limpiarDireccion(s) {
  return s.replace(/\s*(?:barrio|br\.?|b\/|sector|urb\.?)\b.*$/i, '')
    .replace(/\s*\b(?:tel[eé]?f?o?n?o?|tel\.?|cel\.?)\b.*$/i, '')
    .replace(/\s{2,}/g, ' ').trim().replace(/[.,;:-]+$/, '');
}
// Quita basura al inicio del renglón (marcas o letras sueltas que deja una foto).
function quitarBasura(linea) {
  const cs = linea.split(' | ');
  while (cs.length > 1 && /^(?:[^\wÁÉÍÓÚÑáéíóúñ$#]{1,3}|[a-zA-Z]{1,2}|[^\w\s]{1,4}\w?)$/.test(cs[0].trim()) && !/^\d/.test(cs[0].trim())) cs.shift();
  return cs.join(' | ');
}

export function interpretar(lineas) {
  const clientes = [];
  const avisos = [];
  const nuevo = () => ({ cliente: '', direccion: '', telefono: '', factura: '', nuevo: false });
  let pend = nuevo();
  let actual = null;
  let enBloque = false; // estamos leyendo productos del cliente actual
  for (const raw of lineas) {
    const linea = quitarBasura(String(raw || '').trim());
    if (!linea) continue;
    const celdas = linea.split(' | ');
    if (reIgnorar.test(linea)) {
      const tot = /total/i.test(celdas[0]) ? celdas.slice(1).map(c => c.trim()).filter(esNum).map(numero).pop() : NaN;
      if (actual && isFinite(tot) && /factura|pedido|remisi/i.test(linea)) actual.totalDoc = tot;
      continue;
    }
    const pareceEncabezado = reDireccionEtq.test(linea) || reTelEtq.test(linea) || reFactura.test(linea) || reClienteEtq.test(linea) ||
      (reClienteNum.test(linea) && !/\|/.test(linea.split(' | ')[0].replace(reClienteNum, '')) && celdas.length <= 2 && !celdas.slice(1).some(esNum));
    const prod = pareceEncabezado ? null : lineaProducto(celdas, linea);
    if (prod) {
      if (!actual || pend.nuevo) {
        actual = { cliente: pend.cliente, direccion: pend.direccion, telefono: pend.telefono, factura: pend.factura, items: [] };
        clientes.push(actual);
        pend = nuevo();
      }
      actual.items.push(prod);
      enBloque = true;
      continue;
    }
    // información de encabezado de cliente
    let m;
    if ((m = linea.match(reClienteNum)) && tieneLetras(m[2]) && !esNum(m[2])) {
      pend = nuevo(); pend.cliente = limpiarNombre(m[2]); pend.nuevo = true; enBloque = false;
    } else if ((m = linea.match(reClienteEtq))) {
      pend = nuevo(); pend.cliente = limpiarNombre(m[1]); pend.nuevo = true; enBloque = false;
    }
    if ((m = linea.match(reFactura)) || (m = linea.match(reFV))) {
      const f = (m[2] ? `${m[1]}-${m[2]}` : m[1]).replace(/\s+/g, '').replace(/--+/g, '-');
      if (!pend.factura) { if (enBloque && !pend.nuevo) pend = nuevo(); pend.factura = f; pend.nuevo = true; }
    }
    if (!pend.direccion) {
      if ((m = linea.match(reDireccionEtq)) && m[1].trim()) pend.direccion = corregirNumeral(limpiarDireccion(m[1]));
      else if (pend.nuevo && (m = linea.match(reVia))) pend.direccion = corregirNumeral(limpiarDireccion(m[1]));
    }
    if (!pend.telefono && (m = linea.match(reTelEtq) || linea.match(reCel))) {
      pend.telefono = (m[2] || m[1] || '').replace(/[^\d]/g, '').replace(/^57(?=3\d{9}$)/, '');
    }
  }
  clientes.forEach((c, i) => {
    if (!c.cliente) { c.cliente = c.factura ? `Cliente factura ${c.factura}` : `Cliente ${i + 1}`; avisos.push(`Al cliente ${i + 1} no le encontré el nombre.`); }
    if (!c.direccion) avisos.push(`${c.cliente}: sin dirección.`);
    const suma = c.items.reduce((a, it) => a + it.total, 0);
    if (c.totalDoc && Math.abs(c.totalDoc - suma) > 2) avisos.push(`${c.cliente}: los productos suman ${suma.toLocaleString('es-CO')} y el documento dice ${c.totalDoc.toLocaleString('es-CO')}.`);
    if (c.items.some(it => it.dudoso)) avisos.push(`${c.cliente}: revisa cantidades y precios, no pude comprobarlos con el total de la línea.`);
  });
  const filas = [];
  for (const c of clientes) for (const it of c.items) filas.push({
    cliente: c.cliente, direccion: c.direccion, telefono: c.telefono, factura: c.factura,
    referencia: it.codigo, producto: it.producto, cantidad: it.cantidad, precio: it.precio
  });
  return { filas, clientes: clientes.length, avisos };
}
