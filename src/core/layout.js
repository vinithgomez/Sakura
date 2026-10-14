// World layout shared by the island, tree and particles. The analytic terrain
// height exists twice — once in JS (meshes, prop placement) and once as GLSL
// (petals/leaves landing on the ground) — generated from the same constants.

export const ISLAND_RADIUS = 10;
export const TREE = { x: -1.3, z: -1.1 };
export const POND = { x: 3.8, z: 2.4, r: 2.35, water: -0.17 };
export const TORII = { x: -3.6, z: 6.3 };
export const LANTERN = { x: 1.05, z: 4.75 };

// Gentle mounds across the open ground: [x, z, height, radius]. They fade to
// nothing around the tree (whose roots are modelled on the ground there) and
// around the pond, so neither moves.
const MOUNDS = [
  [-6.2, -3.8, 0.3, 2.2],
  [5.6, -4.6, 0.34, 2.5],
  [-6.9, 2.4, 0.24, 1.9],
  [1.4, -6.9, 0.26, 2.1],
  [7.0, 0.6, 0.2, 1.6],
  [2.9, 7.4, 0.2, 1.7],
  [-1.6, 7.6, 0.14, 1.4],
  [-3.9, -7.0, 0.18, 1.6],
];
const MOUND_CLEAR_TREE = [3.0, 4.6]; // fully flat inside 3.0, full mounds beyond 4.6
const MOUND_CLEAR_POND = [POND.r + 0.5, POND.r + 1.7];

const smooth = (a, b, v) => {
  const t = Math.min(Math.max((v - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** The mounds and long swell alone (0 near the tree and pond). */
export function terrainRelief(x, z) {
  let m = 0.06 * Math.sin(0.9 * x + 0.4) * Math.cos(0.7 * z - 0.3); // long, low swell
  for (const [mx, mz, mh, mr] of MOUNDS) m += mh * Math.exp(-((x - mx) ** 2 + (z - mz) ** 2) / (2 * mr * mr));
  const clear =
    smooth(MOUND_CLEAR_TREE[0], MOUND_CLEAR_TREE[1], Math.hypot(x - TREE.x, z - TREE.z)) *
    smooth(MOUND_CLEAR_POND[0], MOUND_CLEAR_POND[1], Math.hypot(x - POND.x, z - POND.z));
  return m * clear;
}

export function terrainHeight(x, z) {
  const r2 = Math.min((x * x + z * z) / (ISLAND_RADIUS * ISLAND_RADIUS), 1);
  let h = 0.42 * (1 - r2);
  const dt = (x - TREE.x) ** 2 + (z - TREE.z) ** 2;
  h += 0.38 * Math.exp(-dt / (2 * 2.4 * 2.4));
  const dp = Math.hypot(x - POND.x, z - POND.z);
  h -= 1.15 * smooth(POND.r + 0.35, POND.r - 0.75, dp); // pond bowl, ~0.6 deep at the centre
  return h + terrainRelief(x, z);
}

export function distToPond(x, z) {
  return Math.hypot(x - POND.x, z - POND.z);
}

const f = (n) => n.toFixed(4);

export const TERRAIN_GLSL = /* glsl */ `
const float ISLAND_R = ${f(ISLAND_RADIUS)};
const vec2 POND_C = vec2(${f(POND.x)}, ${f(POND.z)});
const float POND_R = ${f(POND.r)};
const float WATER_Y = ${f(POND.water)};

float terrainRelief(vec2 p) {
  float m = 0.06 * sin(0.9 * p.x + 0.4) * cos(0.7 * p.y - 0.3);
${MOUNDS.map(([x, z, h, r]) => `  m += ${f(h)} * exp(-dot(p - vec2(${f(x)}, ${f(z)}), p - vec2(${f(x)}, ${f(z)})) / ${f(2 * r * r)});`).join('\n')}
  float clear = smoothstep(${f(MOUND_CLEAR_TREE[0])}, ${f(MOUND_CLEAR_TREE[1])}, length(p - vec2(${f(TREE.x)}, ${f(TREE.z)})))
              * smoothstep(${f(MOUND_CLEAR_POND[0])}, ${f(MOUND_CLEAR_POND[1])}, length(p - POND_C));
  return m * clear;
}

float terrainHeight(vec2 p) {
  float r2 = min(dot(p, p) / (ISLAND_R * ISLAND_R), 1.0);
  float h = 0.42 * (1.0 - r2);
  vec2 dt = p - vec2(${f(TREE.x)}, ${f(TREE.z)});
  h += 0.38 * exp(-dot(dt, dt) / (2.0 * 2.4 * 2.4));
  float dp = length(p - POND_C);
  h -= 1.15 * smoothstep(POND_R + 0.35, POND_R - 0.75, dp);
  return h + terrainRelief(p);
}

// Height a falling thing comes to rest at (water surface inside the pond).
float restHeight(vec2 p) {
  return max(terrainHeight(p), length(p - POND_C) < POND_R + 0.1 ? WATER_Y : -100.0);
}
`;
