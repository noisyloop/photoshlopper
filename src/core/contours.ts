// Marching squares contour tracing + Douglas-Peucker simplification.
// Shared by the selection "marching ants" overlay and the die-cut sticker
// mesh exporter (silhouette -> polygon -> ExtrudeGeometry).

export type Point = [number, number];

/**
 * Trace iso-contours of `mask` (values 0..255, threshold at `threshold`).
 * Returns closed polylines in pixel coordinates. Border-following approach:
 * walks cell edges of the binary grid, emitting every boundary loop
 * (outer contours and holes alike).
 */
export function traceContours(mask: Uint8ClampedArray, w: number, h: number, threshold = 128): Point[][] {
  const inside = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] >= threshold;

  // horizontal + vertical boundary edges between differing cells
  // key: edge id; walk edges into loops
  const contours: Point[][] = [];
  // edge between pixel (x,y) top side: exists if inside(x,y) !== inside(x,y-1)
  const visitedH = new Uint8Array((w + 1) * (h + 1));
  const visitedV = new Uint8Array((w + 1) * (h + 1));

  const hEdge = (x: number, y: number) => inside(x, y) !== inside(x, y - 1);
  const vEdge = (x: number, y: number) => inside(x, y) !== inside(x - 1, y);

  for (let y = 0; y <= h; y++) {
    for (let x = 0; x < w; x++) {
      if (!hEdge(x, y) || visitedH[y * (w + 1) + x]) continue;
      // start tracing a loop from this horizontal edge
      const loop: Point[] = [];
      // walk along the boundary keeping inside on one side
      let cx = x, cy = y, dir: 0 | 1 | 2 | 3 = inside(cx, cy) ? 0 : 2; // 0=E,1=S,2=W,3=N
      const startX = cx, startY = cy, startDir = dir;
      let guard = w * h * 8;
      do {
        if (dir === 0 || dir === 2) visitedH[cy * (w + 1) + (dir === 0 ? cx : cx - 1)] = 1;
        else visitedV[(dir === 1 ? cy : cy - 1) * (w + 1) + cx] = 1;
        loop.push([cx, cy]);
        // advance one unit in dir
        if (dir === 0) cx += 1;
        else if (dir === 1) cy += 1;
        else if (dir === 2) cx -= 1;
        else cy -= 1;
        // choose next direction: prefer left turn, straight, right turn
        const turns: Array<0 | 1 | 2 | 3> = [((dir + 3) % 4) as 0 | 1 | 2 | 3, dir, ((dir + 1) % 4) as 0 | 1 | 2 | 3];
        let moved = false;
        for (const nd of turns) {
          if (canGo(cx, cy, nd)) {
            dir = nd;
            moved = true;
            break;
          }
        }
        if (!moved) break;
      } while ((cx !== startX || cy !== startY || dir !== startDir) && guard-- > 0);
      if (loop.length >= 3) contours.push(loop);
    }
  }

  function canGo(cx: number, cy: number, dir: 0 | 1 | 2 | 3): boolean {
    // moving along grid line from node (cx,cy) in dir must separate an inside
    // pixel from an outside pixel
    if (dir === 0) return cy >= 0 && cy <= h && cx >= 0 && cx < w && hEdge(cx, cy) && !visitedH[cy * (w + 1) + cx];
    if (dir === 2) return cy >= 0 && cy <= h && cx - 1 >= 0 && cx - 1 < w && hEdge(cx - 1, cy) && !visitedH[cy * (w + 1) + cx - 1];
    if (dir === 1) return cx >= 0 && cx <= w && cy >= 0 && cy < h && vEdge(cx, cy) && !visitedV[cy * (w + 1) + cx];
    return cx >= 0 && cx <= w && cy - 1 >= 0 && cy - 1 < h && vEdge(cx, cy - 1) && !visitedV[(cy - 1) * (w + 1) + cx];
  }

  return contours;
}

/** Ramer–Douglas–Peucker polyline simplification. */
export function simplifyDP(points: Point[], epsilon: number): Point[] {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = points[a];
    const [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1e-9;
    let maxD = 0, maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs((points[i][0] - ax) * dy - (points[i][1] - ay) * dx) / len;
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > epsilon && maxI > 0) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  const out: Point[] = [];
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i]);
  return out;
}

export function polygonArea(points: Point[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

export function pointInPolygon(p: Point, poly: Point[]): boolean {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
