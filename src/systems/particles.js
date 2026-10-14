import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DataTexture,
  DoubleSide,
  FloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  NearestFilter,
  Points,
  RGBAFormat,
  ShaderMaterial,
  UniformsLib,
  UniformsUtils,
} from 'three';
import { Rng } from '../core/random.js';
import { shared } from '../core/uniforms.js';
import { GLSL } from '../core/materials.js';
import { POND, TREE, TERRAIN_GLSL, terrainHeight } from '../core/layout.js';
import { drawLate } from '../core/layers.js';
import fallingVert from '../shaders/falling.vert?raw';
import fallingFrag from '../shaders/falling.frag?raw';
import snowVert from '../shaders/snow.vert?raw';
import snowFrag from '../shaders/snow.frag?raw';
import fireflyVert from '../shaders/firefly.vert?raw';
import fireflyFrag from '../shaders/firefly.frag?raw';

/**
 * All four particle families. Each is a single draw call whose motion lives
 * entirely in its vertex shader; per frame the CPU only writes emission rates.
 */
export class Particles {
  constructor(scene, spawnPoints) {
    this.rng = new Rng(404);
    this.spawn = createSpawnTexture(spawnPoints);

    this.petals = this._createFalling({
      count: 1400,
      geometry: createPetalGeometry(),
      life: 15,
      fall: 0.62,
      drift: 0.75,
      flutter: 0.4,
      spin: 2.4,
      scale: 0.12,
      colors: ['#f7b6c9', '#ffe4ec', '#fff8fa'],
      translucency: 0.7,
    });
    this.leaves = this._createFalling({
      count: 750,
      geometry: createLeafGeometry(),
      life: 13,
      fall: 0.95,
      drift: 0.6,
      flutter: 0.32,
      spin: 3.2,
      scale: 0.2,
      colors: ['#e3ad3a', '#d9612a', '#a8262a'],
      translucency: 0.5,
    });
    // transparent: drawn after the opaque scene is captured for the pond
    this.snow = drawLate(this._createSnow(3200));
    this.fireflies = drawLate(this._createFireflies(110));

    scene.add(this.petals, this.leaves, this.snow, this.fireflies);
  }

  _createFalling({ count, geometry, life, fall, drift, flutter, spin, scale, colors, translucency }) {
    const rng = this.rng;
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < seeds.length; i++) seeds[i] = rng.next();

    const geo = new InstancedBufferGeometry();
    geo.copy(geometry);
    geo.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 4));
    geo.instanceCount = count;

    const uniforms = UniformsUtils.merge([UniformsLib.fog]);
    Object.assign(uniforms, {
      uTime: shared.uTime,
      uWindStrength: shared.uWindStrength,
      uWindDir: shared.uWindDir,
      uSunDir: shared.uSunDir,
      uSunColor: shared.uSunColor,
      uSkyAmbient: shared.uSkyAmbient,
      uGroundAmbient: shared.uGroundAmbient,
      uSpawn: { value: this.spawn.texture },
      uSpawnSize: { value: this.spawn.size },
      uSpawnCount: { value: this.spawn.count },
      uRate: { value: 0 },
      uLife: { value: life },
      uFall: { value: fall },
      uDrift: { value: drift },
      uFlutter: { value: flutter },
      uSpin: { value: spin },
      uScale: { value: scale },
      uColorA: { value: new Color(colors[0]) },
      uColorB: { value: new Color(colors[1]) },
      uColorC: { value: new Color(colors[2]) },
      uTranslucency: { value: translucency },
    });

    const mesh = new Mesh(
      geo,
      new ShaderMaterial({
        uniforms,
        vertexShader: '#include <common>\n' + GLSL.common + GLSL.wind + TERRAIN_GLSL + fallingVert,
        fragmentShader: '#include <common>\n' + fallingFrag,
        side: DoubleSide,
        fog: true,
      }),
    );
    mesh.frustumCulled = false;
    return mesh;
  }

  _createSnow(count) {
    const rng = this.rng;
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      // uniform over a disc
      const a = rng.float(0, Math.PI * 2);
      const r = Math.sqrt(rng.next());
      seeds.set([Math.cos(a) * r, rng.next(), Math.sin(a) * r, rng.next()], i * 4);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('aSeed', new BufferAttribute(seeds, 4));

    this.snowUniforms = {
      uTime: shared.uTime,
      uWindStrength: shared.uWindStrength,
      uWindDir: shared.uWindDir,
      uSunColor: shared.uSunColor,
      uSkyAmbient: shared.uSkyAmbient,
      uRate: { value: 0 },
      uSize: { value: 0.085 },
      uScale: { value: 500 },
    };
    const points = new Points(
      geo,
      new ShaderMaterial({
        uniforms: this.snowUniforms,
        vertexShader: GLSL.wind + TERRAIN_GLSL + snowVert,
        fragmentShader: '#include <common>\n' + snowFrag,
        transparent: true,
        depthWrite: false,
      }),
    );
    points.frustumCulled = false;
    return points;
  }

  _createFireflies(count) {
    const rng = this.rng;
    const homes = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 4);
    for (let i = 0; i < count; i++) {
      // most gather near the pond, the rest drift around the tree
      const nearPond = i < count * 0.6;
      const cx = nearPond ? POND.x : TREE.x;
      const cz = nearPond ? POND.z : TREE.z;
      const a = rng.float(0, Math.PI * 2);
      const r = nearPond ? rng.float(0.5, 4) : rng.float(1.5, 6.5);
      const x = cx + Math.cos(a) * r;
      const z = cz + Math.sin(a) * r;
      homes.set([x, Math.max(terrainHeight(x, z), -0.1) + rng.float(0.35, 2.6), z], i * 3);
      seeds.set([rng.next(), rng.next(), rng.next(), rng.next()], i * 4);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute('aHome', new BufferAttribute(homes, 3));
    geo.setAttribute('aSeed', new BufferAttribute(seeds, 4));

    this.fireflyUniforms = {
      uTime: shared.uTime,
      uIntensity: { value: 0 },
      uSize: { value: 0.32 },
      uScale: { value: 500 },
      uColor: { value: new Color(0.75, 1.0, 0.32).multiplyScalar(7) },
    };
    const points = new Points(
      geo,
      new ShaderMaterial({
        uniforms: this.fireflyUniforms,
        vertexShader: fireflyVert,
        fragmentShader: fireflyFrag,
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      }),
    );
    points.frustumCulled = false;
    return points;
  }

  /** Perspective size attenuation for point sprites (call on resize). */
  setViewportHeight(heightInPixels) {
    this.snowUniforms.uScale.value = heightInPixels * 0.5;
    this.fireflyUniforms.uScale.value = heightInPixels * 0.5;
  }

  update(state) {
    const day = shared.uDay.value;
    this.petals.material.uniforms.uRate.value = state.petalRate;
    this.petals.visible = state.petalRate > 0.001;
    this.leaves.material.uniforms.uRate.value = state.leafFallRate;
    this.leaves.visible = state.leafFallRate > 0.001;
    this.snowUniforms.uRate.value = state.snowfall;
    this.snow.visible = state.snowfall > 0.001;
    // fireflies come out from dusk onward
    const ff = state.fireflies * (1 - smooth(0.35, 0.8, day));
    this.fireflyUniforms.uIntensity.value = ff;
    this.fireflies.visible = ff > 0.002;
  }
}

const smooth = (a, b, v) => {
  const t = Math.min(Math.max((v - a) / (b - a), 0), 1);
  return t * t * (3 - 2 * t);
};

// --- helpers ------------------------------------------------------------------------

function createSpawnTexture(points) {
  const count = points.length / 4;
  const width = 64;
  const height = Math.ceil(count / width);
  const data = new Float32Array(width * height * 4);
  data.set(points);
  const texture = new DataTexture(data, width, height, RGBAFormat, FloatType);
  texture.minFilter = texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  return { texture, count, size: { x: width, y: height } };
}

/** Flat outline in the XZ plane (normal +Y), fan-triangulated from the centre. */
function fanGeometry(outline, lift) {
  const pos = [0, lift(0, 0), 0];
  const nrm = [0, 1, 0];
  for (const [x, z] of outline) {
    pos.push(x, lift(x, z), z);
    nrm.push(0, 1, 0);
  }
  const index = [];
  for (let i = 1; i <= outline.length; i++) {
    index.push(0, i, (i % outline.length) + 1);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(nrm), 3));
  g.setIndex(index);
  return g;
}

function createPetalGeometry() {
  // a cherry petal: rounded, with the characteristic notch at the tip
  const outline = [
    [0, -0.5], [0.2, -0.33], [0.3, -0.08], [0.29, 0.18], [0.2, 0.4], [0.09, 0.5],
    [0, 0.4],
    [-0.09, 0.5], [-0.2, 0.4], [-0.29, 0.18], [-0.3, -0.08], [-0.2, -0.33],
  ];
  return fanGeometry(outline, (x) => 0.5 * x * x); // gently cupped
}

function createLeafGeometry() {
  const outline = [
    [0, -0.5], [0.12, -0.36], [0.21, -0.14], [0.23, 0.08], [0.17, 0.3], [0.08, 0.44], [0, 0.55],
    [-0.08, 0.44], [-0.17, 0.3], [-0.23, 0.08], [-0.21, -0.14], [-0.12, -0.36],
  ];
  return fanGeometry(outline, (x) => Math.abs(x) * 0.35); // folded along the midrib
}
