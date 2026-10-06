// Ubicación aproximada por nomenclatura colombiana (calle con carrera) y optimización del orden de visita.
const VIA_CALLE = /^(AVENIDA CALLE|AV CALLE|AV CL|AVENIDA CL|CALLE|CALL|CLL|CL|AC|DIAGONAL|DIAG|DG)\b/;
const VIA_CARRERA = /^(AVENIDA CARRERA|AV CARRERA|AV CRA|AV KR|AVENIDA CRA|CARRERA|CARRRERA|CRA|CRR|KRA|KR|CR|AK|K|TRANSVERSAL|TRANSV|TV|TR)\b/;
export function normDir(s){
  return String(s || '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/N[°º]/g, '#').replace(/\bNRO\b|\bNUM(ERO)?\b/g, '#').replace(/\./g, ' ')
    .replace(/\bNO(?=\s*\d)/g, '#').replace(/\s+/g, ' ').trim();
}
export function parseDir(s){
  const t = normDir(s); let tipo = null, rest = '', m;
  if ((m = t.match(VIA_CALLE))){ tipo = 'calle'; rest = t.slice(m[0].length); }
  else if ((m = t.match(VIA_CARRERA))){ tipo = 'carrera'; rest = t.slice(m[0].length); }
  if (!tipo) return null;
  const r = rest.match(/^\s*(\d{1,3})\s*([A-H](?![A-Z]))?\s*(BIS)?\s*([A-H](?![A-Z]))?\s*(?:SUR|ESTE)?\s*(?:#|-|\s)\s*(\d{1,3})\s*([A-H](?![A-Z]))?\s*(BIS)?\s*([A-H](?![A-Z]))?\s*(?:-\s*(\d{1,3}))?/);
  if (!r) return null;
  const val = (n, l1, bis, l2) => +n + (l1 ? (l1.charCodeAt(0) - 64) * 0.08 : 0) + (bis ? 0.1 : 0) + (l2 ? 0.05 : 0);
  const p = val(r[1], r[2], r[3], r[4]);
  const c = val(r[5], r[6], r[7], r[8]) + (r[9] ? Math.min(+r[9], 99) / 100 : 0);
  let calle = tipo === 'calle' ? p : c, carrera = tipo === 'calle' ? c : p;
  if (/\bSUR\b/.test(rest)) calle = -calle;
  if (/\bESTE\b/.test(rest)) carrera = -carrera;
  return {calle, carrera};
}
export const dist = (a, b) => Math.abs(a.calle - b.calle) + Math.abs(a.carrera - b.carrera);
export function costo(seq, start, regreso){
  let c = 0; if (!seq.length) return 0;
  if (start) c += dist(start, seq[0]);
  for (let k = 1; k < seq.length; k++) c += dist(seq[k-1], seq[k]);
  if (start && regreso) c += dist(seq[seq.length-1], start);
  return c;
}
export function optimizar(pts, start, regreso){
  const ok = pts.filter(p => p.u), bad = pts.filter(p => !p.u);
  if (ok.length < 2) return [...ok, ...bad].map(p => p.i);
  const nn = first => { const rest = ok.slice(), out = []; let cur = first;
    while (rest.length){ let bi = 0, bd = Infinity; rest.forEach((p, j) => { const d = dist(cur, p.u); if (d < bd){ bd = d; bi = j; } }); cur = rest[bi].u; out.push(rest.splice(bi, 1)[0]); }
    return out; };
  let best;
  if (start) best = nn(start);
  else { let bc = Infinity; ok.slice(0, 40).forEach(p => { const s = nn(p.u); const c = costo(s.map(x => x.u), null, false); if (c < bc){ bc = c; best = s; } }); }
  const A = best.slice(), U = i => i < 0 ? start : A[i].u, n = A.length;
  const closed = !!(start && regreso);
  for (let it = 0, mejoro = true; mejoro && it < 60; it++){
    mejoro = false;
    for (let i = 0; i < n - 1; i++) for (let k = i + 1; k < n; k++){
      const prev = i > 0 ? A[i-1].u : start, next = k < n - 1 ? A[k+1].u : (closed ? start : null);
      const d0 = (prev ? dist(prev, A[i].u) : 0) + (next ? dist(A[k].u, next) : 0);
      const d1 = (prev ? dist(prev, A[k].u) : 0) + (next ? dist(A[i].u, next) : 0);
      if (d1 < d0 - 1e-9){ A.splice(i, k - i + 1, ...A.slice(i, k + 1).reverse()); mejoro = true; }
    }
  }
  return [...A, ...bad].map(p => p.i);
}

export const kmDe = cuadras => cuadras * 0.1;
export const kmTxt = c => '≈ ' + kmDe(c).toLocaleString('es-CO', { maximumFractionDigits: 1 }) + ' km';
export const lblDir = u => u ? `Calle ${Math.floor(Math.abs(u.calle))}${u.calle < 0 ? ' Sur' : ''} con Carrera ${Math.floor(Math.abs(u.carrera))}${u.carrera < 0 ? ' Este' : ''}` : '';
export function costoParadas(ps, start, regreso) { return costo(ps.map(p => parseDir(p.direccion)).filter(Boolean), start, regreso); }
