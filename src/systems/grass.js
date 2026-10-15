import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedMesh,
  MeshLambertMaterial,
  Object3D,
} from 'three';
import { Rng, fbm2 } from '../core/random.js';
import { shared } from '../core/uniforms.js';
import { enhanceMaterial, GLSL } from '../core/materials.js';
import { POND, TREE, LANTERN, ISLAND_RADIUS } from '../core/layout.js';
import { edgeRadius } from './island.js';

// ---------------------------------------------------------------------------
// Grass: instanced tufts of curved blades.
//   • two-sided: the material is DoubleSide, so three flips the normal on back
//     faces; the shader then tilts that (already facing the viewer) normal
//     toward the sky, so both faces of a blade light correctly and softly
//   • wind: the shared windOffset(), weighted by height², plus a fast flutter
//   • seasons: fresh shoots in spring, lush summer, each blade drying to straw
//     on its own schedule in autumn, frosted tips at the turn of winter, and
//     sinking under the snow patch by patch, in step with the ground turning
//     white beneath it (the ground shader's snow rule, via island.snowAt)
//   • quality: High draws more tufts with finer blades; Low fewer, coarser
//     ones. Both geometries share the per-tuft data, so switching is free.
// ---------------------------------------------------------------------------

const COUNTS = { high: 12000, low: 4200 };

const smooth = (a, b, v) => {
  const t = Math.min(Math.max((v - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

export class Grass {
  constructor(scene, island) {
    this.island = island;
    this.uniforms = {
      uGrassColor: { value: new Color('#79b04b') },
      uStraw: { value: new Color('#b79a58') },
      uStrawDark: { value: new Color('#7c6648') },
      uFrostColor: { value: new Color('#dfe8f2') },
      uFresh: { value: 0 },
      uDry: { value: 0 },
      uFrost: { value: 0 },
      uHeight: { value: 1 },
      uFlop: { value: 0 },
    };

    const tufts = this._plant();
    this.count = tufts.length;
    const data = new InstancedBufferAttribute(new Float32Array(tufts.flatMap((t) => t.rand)), 4);
    this.geometries = {
      high: createTuftGeometry({ blades: 4, rows: 5, seed: 3 }),
      low: createTuftGeometry({ blades: 3, rows: 3, seed: 3 }),
    };
    // where each tuft's patch of ground turns white (island.snowAt): the blade
    // sinks with its own patch, so no tip pokes out of ground already snowed over
    const snowAt = new InstancedBufferAttribute(
      new Float32Array(tufts.flatMap((t) => {
        const s = island.snowAt(t.x, t.z);
        return [s.threshold, s.slope];
      })),
      2,
    );
    for (const g of Object.values(this.geometries)) {
      g.setAttribute('aTuft', data);
      g.setAttribute('aSnowAt', snowAt);
    }

    this.material = new MeshLambertMaterial({ side: DoubleSide });
    enhanceMaterial(this.material, { key: 'grass-v2', patch: (shader) => this._patch(shader) });

    this.mesh = new InstancedMesh(this.geometries.high, this.material, this.count);
    const d = new Object3D();
    tufts.forEach((t, i) => {
      d.position.set(t.x, t.y, t.z);
      d.rotation.set(0, t.yaw, 0);
      d.scale.set(t.scale, t.scale * t.tall, t.scale);
      d.updateMatrix();
      this.mesh.setMatrixAt(i, d.matrix);
    });
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.setQuality({ name: 'high' });
  }

  /** Scatter tufts over the open ground, in clumps, clear of water, soil, stones and paths. */
  _plant() {
    const rng = new Rng(808);
    const isl = this.island;
    const tufts = [];
    let guard = 0;
    while (tufts.length < COUNTS.high && guard++ < COUNTS.high * 30) {
      const a = rng.float(0, Math.PI * 2);
      const r = Math.sqrt(rng.next()) * ISLAND_RADIUS * 1.05;
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (r > edgeRadius(a) - 0.45) continue;
      if (Math.hypot(x - POND.x, z - POND.z) < POND.r + 0.4) continue;
      if (Math.hypot(x - TREE.x, z - TREE.z) < 1.15) continue;
      if (Math.hypot(x - LANTERN.x, z - LANTERN.z) < 0.55) continue;
      if (isl.pathPoints.some((p) => Math.hypot(x - p.x, z - p.z) < 0.5)) continue;
      if (isl.rockSpots.some(([rx, rz, rr]) => Math.hypot(x - rx, z - rz) < rr + 0.08)) continue;
      if (isl._rootHeave(x, z).soil > 0.45) continue;
      // clumpy, with thinner patches
      if (fbm2(x * 0.5 + 9, z * 0.5 + 9) < rng.float(0.25, 0.5)) continue;
      tufts.push({
        x,
        y: isl.surfaceHeight(x, z) - 0.02,
        z,
        yaw: rng.float(0, Math.PI * 2),
        scale: rng.float(0.75, 1.2),
        tall: rng.float(0.75, 1.35),
        rand: [rng.next(), rng.next(), rng.next(), rng.next()], // hue · dry order · phase · lean
      });
    }
    return tufts;
  }

  _patch(shader) {
    Object.assign(shader.uniforms, this.uniforms);
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uWindStrength = shared.uWindStrength;
    shader.uniforms.uWindDir = shared.uWindDir;
    shader.uniforms.uSnowCover = shared.uSnowCover;
    shader.uniforms.uSunDir = shared.uSunDir;
    shader.uniforms.uSunColor = shared.uSunColor;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        ${GLSL.wind}
        attribute vec4 aTuft;
        attribute vec2 aSnowAt; // this patch's snow threshold · can it hold snow (0 when steep)
        uniform float uHeight;
        uniform float uSnowCover;
        uniform float uFlop;
        varying float vH;
        varying vec4 vTuft;
        varying vec3 vGrassWorld;`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vH = uv.y;
        vTuft = aTuft;
        // the ground shader's own snow rule at this tuft: once its patch turns
        // white the blade has sunk out of sight (gone by half-coverage)
        float snowHere = smoothstep(aSnowAt.x - 0.08, aSnowAt.x + 0.08, uSnowCover * 1.2 - 0.08) * aSnowAt.y;
        float buried = 1.0 - smoothstep(0.0, 0.5, snowHere);
        transformed.y *= uHeight * buried;
        // dry blades flop over
        transformed.xz += normalize(vec2(aTuft.w - 0.5, 0.35)) * uFlop * uv.y * uv.y * 0.14;`,
      )
      .replace(
        '#include <project_vertex>',
        `vec4 mvPosition = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
          vec3 root = (instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
          float h = uv.y * uHeight;
          mvPosition.xyz += windOffset(root, h * h * 0.5);
          mvPosition.xz += uWindDir * windFlutter(root + aTuft.z * 3.0, 7.0) * 0.035 * h;
        #endif
        vGrassWorld = (modelMatrix * mvPosition).xyz;
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uGrassColor;
        uniform vec3 uStraw;
        uniform vec3 uStrawDark;
        uniform vec3 uFrostColor;
        uniform float uFresh;
        uniform float uDry;
        uniform float uFrost;
        uniform vec3 uSunDir;
        uniform vec3 uSunColor;
        varying float vH;
        varying vec4 vTuft;
        varying vec3 vGrassWorld;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        vec3 base = uGrassColor * (0.82 + 0.36 * vTuft.x);
        base *= vec3(1.0 + (vTuft.x - 0.5) * 0.14, 1.0, 1.0 - (vTuft.x - 0.5) * 0.16);
        // each blade dries on its own schedule
        float dry = smoothstep(vTuft.y * 0.6, vTuft.y * 0.6 + 0.4, uDry);
        base = mix(base, mix(uStraw, uStrawDark, vTuft.x), dry);
        // pale fresh shoots at the tips in spring
        base = mix(base, base * vec3(1.15, 1.22, 0.82), uFresh * smoothstep(0.45, 1.0, vH));
        vec3 grassCol = base * mix(0.36, 1.12, vH); // dim at the root, bright at the tip
        // hoar frost on the upper blade
        grassCol = mix(grassCol, uFrostColor, uFrost * smoothstep(0.3, 1.0, vH) * (0.55 + 0.45 * vTuft.z));
        diffuseColor.rgb = grassCol;`,
      )
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        // three has already flipped the normal for back faces (DOUBLE_SIDED), so
        // it faces the viewer on either side; tilt it toward the sky for soft,
        // even lighting from both sides of the blade
        normal = normalize(normal + normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz) * 0.9);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
        // sunlight glowing through blades seen against the sun
        {
          vec3 V = normalize(cameraPosition - vGrassWorld);
          float through = pow(saturate(dot(-V, uSunDir)), 3.0) * vH;
          totalEmissiveRadiance += diffuseColor.rgb * uSunColor * through * 0.12 * RECIPROCAL_PI;
        }`,
      );
  }

  setQuality({ name }) {
    const high = name === 'high';
    this.mesh.geometry = high ? this.geometries.high : this.geometries.low;
    this.mesh.count = Math.min(this.count, high ? COUNTS.high : COUNTS.low);
  }

  update(state) {
    const y = state.year;
    const u = this.uniforms;
    u.uGrassColor.value.copy(state.grass);
    u.uFresh.value = smooth(0.04, 0.12, y) * (1 - smooth(0.24, 0.34, y));
    // dry: the winter straw greens over by mid-spring; dries again through autumn
    u.uDry.value = y < 0.5 ? 1 - smooth(0.0, 0.16, y) : smooth(0.6, 0.8, y);
    u.uFlop.value = u.uDry.value * 0.6;
    // frost at the turn of winter, and on the thawing straw in late winter
    const firstFrost = smooth(0.73, 0.79, y) * (1 - smooth(0.84, 0.9, y));
    const thaw = 0.5 * Math.max(smooth(0.93, 0.98, y), 1 - smooth(0.0, 0.06, y));
    u.uFrost.value = Math.max(firstFrost, thaw);
    // grows in spring, stands tall in summer, settles in autumn, buried in winter
    const growth = 0.5 + 0.5 * smooth(0.02, 0.24, y);
    u.uHeight.value = growth * (1 - 0.15 * u.uDry.value) * Math.max(0, 1 - state.snowCover * 1.12); // fully buried in deep snow
    this.mesh.visible = u.uHeight.value > 0.06;
  }
}

/**
 * A tuft: `blades` curved, tapering blades fanned around the root. Each blade
 * is a strip of `rows` vertex pairs; uv.y = height fraction (wind, colour).
 */
function createTuftGeometry({ blades, rows, seed }) {
  const rng = new Rng(seed);
  const pos = [];
  const nrm = [];
  const uv = [];
  const index = [];
  for (let b = 0; b < blades; b++) {
    const yaw = (b / blades) * Math.PI + rng.spread(0.3);
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const h = rng.float(0.26, 0.4);
    const w = rng.float(0.03, 0.045);
    const lean = rng.float(0.05, 0.14) * (rng.chance(0.5) ? -1 : 1);
    const ox = rng.spread(0.05);
    const oz = rng.spread(0.05);
    const base = pos.length / 3;
    for (let k = 0; k < rows; k++) {
      const u = k / (rows - 1);
      const half = w * (1 - u) * 0.5 + 0.0015;
      const bend = lean * u * u; // arcs over toward the tip
      // blade plane spans local x' (width); it leans along local z'
      for (const side of [-1, 1]) {
        const lx = side * half;
        const lz = bend;
        pos.push(ox + lx * c - lz * s, u * h, oz + lx * s + lz * c);
        nrm.push(s, 0.2, -c); // ⟂ to the blade's width
        uv.push(side < 0 ? 0 : 1, u);
      }
    }
    for (let k = 0; k < rows - 1; k++) {
      const a = base + k * 2;
      index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array(uv), 2));
  g.setIndex(index);
  return g;
}
