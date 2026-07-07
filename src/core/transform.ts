// Inverse layer-transform as affine uv coefficients:
//   layerU = a*u + b*v + c ;  layerV = d*u + e*v + f
// Used by the compositor (as a mat3 uniform) and baked as constants by the
// shader exporter — one implementation so exports match the canvas.

import type { Transform } from '../types';

export interface InvUvCoeffs { a: number; b: number; c: number; d: number; e: number; f: number }

export function invUvCoeffs(t: Transform, w: number, h: number): InvUvCoeffs {
  const cx = w / 2;
  const cy = h / 2;
  const cos = Math.cos(t.rotation);
  const sin = Math.sin(t.rotation);
  const isx = 1 / (t.scaleX || 1e-6);
  const isy = 1 / (t.scaleY || 1e-6);
  // layerPx = S^-1 * R^-1 * (docPx - center - translate) + center; uv = px/size
  const map = (u: number, v: number): [number, number] => {
    const qx = u * w - cx - t.x;
    const qy = v * h - cy - t.y;
    const rx = qx * cos + qy * sin;
    const ry = -qx * sin + qy * cos;
    return [(rx * isx + cx) / w, (ry * isy + cy) / h];
  };
  const o = map(0, 0);
  const du = map(1, 0);
  const dv = map(0, 1);
  return { a: du[0] - o[0], b: dv[0] - o[0], c: o[0], d: du[1] - o[1], e: dv[1] - o[1], f: o[1] };
}

export function isIdentity(t: Transform): boolean {
  return t.x === 0 && t.y === 0 && t.scaleX === 1 && t.scaleY === 1 && t.rotation === 0;
}
