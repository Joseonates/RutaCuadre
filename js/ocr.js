// Lectura de fotos de planillas con OCR (Tesseract, en español) dentro del mismo celular.
// No envía la foto a ningún servidor. Devuelve líneas de texto con " | " entre columnas,
// listas para el intérprete de importar.js.

const BASE = 'vendor/ocr/';
let workerPromise = null;

function cargarScript(src) {
  return new Promise((res, rej) => {
    if (window.Tesseract) return res();
    const el = document.createElement('script'); el.src = src;
    el.onload = res; el.onerror = () => rej(new Error('No se pudo cargar el lector de fotos.'));
    document.head.appendChild(el);
  });
}

async function obtenerWorker(avance) {
  if (!workerPromise) {
    workerPromise = (async () => {
      await cargarScript(BASE + 'tesseract.min.js');
      const abs = u => new URL(u, location.href).href;
      const w = await window.Tesseract.createWorker('spa', 1, {
        workerPath: abs(BASE + 'worker.min.js'),
        corePath: abs(BASE),
        langPath: abs(BASE),
        gzip: true,
        cacheMethod: 'write',
        logger: m => { if (obtenerWorker.avance && m && m.status) obtenerWorker.avance(m); }
      });
      await w.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1', user_defined_dpi: '300' });
      return w;
    })();
    workerPromise.catch(() => { workerPromise = null; });
  }
  obtenerWorker.avance = avance;
  return workerPromise;
}

function cargarImagen(file) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('No se pudo abrir la foto.'));
    img.src = URL.createObjectURL(file);
  });
}

// Prepara la foto: tamaño adecuado, escala de grises y corrección de sombras e iluminación desigual.
export async function prepararFoto(file, anchoObjetivo = 2200) {
  let src;
  try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { src = await cargarImagen(file); }
  const esc = Math.min(2.5, anchoObjetivo / src.width);
  const W = Math.round(src.width * esc), H = Math.round(src.height * esc);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, W, H);
  // fondo estimado: versión muy reducida y vuelta a ampliar (equivale a un desenfoque amplio)
  const bw = Math.max(8, Math.round(W / 40)), bh = Math.max(8, Math.round(H / 40));
  const bg = document.createElement('canvas'); bg.width = bw; bg.height = bh;
  const bctx = bg.getContext('2d'); bctx.imageSmoothingQuality = 'high'; bctx.drawImage(cv, 0, 0, bw, bh);
  const bg2 = document.createElement('canvas'); bg2.width = W; bg2.height = H;
  const b2 = bg2.getContext('2d', { willReadFrequently: true }); b2.imageSmoothingQuality = 'high'; b2.drawImage(bg, 0, 0, W, H);
  const img = ctx.getImageData(0, 0, W, H), d = img.data, fb = b2.getImageData(0, 0, W, H).data;
  for (let i = 0; i < d.length; i += 4) {
    const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const f = 0.299 * fb[i] + 0.587 * fb[i + 1] + 0.114 * fb[i + 2];
    let v = f > 10 ? (g / f) * 255 : g;          // divide por el fondo: elimina sombras
    v = (v - 60) * (255 / 175);                   // estira el contraste
    v = v < 0 ? 0 : v > 255 ? 255 : v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return cv;
}

// Corrige confusiones típicas del OCR en montos y cantidades.
function limpiarToken(t) {
  let s = t.replace(/[“”"'`´]/g, '');
  if (/^[S$§][\d.,]{2,}$/.test(s)) s = '$' + s.slice(1);
  if (/^\$?[\dOoIl|.,]+$/.test(s) && /\d/.test(s)) s = s.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1');
  return s;
}

// Une las palabras de cada renglón; un espacio grande entre palabras es un cambio de columna.
function armarLineas(data) {
  const out = [];
  const lineas = [];
  for (const b of data.blocks || []) for (const p of b.paragraphs || []) for (const l of p.lines || []) lineas.push(l);
  for (const l of lineas) {
    const ws = (l.words || []).filter(w => w.text && w.text.trim() && w.confidence > 15);
    if (!ws.length) continue;
    ws.sort((a, b) => a.bbox.x0 - b.bbox.x0);
    const alturas = ws.map(w => w.bbox.y1 - w.bbox.y0).sort((a, b) => a - b);
    const h = alturas[Math.floor(alturas.length / 2)] || 20;
    let s = '', fin = null;
    for (const w of ws) {
      if (fin !== null) s += (w.bbox.x0 - fin > h * 1.1) ? ' | ' : ' ';
      s += limpiarToken(w.text.trim());
      fin = w.bbox.x1;
    }
    out.push(s.replace(/\s*\|\s*\|\s*/g, ' | ').trim());
  }
  return out;
}

export async function leerFotos(files, avance = () => { }) {
  const todas = [];
  let confianza = 0;
  for (let i = 0; i < files.length; i++) {
    avance({ paso: 'preparar', i: i + 1, n: files.length });
    const cv = await prepararFoto(files[i]);
    const w = await obtenerWorker(m => {
      if (m.status === 'recognizing text') avance({ paso: 'leer', i: i + 1, n: files.length, p: m.progress || 0 });
      else avance({ paso: 'cargar', i: i + 1, n: files.length, p: m.progress || 0, estado: m.status });
    });
    avance({ paso: 'leer', i: i + 1, n: files.length, p: 0 });
    const { data } = await w.recognize(cv, {}, { blocks: true, text: true });
    confianza += data.confidence || 0;
    todas.push(...armarLineas(data), '');
  }
  return { lineas: todas, confianza: Math.round(confianza / files.length) };
}

export async function terminarOCR() {
  if (!workerPromise) return;
  try { const w = await workerPromise; await w.terminate(); } catch (e) { }
  workerPromise = null;
}
