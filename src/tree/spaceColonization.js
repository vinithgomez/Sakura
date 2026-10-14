import { Vector3 } from 'three';

// ---------------------------------------------------------------------------
// Space colonization (Runions, Lane & Prusinkiewicz, "Modeling Trees with a
// Space Colonization Algorithm", 2007).
//
// A cloud of attraction points fills the crown envelope. Each iteration every
// point pulls on the closest branch node within the influence radius; each
// pulled node grows one segment toward the average of its pulls; points that
// a node reaches within the kill radius are consumed. Branching emerges on its
// own wherever a node is pulled from several directions over time.
//
// Speed: each attraction point caches its closest node. Nodes are only ever
// added, so per iteration a point only has to be compared with the *new* nodes
// (found through a spatial hash), which keeps growth to a few ms in JS.
// ---------------------------------------------------------------------------

const _v = new Vector3();
const _d = new Vector3();

/**
 * @returns {Array<{pos: Vector3, parent: number, children: number[], radius: number}>}
 *          Parents always precede their children in the array.
 */
export function colonize({
  attractors, // Vector3[] — consumed (positions are not modified)
  root, // Vector3: base of the trunk
  // optional hand-placed start skeleton [{pos, parent}] (parents first) — e.g. a
  // trunk with scaffold-limb stubs; replaces the automatic trunk
  seed = null,
  trunkDir = new Vector3(0, 1, 0),
  segment = 0.25,
  influence = 2.5,
  kill = 0.5,
  maxIterations = 220,
  maxNodes = 9000,
  jitter = 0.1,
  bias = new Vector3(), // constant growth bias (e.g. a little phototropism)
  trunkMinLength = 0, // bare trunk before the crown may pull on it
  trunkMaxLength = 8,
  rng,
}) {
  const nodes = [{ pos: root.clone(), parent: -1, children: [] }];
  const count = attractors.length;
  const alive = new Uint8Array(count).fill(1);
  const closest = new Int32Array(count).fill(-1);
  const closestD2 = new Float32Array(count).fill(Infinity);
  const infl2 = influence * influence;
  const kill2 = kill * kill;

  const addNode = (parent, pos) => {
    const i = nodes.length;
    nodes.push({ pos, parent, children: [] });
    nodes[parent].children.push(i);
    return i;
  };

  // 1. Trunk: either the given seed skeleton, or grow straight-ish until the
  //    crown is within reach.
  let newNodes = [0];
  if (seed) {
    nodes.length = 0;
    newNodes = [];
    for (const s of seed) {
      const i = nodes.length;
      nodes.push({ pos: s.pos.clone(), parent: s.parent, children: [] });
      if (s.parent >= 0) nodes[s.parent].children.push(i);
      newNodes.push(i);
    }
  }
  const trunk = trunkDir.clone().normalize();
  for (let len = 0; !seed && len < trunkMaxLength; len += segment) {
    const tip = nodes[nodes.length - 1].pos;
    if (len >= trunkMinLength) {
      let reached = false;
      for (let a = 0; a < count && !reached; a++) {
        if (attractors[a].distanceToSquared(tip) < infl2) reached = true;
      }
      if (reached) break;
    }
    const dir = _d.copy(trunk).add(_v.set(rng.spread(jitter), 0, rng.spread(jitter))).normalize();
    newNodes.push(addNode(nodes.length - 1, tip.clone().addScaledVector(dir, segment)));
  }

  // 2. Colonize.
  const cell = influence;
  const key = (x, y, z) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  const acc = new Map(); // node index → { dir: Vector3, n: number }

  for (let iter = 0; iter < maxIterations && nodes.length < maxNodes; iter++) {
    // spatial hash of the nodes added last iteration
    const grid = new Map();
    for (const i of newNodes) {
      const p = nodes[i].pos;
      const k = key(p.x, p.y, p.z);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }

    // update each point's closest node; consume points that were reached
    let remaining = 0;
    for (let a = 0; a < count; a++) {
      if (!alive[a]) continue;
      const ap = attractors[a];
      const cx = Math.floor(ap.x / cell);
      const cy = Math.floor(ap.y / cell);
      const cz = Math.floor(ap.z / cell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) {
            const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
            if (!bucket) continue;
            for (const i of bucket) {
              const d2 = nodes[i].pos.distanceToSquared(ap);
              if (d2 < closestD2[a]) {
                closestD2[a] = d2;
                closest[a] = i;
              }
            }
          }
        }
      }
      if (closestD2[a] < kill2) {
        alive[a] = 0;
        continue;
      }
      remaining++;
      if (closestD2[a] < infl2) {
        const i = closest[a];
        let e = acc.get(i);
        if (!e) acc.set(i, (e = { dir: new Vector3(), n: 0 }));
        e.dir.add(_v.subVectors(ap, nodes[i].pos).normalize());
        e.n++;
      }
    }
    if (remaining === 0 || acc.size === 0) break;

    // grow one segment from every pulled node
    newNodes = [];
    for (const [i, e] of acc) {
      const node = nodes[i];
      // pulls that cancel out (a node exactly between two clusters) → skip
      if (e.dir.length() < 0.15 * e.n) continue;
      const dir = e.dir.normalize().add(bias);
      dir.x += rng.spread(jitter);
      dir.y += rng.spread(jitter);
      dir.z += rng.spread(jitter);
      dir.normalize();
      // don't sprout a duplicate of an existing child
      let dup = false;
      for (const c of node.children) {
        if (_d.subVectors(nodes[c].pos, node.pos).normalize().dot(dir) > 0.985) {
          dup = true;
          break;
        }
      }
      if (dup) continue;
      newNodes.push(addNode(i, node.pos.clone().addScaledVector(dir, segment)));
    }
    acc.clear();
    if (newNodes.length === 0) break;
  }

  return nodes;
}

/**
 * Pipe-model radii: a tip has radius `tip`; a parent's cross-section is the
 * combined cross-section of its children, r^n = Σ r_child^n (n ≈ 2–3,
 * da Vinci / Murray's law).
 */
export function assignRadii(nodes, { tip = 0.012, exponent = 2.4 } = {}) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node.children.length === 0) {
      node.radius = tip;
      continue;
    }
    let sum = 0;
    for (const c of node.children) sum += Math.pow(nodes[c].radius, exponent);
    node.radius = Math.pow(sum, 1 / exponent);
  }
  return nodes;
}
