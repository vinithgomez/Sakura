import { Vector2, WebGLRenderTarget, HalfFloatType, ShaderMaterial, UniformsUtils, DepthTexture, UnsignedIntType } from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';
import { LATE_LAYER } from './layers.js';
import { FinalPass } from './finalPass.js';
import { CinematicPass } from './cinematicPass.js';

/**
 * Renders the scene into its own multisampled HDR target and resolves it
 * once into the composer's (single-sampled) buffer. Keeping MSAA out of the
 * composer's ping-pong targets matters: otherwise every post pass writes to —
 * and re-resolves — a 4× multisampled half-float buffer.
 */
class SceneRenderPass extends Pass {
  constructor(scene, camera, samples) {
    super();
    this.scene = scene;
    this.camera = camera;
    this.needsSwap = false;
    this.refraction = false; // set by the quality preset
    this.target = new WebGLRenderTarget(2, 2, { type: HalfFloatType, samples });
    this.target.texture.name = 'Sakura.msaa';
    this.copy = new FullScreenQuad(
      new ShaderMaterial({
        uniforms: UniformsUtils.clone(CopyShader.uniforms),
        vertexShader: CopyShader.vertexShader,
        fragmentShader: CopyShader.fragmentShader,
        depthTest: false,
        depthWrite: false,
      }),
    );
  }

  setSamples(samples) {
    if (samples === this.target.samples) return;
    this.target.samples = samples;
    this.target.dispose(); // re-created with the new sample count on next use
  }

  setSize(width, height) {
    this.target.setSize(width, height);
  }

  /**
   * The opaque scene as rendered this frame (linear HDR), for the pond to
   * refract. Only valid with MSAA: the multisampled draw buffer and this
   * resolved texture are separate attachments, so the water can sample it
   * while drawing into the same target — no extra copy or scene render.
   */
  get sceneColor() {
    return this.target.texture;
  }

  render(renderer, writeBuffer, readBuffer) {
    const cam = this.camera;
    if (this.target.samples === 0) {
      cam.layers.enable(LATE_LAYER);
      renderer.setRenderTarget(readBuffer);
      renderer.clear();
      renderer.render(this.scene, cam);
      return;
    }
    renderer.setRenderTarget(this.target);
    renderer.clear();
    if (this.refraction) {
      // 1. opaque scene + sky → resolved into target.texture
      cam.layers.disable(LATE_LAYER);
      renderer.render(this.scene, cam);
      // 2. water, clouds, snow, fireflies on top (water samples the resolve)
      cam.layers.set(LATE_LAYER);
      const autoClear = renderer.autoClear;
      const shadows = renderer.shadowMap.autoUpdate;
      renderer.autoClear = false;
      renderer.shadowMap.autoUpdate = false; // already rendered in step 1
      renderer.render(this.scene, cam);
      renderer.autoClear = autoClear;
      renderer.shadowMap.autoUpdate = shadows;
      cam.layers.set(0);
      cam.layers.enable(LATE_LAYER);
    } else {
      cam.layers.enable(LATE_LAYER);
      renderer.render(this.scene, cam);
    }
    this.copy.material.uniforms.tDiffuse.value = this.target.texture;
    renderer.setRenderTarget(readBuffer);
    this.copy.render(renderer);
  }
}

/**
 * Scene (MSAA, half-float HDR) [→ Cinematic: SSAO + volumetric fog + DOF]
 * → Unreal bloom (quarter res) → Final (grade, ACES, vignette, grain, sRGB)
 * [→ SMAA on the Low preset, which has no MSAA].
 * The scene is rendered in linear HDR, so emitters brighter than 1.0
 * (fireflies, the lantern, sun glints) are what cross the bloom threshold.
 */
export class PostFX {
  constructor(renderer, scene, camera) {
    // (keeps a depth buffer: without MSAA the scene renders straight into it)
    const target = new WebGLRenderTarget(2, 2, { type: HalfFloatType });
    target.texture.name = 'Sakura.hdr';
    this.composer = new EffectComposer(renderer, target);

    this.scenePass = new SceneRenderPass(scene, camera, 4);
    this.composer.addPass(this.scenePass);

    // Bloom is soft by nature — run its mip chain from quarter resolution.
    this.bloom = new UnrealBloomPass(new Vector2(256, 256), 0.45, 0.55, 0.92);
    const setBloomSize = this.bloom.setSize.bind(this.bloom);
    this.bloom.setSize = (w, h) => setBloomSize(Math.max(2, Math.round(w / 2)), Math.max(2, Math.round(h / 2)));
    this.composer.addPass(this.bloom);

    this.final = new FinalPass();
    this.composer.addPass(this.final);

    // Morphological AA for the one fallback level that drops MSAA (much better
    // than FXAA on long thin edges like branches).
    this.smaa = new SMAAPass();
    this.smaa.enabled = false;
    this.composer.addPass(this.smaa);
  }

  setSize(width, height, pixelRatio) {
    this.composer.setPixelRatio(pixelRatio);
    this.composer.setSize(width, height);
  }

  /** Create the Cinematic pass (needs the sun and the orbit target, which exist later). */
  initCinematic({ camera, sun, getFocus }) {
    this.cinematic = new CinematicPass({ camera, sun, sceneTarget: this.scenePass.target, getFocus });
    this.composer.insertPass(this.cinematic, 1);
  }

  /** SSAO + volumetric fog + depth of field — Cinematic preset only. */
  setCinematic(on) {
    if (!this.cinematic) return;
    const target = this.scenePass.target;
    if (on && !target.depthTexture) {
      target.depthTexture = new DepthTexture(target.width, target.height, UnsignedIntType);
      target.dispose(); // rebuilt with the depth texture attached
    }
    this.cinematic.enabled = on;
  }

  /** The opaque scene texture the pond refracts (High preset only). */
  get sceneColor() {
    return this.scenePass.sceneColor;
  }

  setRefraction(on) {
    this.scenePass.refraction = on;
  }

  setSamples(samples) {
    this.scenePass.setSamples(samples);
    this.smaa.enabled = samples === 0;
  }

  /** Bloom tuning is driven by the lighting system (stronger at night). */
  setBloom(strength, threshold, radius) {
    this.bloom.strength = strength;
    this.bloom.threshold = threshold;
    this.bloom.radius = radius;
  }

  render(dt) {
    this.composer.render(dt);
  }
}
