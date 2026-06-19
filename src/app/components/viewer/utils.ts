
 
 
export function safeParseContours(json: string): number[][][] {
  try {
    const v = JSON.parse(json);
    if (!Array.isArray(v)) return [];
    return v as number[][][];
  } catch {
    return [];
  }
}
 
export function polygonsToPathD(polygons: number[][][]): string {
  const parts: string[] = [];
  for (const poly of polygons) {
    if (!poly.length) continue;
    let s = 'M' + poly[0][0] + ',' + poly[0][1];
    for (let i = 1; i < poly.length; i++) {
      s += 'L' + poly[i][0] + ',' + poly[i][1];
    }
    s += 'Z';
    parts.push(s);
  }
  return parts.join('');
}
 
export function polygonsBoundingGeom(polygons: number[][][]): { cx: number; cy: number; r: number } | null {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let count = 0;
  for (const poly of polygons) {
    for (const [x, y] of poly) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      count++;
    }
  }
  if (!count) return null;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const r = (maxX - minX) / 2;
  return { cx, cy, r };
}
