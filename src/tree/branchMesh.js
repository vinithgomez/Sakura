import { BufferAttribute, BufferGeometry, CatmullRomCurve3, Color, Quaternion, Vector3 } from 'three';

// ---------------------------------------------------------------------------
// Branch chains → one merged tube mesh.
//
// • Each chain is a centripetal Catmull-Rom curve through its nodes, resampled
//   into rings; radius tapers per ring.
// • Ring frames use parallel transport (no twisting); ring resolution drops as
//   the branch thins and rings of different resolution are "zipper" stitched,
//   so there are no cracks.
// • Junctions: a child chain starts on its parent's axis with a flared collar,
//   and near the base its normals are blended toward the parent's surface
//   normal so the two read as one continuous surface.
// • The trunk gets a root flare with buttress lobes.
// • Normals are analytic, including the radius change along the branch and
//   around the lobes.
// • Extra attributes: aFlex (wind weight), aAxis (ring centre — lets the
//   vertex shader keep thin twigs at a minimum on-screen width).
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
const BARK_TILE = 0.9; // world size of one bark texture tile around a limb

// never fewer than 8 sides: a real round tube from every angle, even edge-on
export const radialFor = (r) => (r > 0.3 ? 28 : r > 0.17 ? 20 : r > 0.09 ? 14 : r > 0.05 ? 10 : 8);

const smooth = (a, b, v) => {
  const t = Math.min(Math.max((v - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * @param {Array} chains  [{ points: [{pos, radius, dist}], junction?: {point, tangent, radius, collar, flare?}, rootFlare?: {phase}, flexScale? }]
 * @param {{maxDist: number, tint: (radius: number, out: Color) => Color}} opts
 * @returns {{ geometry: BufferGeometry, samples: Array<{pos: Vector3, radius: number, dist: number, end: boolean}> }}
 */
export function buildBranchGeometry(chains, { maxDist, tint }) {
  const rings = chains.map((c) => sampleChain(c));

  // count
  let vCount = 0;
  let iCount = 0;
  for (const chainRings of rings) {
    let prevR = 0;
    chainRings.forEach((ring, k) => {
      vCount += ring.R + 1;
      if (k > 0) iCount += (ring.R + prevR) * 3;
      prevR = ring.R;
    });
    vCount += 2 + chainRings[0].R + 1; // cap centres + the start cap's own rim
    iCount += (chainRings[0].R + prevR) * 3;
  }

  const position = new Float32Array(vCount * 3);
  const normal = new Float32Array(vCount * 3);
  const uv = new Float32Array(vCount * 2);
  const color = new Float32Array(vCount * 3);
  const flex = new Float32Array(vCount);
  const axis = new Float32Array(vCount * 3);
  const index = new Uint32Array(iCount);
  const samples = [];

  const N = new Vector3();
  const B = new Vector3();
  const q = new Quaternion();
  const dir = new Vector3();
  const perp = new Vector3();
  const n = new Vector3();
  const pn = new Vector3();
  const rel = new Vector3();
  const vert = new Vector3();
  const col = new Color();
  let v = 0;
  let ii = 0;

  // Close a chain's first ring with a flat fan facing back along −T. Seals the
  // trunk base and the root ends (and the child bases tucked inside their
  // parents), so every branch is a watertight tube. The rim is duplicated so
  // the disc gets its own flat normal instead of the tube's radial ones.
  const startCap = (index, ii, ring0, R, ring, c, f) => {
    const back = [-ring.tangent.x, -ring.tangent.y, -ring.tangent.z];
    const centre = v++;
    position.set([ring.center.x, ring.center.y, ring.center.z], centre * 3);
    normal.set(back, centre * 3);
    uv.set([0.5, 0], centre * 2);
    color.set([c.r, c.g, c.b], centre * 3);
    flex[centre] = f;
    axis.set([ring.center.x, ring.center.y, ring.center.z], centre * 3);
    const rim = v;
    for (let j = 0; j <= R; j++, v++) {
      const src = ring0 + j;
      position.copyWithin(v * 3, src * 3, src * 3 + 3);
      normal.set(back, v * 3);
      uv.copyWithin(v * 2, src * 2, src * 2 + 2);
      color.copyWithin(v * 3, src * 3, src * 3 + 3);
      flex[v] = flex[src];
      axis.copyWithin(v * 3, src * 3, src * 3 + 3);
    }
    for (let j = 0; j < R; j++) {
      index[ii++] = centre;
      index[ii++] = rim + j + 1;
      index[ii++] = rim + j;
    }
    return ii;
  };

  chains.forEach((chain, ci) => {
    const chainRings = rings[ci];
    const repeats = Math.min(4, Math.max(1, Math.round((TAU * chainRings[0].radius) / BARK_TILE)));
    const baseR = chainRings[0].radius;
    const flexScale = chain.flexScale ?? 1;
    const jn = chain.junction;

    // initial frame normal ⟂ first tangent
    const T0 = chainRings[0].tangent;
    N.set(0, 0, 1);
    if (Math.abs(T0.z) > 0.9) N.set(1, 0, 0);
    N.addScaledVector(T0, -N.dot(T0)).normalize();

    let vCoord = 0;
    let prevStart = -1;
    let prevR = 0;

    chainRings.forEach((ring, k) => {
      const { center, tangent: T, radius, dist, s, R } = ring;
      if (k > 0) {
        q.setFromUnitVectors(chainRings[k - 1].tangent, T);
        N.applyQuaternion(q);
        N.addScaledVector(T, -N.dot(T)).normalize();
        const ds = center.distanceTo(chainRings[k - 1].center);
        vCoord += (ds * repeats) / (TAU * Math.max(radius, baseR * 0.25));
      }
      B.crossVectors(T, N);

      // radius slope along the branch, for analytic normals
      const prev = chainRings[Math.max(0, k - 1)];
      const next = chainRings[Math.min(chainRings.length - 1, k + 1)];
      const span = Math.max(1e-4, next.s - prev.s);
      const drds = (next.radius - prev.radius) / span;

      const f = Math.pow(Math.max(0, dist) / maxDist, 1.6) * flexScale;
      tint(radius, col);
      const start = v;

      for (let j = 0; j <= R; j++) {
        const a = (j / R) * TAU;
        const ca = Math.cos(a);
        const sa = Math.sin(a);
        dir.set(N.x * ca + B.x * sa, N.y * ca + B.y * sa, N.z * ca + B.z * sa);
        perp.set(-N.x * sa + B.x * ca, -N.y * sa + B.y * ca, -N.z * sa + B.z * ca);

        // root flare lobes (buttresses) on the trunk base
        let r = radius;
        let drda = 0;
        if (chain.rootFlare) {
          const h = Math.max(0, s - chain.rootFlare.depth);
          const lobe = (ang) => 1 + 0.38 * Math.exp(-h / 0.4) * Math.pow(0.5 + 0.5 * Math.cos(5 * ang + chain.rootFlare.phase), 1.6);
          r = radius * lobe(a);
          drda = (radius * (lobe(a + 0.01) - lobe(a - 0.01))) / 0.02;
        }

        vert.copy(center).addScaledVector(dir, r);
        n.copy(dir).addScaledVector(perp, -drda / Math.max(r, 1e-4)).addScaledVector(T, -drds).normalize();

        // junction: blend toward the parent's surface normal near the collar
        if (jn) {
          rel.subVectors(vert, jn.point);
          pn.copy(rel).addScaledVector(jn.tangent, -rel.dot(jn.tangent));
          // (never blend a normal toward the inside of the branch)
          if (pn.lengthSq() > 1e-8 && pn.dot(n) > 0) {
            pn.normalize();
            const w = smooth(jn.radius * 0.8, jn.radius + jn.collar * 1.6, s);
            n.lerp(pn, 1 - w).normalize();
          }
        }

        position[v * 3] = vert.x;
        position[v * 3 + 1] = vert.y;
        position[v * 3 + 2] = vert.z;
        normal[v * 3] = n.x;
        normal[v * 3 + 1] = n.y;
        normal[v * 3 + 2] = n.z;
        uv[v * 2] = (j / R) * repeats;
        uv[v * 2 + 1] = vCoord;
        color[v * 3] = col.r;
        color[v * 3 + 1] = col.g;
        color[v * 3 + 2] = col.b;
        flex[v] = f;
        axis[v * 3] = center.x;
        axis[v * 3 + 1] = center.y;
        axis[v * 3 + 2] = center.z;
        v++;
      }

      if (k > 0) ii = zipper(index, ii, prevStart, prevR, start, R);
      else ii = startCap(index, ii, start, R, chainRings[0], col, f);
      prevStart = start;
      prevR = R;
      samples.push({ pos: center, radius, dist, end: k === chainRings.length - 1 });
    });

    // tip cap
    const last = chainRings[chainRings.length - 1];
    const tip = v;
    // a pointed tip on twigs, a low dome where a thick limb ends in a fork
    vert.copy(last.center).addScaledVector(last.tangent, last.radius * (last.radius > 0.05 ? 0.55 : 1.2));
    position.set([vert.x, vert.y, vert.z], v * 3);
    normal.set([last.tangent.x, last.tangent.y, last.tangent.z], v * 3);
    uv.set([0.5, vCoord], v * 2);
    color.set([col.r, col.g, col.b], v * 3);
    flex[v] = Math.pow(Math.max(0, last.dist) / maxDist, 1.6) * flexScale;
    axis.set([last.center.x, last.center.y, last.center.z], v * 3);
    v++;
    // counter-clockwise seen from outside (beyond the tip)
    for (let j = 0; j < prevR; j++) {
      index[ii++] = prevStart + j;
      index[ii++] = prevStart + j + 1;
      index[ii++] = tip;
    }
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(position, 3));
  geometry.setAttribute('normal', new BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new BufferAttribute(uv, 2));
  geometry.setAttribute('color', new BufferAttribute(color, 3));
  geometry.setAttribute('aFlex', new BufferAttribute(flex, 1));
  geometry.setAttribute('aAxis', new BufferAttribute(axis, 3));
  geometry.setIndex(new BufferAttribute(index.subarray(0, ii), 1));
  geometry.computeBoundingSphere();
  return { geometry, samples };
}

/**
 * Stitch ring A (na segments) to ring B (nb segments, further along the
 * branch) without cracks. Ring vertices run counter-clockwise around the
 * tangent T, so (A[i], A[i+1], B[j]) is counter-clockwise seen from outside —
 * front faces point out of the tube, matching the outward normals.
 */
function zipper(index, ii, a0, na, b0, nb) {
  let i = 0;
  let j = 0;
  while (i < na || j < nb) {
    if (j >= nb || (i < na && (i + 1) / na <= (j + 1) / nb)) {
      index[ii++] = a0 + i;
      index[ii++] = a0 + i + 1;
      index[ii++] = b0 + j;
      i++;
    } else {
      index[ii++] = a0 + i;
      index[ii++] = b0 + j + 1;
      index[ii++] = b0 + j;
      j++;
    }
  }
  return ii;
}

/** Catmull-Rom resample of a chain into rings (centre, tangent, radius, …). */
function sampleChain(chain) {
  const pts = chain.points;
  const curve = new CatmullRomCurve3(pts.map((p) => p.pos), false, 'centripetal');
  const out = [];
  const last = pts.length - 1;
  let s = 0;
  let prev = null;
  let maxR = Infinity;

  const push = (t, i, f) => {
    const center = curve.getPoint(t);
    const tangent = curve.getTangent(t).normalize();
    if (prev) s += center.distanceTo(prev);
    prev = center;
    const a = pts[i];
    const b = pts[Math.min(i + 1, last)];
    let radius = a.radius + (b.radius - a.radius) * f;
    const dist = a.dist + (b.dist - a.dist) * f;

    if (chain.junction && chain.junction.flare !== false) {
      // collar: flare the child where it leaves its parent
      const j = chain.junction;
      const flared = radius * (1 + 0.6 * Math.exp(-s / j.collar));
      radius = Math.max(radius, Math.min(flared, j.radius * 0.94));
    }
    if (chain.rootFlare) {
      // flare peaks at ground level (the trunk starts a little below it)
      const h = Math.max(0, s - chain.rootFlare.depth);
      radius *= 1 + 0.75 * Math.exp(-h / 0.45);
    }

    // ring resolution never increases along a chain
    const R = Math.min(maxR, radialFor(radius));
    maxR = R;
    out.push({ center, tangent, radius, dist, s, R });
  };

  for (let i = 0; i < last; i++) {
    const segLen = pts[i].pos.distanceTo(pts[i + 1].pos);
    const r = (pts[i].radius + pts[i + 1].radius) * 0.5;
    const k = Math.max(1, Math.ceil(segLen / (r > 0.12 ? 0.09 : r > 0.04 ? 0.12 : 0.16)));
    for (let j = 0; j < k; j++) push((i + j / k) / last, i, j / k);
  }
  push(1, last, 0);
  return out;
}
