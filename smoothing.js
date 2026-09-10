// Catmull-Rom spline smoothing utilities for freehand strokes drawn with a mouse.

export function catmullRomToBezier(p0, p1, p2, p3) {
  return {
    c1: { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 },
    c2: { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 },
  };
}

/**
 * Draws a smooth path through `points` (canvas-pixel space) using a
 * Catmull-Rom spline converted to cubic bezier segments.
 */
export function tracePath(ctx, points) {
  if (points.length === 0) return;

  if (points.length === 1) {
    const p = points[0];
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.01, p.y + 0.01);
    return;
  }

  if (points.length === 2) {
    ctx.moveTo(points[0].x, points[0].y);
    ctx.lineTo(points[1].x, points[1].y);
    return;
  }

  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const { c1, c2 } = catmullRomToBezier(p0, p1, p2, p3);
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, p2.x, p2.y);
  }
}

export function strokeSmoothPath(ctx, points, { color, width, alpha = 1, composite = 'source-over' }) {
  if (points.length === 0) return;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = composite;
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(width, 0.5);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  tracePath(ctx, points);
  ctx.stroke();
  ctx.restore();
}

/** Minimum spacing (in the same units as the input points) between recorded points. */
export function shouldRecordPoint(lastPoint, candidate, minDistance) {
  if (!lastPoint) return true;
  const dx = candidate.x - lastPoint.x;
  const dy = candidate.y - lastPoint.y;
  return dx * dx + dy * dy >= minDistance * minDistance;
}

/**
 * Samples points along the segment from `from` to `to` at roughly `spacing`
 * intervals, so a fast pointer swipe between two sparse pointermove samples
 * still gets tested at fine-enough resolution (used by the eraser hit test).
 */
export function sampleSweptPath(from, to, spacing) {
  if (!from) return [to];
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const step = Math.max(spacing, 0.25);
  const steps = Math.max(1, Math.ceil(dist / step));
  const pts = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    pts.push({ x: from.x + dx * t, y: from.y + dy * t });
  }
  return pts;
}

/**
 * Samples dense points along the same Catmull-Rom spline used for on-screen
 * strokes, so exporters that can't stroke a bezier curve directly (e.g.
 * pdf-lib's line drawing) can approximate it with short straight segments.
 */
export function sampleSmoothPath(points, segmentsPerCurve = 8) {
  if (points.length === 0) return [];
  if (points.length <= 2) return points.slice();

  const out = [points[0]];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    const { c1, c2 } = catmullRomToBezier(p0, p1, p2, p3);
    for (let s = 1; s <= segmentsPerCurve; s++) {
      const t = s / segmentsPerCurve;
      out.push(cubicBezierPoint(p1, c1, c2, p2, t));
    }
  }
  return out;
}

function cubicBezierPoint(p0, c1, c2, p1, t) {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p1.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p1.y,
  };
}

export function distancePointToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) {
    const ddx = p.x - a.x;
    const ddy = p.y - a.y;
    return Math.sqrt(ddx * ddx + ddy * ddy);
  }
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  const ddx = p.x - projX;
  const ddy = p.y - projY;
  return Math.sqrt(ddx * ddx + ddy * ddy);
}
