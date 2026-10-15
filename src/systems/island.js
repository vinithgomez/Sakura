import {
  BufferAttribute,
  BufferGeometry,
  BoxGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  ShaderMaterial,
  SphereGeometry,
  UniformsLib,
  UniformsUtils,
  Vector2,
  Vector3,
  WebGLRenderTarget,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { drawLate } from '../core/layers.js';
import { Rng, fbm2, noise2 } from '../core/random.js';
import { shared } from '../core/uniforms.js';
import { enhanceMaterial, GLSL } from '../core/materials.js';
import {
  ISLAND_RADIUS,
  TREE,
  POND,
  TORII,
  LANTERN,
  terrainHeight,
  TERRAIN_GLSL,
} from '../core/layout.js';
import waterVert from '../shaders/water.vert?raw';
import waterFrag from '../shaders/water.frag?raw';
import koiVert from '../shaders/koi.vert?raw';
import koiFrag from '../shaders/koi.frag?raw';

const SEG = 160; // angular resolution shared by the grass top and the rocky underside
const NOISE_EXTENT = 11; // baked ground-noise textures cover [-11, 11]² in x/z
const MAX_ROCK_SPOTS = 48;

/** Irregular island outline radius at angle θ. */
export function edgeRadius(theta) {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  return (
    ISLAND_RADIUS *
    (1 + 0.045 * Math.sin(3 * theta + 0.7) + 0.03 * Math.sin(5 * theta + 2.1) + (noise2(c * 2 + 5, s * 2 + 5) - 0.5) * 0.07)
  );
}

const smooth = (a, b, v) => {
  const t = Math.min(Math.max((v - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

/** Fine, mesh-only relief on top of the shared terrain (± a few cm). */
function microRelief(x, z) {
  return (fbm2(x * 0.35 + 3, z * 0.35 + 3) - 0.5) * 0.14 + (noise2(x * 1.7 + 11, z * 1.7 + 4) - 0.5) * 0.035;
}

export class Island {
  constructor(scene) {
    this.group = new Group();
    scene.add(this.group);
    this.rng = new Rng(31);
    this.koiTime = 0;
    this.resolution = new Vector2(1, 1); // drawing-buffer size, for the water's screen-space refraction
    this._dummy = new Object3D();
    this.rockSpots = []; // [x, z, radius] of stones & posts — moss and snow drifts gather there

    this._buildTerrain();
    this._buildUnderside();
    this._buildPond();
    this._buildRocks();
    this._buildTorii();
    this._buildLantern();
    this._buildFloatingRocks();
  }

  // --- terrain: polar grid, everything seasonal happens in the shader -------
  //
  // Height = the shared analytic terrain (dome, tree mound, pond bowl, gentle
  // mounds — layout.js) + fine noise relief + a rounded lip at the edge + soil
  // heaved up beside the tree's surface roots (setTreeRoots). Per vertex we
  // also store `aLand` = (hollow, bare soil, inland): hollows collect snow
  // drifts first, bare soil shows around the trunk and along the roots, and
  // `inland` keeps the snow from lifting the rim away from the underside.

  /** Ground height exactly as the terrain mesh renders it (used to plant grass). */
  surfaceHeight(x, z) {
    const r = Math.hypot(x, z);
    const t = r / edgeRadius(Math.atan2(z, x));
    let y = terrainHeight(x, z) + microRelief(x, z) * smooth(0, 0.3, t);
    y -= smooth(0.9, 1, t) * 0.16; // rounded lip
    return y + this._rootHeave(x, z).heave;
  }

  _buildTerrain() {
    const RINGS = 60;
    const verts = [];
    const land = [];
    const index = [];
    this.edge = []; // outline ring, reused by the underside for a seamless join
    this.rootPaths = [];

    const push = (x, z, t) => {
      verts.push(x, this.surfaceHeight(x, z), z);
      land.push(0, 0, 1 - smooth(0.9, 0.98, t));
    };
    push(0, 0, 0);
    for (let i = 1; i <= RINGS; i++) {
      const t = i / RINGS;
      for (let j = 0; j < SEG; j++) {
        const theta = (j / SEG) * Math.PI * 2;
        const r = t * edgeRadius(theta);
        push(Math.cos(theta) * r, Math.sin(theta) * r, t);
        if (i === RINGS) this.edge.push(new Vector3(verts.at(-3), verts.at(-2), verts.at(-1)));
      }
    }
    for (let j = 0; j < SEG; j++) index.push(0, 1 + ((j + 1) % SEG), 1 + j);
    for (let i = 1; i < RINGS; i++) {
      const a0 = 1 + (i - 1) * SEG;
      const b0 = 1 + i * SEG;
      for (let j = 0; j < SEG; j++) {
        const j1 = (j + 1) % SEG;
        index.push(a0 + j, a0 + j1, b0 + j, a0 + j1, b0 + j1, b0 + j);
      }
    }

    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3));
    geo.setAttribute('aLand', new BufferAttribute(new Float32Array(land), 3));
    geo.setIndex(index);
    this._updateLandAttributes(geo);

    this.groundUniforms = {
      uGrass: { value: new Color('#79b04b') },
      uPetalCover: { value: 0 },
      uLeafCover: { value: 0 },
      uNoiseA: { value: null }, // filled by bakeGroundNoise()
      uNoiseB: { value: null },
      uCaustics: { value: 0 }, // High preset only
      uSparkle: { value: 0 }, // High preset only
      uPondIce: { value: 0 },
      uMoss: { value: new Color('#466b2c') },
    };
    const mat = enhanceMaterial(new MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 }), {
      key: 'ground',
      patch: (shader) => this._groundPatch(shader),
    });
    this.ground = new Mesh(geo, mat);
    this.ground.receiveShadow = true;
    this.group.add(this.ground);
  }

  /** Recompute normals, hollowness and bare-soil masks after the heights change. */
  _updateLandAttributes(geo) {
    const p = geo.attributes.position;
    const land = geo.attributes.aLand;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      const y = p.getY(i);
      const hollow = this._hollowAt(x, z, y);
      // bare soil: trampled earth at the trunk base, and along the roots
      const dTrunk = Math.hypot(x - TREE.x, z - TREE.z);
      const soil = Math.max(smooth(1.45, 0.75, dTrunk), this._rootHeave(x, z).soil);
      land.setX(i, hollow);
      land.setY(i, soil);
    }
    land.needsUpdate = true;
    geo.computeVertexNormals();
  }

  /** Hollowness (0–1): how far the ground at height `y` sits below its surroundings, 0.8 units out. */
  _hollowAt(x, z, y) {
    let avg = 0;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      avg += terrainHeight(x + Math.cos(a) * 0.8, z + Math.sin(a) * 0.8) + microRelief(x + Math.cos(a) * 0.8, z + Math.sin(a) * 0.8);
    }
    return y > POND.water + 0.05 ? Math.min(1, Math.max(0, (avg / 6 - y) * 9)) : 0;
  }

  /**
   * The ground shader's snow rule at one spot, for things standing on the
   * ground (grass): `threshold` is the snow level at which this patch turns
   * white (snow arrives first in hollows and against stones), `slope` is 0 on
   * ground too steep to hold snow. Same inputs as the shader: the baked noise
   * (read back once after bakeGroundNoise), hollowness and the surface normal.
   */
  snowAt(x, z) {
    const nb = this._noiseB;
    let r = 0.5;
    let rocks = 0;
    if (nb) {
      // bilinear lookup in the baked texture (row 0 = v 0 = the −z edge)
      const fx = (x / (2 * NOISE_EXTENT) + 0.5) * nb.size - 0.5;
      const fz = (z / (2 * NOISE_EXTENT) + 0.5) * nb.size - 0.5;
      const x0 = Math.max(0, Math.min(nb.size - 2, Math.floor(fx)));
      const z0 = Math.max(0, Math.min(nb.size - 2, Math.floor(fz)));
      const tx = Math.min(1, Math.max(0, fx - x0));
      const tz = Math.min(1, Math.max(0, fz - z0));
      const at = (i, j, c) => nb.data[((z0 + j) * nb.size + (x0 + i)) * 4 + c] / 255;
      const lerp2 = (c) => (at(0, 0, c) * (1 - tx) + at(1, 0, c) * tx) * (1 - tz) + (at(0, 1, c) * (1 - tx) + at(1, 1, c) * tx) * tz;
      r = lerp2(0);
      rocks = lerp2(2);
    }
    const y = this.surfaceHeight(x, z);
    const e = 0.12;
    const dx = this.surfaceHeight(x + e, z) - this.surfaceHeight(x - e, z);
    const dz = this.surfaceHeight(x, z + e) - this.surfaceHeight(x, z - e);
    const ny = (2 * e) / Math.hypot(dx, 2 * e, dz);
    return { threshold: r - this._hollowAt(x, z, y) * 0.35 - rocks * 0.3, slope: smooth(0.55, 0.75, ny) };
  }

  /**
   * The tree's surface roots (tree.rootPaths) push the soil up beside them and
   * leave a strip of bare earth along their length. Called once the tree exists.
   */
  setTreeRoots(paths) {
    this.rootPaths = paths;
    const geo = this.ground.geometry;
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i);
      const z = p.getZ(i);
      if (Math.hypot(x - TREE.x, z - TREE.z) > 3.4) continue;
      p.setY(i, this.surfaceHeight(x, z));
    }
    p.needsUpdate = true;
    this._updateLandAttributes(geo);
    geo.computeBoundingSphere();
  }

  /** Soil heave and bare-soil mask from the nearest root (0 away from them). */
  _rootHeave(x, z) {
    let best = Infinity;
    let along = 0;
    let rad = 0;
    for (const path of this.rootPaths) {
      for (let k = 0; k < path.length - 1; k++) {
        const a = path[k].pos;
        const b = path[k + 1].pos;
        const abx = b.x - a.x;
        const abz = b.z - a.z;
        const len2 = abx * abx + abz * abz;
        const u = len2 > 0 ? Math.min(1, Math.max(0, ((x - a.x) * abx + (z - a.z) * abz) / len2)) : 0;
        const d = Math.hypot(x - (a.x + abx * u), z - (a.z + abz * u));
        if (d < best) {
          best = d;
          along = (k + u) / (path.length - 1);
          rad = path[k].radius + (path[k + 1].radius - path[k].radius) * u;
        }
      }
    }
    if (best === Infinity) return { heave: 0, soil: 0 };
    // shoulders of soil just outside the root, fading toward its tip
    const shoulder = Math.exp(-((best - rad * 1.4) ** 2) / (2 * 0.12 * 0.12));
    const fade = 1 - smooth(0.55, 1, along);
    return { heave: 0.06 * shoulder * fade, soil: Math.exp(-(best * best) / (2 * (rad + 0.18) ** 2)) * (0.4 + 0.6 * fade) };
  }

  _groundPatch(shader) {
    Object.assign(shader.uniforms, this.groundUniforms);
    shader.uniforms.uSunDir = shared.uSunDir;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec3 aLand; // hollow · bare soil · inland
        uniform float uSnowCover;
        uniform sampler2D uNoiseB;
        varying vec3 vGroundPos;
        varying vec3 vGroundN;
        varying vec3 vLand;
        varying float vSnowDepth;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        // snow builds up — deepest in hollows and against rocks, none on steep
        // slopes, underwater, or at the rim (which must meet the underside)
        {
          vec2 nuv = position.xz / (2.0 * ${NOISE_EXTENT.toFixed(1)}) + 0.5;
          float rocks = texture2D(uNoiseB, nuv).b;
          float level = smoothstep(0.55, 0.8, normal.y);
          float dry = step(${(POND.water + 0.03).toFixed(3)}, position.y);
          vSnowDepth = (0.03 + 0.11 * aLand.x + 0.13 * rocks) * level * dry * aLand.z;
          transformed.y += uSnowCover * vSnowDepth;
        }`,
      )
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vGroundPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vGroundN = normalize(mat3(modelMatrix) * objectNormal);
        vLand = aLand;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <uv_pars_fragment>',
        `#include <uv_pars_fragment>
        varying vec3 vGroundPos;
        varying vec3 vGroundN;
        varying vec3 vLand;
        varying float vSnowDepth;
        uniform vec3 uGrass;
        uniform vec3 uMoss;
        uniform float uPetalCover;
        uniform float uLeafCover;
        uniform float uSnowCover;
        uniform vec3 uSnowColor;
        uniform sampler2D uNoiseA;
        uniform sampler2D uNoiseB;
        uniform float uTime;
        uniform float uCaustics;
        uniform float uSparkle;
        uniform float uPondIce;
        uniform vec3 uSunDir;
        const vec2 TREE_C = vec2(${TREE.x.toFixed(3)}, ${TREE.z.toFixed(3)});
        const vec2 POND_XZ = vec2(${POND.x.toFixed(3)}, ${POND.z.toFixed(3)});
        const float POND_RADIUS = ${POND.r.toFixed(3)};
        const float WATER_LEVEL = ${POND.water.toFixed(3)};

        // Caustics: two layers of drifting cells; light focuses into bright
        // threads where neighbouring cells meet (small F2 − F1).
        float causticLayer(vec2 p, float t) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          float d1 = 8.0;
          float d2 = 8.0;
          for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
              vec2 c = vec2(float(x), float(y));
              vec2 h = vec2(hash12(i + c), hash12(i + c + 19.7));
              vec2 o = 0.5 + 0.38 * sin(t * (0.5 + h * 0.6) + 6.2831 * h);
              float d = length(c + o - f);
              if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
            }
          }
          return 1.0 - smoothstep(0.0, 0.11, d2 - d1);
        }
        float caustics(vec2 p, float t) {
          float a = causticLayer(p * 3.1, t);
          float b = causticLayer(p * 4.3 + 7.1, t * 1.25);
          return pow(a * 0.65 + b * 0.5, 2.2);
        }`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec2 gp = vGroundPos.xz;
        // all the static noise comes from the baked textures (see bakeGroundNoise)
        vec2 nuv = gp / (2.0 * ${NOISE_EXTENT.toFixed(1)}) + 0.5;
        vec4 nA = texture2D(uNoiseA, nuv);
        vec4 nB = texture2D(uNoiseB, nuv);
        float n1 = nA.r;
        float n2 = nA.g;
        float rocks = nB.b; // proximity to stones, the lantern and torii posts
        vec3 grass = uGrass * (0.62 + 0.36 * n1) * (0.88 + 0.18 * n2);
        grass = mix(grass, grass * vec3(1.15, 1.06, 0.7), smoothstep(0.58, 0.85, n1) * 0.55);

        // soil: trampled earth at the trunk and along the roots, and exposed
        // where the rim falls away steeply
        vec3 soilCol = vec3(0.2, 0.14, 0.09) * (0.75 + 0.5 * n2) * (0.85 + 0.3 * step(0.7, nA.b));
        float soil = max(smoothstep(0.25, 0.75, vLand.y + (n2 - 0.5) * 0.4), smoothstep(0.82, 0.62, vGroundN.y));
        grass = mix(grass, soilCol, soil);

        // moss: in the damp ring around the pond and in the lee of stones
        float dPond = length(gp - POND_XZ);
        float pondRing = smoothstep(POND_RADIUS + 0.15, POND_RADIUS + 0.45, dPond) * smoothstep(POND_RADIUS + 1.5, POND_RADIUS + 0.6, dPond);
        float moss = smoothstep(0.35, 0.65, max(pondRing, rocks) * (0.55 + 0.6 * n1) + (n2 - 0.5) * 0.3) * (1.0 - soil);
        grass = mix(grass, uMoss * (0.75 + 0.4 * n2), moss);

        // the pond: a damp bank just above the waterline, then sandy shallows
        // deepening to dark silt, mottled with pebbles
        float wet = smoothstep(WATER_LEVEL + 0.14, WATER_LEVEL + 0.01, vGroundPos.y);
        float under = smoothstep(WATER_LEVEL + 0.01, WATER_LEVEL - 0.05, vGroundPos.y);
        float floorDepth = max(WATER_LEVEL - vGroundPos.y, 0.0);
        vec3 sand = vec3(0.42, 0.36, 0.26) * (0.75 + 0.5 * n2);
        vec3 silt = vec3(0.15, 0.16, 0.11) * (0.8 + 0.4 * n1);
        vec3 pondFloor = mix(sand, silt, smoothstep(0.08, 0.5, floorDepth));
        pondFloor *= 0.82 + 0.36 * step(0.68, nA.b);
        vec3 col = mix(grass, grass * vec3(0.5, 0.46, 0.38), wet);
        col = mix(col, pondFloor, under);
        float bank = max(wet, under);
        if (uCaustics > 0.5 && under > 0.0) {
          float atten = exp(-floorDepth * 1.6) * (1.0 - uPondIce);
          col *= 1.0 + caustics(gp, uTime) * 1.6 * atten * under;
        }

        float dTree = length(gp - TREE_C);
        float petalZone = smoothstep(9.0, 2.0, dTree) * (1.0 - bank);
        float pn = nA.b;
        float petal = step(1.0 - uPetalCover * petalZone * 0.55, pn);
        col = mix(col, vec3(0.94, 0.62, 0.7), petal);

        float leafZone = smoothstep(10.5, 2.5, dTree) * (1.0 - bank);
        float ln = nA.a;
        float leaf = step(1.0 - uLeafCover * leafZone * 0.5, ln);
        col = mix(col, mix(vec3(0.78, 0.3, 0.06), vec3(0.6, 0.1, 0.06), nB.g), leaf);

        // snow: arrives first in hollows and against stones, never on steep
        // ground or under water; a faint blue in its own drift shadows
        float sn = nB.r - vLand.x * 0.35 - rocks * 0.3;
        float slopeOk = smoothstep(0.55, 0.75, vGroundN.y);
        float snowAmt = smoothstep(sn - 0.08, sn + 0.08, uSnowCover * 1.2 - 0.08) * (1.0 - under) * slopeOk;
        vec3 snowCol = uSnowColor * mix(vec3(1.0), vec3(0.9, 0.94, 1.02), smoothstep(0.0, 0.12, vSnowDepth) * 0.6);
        col = mix(col, snowCol, snowAmt);
        diffuseColor.rgb = col;

        // sparkle (High preset): a sprinkling of ice crystals, each with its own
        // tilted facet. The glint itself is added after lighting (see below), so
        // the snow's shading normal is never disturbed.
        vec3 crystal = floor(vGroundPos * 70.0);
        float sparkle = uSparkle * step(0.9, hash13(crystal)) * smoothstep(0.6, 0.85, snowAmt)
                      * (1.0 - smoothstep(6.0, 22.0, distance(cameraPosition, vGroundPos)));
        vec3 facet = normalize((hash33(crystal + 3.1) * 2.0 - 1.0) * vec3(0.9, 0.35, 0.9) + vec3(0.0, 1.0, 0.0));`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.62, snowAmt);',
      )
      .replace(
        '#include <lights_fragment_end>',
        `#include <lights_fragment_end>
        {
          // a crystal flashes when its facet bisects the sun and the eye; scaled
          // by the direct light this pixel actually received, so none in shadow
          // (branch-free on purpose: cheap, and robust on every driver)
          vec3 sunLit = reflectedLight.directDiffuse / max(diffuseColor.rgb, vec3(0.05));
          vec3 Lv = normalize((viewMatrix * vec4(uSunDir, 0.0)).xyz);
          vec3 Hv = normalize(Lv + normalize(vViewPosition));
          vec3 Fv = normalize((viewMatrix * vec4(facet, 0.0)).xyz);
          float glint = pow(saturate(dot(Fv, Hv)), 400.0);
          reflectedLight.directSpecular += sunLit * glint * sparkle * 45.0;
        }`,
      );
  }

  /**
   * The ground's colour variation, fallen-petal / leaf speckles and snow
   * pattern are static, world-space value noise (~17 noise evaluations per
   * pixel). They are baked once into two mipmapped textures on the GPU, so the
   * ground shader does two texture fetches instead — and the mipmaps stop the
   * fine speckle from shimmering in the distance.
   */
  bakeGroundNoise(renderer, size = 1024) {
    const make = () =>
      new WebGLRenderTarget(size, size, {
        depthBuffer: false,
        generateMipmaps: true,
        minFilter: LinearMipmapLinearFilter,
        magFilter: LinearFilter,
      });
    const a = make();
    const b = make();
    const quad = new FullScreenQuad(
      new ShaderMaterial({
        uniforms: {
          uLayer: { value: 0 },
          uRocks: { value: this.rockSpots.slice(0, MAX_ROCK_SPOTS).map(([x, z, r]) => new Vector3(x, z, r)).concat(Array.from({ length: Math.max(0, MAX_ROCK_SPOTS - this.rockSpots.length) }, () => new Vector3(1e4, 1e4, 0))) },
        },
        vertexShader: 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
        fragmentShader: `#include <common>
          ${GLSL.common}
          uniform int uLayer;
          uniform vec3 uRocks[${MAX_ROCK_SPOTS}];
          varying vec2 vUv;
          void main() {
            vec2 gp = (vUv - 0.5) * 2.0 * ${NOISE_EXTENT.toFixed(1)};
            if (uLayer == 0) {
              gl_FragColor = vec4(
                fbm2(gp * 0.45),
                vnoise(gp * 3.1),
                vnoise(gp * 14.0) * 0.7 + fbm2(gp * 1.2 + 3.0) * 0.3,
                vnoise(gp * 9.0 + 17.0) * 0.7 + fbm2(gp * 1.1 + 5.0) * 0.3);
            } else {
              // proximity to stones and posts: moss grows, and snow drifts, against them
              float prox = 0.0;
              for (int i = 0; i < ${MAX_ROCK_SPOTS}; i++) {
                vec3 r = uRocks[i];
                float d = length(gp - r.xy);
                prox = max(prox, smoothstep(r.z + 0.6, r.z * 0.7, d));
              }
              gl_FragColor = vec4(fbm2(gp * 0.8 + 11.0) * 0.7 + vnoise(gp * 4.0) * 0.3, vnoise(gp * 4.0), prox, 1.0);
            }
          }`,
        depthTest: false,
        depthWrite: false,
      }),
    );
    const prev = renderer.getRenderTarget();
    for (const [layer, target] of [[0, a], [1, b]]) {
      quad.material.uniforms.uLayer.value = layer;
      renderer.setRenderTarget(target);
      quad.render(renderer);
    }
    // a CPU copy of the snow / stone layer, so props on the ground can follow
    // the same per-spot snow rule as the ground shader (see snowAt)
    if (!this._noiseB) {
      const data = new Uint8Array(size * size * 4);
      renderer.readRenderTargetPixels(b, 0, 0, size, size, data);
      this._noiseB = { data, size };
    }
    renderer.setRenderTarget(prev);
    quad.dispose();
    quad.material.dispose();
    // (also re-baked after a lost WebGL context: the old targets' GL objects
    // died with that context, so they are simply replaced — disposing them
    // would ask the new context to delete objects it never owned)
    this.groundUniforms.uNoiseA.value = a.texture;
    this.groundUniforms.uNoiseB.value = b.texture;
  }

  // --- rocky underside ----------------------------------------------------------

  _buildUnderside() {
    const ROWS = 16;
    const depth = 10.5;
    const tip = new Vector3(0.7, -depth, -0.5);
    const verts = [];
    const depthBelowRim = [];
    const index = [];

    for (let k = 0; k <= ROWS; k++) {
      const s = k / ROWS;
      for (let j = 0; j < SEG; j++) {
        const e = this.edge[j];
        const theta = (j / SEG) * Math.PI * 2;
        let x;
        let y;
        let z;
        if (k === 0) {
          x = e.x;
          y = e.y;
          z = e.z;
        } else {
          const shape = Math.pow(1 - s, 0.72) * (1 + 0.04 * Math.sin(s * Math.PI));
          const n = (fbm2(theta * 2.2 + 1, s * 4.5) - 0.5) * 2.4 * Math.sin(s * Math.PI) + (noise2(theta * 9, s * 14) - 0.5) * 0.5 * (1 - s);
          const rad = Math.max(0, shape + n / ISLAND_RADIUS);
          x = tip.x * s + e.x * rad;
          z = tip.z * s + e.z * rad;
          y = e.y - 0.12 - s * (depth - 1.5) - s * s * 1.5 + (noise2(theta * 6, s * 10) - 0.5) * 0.6 * Math.sin(s * Math.PI);
        }
        verts.push(x, y, z);
        depthBelowRim.push(e.y - y);
      }
    }
    for (let k = 0; k < ROWS; k++) {
      for (let j = 0; j < SEG; j++) {
        const j1 = (j + 1) % SEG;
        const a = k * SEG + j;
        const b = k * SEG + j1;
        const c = (k + 1) * SEG + j;
        const d = (k + 1) * SEG + j1;
        index.push(a, b, c, b, d, c);
      }
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(verts), 3));
    geo.setAttribute('aDepth', new BufferAttribute(new Float32Array(depthBelowRim), 1));
    geo.setIndex(index);
    geo.computeVertexNormals();

    const mat = enhanceMaterial(new MeshStandardMaterial({ roughness: 1, flatShading: true }), {
      snow: true,
      key: 'rock-under',
      patch: strataPatch,
    });
    this.underside = new Mesh(geo, mat);
    this.underside.receiveShadow = true;
    this.group.add(this.underside);
  }

  // --- koi pond -----------------------------------------------------------------

  _buildPond() {
    this.waterUniforms = UniformsUtils.merge([UniformsLib.fog]);
    Object.assign(this.waterUniforms, {
      uTime: shared.uTime,
      uSunDir: shared.uSunDir,
      uSunColor: shared.uSunColor,
      uSkyAmbient: shared.uSkyAmbient,
      uSkyZenith: shared.uSkyZenith,
      uSkyHorizon: shared.uSkyHorizon,
      uSnowCover: shared.uSnowCover,
      uSnowColor: shared.uSnowColor,
      uDeep: { value: new Color('#0a3a3c') },
      uShallow: { value: new Color('#3f7a6a') },
      uIce: { value: 0 },
      uPetals: { value: 0 },
      uLeaves: { value: 0 },
      uSceneColor: { value: null }, // High preset: this frame's opaque scene
      uResolution: { value: this.resolution },
    });
    const water = new Mesh(
      new CircleGeometry(POND.r + 0.15, 72).rotateX(-Math.PI / 2),
      new ShaderMaterial({
        uniforms: this.waterUniforms,
        vertexShader: waterVert,
        fragmentShader: '#include <common>\n' + GLSL.common + GLSL.snow + TERRAIN_GLSL + waterFrag,
        transparent: true,
        depthWrite: false,
        fog: true,
      }),
    );
    water.position.set(POND.x, POND.water, POND.z);
    water.renderOrder = 2;
    this.water = drawLate(water); // drawn after the opaque scene it refracts
    this.group.add(water);

    // koi: five fish on their own loops, at different depths and directions
    const koiGeo = createKoiGeometry();
    const n = 5;
    const swim = new Float32Array(n * 4);
    const place = new Float32Array(n * 4);
    const patterns = [0.1, 0.35, 0.6, 0.85, 0.15];
    for (let i = 0; i < n; i++) {
      swim.set([this.rng.float(0.7, 1.3), this.rng.float(0.14, 0.22) * (i % 2 ? -1 : 1), this.rng.float(0, 6.28), patterns[i]], i * 4);
      place.set([this.rng.spread(0.3), this.rng.spread(0.25), this.rng.float(0.16, 0.4), this.rng.float(0.5, 0.72)], i * 4);
    }
    koiGeo.setAttribute('aSwim', new InstancedBufferAttribute(swim, 4));
    koiGeo.setAttribute('aPlace', new InstancedBufferAttribute(place, 4));
    koiGeo.instanceCount = n;
    this.koiUniforms = {
      uKoiTime: { value: 0 },
      uSunDir: shared.uSunDir,
      uSunColor: shared.uSunColor,
      uSkyAmbient: shared.uSkyAmbient,
    };
    const koi = new Mesh(
      koiGeo,
      new ShaderMaterial({
        uniforms: this.koiUniforms,
        vertexShader: TERRAIN_GLSL + koiVert,
        fragmentShader: '#include <common>\n' + GLSL.common + koiFrag,
        side: DoubleSide,
      }),
    );
    koi.frustumCulled = false;
    this.group.add(koi);

    this._buildLilies();
  }

  /** Lily pads in two loose clusters near the banks, two of them flowering. */
  _buildLilies() {
    const rng = this.rng;
    const clusters = [
      { a: 2.35, r: 1.45, n: 4 },
      { a: 5.25, r: 1.35, n: 3 },
    ];
    this.pads = [];
    for (const c of clusters) {
      for (let k = 0; k < c.n; k++) {
        const a = c.a + rng.spread(0.45);
        const r = c.r + rng.spread(0.3);
        this.pads.push({
          x: POND.x + Math.cos(a) * r,
          z: POND.z + Math.sin(a) * r,
          size: rng.float(0.2, 0.34),
          spin: rng.float(0, Math.PI * 2),
          phase: rng.float(0, 6.28),
        });
      }
    }
    const padMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.42, side: DoubleSide });
    this.padMesh = new InstancedMesh(createLilyPadGeometry(), padMat, this.pads.length);
    this.padMesh.receiveShadow = true;
    this.padMesh.castShadow = true;
    this.padMesh.frustumCulled = false;

    this.flowerPads = [0, 4];
    const flowerMat = new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: DoubleSide });
    this.flowerMesh = new InstancedMesh(createWaterLilyGeometry(), flowerMat, this.flowerPads.length);
    this.flowerMesh.castShadow = true;
    this.flowerMesh.frustumCulled = false;
    this.group.add(this.padMesh, this.flowerMesh);
  }

  /** Apply the quality preset: refraction and caustics are High-only. */
  setQuality({ refraction, caustics, sparkle, sceneColor }) {
    const mat = this.water.material;
    const wants = refraction ? '' : undefined;
    if (mat.defines.REFRACTION !== wants) {
      if (refraction) mat.defines.REFRACTION = '';
      else delete mat.defines.REFRACTION;
      mat.needsUpdate = true;
    }
    this.waterUniforms.uSceneColor.value = refraction ? sceneColor : null;
    this.groundUniforms.uCaustics.value = caustics ? 1 : 0;
    this.groundUniforms.uSparkle.value = sparkle ? 1 : 0;
  }

  // --- stones: pond rim, boulders, stepping-stone path -----------------------

  _buildRocks() {
    const rng = this.rng;
    const rockGeo = createRockGeometry(1, 1);
    const stoneMat = enhanceMaterial(
      new MeshStandardMaterial({ color: '#8c877e', roughness: 0.95, flatShading: true }),
      { snow: true, key: 'stone', patch: mossOnStone },
    );

    const placements = [];
    const rimCount = 17;
    for (let i = 0; i < rimCount; i++) {
      const a = (i / rimCount) * Math.PI * 2 + rng.spread(0.12);
      const r = POND.r + 0.22 + rng.spread(0.12);
      const x = POND.x + Math.cos(a) * r;
      const z = POND.z + Math.sin(a) * r;
      const s = rng.float(0.17, 0.34);
      placements.push([x, terrainHeight(x, z) + s * 0.15, z, s * rng.float(1, 1.4), s * rng.float(0.6, 0.9), s * rng.float(1, 1.3), rng.float(0, 6.28)]);
    }
    // stones sitting right at the waterline, half in the water
    for (let i = 0; i < 7; i++) {
      const a = rng.float(0, Math.PI * 2);
      const r = POND.r - 0.12 + rng.spread(0.08);
      const x = POND.x + Math.cos(a) * r;
      const z = POND.z + Math.sin(a) * r;
      const s = rng.float(0.13, 0.24);
      placements.push([x, Math.max(terrainHeight(x, z), POND.water - 0.04) + s * 0.05, z, s * rng.float(1, 1.4), s * rng.float(0.6, 0.85), s, rng.float(0, 6.28)]);
    }
    // pebbles on the pond floor, seen through the water
    for (let i = 0; i < 16; i++) {
      const a = rng.float(0, Math.PI * 2);
      const r = Math.sqrt(rng.next()) * (POND.r - 0.5);
      const x = POND.x + Math.cos(a) * r;
      const z = POND.z + Math.sin(a) * r;
      const s = rng.float(0.05, 0.12);
      placements.push([x, terrainHeight(x, z) + s * 0.2, z, s * 1.3, s * 0.55, s, rng.float(0, 6.28)]);
    }
    // a few boulders around the island
    const boulders = [[-6.4, -3.6, 0.85], [6.8, -2.4, 0.6], [-7.6, 2.4, 0.5], [0.8, -7.2, 0.7], [5.5, 5.9, 0.45], [-5.2, -6.0, 0.45]];
    for (const [x, z, s] of boulders) {
      placements.push([x, terrainHeight(x, z) + s * 0.2, z, s * 1.2, s * 0.8, s, rng.float(0, 6.28)]);
    }

    const dummy = new Object3D();
    const rocks = new InstancedMesh(rockGeo, stoneMat, placements.length);
    placements.forEach(([x, y, z, sx, sy, sz, ry], i) => {
      dummy.position.set(x, y, z);
      dummy.rotation.set(0, ry, 0);
      dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix();
      rocks.setMatrixAt(i, dummy.matrix);
    });
    rocks.castShadow = true;
    rocks.receiveShadow = true;
    this.group.add(rocks);
    for (const [x, , z, sx, , sz] of placements) {
      const r = Math.max(sx, sz);
      if (r > 0.14) this.rockSpots.push([x, z, r]); // not the little floor pebbles
    }

    // stepping stones from the torii toward the tree
    const stoneGeo = new CylinderGeometry(0.42, 0.47, 0.16, 8);
    jitterGeometry(stoneGeo, 0.05, 5);
    const from = new Vector3(TORII.x, 0, TORII.z);
    const to = new Vector3(TREE.x, 0, TREE.z);
    const steps = 7;
    const path = new InstancedMesh(stoneGeo, stoneMat, steps);
    this.pathPoints = [];
    for (let i = 0; i < steps; i++) {
      const t = 0.08 + (i / (steps - 1)) * 0.62;
      const p = from.clone().lerp(to, t);
      p.x += Math.sin(i * 1.7) * 0.32;
      p.z += Math.cos(i * 1.3) * 0.18;
      this.pathPoints.push(p.clone());
      dummy.position.set(p.x, terrainHeight(p.x, p.z) + 0.03, p.z);
      dummy.rotation.set(0, rng.float(0, 3), 0);
      const s = rng.float(0.8, 1.1);
      dummy.scale.set(s, 1, s * rng.float(0.8, 1));
      dummy.updateMatrix();
      path.setMatrixAt(i, dummy.matrix);
    }
    path.receiveShadow = true;
    path.castShadow = true;
    this.group.add(path);
  }

  // --- torii gate -----------------------------------------------------------------

  _buildTorii() {
    const red = [];
    const black = [];
    const H = 3.0;
    for (const sx of [-1.18, 1.18]) {
      red.push(new CylinderGeometry(0.13, 0.155, H, 14).translate(sx, H / 2 - 0.1, 0));
      black.push(new CylinderGeometry(0.19, 0.2, 0.36, 14).translate(sx, 0.08, 0));
    }
    red.push(new BoxGeometry(3.25, 0.17, 0.12).translate(0, 2.3, 0)); // nuki
    red.push(new BoxGeometry(0.15, 0.45, 0.11).translate(0, 2.62, 0)); // gakuzuka
    red.push(new BoxGeometry(3.3, 0.17, 0.24).translate(0, 2.92, 0)); // shimaki

    // kasagi: the black top lintel with upswept ends
    const kasagi = new BoxGeometry(4.0, 0.18, 0.32, 32, 1, 1);
    const pos = kasagi.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const u = Math.abs(x) / 2.0;
      pos.setY(i, pos.getY(i) + 0.17 * Math.pow(u, 3) + (pos.getY(i) > 0 ? 0.02 * u : 0));
    }
    kasagi.computeVertexNormals();
    black.push(kasagi.translate(0, 3.1, 0));

    const redMat = enhanceMaterial(new MeshStandardMaterial({ color: '#c8382a', roughness: 0.55 }), {
      snow: true,
      key: 'torii-red',
    });
    const blackMat = enhanceMaterial(new MeshStandardMaterial({ color: '#1e1a1a', roughness: 0.45 }), {
      snow: true,
      key: 'torii-black',
    });

    const torii = new Group();
    for (const [parts, mat] of [[red, redMat], [black, blackMat]]) {
      const m = new Mesh(mergeGeometries(parts), mat);
      m.castShadow = true;
      m.receiveShadow = true;
      torii.add(m);
    }
    // face along the path to the tree
    const dx = TREE.x - TORII.x;
    const dz = TREE.z - TORII.z;
    torii.rotation.y = Math.atan2(dx, dz);
    torii.position.set(TORII.x, terrainHeight(TORII.x, TORII.z) - 0.05, TORII.z);
    for (const sx of [-1.18, 1.18]) {
      // snow drifts and moss gather at the foot of each post
      const c = Math.cos(torii.rotation.y);
      const sn = Math.sin(torii.rotation.y);
      this.rockSpots.push([TORII.x + sx * 0.95 * c, TORII.z - sx * 0.95 * sn, 0.22]);
    }
    torii.scale.setScalar(0.95);
    this.group.add(torii);
  }

  // --- stone lantern (tōrō) -----------------------------------------------------

  _buildLantern() {
    const parts = [
      new CylinderGeometry(0.34, 0.42, 0.16, 6).translate(0, 0.08, 0), // kiso
      new CylinderGeometry(0.12, 0.14, 0.78, 8).translate(0, 0.55, 0), // sao
      new CylinderGeometry(0.17, 0.17, 0.06, 8).translate(0, 0.55, 0), // ring
      new CylinderGeometry(0.34, 0.18, 0.16, 6).translate(0, 1.02, 0), // chūdai
      new CylinderGeometry(0.06, 0.06, 0.34, 6).translate(0, 1.27, 0), // core under the windows
      new CylinderGeometry(0.3, 0.3, 0.04, 6).translate(0, 1.12, 0),
      new CylinderGeometry(0.1, 0.52, 0.28, 6).translate(0, 1.58, 0), // kasa
      new CylinderGeometry(0.5, 0.5, 0.05, 6).translate(0, 1.43, 0),
      new SphereGeometry(0.1, 10, 8).translate(0, 1.79, 0), // hōju
      new CylinderGeometry(0.0, 0.07, 0.12, 8).translate(0, 1.9, 0),
    ];
    // six corner posts framing the fire box
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      parts.push(new BoxGeometry(0.06, 0.34, 0.06).translate(Math.cos(a) * 0.25, 1.27, Math.sin(a) * 0.25));
    }
    const stone = enhanceMaterial(new MeshStandardMaterial({ color: '#9b968d', roughness: 0.95, flatShading: true }), {
      snow: true,
      key: 'lantern',
    });
    const body = new Mesh(mergeGeometries(parts.map((g) => g.toNonIndexed())), stone);
    body.castShadow = true;
    body.receiveShadow = true;

    // paper windows glowing from within (HDR colour → bloom)
    this.lanternGlow = new MeshBasicMaterial({ color: new Color('#ffb46a'), side: DoubleSide, fog: true });
    this.lanternGlowBase = new Color('#ffb46a');
    const windows = new Mesh(new CylinderGeometry(0.22, 0.22, 0.3, 6, 1, true).translate(0, 1.27, 0), this.lanternGlow);

    const lantern = new Group();
    lantern.add(body, windows);
    const y = terrainHeight(LANTERN.x, LANTERN.z) - 0.04;
    lantern.position.set(LANTERN.x, y, LANTERN.z);
    this.rockSpots.push([LANTERN.x, LANTERN.z, 0.5]);
    lantern.rotation.y = 0.4;
    lantern.scale.setScalar(1.3);
    this.group.add(lantern);
    this.lanternLightPos = new Vector3(LANTERN.x, y + 1.27 * 1.3, LANTERN.z);
  }

  // --- small rock islets drifting around the main island -------------------------

  _buildFloatingRocks() {
    const rng = this.rng;
    const geo = createRockGeometry(1, 2);
    // flatten the top, pull the bottom into a point: a tiny floating island
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      p.setY(i, y > 0.2 ? 0.2 + (y - 0.2) * 0.25 : y * 1.6);
    }
    geo.computeVertexNormals();
    const mat = enhanceMaterial(new MeshStandardMaterial({ color: '#8a7e70', roughness: 1, flatShading: true }), {
      snow: true,
      key: 'islet',
    });
    this.islets = [];
    const n = 6;
    this.isletMesh = new InstancedMesh(geo, mat, n);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rng.spread(0.35);
      const r = rng.float(13.5, 18);
      this.islets.push({
        base: new Vector3(Math.cos(a) * r, rng.float(-4, 2.5), Math.sin(a) * r),
        scale: rng.float(0.45, 1.1),
        phase: rng.float(0, 6.28),
        spin: rng.float(0, 6.28),
      });
    }
    this.isletMesh.castShadow = true;
    this.isletMesh.receiveShadow = true;
    this.group.add(this.isletMesh);
    this._dummy = new Object3D();
  }

  // --- per frame ------------------------------------------------------------------

  /** Pads bob and turn on the swell; they die back under ice and snow, and flower in early summer. */
  _updateLilies(state) {
    const t = shared.uTime.value;
    const presence = Math.max(0, 1 - Math.max(state.pondIce, state.snowCover) * 1.2);
    const y = state.year;
    const bloom = Math.min(1, Math.max(0, (y - 0.3) / 0.06)) * Math.min(1, Math.max(0, (0.62 - y) / 0.06));
    const d = this._dummy;
    this.pads.forEach((pad, i) => {
      d.position.set(pad.x, POND.water + 0.004 + Math.sin(t * 0.9 + pad.phase) * 0.006, pad.z);
      d.rotation.set(Math.sin(t * 0.7 + pad.phase) * 0.02, pad.spin + Math.sin(t * 0.12 + pad.phase) * 0.15, 0);
      d.scale.setScalar(pad.size * presence + 1e-4);
      d.updateMatrix();
      this.padMesh.setMatrixAt(i, d.matrix);
    });
    this.padMesh.instanceMatrix.needsUpdate = true;
    this.padMesh.visible = presence > 0.01;

    this.flowerPads.forEach((p, i) => {
      const pad = this.pads[p];
      d.position.set(pad.x + 0.03, POND.water + 0.012 + Math.sin(t * 0.9 + pad.phase) * 0.006, pad.z - 0.02);
      d.rotation.set(0, pad.phase, 0);
      d.scale.setScalar(0.11 * bloom * presence + 1e-4);
      d.updateMatrix();
      this.flowerMesh.setMatrixAt(i, d.matrix);
    });
    this.flowerMesh.instanceMatrix.needsUpdate = true;
    this.flowerMesh.visible = bloom * presence > 0.01;
  }

  update(state, dt, lighting) {
    this.groundUniforms.uGrass.value.copy(state.grass);
    this.groundUniforms.uPetalCover.value = state.petalCover;
    this.groundUniforms.uLeafCover.value = state.leafCover;


    this.waterUniforms.uIce.value = state.pondIce;
    this.groundUniforms.uPondIce.value = state.pondIce;
    this._updateLilies(state);
    this.waterUniforms.uPetals.value = state.petalCover;
    this.waterUniforms.uLeaves.value = state.leafCover;

    // koi slow right down under the ice
    this.koiTime += dt * (1 - 0.85 * state.pondIce);
    this.koiUniforms.uKoiTime.value = this.koiTime;

    // lantern glow (HDR)
    const glow = lighting.lanternLevel;
    this.lanternGlow.color.copy(this.lanternGlowBase).multiplyScalar(0.25 + glow * 5.5 * (lighting.lantern.intensity / 7 + 0.1));

    // islets bob gently
    const t = shared.uTime.value;
    this.islets.forEach((it, i) => {
      const d = this._dummy;
      d.position.copy(it.base);
      d.position.y += Math.sin(t * 0.35 + it.phase) * 0.35;
      d.rotation.set(0, it.spin + t * 0.02, 0);
      d.scale.setScalar(it.scale);
      d.updateMatrix();
      this.isletMesh.setMatrixAt(i, d.matrix);
    });
    this.isletMesh.instanceMatrix.needsUpdate = true;
  }
}

// --- geometry helpers ------------------------------------------------------------

function jitterGeometry(geo, amount, seed) {
  const p = geo.attributes.position;
  const v = new Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    // hash by position so shared vertices of non-indexed geometry stay welded
    const h = noise2(v.x * 3.1 + seed, v.z * 3.1 + v.y * 1.7);
    v.multiplyScalar(1 + (h - 0.5) * amount * 2);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

function createRockGeometry(radius, detail) {
  const g = new IcosahedronGeometry(radius, detail);
  return jitterGeometry(g, 0.22, 2);
}

/**
 * Procedural koi, head at +x, ~1 unit long before scaling.
 *   aBody: 0 at the nose → 1 at the tail tip (drives the swimming wave)
 *   aFin:  0 body · 1 tail · 2 pectoral · 3 dorsal (each fin moves its own way)
 * A blunt head, widest just behind it, a narrow tail stalk, then a long
 * two-lobed tail fan; flat pectoral fins and a low dorsal crest.
 */
function createKoiGeometry() {
  const pos = [];
  const nrm = [];
  const body = [];
  const fin = [];
  const index = [];
  const RINGS = 18;
  const RAD = 12;
  for (let i = 0; i <= RINGS; i++) {
    const s = i / RINGS; // 0 nose → 1 tail root
    const x = 0.45 - s * 0.9;
    // blunt rounded head, fullest at ~30 %, tapering to a slim peduncle
    const r = 0.13 * Math.pow(Math.sin(Math.PI * Math.min(1, 0.08 + s * 0.86)), 0.7) * (1 - 0.55 * s * s) + 0.014;
    for (let j = 0; j <= RAD; j++) {
      const a = (j / RAD) * Math.PI * 2;
      const cy = Math.cos(a);
      const cz = Math.sin(a);
      pos.push(x, cy * r * 0.85, cz * r);
      nrm.push(0, cy, cz);
      body.push(s * 0.8);
      fin.push(0);
    }
  }
  // ring vertices run counter-clockwise around +x seen from the head; emit
  // so front faces point outward (the material is double-sided anyway)
  for (let i = 0; i < RINGS; i++) {
    for (let j = 0; j < RAD; j++) {
      const a = i * (RAD + 1) + j;
      const b = a + RAD + 1;
      index.push(a, a + 1, b, a + 1, b + 1, b);
    }
  }

  const vert = (x, y, z, bs, f, n = [0, 1, 0]) => {
    pos.push(x, y, z);
    nrm.push(...n);
    body.push(bs);
    fin.push(f);
    return pos.length / 3 - 1;
  };

  // tail: a segmented fan so it can ripple; trailing edge notched into two lobes
  const T = 6;
  const rows = [];
  for (let k = 0; k <= T; k++) {
    const u = k / T;
    const x = -0.45 - u * 0.34;
    const w = 0.02 + 0.2 * Math.pow(u, 0.8);
    const notch = k === T ? 0.12 : 0;
    rows.push([vert(x, 0, -w, 0.8 + 0.2 * u, 1), vert(x + notch, 0, 0, 0.8 + 0.2 * u, 1), vert(x, 0, w, 0.8 + 0.2 * u, 1)]);
  }
  for (let k = 0; k < T; k++) {
    const [a0, a1, a2] = rows[k];
    const [b0, b1, b2] = rows[k + 1];
    index.push(a0, b0, a1, a1, b0, b1, a1, b1, a2, a2, b1, b2);
  }

  // pectoral fins
  for (const side of [-1, 1]) {
    const a = vert(0.2, -0.06, side * 0.08, 0.28, 2);
    const b = vert(0.05, -0.08, side * 0.24, 0.42, 2);
    const c = vert(0.1, -0.06, side * 0.08, 0.34, 2);
    const d = vert(0.16, -0.07, side * 0.2, 0.36, 2);
    index.push(a, d, c, c, d, b);
  }

  // dorsal crest
  const dn = [0, 0, 1];
  const d0 = vert(0.12, 0.1, 0, 0.35, 3, dn);
  const d1 = vert(-0.12, 0.08, 0, 0.55, 3, dn);
  const d2 = vert(0.02, 0.17, 0, 0.42, 3, dn);
  const d3 = vert(-0.2, 0.12, 0, 0.62, 3, dn);
  index.push(d0, d1, d2, d2, d1, d3);

  const g = new InstancedBufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('aBody', new BufferAttribute(new Float32Array(body), 1));
  g.setAttribute('aFin', new BufferAttribute(new Float32Array(fin), 1));
  g.setIndex(index);
  return g;
}

/** A lily pad: a disc with the classic notch, slightly cupped, with radial veins. Radius 1. */
function createLilyPadGeometry() {
  const SEG = 30;
  const RINGS = 3;
  const notch = 0.22; // half-angle of the cut
  const pos = [0, 0.01, 0];
  const col = [];
  const index = [];
  const dark = new Color('#2f5a24');
  const light = new Color('#6a9a3e');
  const c = new Color();
  c.copy(dark);
  col.push(c.r, c.g, c.b);
  for (let i = 1; i <= RINGS; i++) {
    const t = i / RINGS;
    for (let j = 0; j <= SEG; j++) {
      const a = notch + (j / SEG) * (Math.PI * 2 - 2 * notch);
      pos.push(Math.cos(a) * t, 0.01 + 0.05 * Math.pow(t, 4), Math.sin(a) * t);
      const vein = Math.pow(Math.abs(Math.cos(a * 9)), 18) * 0.25;
      c.lerpColors(dark, light, t * 0.8 + vein);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let j = 0; j < SEG; j++) index.push(0, 2 + j, 1 + j);
  for (let i = 1; i < RINGS; i++) {
    const a0 = 1 + (i - 1) * (SEG + 1);
    const b0 = 1 + i * (SEG + 1);
    for (let j = 0; j < SEG; j++) index.push(a0 + j, a0 + j + 1, b0 + j, a0 + j + 1, b0 + j + 1, b0 + j);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** A water lily: two whorls of pointed petals, white flushing pink, around a gold centre. Height ~1. */
function createWaterLilyGeometry() {
  const pos = [];
  const col = [];
  const index = [];
  const tip = new Color('#f6c3d4');
  const base = new Color('#fff6f2');
  const gold = new Color('#f2c14e');
  const add = (p, c) => {
    pos.push(p[0], p[1], p[2]);
    col.push(c.r, c.g, c.b);
    return pos.length / 3 - 1;
  };
  const whorls = [
    { n: 8, len: 1.0, lift: 0.55, offset: 0 },
    { n: 8, len: 0.75, lift: 0.95, offset: Math.PI / 8 },
  ];
  for (const w of whorls) {
    for (let k = 0; k < w.n; k++) {
      const a = w.offset + (k / w.n) * Math.PI * 2;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      const sx = -dz;
      const sz = dx;
      const reach = w.len * Math.cos(w.lift * 0.6);
      const b0 = add([sx * 0.08, 0.05, sz * 0.08], base);
      const b1 = add([-sx * 0.08, 0.05, -sz * 0.08], base);
      const m0 = add([dx * reach * 0.55 + sx * 0.17, w.lift * 0.45, dz * reach * 0.55 + sz * 0.17], base.clone().lerp(tip, 0.4));
      const m1 = add([dx * reach * 0.55 - sx * 0.17, w.lift * 0.45, dz * reach * 0.55 - sz * 0.17], base.clone().lerp(tip, 0.4));
      const t = add([dx * reach, w.lift * 0.75, dz * reach], tip);
      index.push(b0, m0, b1, b1, m0, m1, m0, t, m1);
    }
  }
  // gold centre
  const centre = add([0, 0.22, 0], gold);
  const ring = [];
  for (let k = 0; k <= 10; k++) {
    const a = (k / 10) * Math.PI * 2;
    ring.push(add([Math.cos(a) * 0.16, 0.12, Math.sin(a) * 0.16], gold));
  }
  for (let k = 0; k < 10; k++) index.push(centre, ring[k + 1], ring[k]);

  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new BufferAttribute(new Float32Array(col), 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** Moss on the upper faces of stones (before the snow layer, which lands on top). */
function mossOnStone(shader) {
  shader.fragmentShader = shader.fragmentShader.replace(
    '#include <color_fragment>',
    `#include <color_fragment>
    {
      float mn = vnoise(vSnowPos.xz * 3.0 + vSnowPos.y * 2.0) * 0.6 + vnoise(vSnowPos.xz * 11.0 - vSnowPos.y) * 0.4;
      float up = smoothstep(0.1, 0.75, normalize(vSnowNormal).y);
      float moss = smoothstep(0.5, 0.66, mn * 0.75 + up * 0.4);
      diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.2, 0.32, 0.11) * (0.75 + 0.5 * mn), moss);
    }`,
  );
}

/**
 * The island's cut edge and underside: a band of dark humus under the grassy
 * rim with root threads hanging out of it, then tilted, warped rock strata
 * with dark seams between layers, darkening toward the hanging tip.
 */
function strataPatch(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aDepth;\nvarying float vUnderDepth;')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\nvUnderDepth = aDepth;');
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <uv_pars_fragment>', '#include <uv_pars_fragment>\nvarying float vUnderDepth;')
    .replace(
      '#include <color_fragment>',
      `#include <color_fragment>
      {
        vec3 wp = vSnowPos;
        float d = vUnderDepth;            // depth below the grassy rim
        float ang = atan(wp.z, wp.x);
        // rock strata: gently tilted, warped layers
        float warp = vnoise(vec2(ang * 3.0, wp.y * 0.25)) * 1.4 + vnoise(wp.xz * 0.9 + wp.y) * 0.35;
        float band = wp.y * 1.15 + warp + wp.x * 0.05;
        float id = floor(band);
        float f = fract(band);
        float pick = hash11(id * 1.37 + 4.0);
        vec3 rock = pick < 0.25 ? vec3(0.6, 0.53, 0.44) : pick < 0.5 ? vec3(0.45, 0.42, 0.39)
                  : pick < 0.75 ? vec3(0.68, 0.56, 0.4) : vec3(0.52, 0.48, 0.43);
        rock *= 0.85 + 0.3 * vnoise(vec2(ang * 40.0, wp.y * 6.0));                          // grain
        rock *= mix(0.72, 1.0, smoothstep(0.0, 0.04, f) * smoothstep(1.0, 0.95, f));         // seams
        // humus under the rim, with hanging root threads
        float soilBand = smoothstep(0.85, 0.35, d);
        vec3 soil = vec3(0.27, 0.19, 0.12) * (0.8 + 0.4 * vnoise(vec2(ang * 30.0, d * 8.0)));
        float roots = smoothstep(0.035, 0.0, abs(vnoise(vec2(ang * 55.0, d * 1.5)) - 0.5)) * smoothstep(1.1, 0.2, d);
        soil = mix(soil, vec3(0.5, 0.38, 0.25), roots * 0.85);
        vec3 col = mix(rock, soil, soilBand);
        col = mix(col, vec3(0.2, 0.3, 0.12), smoothstep(0.12, 0.0, d) * 0.8);                // grassy lip
        col *= mix(1.0, 0.55, smoothstep(1.0, 10.0, d));                                     // less sky lower down
        diffuseColor.rgb = col;
      }`,
    );
}
