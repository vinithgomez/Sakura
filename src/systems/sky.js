import {
  Mesh,
  SphereGeometry,
  ShaderMaterial,
  BackSide,
  Color,
  PlaneGeometry,
  InstancedBufferGeometry,
  InstancedBufferAttribute,
  UniformsLib,
  UniformsUtils,
} from 'three';
import { GLSL } from '../core/materials.js';
import { shared } from '../core/uniforms.js';
import { Rng } from '../core/random.js';
import { createCloudTexture } from '../textures/canvasTextures.js';
import { drawLate } from '../core/layers.js';
import skyVert from '../shaders/sky.vert?raw';
import skyFrag from '../shaders/sky.frag?raw';
import cloudsVert from '../shaders/clouds.vert?raw';
import cloudsFrag from '../shaders/clouds.frag?raw';

/** Sky dome (gradient, sun, moon, stars) and a ring of drifting clouds. Driven by lighting.js. */
export class Sky {
  constructor(scene) {
    this.uniforms = {
      uZenith: { value: new Color() },
      uHorizon: { value: new Color() },
      uNadir: { value: new Color() },
      uGlowColor: { value: new Color() },
      uSunDir: shared.uSunDir,
      uSunAmount: { value: 1 },
      uMoonAmount: { value: 0 },
      uStars: { value: 0 },
      uTime: shared.uTime,
    };

    this.dome = new Mesh(
      new SphereGeometry(500, 32, 20),
      new ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: skyVert,
        fragmentShader: '#include <common>\n' + GLSL.common + skyFrag,
        side: BackSide,
        depthWrite: false,
        fog: false,
      }),
    );
    // Drawn *after* the opaque scene (it sits on the far plane), so early depth
    // testing skips every pixel the island and tree already cover.
    this.dome.renderOrder = 1000;
    this.dome.frustumCulled = false;
    scene.add(this.dome);

    this.clouds = drawLate(this._createClouds());
    scene.add(this.clouds);
  }

  _createClouds() {
    const rng = new Rng(9);
    const count = 26;
    const centers = new Float32Array(count * 3);
    const params = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const low = i < 18; // most of them form a cloud sea below the island
      const a = (i / count) * Math.PI * 2 * 3.1 + rng.spread(0.3);
      const r = low ? rng.float(34, 80) : rng.float(85, 140);
      centers[i * 3] = Math.cos(a) * r;
      centers[i * 3 + 1] = low ? rng.float(-26, -9) : rng.float(4, 26);
      centers[i * 3 + 2] = Math.sin(a) * r;
      const w = low ? rng.float(24, 42) : rng.float(30, 55);
      params[i * 3] = w;
      params[i * 3 + 1] = w * rng.float(0.42, 0.6);
      params[i * 3 + 2] = rng.next();
    }

    const geo = new InstancedBufferGeometry();
    geo.copy(new PlaneGeometry(1, 1));
    geo.setAttribute('aCenter', new InstancedBufferAttribute(centers, 3));
    geo.setAttribute('aParams', new InstancedBufferAttribute(params, 3));
    geo.instanceCount = count;

    this.cloudUniforms = UniformsUtils.merge([UniformsLib.fog]);
    Object.assign(this.cloudUniforms, {
      uMap: { value: createCloudTexture() },
      uTime: shared.uTime,
      uSunColor: shared.uSunColor,
      uSkyAmbient: shared.uSkyAmbient,
      uOpacity: { value: 0.9 },
    });

    const mesh = new Mesh(
      geo,
      new ShaderMaterial({
        uniforms: this.cloudUniforms,
        vertexShader: cloudsVert,
        fragmentShader: '#include <common>\n' + cloudsFrag,
        transparent: true,
        depthWrite: false,
        fog: true,
      }),
    );
    mesh.frustumCulled = false;
    mesh.renderOrder = -5;
    return mesh;
  }

  /** Called by lighting.js with the blended palette. */
  apply({ zenith, horizon, nadir, glow, sunAmount, moonAmount, stars }) {
    const u = this.uniforms;
    u.uZenith.value.copy(zenith);
    u.uHorizon.value.copy(horizon);
    u.uNadir.value.copy(nadir);
    u.uGlowColor.value.copy(glow);
    u.uSunAmount.value = sunAmount;
    u.uMoonAmount.value = moonAmount;
    u.uStars.value = stars;
  }

  follow(camera) {
    this.dome.position.copy(camera.position);
  }
}
