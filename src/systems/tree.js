import {
  BackSide,
  Color,
  DoubleSide,
  FrontSide,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  MeshDepthMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
  Vector2,
  Vector3,
  Box3,
} from 'three';
import { colonize, assignRadii } from '../tree/spaceColonization.js';
import { buildBranchGeometry } from '../tree/branchMesh.js';
import { Rng, fbm2 } from '../core/random.js';
import { shared } from '../core/uniforms.js';
import { enhanceMaterial, GLSL } from '../core/materials.js';
import { TREE, POND, terrainHeight } from '../core/layout.js';
import { createFoliageAtlas } from '../textures/canvasTextures.js';
import { createBarkTextures } from '../textures/barkTextures.js';
import { SHADOW_ONLY_LAYER } from '../core/shadows.js';
import foliageVert from '../shaders/foliage.vert?raw';
import foliageFrag from '../shaders/foliage.frag?raw';

// ---------------------------------------------------------------------------
// The tree is grown, not drawn:
//   1. attraction points fill a lumpy, umbrella-shaped crown envelope that
//      leans out over the pond;
//   2. space colonization grows a branch skeleton toward them;
//   3. pipe-model radii, then a "gnarl" pass (small random kinks on the
//      limbs) and a droop pass (each joint bends its subtree down in
//      proportion to lever arm over stiffness, so thin outer branches arch
//      and weep the way a Somei-Yoshino's do);
//   4. the skeleton is split into chains and swept into smooth Catmull-Rom
//      tubes with junction collars, root flare and surface roots.
// The canopy (blossoms / leaves) is unchanged — it simply attaches to the
// twig samples the new mesh produces.
// ---------------------------------------------------------------------------

const UP = new Vector3(0, 1, 0);

const BARK_OLD = new Color('#ded6d2');
const BARK_YOUNG = new Color('#f4c8b2');

const TAU = Math.PI * 2;

function crownAttractors(rng, base, toPond) {
  // lean the crown toward the pond — a cherry reaching over water
  const center = base.clone().add(new Vector3(0, 5.15, 0)).addScaledVector(toPond, 0.9);
  const radii = new Vector3(7.5, 2.7, 7.0);
  const pts = [];
  let guard = 0;
  while (pts.length < 4200 && guard++ < 120000) {
    const x = rng.spread(1);
    const y = rng.spread(1);
    const z = rng.spread(1);
    const d2 = x * x + y * y + z * z;
    if (d2 > 1) continue;
    // billowing silhouette: blossom "clouds" rather than a smooth dome
    const lump = fbm2(x * 1.8 + z * 0.7 + 4.1, y * 2.1 + z * 1.3 + 9.3, 3);
    if (Math.sqrt(d2) > 0.72 + 0.38 * lump) continue;
    // an open interior: twigs crowd the outer shell
    if (d2 < 0.36 && rng.next() < 0.9) continue;
    const p = new Vector3(x * radii.x, y * radii.y, z * radii.z).add(center);
    if (p.y - base.y < 3.0) continue; // flat underside — the umbrella
    // no central leader: keep the column above the trunk open
    if (Math.hypot(p.x - base.x, p.z - base.z) < 1.9 && rng.next() < 0.92) continue;
    pts.push(p);
  }
  return pts;
}

/**
 * Hand-placed start for the colonization: a short, slightly leaning trunk that
 * splits into four ascending scaffold limbs, plus one long low limb reaching
 * out over the pond. Space colonization takes it from there.
 */
function scaffoldSeed(base, toPond, rng, segment) {
  const seed = [];
  const add = (pos, parent) => seed.push({ pos, parent }) - 1;
  const jit = new Vector3();

  let p = base.clone().add(new Vector3(0, -0.45, 0));
  let i = add(p, -1);
  const dir = new Vector3(0, 1, 0).addScaledVector(toPond, 0.14).normalize();
  const trunk = [];
  const steps = Math.round(2.75 / segment);
  for (let k = 0; k < steps; k++) {
    dir.add(jit.set(rng.spread(0.07), 0, rng.spread(0.07))).normalize();
    p = p.clone().addScaledVector(dir, segment);
    i = add(p, i);
    trunk.push(i);
  }

  const pondAz = Math.atan2(toPond.z, toPond.x);
  const limbs = [
    { az: pondAz, elev: 0.3, from: trunk[Math.floor(steps * 0.66)], n: 11, sag: 0.03 }, // over the water
    { az: pondAz + 1.35, elev: 0.75, from: trunk[steps - 2], n: 7, sag: 0.04 },
    { az: pondAz + 2.55, elev: 0.62, from: trunk[steps - 1], n: 8, sag: 0.04 },
    { az: pondAz + 3.75, elev: 0.7, from: trunk[steps - 2], n: 7, sag: 0.04 },
    { az: pondAz + 4.95, elev: 0.82, from: trunk[steps - 1], n: 6, sag: 0.035 },
  ];
  for (const limb of limbs) {
    const az = limb.az + rng.spread(0.2);
    const elev = limb.elev + rng.spread(0.08);
    const d = new Vector3(Math.cos(az) * Math.cos(elev), Math.sin(elev), Math.sin(az) * Math.cos(elev));
    let q = seed[limb.from].pos;
    let parent = limb.from;
    for (let k = 0; k < limb.n; k++) {
      d.y -= limb.sag; // rise, then level out
      d.add(jit.set(rng.spread(0.09), rng.spread(0.05), rng.spread(0.09))).normalize();
      q = q.clone().addScaledVector(d, segment);
      parent = add(q, parent);
    }
  }
  return seed;
}

/** Gnarl + droop: re-pose the skeleton by bending every joint. */
function bendSkeleton(nodes, rng, { droop = 0.085, gnarl = 0.075 } = {}) {
  const rest = nodes.map((n) => n.pos.clone());
  const rot = nodes.map(() => new Quaternion());
  const seg = new Vector3();
  const axis = new Vector3();
  const q = new Quaternion();
  nodes[0].dist = 0;

  for (let i = 1; i < nodes.length; i++) {
    const node = nodes[i];
    const p = node.parent;
    seg.subVectors(rest[i], rest[p]).applyQuaternion(rot[p]);
    const len = seg.length();
    const d = seg.clone().divideScalar(len);
    rot[i].copy(rot[p]);

    // droop: lever arm (how horizontal) × flexibility (thin = soft)
    const horizontal = Math.sqrt(Math.max(0, 1 - d.y * d.y));
    const soft = Math.min(3, Math.pow(0.06 / Math.max(node.radius, 0.008), 0.85));
    axis.crossVectors(d, UP);
    if (axis.lengthSq() > 1e-6) {
      q.setFromAxisAngle(axis.normalize(), -droop * len * horizontal * soft);
      rot[i].premultiply(q);
    }
    // gnarl: small random kinks, strongest on the old wood
    if (node.radius > 0.03) {
      axis.set(rng.spread(1), rng.spread(1), rng.spread(1)).cross(d);
      if (axis.lengthSq() > 1e-6) {
        q.setFromAxisAngle(axis.normalize(), rng.spread(gnarl) * Math.min(1, node.radius / 0.08));
        rot[i].premultiply(q);
      }
    }

    seg.subVectors(rest[i], rest[p]).applyQuaternion(rot[i]);
    node.pos.copy(nodes[p].pos).add(seg);
    node.dist = nodes[p].dist + seg.length();
  }
}

/** Split the skeleton into chains: each follows its thickest child; side children start new chains. */
function skeletonChains(nodes, rootPhase) {
  const chains = [];
  const stack = [{ start: 0, junction: -1 }];
  const point = (i, radius = nodes[i].radius) => ({ pos: nodes[i].pos, radius, dist: nodes[i].dist });
  const tangentAt = (i) => {
    const n = nodes[i];
    const main = n.children.reduce((a, b) => (nodes[b].radius > nodes[a].radius ? b : a), n.children[0]);
    const from = n.parent >= 0 ? nodes[n.parent].pos : n.pos;
    const to = main !== undefined ? nodes[main].pos : n.pos;
    return new Vector3().subVectors(to, from).normalize();
  };

  while (stack.length) {
    const { start, junction } = stack.pop();
    const points = [];
    if (junction >= 0) points.push(point(junction, nodes[start].radius));
    let i = start;
    for (;;) {
      points.push(point(i));
      const kids = nodes[i].children;
      if (kids.length === 0) break;
      const sorted = [...kids].sort((a, b) => nodes[b].radius - nodes[a].radius);
      for (let k = 1; k < sorted.length; k++) stack.push({ start: sorted[k], junction: i });
      // A thick branch can't turn tighter than ~1.4× its own radius without
      // its rings overlapping (the tube folds inside-out in the crotch). There
      // it becomes a true fork instead: the chain ends in a dome and the main
      // child leaves with a collar like the others.
      const p = nodes[i].parent;
      if (p >= 0 && points.length > 1) {
        const inDir = new Vector3().subVectors(nodes[i].pos, nodes[p].pos);
        const outDir = new Vector3().subVectors(nodes[sorted[0]].pos, nodes[i].pos);
        const bend = inDir.angleTo(outDir);
        if (bend > (0.7 * outDir.length()) / nodes[i].radius) {
          stack.push({ start: sorted[0], junction: i });
          break;
        }
      }
      i = sorted[0];
    }
    chains.push({
      points,
      junction:
        junction >= 0
          ? {
              point: nodes[junction].pos,
              tangent: tangentAt(junction),
              radius: nodes[junction].radius,
              collar: nodes[start].radius * 1.6 + 0.04,
            }
          : null,
      rootFlare: start === 0 ? { phase: rootPhase, depth: 0.45 } : null,
    });
  }
  return chains;
}

/** A few surface roots reaching out from the buttresses and diving into the soil. */
function surfaceRoots(base, groundY, rootPhase, rng) {
  const roots = [];
  for (let k = 0; k < 5; k++) {
    if (k === 3) continue; // leave a gap so it doesn't look like a star
    // buttress lobes sit at 5a + phase = 2πk in the trunk's base frame (≈ world x/z here)
    const a = (Math.PI * 2 * k - rootPhase) / 5 + rng.spread(0.12);
    const dir = new Vector3(Math.sin(a), 0, Math.cos(a));
    const side = new Vector3(dir.z, 0, -dir.x);
    const reach = rng.float(1.9, 2.6);
    const points = [];
    const steps = 7;
    // starts on the trunk axis (hidden inside the buttress), runs out half
    // buried in the soil, then dives under
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const p = base.clone().addScaledVector(dir, t * reach).addScaledVector(side, Math.sin(t * 5 + k) * 0.1 * t);
      const surface = terrainHeight(p.x, p.z);
      p.y = surface + 0.02 + 0.1 * (1 - t) - 0.25 * t ** 4;
      points.push({ pos: p, radius: 0.17 * (1 - t) ** 0.6 + 0.035, dist: 0 });
    }
    roots.push({
      points,
      // no collar, but shade into the trunk like any branch junction
      junction: { point: new Vector3(base.x, points[0].pos.y, base.z), tangent: UP, radius: 0.5, collar: 0.25, flare: false },
      rootFlare: null,
      flexScale: 0,
    });
  }
  return roots;
}

/** Keeps thin twigs at least `uMinTwigPx` pixels in radius on screen (no sub-pixel shimmer). */
function minWidthPatch(shader) {
  shader.uniforms.uViewportHeight = shared.uViewportHeight;
  shader.uniforms.uMinTwigPx = { value: 0.6 };
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute vec3 aAxis;\nuniform float uViewportHeight;\nuniform float uMinTwigPx;')
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
      {
        vec4 axisView = modelViewMatrix * vec4(aAxis, 1.0);
        float pxPerUnit = projectionMatrix[1][1] * uViewportHeight * 0.5 / max(-axisView.z, 0.05);
        vec3 radial = transformed - aAxis;
        float radiusPx = length(radial) * pxPerUnit;
        transformed = aAxis + radial * max(1.0, uMinTwigPx / max(radiusPx, 1e-4));
      }`,
    );
}

// --- the system -----------------------------------------------------------------

export class Tree {
  constructor(scene, { seed = 11, anisotropy = 4 } = {}) {
    this.group = new Group();
    scene.add(this.group);

    const rng = new Rng(seed);
    const groundY = terrainHeight(TREE.x, TREE.z);
    const base = new Vector3(TREE.x, groundY, TREE.z);
    const t0 = performance.now();

    // 1–2. grow the skeleton
    const toPond = new Vector3(POND.x - TREE.x, 0, POND.z - TREE.z).normalize();
    const segment = 0.26;
    const nodes = colonize({
      attractors: crownAttractors(rng, base, toPond),
      root: base,
      seed: scaffoldSeed(base, toPond, rng, segment),
      segment,
      influence: 2.2,
      kill: 0.46,
      jitter: 0.16,
      bias: new Vector3(0, 0.04, 0),
      rng,
    });

    // 3. radii (pipe model, remapped so the trunk reads ~0.42 thick) + re-pose
    assignRadii(nodes, { tip: 0.011, exponent: 2.1 });
    const tip = 0.011;
    const scale = (0.42 - tip) / Math.max(1e-3, nodes[0].radius - tip);
    for (const n of nodes) n.radius = tip + (n.radius - tip) * scale;
    bendSkeleton(nodes, rng);

    // 4. chains → tubes
    const rootPhase = rng.float(0, Math.PI * 2);
    const chains = [...skeletonChains(nodes, rootPhase), ...surfaceRoots(base, groundY, rootPhase, rng)];
    // read-only: the land heaves its soil around these (island.js)
    this.rootPaths = chains.filter((c) => c.flexScale === 0).map((c) => c.points.map((p) => ({ pos: p.pos.clone(), radius: p.radius })));
    let maxDist = 0;
    for (const n of nodes) maxDist = Math.max(maxDist, n.dist);
    const { geometry, samples } = buildBranchGeometry(chains, {
      maxDist,
      tint: (r, out) => out.lerpColors(BARK_YOUNG, BARK_OLD, Math.min(1, Math.max(0, (r - 0.02) / 0.2))),
    });

    const bark = createBarkTextures({ anisotropy });
    const woodMat = enhanceMaterial(
      new MeshStandardMaterial({
        map: bark.map,
        normalMap: bark.normalMap,
        normalScale: new Vector2(1.25, 1.25),
        roughnessMap: bark.roughnessMap,
        roughness: 1,
        metalness: 0,
        vertexColors: true,
        // fully opaque, single-sided: the tubes are closed and wound outward, so
        // the shadow pass draws their back faces (the standard acne-free setup)
        transparent: false,
        side: FrontSide,
        shadowSide: BackSide,
      }),
      { wind: true, snow: true, patch: minWidthPatch, key: 'bark-sc' },
    );
    this.wood = new Mesh(geometry, woodMat);
    this.wood.castShadow = true;
    this.wood.receiveShadow = true;
    this.wood.customDepthMaterial = enhanceMaterial(new MeshDepthMaterial(), { wind: true, key: 'bark-depth' });
    this.group.add(this.wood);

    // Canopy — attaches to the new twigs.
    const points = attachPointsFromTwigs(samples, maxDist, rng);
    this.attachPoints = points;
    this.crown = crownBounds(points);
    const atlas = createFoliageAtlas();
    this.blossoms = createFoliageLayer(points, this.crown, atlas, rng, {
      blossom: true,
      perPoint: 2,
      jitter: 0.3,
      size: 0.95,
    });
    this.leaves = createFoliageLayer(points, this.crown, atlas, rng, {
      blossom: false,
      perPoint: 2,
      jitter: 0.34,
      size: 1.0,
    });
    this.group.add(this.blossoms, this.leaves);

    // The canopy casts its shadow through half-density proxies that only the
    // sun's shadow camera sees (layer 1): the dappled shadow reads the same at
    // half the shadow-map fill, which is the single biggest cost on weak GPUs.
    this.blossomShadow = shadowProxy(this.blossoms);
    this.leafShadow = shadowProxy(this.leaves);
    this.group.add(this.blossomShadow, this.leafShadow);

    this.stats = {
      nodes: nodes.length,
      chains: chains.length,
      woodVertices: geometry.attributes.position.count,
      woodTriangles: geometry.index.count / 3,
      attachPoints: points.length,
      sprites: this.blossoms.geometry.instanceCount + this.leaves.geometry.instanceCount,
      buildMs: Math.round(performance.now() - t0),
    };
  }

  /** Flat array [x, y, z, flex, …] of canopy positions — petals/leaves spawn here. */
  getSpawnPoints() {
    const out = new Float32Array(this.attachPoints.length * 4);
    this.attachPoints.forEach((p, i) => {
      out[i * 4] = p.pos.x;
      out[i * 4 + 1] = p.pos.y;
      out[i * 4 + 2] = p.pos.z;
      out[i * 4 + 3] = p.flex;
    });
    return out;
  }

  update(state) {
    const b = this.blossoms.material.uniforms;
    b.uPresence.value = state.blossoms;
    b.uGrowth.value = state.bloom;
    this.blossoms.visible = state.blossoms > 0.001;

    const l = this.leaves.material.uniforms;
    l.uPresence.value = state.leaves;
    l.uGrowth.value = state.leafGrowth;
    l.uAutumn.value = state.autumn;
    this.leaves.visible = state.leaves > 0.001;

    this.blossomShadow.visible = this.blossoms.visible;
    this.leafShadow.visible = this.leaves.visible;
  }
}

/** Every other sprite of a canopy layer, slightly enlarged, rendered only into the shadow map. */
function shadowProxy(layer) {
  const src = layer.geometry;
  const geo = new InstancedBufferGeometry();
  geo.index = src.index;
  geo.setAttribute('position', src.attributes.position);
  geo.setAttribute('uv', src.attributes.uv);
  const half = Math.floor(src.instanceCount / 2);
  for (const name of ['aCenter', 'aRand', 'aOut', 'aFlex']) {
    const a = src.attributes[name];
    const out = new Float32Array(half * a.itemSize);
    for (let i = 0; i < half; i++) {
      for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.array[i * 2 * a.itemSize + c];
    }
    geo.setAttribute(name, new InstancedBufferAttribute(out, a.itemSize));
  }
  geo.instanceCount = half;

  // shares the layer's uniforms (presence, growth, wind…) but draws bigger sprites
  const depth = layer.customDepthMaterial.clone();
  depth.uniforms = { ...layer.customDepthMaterial.uniforms, uSize: { value: layer.material.uniforms.uSize.value * 1.25 } };
  const proxy = new Mesh(geo, new MeshDepthMaterial({ colorWrite: false, depthWrite: false, side: DoubleSide }));
  proxy.customDepthMaterial = depth;
  proxy.castShadow = true;
  proxy.frustumCulled = false;
  proxy.layers.set(SHADOW_ONLY_LAYER);
  layer.castShadow = false;
  return proxy;
}

// --- canopy -----------------------------------------------------------------------

/**
 * Blossoms and leaves grow on the twigs: take the ring centres of the thin
 * outer branches (and every tip) and thin them to a steady density, so the
 * canopy keeps the same fullness whatever shape the skeleton grows into.
 */
function attachPointsFromTwigs(samples, maxDist, rng, { twigRadius = 0.03, target = 1250 } = {}) {
  const twig = samples.filter((s) => s.radius < twigRadius && s.dist > 0);
  const tips = twig.filter((s) => s.end);
  const rest = twig.filter((s) => !s.end);
  // shuffle, then keep all tips and fill the remainder from along the twigs
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  const chosen = [...tips, ...rest.slice(0, Math.max(0, target - tips.length))];
  return chosen.map((s) => ({ pos: s.pos.clone(), flex: Math.pow(s.dist / maxDist, 1.6) }));
}

function crownBounds(points) {
  const box = new Box3();
  for (const p of points) box.expandByPoint(p.pos);
  const center = box.getCenter(new Vector3());
  const size = box.getSize(new Vector3()).multiplyScalar(0.5);
  center.y -= size.y * 0.35; // normals fan out from low in the crown → umbrella shading
  return { box, center, radii: size };
}

const LAYER_TINTS = {
  blossom: ['#ffd5e3', '#fff1f6', '#000000', '#000000', '#000000'],
  //        spring greens         gold       orange     crimson
  leaf: ['#7fb357', '#5c9a45', '#e8b53c', '#df6a2a', '#b32a2a'],
};

function createFoliageLayer(points, crown, atlas, rng, { blossom, perPoint, jitter, size }) {
  const count = points.length * perPoint;
  const center = new Float32Array(count * 3);
  const rand = new Float32Array(count * 4);
  const out = new Float32Array(count * 4);
  const flex = new Float32Array(count);
  const d = new Vector3();

  let k = 0;
  for (const p of points) {
    for (let s = 0; s < perPoint; s++, k++) {
      const x = p.pos.x + rng.spread(jitter);
      const y = p.pos.y + rng.spread(jitter) + (blossom ? 0 : 0.05);
      const z = p.pos.z + rng.spread(jitter);
      center.set([x, y, z], k * 3);
      rand.set([rng.next(), rng.next(), rng.next(), rng.next()], k * 4);

      d.set(x, y, z).sub(crown.center);
      const r = Math.sqrt(
        (d.x / crown.radii.x) ** 2 + (d.y / crown.radii.y) ** 2 + (d.z / crown.radii.z) ** 2,
      );
      d.normalize();
      const shade = Math.min(1, Math.max(0, (r - 0.35) / 0.75)) * 0.8 + Math.max(0, d.y) * 0.2;
      out.set([d.x, d.y, d.z, shade], k * 4);
      flex[k] = p.flex;
    }
  }

  const geo = new InstancedBufferGeometry();
  geo.copy(new PlaneGeometry(1, 1));
  geo.setAttribute('aCenter', new InstancedBufferAttribute(center, 3));
  geo.setAttribute('aRand', new InstancedBufferAttribute(rand, 4));
  geo.setAttribute('aOut', new InstancedBufferAttribute(out, 4));
  geo.setAttribute('aFlex', new InstancedBufferAttribute(flex, 1));
  geo.instanceCount = count;

  const tints = LAYER_TINTS[blossom ? 'blossom' : 'leaf'].map((c) => new Color(c));
  const uniforms = UniformsUtils.merge([UniformsLib.fog]);
  Object.assign(uniforms, {
    uAtlas: { value: atlas },
    uPresence: { value: 1 },
    uGrowth: { value: 1 },
    uAutumn: { value: 0 },
    uSize: { value: size },
    uTintA: { value: tints[0] },
    uTintB: { value: tints[1] },
    uTintC: { value: tints[2] },
    uTintD: { value: tints[3] },
    uTintE: { value: tints[4] },
    uTranslucency: { value: blossom ? 0.75 : 0.55 },
    uTime: shared.uTime,
    uWindStrength: shared.uWindStrength,
    uWindDir: shared.uWindDir,
    uSunDir: shared.uSunDir,
    uSunColor: shared.uSunColor,
    uSkyAmbient: shared.uSkyAmbient,
    uGroundAmbient: shared.uGroundAmbient,
  });

  const defines = blossom ? { BLOSSOM: '' } : { LEAF: '' };
  const vertexShader = '#include <common>\n' + GLSL.common + GLSL.wind + foliageVert;
  const fragmentShader = '#include <common>\n' + GLSL.common + foliageFrag;

  const material = new ShaderMaterial({
    uniforms,
    defines,
    vertexShader,
    fragmentShader,
    fog: true,
    alphaToCoverage: true,
    side: DoubleSide,
  });

  const mesh = new Mesh(geo, material);
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.customDepthMaterial = new ShaderMaterial({
    uniforms,
    defines: { ...defines, DEPTH_ONLY: '' },
    vertexShader,
    fragmentShader,
    side: DoubleSide,
  });
  return mesh;
}
