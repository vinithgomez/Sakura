// ---------------------------------------------------------------------------
// Dev check: is every blossom / leaf spray attached to a branch?
//
// Rebuilds the rendered branch tubes from the wood mesh itself (ring centres
// from aAxis, ring radii from the actual ring vertices, aFlex per ring), then,
// for several season positions and wind phases, moves branches and spray hubs
// with the same windOffset() the shaders use and measures the distance from
// each visible spray's hub to the nearest branch surface (0 = on or inside the
// bark). Loaded on demand from the console: __sakura.checkSprayAttachment().
// ---------------------------------------------------------------------------

// JS twin of shaders/wind.glsl windOffset()
function windOffset(x, y, z, flex, t, strength, dx, dz, out) {
  const w = x * dx + z * dz;
  const gust = 0.55 + 0.45 * Math.sin(t * 0.6 - w * 0.22) * Math.sin(t * 0.27 + 1.7 - w * 0.09);
  const phase = x * 0.21 + y * 0.13 + z * 0.17;
  const bend = gust * 0.75 + Math.sin(t * 1.25 + phase) * 0.32 + Math.sin(t * 2.4 + phase * 1.7) * 0.1;
  const sway = Math.sin(t * 1.65 + phase * 1.3) * 0.22 + Math.sin(t * 3.3 + phase * 2.3) * 0.06;
  const k = flex * strength * 0.42;
  const ox = (dx * bend - dz * sway) * k;
  const oz = (dz * bend + dx * sway) * k;
  out[0] = ox;
  out[1] = -(ox * ox + oz * oz) * 0.35;
  out[2] = oz;
  return out;
}

/** Ring centres, radii and flex, in mesh order, from the wood geometry. */
function readRings(geometry) {
  const pos = geometry.attributes.position.array;
  const axis = geometry.attributes.aAxis.array;
  const flex = geometry.attributes.aFlex.array;
  const rings = [];
  let cur = null;
  for (let v = 0; v < flex.length; v++) {
    const ax = axis[v * 3], ay = axis[v * 3 + 1], az = axis[v * 3 + 2];
    if (!cur || cur.x !== ax || cur.y !== ay || cur.z !== az) {
      cur = { x: ax, y: ay, z: az, r: Infinity, f: flex[v] };
      rings.push(cur);
    }
    const d = Math.hypot(pos[v * 3] - ax, pos[v * 3 + 1] - ay, pos[v * 3 + 2] - az);
    if (d > 1e-5) cur.r = Math.min(cur.r, d); // inscribed radius (ignores cap centres)
  }
  for (const r of rings) if (!Number.isFinite(r.r)) r.r = 0;
  return rings;
}

/** Segments between consecutive rings of the same chain (ring spacing is ≤ 0.16). */
function segmentsFrom(rings, t, strength, dx, dz) {
  const o = [0, 0, 0];
  const moved = rings.map((r) => {
    windOffset(r.x, r.y, r.z, r.f, t, strength, dx, dz, o);
    return { x: r.x + o[0], y: r.y + o[1], z: r.z + o[2], r: r.r };
  });
  const segs = [];
  for (let i = 1; i < moved.length; i++) {
    const a = moved[i - 1], b = moved[i];
    if (Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) < 0.3) segs.push([a, b]);
  }
  return segs;
}

const CELL = 0.5;
const key = (i, j, k) => `${i},${j},${k}`;

function gridOf(segs) {
  const grid = new Map();
  for (const s of segs) {
    const [a, b] = s;
    const lo = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)].map((v) => Math.floor(v / CELL));
    const hi = [Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)].map((v) => Math.floor(v / CELL));
    for (let i = lo[0]; i <= hi[0]; i++)
      for (let j = lo[1]; j <= hi[1]; j++)
        for (let k = lo[2]; k <= hi[2]; k++) {
          const kk = key(i, j, k);
          if (!grid.has(kk)) grid.set(kk, []);
          grid.get(kk).push(s);
        }
  }
  return grid;
}

/** Distance from p to the surface of the nearest tube segment (0 when inside). Capped at CELL. */
function surfaceDistance(grid, px, py, pz) {
  const ci = Math.floor(px / CELL), cj = Math.floor(py / CELL), ck = Math.floor(pz / CELL);
  let best = CELL;
  for (let i = ci - 1; i <= ci + 1; i++)
    for (let j = cj - 1; j <= cj + 1; j++)
      for (let k = ck - 1; k <= ck + 1; k++) {
        const list = grid.get(key(i, j, k));
        if (!list) continue;
        for (const [a, b] of list) {
          const ex = b.x - a.x, ey = b.y - a.y, ez = b.z - a.z;
          const len2 = ex * ex + ey * ey + ez * ez || 1e-12;
          const u = Math.min(1, Math.max(0, ((px - a.x) * ex + (py - a.y) * ey + (pz - a.z) * ez) / len2));
          const d = Math.hypot(px - a.x - ex * u, py - a.y - ey * u, pz - a.z - ez * u) - (a.r + (b.r - a.r) * u);
          if (d < best) best = d;
        }
      }
  return Math.max(0, best);
}

/** Calibration: rest-pose distances of arbitrary points (e.g. the anchors) to the branch surface. */
export function restDistances(tree, points) {
  const grid = gridOf(segmentsFrom(readRings(tree.wood.geometry), 0, 0, 1, 0));
  let max = 0;
  for (const p of points) max = Math.max(max, surfaceDistance(grid, p.x, p.y, p.z));
  return { points: points.length, max: +max.toFixed(5) };
}

const smoothstep = (a, b, v) => {
  const t = Math.min(1, Math.max(0, (v - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * @returns {{ rows: object[], overall: { sprays: number, max: number, over: number, threshold: number } }}
 */
export function checkSprayAttachment({ tree, seasons, windDir }, {
  years = { 'early spring (Usui)': 0.06, 'full bloom': 0.17, summer: 0.43, autumn: 0.715 },
  times = [0, 1.7, 3.9, 7.3, 12.6],
  threshold = 0.02,
} = {}) {
  const rings = readRings(tree.wood.geometry);
  const dx = windDir.x, dz = windDir.y;
  const saved = { year: seasons.year, target: seasons.target, autoplay: seasons.autoplay };
  const rows = [];
  let all = 0, allMax = 0, allOver = 0;
  const o = [0, 0, 0];

  for (const [label, y] of Object.entries(years)) {
    seasons.autoplay = false;
    seasons.year = seasons.target = y;
    const state = seasons.update(0);
    const layers = [
      ['blossoms', tree.blossoms, state.blossoms],
      ['leaves', tree.leaves, state.leaves],
    ].filter(([, , presence]) => presence > 0.001);

    for (const t of times) {
      const grid = gridOf(segmentsFrom(rings, t, state.wind, dx, dz));
      let n = 0, max = 0, over = 0, sum = 0;
      for (const [, layer, presence] of layers) {
        const c = layer.geometry.attributes.aCenter.array;
        const f = layer.geometry.attributes.aFlex.array;
        const rnd = layer.geometry.attributes.aRand.array;
        for (let i = 0; i < f.length; i++) {
          const x = rnd[i * 4];
          if (smoothstep(x * 0.9, x * 0.9 + 0.1, presence) < 0.01) continue; // not visible now
          const cx = c[i * 3], cy = c[i * 3 + 1], cz = c[i * 3 + 2];
          windOffset(cx, cy, cz, f[i], t, state.wind, dx, dz, o);
          const d = surfaceDistance(grid, cx + o[0], cy + o[1], cz + o[2]);
          n++;
          sum += d;
          if (d > max) max = d;
          if (d > threshold) over++;
        }
      }
      rows.push({ season: label, year: y, windTime: t, wind: +state.wind.toFixed(2), sprays: n, maxDist: +max.toFixed(4), meanDist: +(sum / Math.max(1, n)).toFixed(4), over: over });
      all += n;
      allOver += over;
      allMax = Math.max(allMax, max);
    }
  }

  seasons.year = saved.year;
  seasons.target = saved.target;
  seasons.autoplay = saved.autoplay;
  seasons.update(0);
  return { rows, overall: { sprays: all, max: +allMax.toFixed(4), over: allOver, threshold, note: `distances capped at ${CELL}` } };
}
