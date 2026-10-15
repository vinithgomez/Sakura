import { Timer, Vector3 } from 'three';
import { createStage, Quality, clampCamera } from './core/renderer.js';
import { PostFX } from './core/postfx.js';
import { shared } from './core/uniforms.js';
import { Seasons } from './systems/seasons.js';
import { Lighting } from './systems/lighting.js';
import { Tree } from './systems/tree.js';
import { Island } from './systems/island.js';
import { Particles } from './systems/particles.js';
import { Grass } from './systems/grass.js';
import { Grading } from './systems/grading.js';
import { UI } from './systems/ui.js';
import { loader } from './systems/loader.js';

// Builds the world step by step (yielding between steps so the loading veil
// can paint its progress), then runs the frame loop. Loaded by main.js.

// --- stage ------------------------------------------------------------------

await loader.step('preparing the stage…', 0.32);
const canvas = document.getElementById('scene');
const { renderer, scene, camera, controls } = createStage(canvas);
const postfx = new PostFX(renderer, scene, camera);

// --- systems ----------------------------------------------------------------

const seasons = new Seasons();
const lighting = new Lighting(scene, postfx, renderer);
await loader.step('shaping the island…', 0.4);
const island = new Island(scene);
island.bakeGroundNoise(renderer);
await loader.step('growing the tree…', 0.5);
const tree = new Tree(scene, { anisotropy: Math.min(8, renderer.capabilities.getMaxAnisotropy()) });
island.setTreeRoots(tree.rootPaths); // soil heaves around the surface roots
await loader.step('sowing the grass…', 0.66);
const grass = new Grass(scene, island);
await loader.step('gathering petals…', 0.74);
const particles = new Particles(scene, tree.getSpawnPoints());
lighting.setLanternPosition(island.lanternLightPos);

const grading = new Grading(postfx.final);
postfx.initCinematic({ camera, sun: lighting.sun, getFocus: () => camera.position.distanceTo(controls.target) });

const brokenPrograms = () => renderer.info.programs.filter((p) => p.diagnostics && !p.diagnostics.runnable);
let verifyPipeline = null; // after a preset switch: programs already broken before it
const quality = new Quality(() => {
  verifyPipeline = new Set(brokenPrograms());
  resize();
});
const ui = new UI(document.getElementById('ui'), { seasons, lighting, controls, quality });

function resize() {
  const settings = quality.settings;
  const { pixelRatio, samples, shadow, refraction, caustics, sparkle } = settings;
  const w = Math.max(1, innerWidth);
  const h = Math.max(1, innerHeight);
  camera.aspect = w / h;
  // keep the whole island in frame on portrait screens
  camera.fov = w / h < 0.8 ? 52 : w / h < 1.2 ? 44 : 38;
  // nudge the island up the frame so the timeline dock sits over open sky
  camera.setViewOffset(w, h, 0, h * 0.07, w, h);
  renderer.setPixelRatio(pixelRatio);
  renderer.setSize(w, h, false);
  postfx.setSize(w, h, pixelRatio);
  postfx.setSamples(samples);
  particles.setViewportHeight(h * pixelRatio);
  shared.uViewportHeight.value = h * pixelRatio;
  lighting.setShadowQuality(shadow);
  postfx.setRefraction(refraction);
  postfx.setCinematic(Boolean(settings.cinematic));
  island.setQuality({ refraction, caustics, sparkle, sceneColor: postfx.sceneColor, resolution: renderer.getDrawingBufferSize(island.resolution) });
  grass.setQuality(settings);
}
addEventListener('resize', resize);
resize();

// --- intro: glide in from afar ------------------------------------------------

const introEnd = camera.position.clone();
const introStart = introEnd.clone().sub(controls.target).multiplyScalar(1.55).add(controls.target).add(new Vector3(0, 6, 0));
let intro = 0;
camera.position.copy(introStart);
controls.addEventListener('start', () => (intro = 1));

// --- frame loop ---------------------------------------------------------------

const timer = new Timer();
timer.connect(document);

function update(dt) {
  shared.uTime.value += dt;

  const state = seasons.update(dt);
  shared.uWindStrength.value = state.wind;
  shared.uSnowCover.value = state.snowCover;

  lighting.update(state, dt, camera);
  grading.update(state, lighting.day);
  postfx.cinematic.setLight(shared.uSunDir.value, shared.uSunColor.value, shared.uSkyAmbient.value);
  tree.update(state);
  island.update(state, dt, lighting);
  grass.update(state);
  particles.update(state);
  ui.update(state);
}

function tick(now) {
  timer.update(now);
  const dt = Math.min(timer.getDelta(), 0.1);
  update(dt);

  if (intro < 1) {
    intro = Math.min(1, intro + dt / 4.5);
    const k = 1 - Math.pow(1 - intro, 3);
    camera.position.lerpVectors(introStart, introEnd, k);
  }
  controls.update(dt);
  clampCamera(camera);

  postfx.render(dt);
  if (verifyPipeline) checkPipeline();
  quality.sample(dt);
}

/**
 * After a preset switch, make sure every shader program the new pipeline used
 * actually linked. A failed program draws nothing, so a broken pass would
 * leave the canvas black; go back to the preset that was working instead.
 */
function checkPipeline() {
  const before = verifyPipeline;
  verifyPipeline = null;
  const broken = brokenPrograms().filter((p) => !before.has(p));
  if (!broken.length) return;
  console.error(`[sakura] ${broken.length} shader program(s) failed on the "${quality.preset}" preset; going back to "${quality.previous}"`);
  quality.revert();
}

const CLEARLY_FAST_MS = 28; // comfortably inside the 30 fps (33.3 ms) cut-off

const median = (values) => {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Median GPU-synced frame time (ms) of the full pipeline at the current
 * settings. The first frames after the shader compile still pay for texture
 * uploads, the shadow map and driver work (measured on the GT 730: ~460, then
 * 35–80, then 26–55 ms against a steady ~25), so it warms up until three
 * frames in a row agree, then times `frames` frames one by one: a few slow
 * ones can't move the median the way they moved the old 8-frame average.
 */
function benchmark(frames = 20, maxWarmup = 30) {
  const gl = renderer.getContext();
  const px = new Uint8Array(4);
  const frame = () => {
    const t0 = performance.now();
    update(1 / 60);
    postfx.render(1 / 60);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); // wait for the GPU
    return performance.now() - t0;
  };
  const warm = [];
  for (let i = 0; i < maxWarmup; i++) {
    warm.push(frame());
    const last = warm.slice(-3);
    if (i >= 4 && Math.max(...last) < Math.min(...last) * 1.15) break;
  }
  const times = [];
  for (let i = 0; i < frames; i++) times.push(frame());
  return { ms: median(times), warmup: warm.length };
}

// Compile every shader up front, measure the GPU, then start.
await loader.step('mixing the paints…', 0.8);
await renderer.compileAsync(scene, camera).catch(() => {});
// (skip when the page has no size yet, e.g. a hidden frame — the governor adapts later)
if (!quality.locked && innerWidth > 0 && innerHeight > 0) {
  await loader.step('checking the light…', 0.94);
  const first = benchmark();
  let ms = first.ms;
  // Hysteresis: anything short of clearly fast is measured up to twice more,
  // 0.4 s apart, and the fastest median counts. Load from elsewhere only ever
  // makes frames slower, so a passing spike can't lock Low for the session;
  // only a GPU that stays slow (or stays busy) for the whole check does.
  for (let pass = 0; pass < 2 && ms > CLEARLY_FAST_MS; pass++) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    ms = Math.min(ms, benchmark(20, 8).ms);
  }
  quality.calibrate(ms);
  console.info(`[sakura] ${ms.toFixed(1)} ms/frame on High (${(1000 / ms).toFixed(0)} fps, median; first pass ${first.ms.toFixed(1)} ms after ${first.warmup} warm-up frames) → "${quality.settings.name}" preset`);
}
renderer.setAnimationLoop(tick);
await loader.step('', 1); // let the first frame land before the veil lifts
loader.done();
ui.showHint();

// --- lost / restored WebGL context ---------------------------------------------
// The browser can drop the context (driver reset, GPU memory pressure, a long
// stall). preventDefault() asks for it back; three re-creates its own GL state
// on restore, and every render target refills on its next frame. The only
// GPU-made content that would stay empty is the baked ground noise, so bake it
// again, re-apply the preset, and resume. If it never comes back, say so.
let restoreTimer = 0;
canvas.addEventListener('webglcontextlost', (e) => {
  e.preventDefault();
  renderer.setAnimationLoop(null);
  console.warn('[sakura] WebGL context lost; waiting for the browser to restore it');
  loader.message('The graphics card took a break', 'Bringing the island back…');
  clearTimeout(restoreTimer);
  restoreTimer = setTimeout(
    () => loader.message('The graphics card took a break', 'The browser didn’t hand the graphics context back. <a href="">Reload</a> to bring the island back.'),
    8000,
  );
});
canvas.addEventListener('webglcontextrestored', () => {
  clearTimeout(restoreTimer);
  island.bakeGroundNoise(renderer);
  resize();
  renderer.setAnimationLoop(tick);
  console.info('[sakura] WebGL context restored');
  setTimeout(() => loader.done(), 300); // let a frame land under the veil first
});

// Handy for poking around in the console.
window.__sakura = {
  seasons, lighting, tree, island, grass, particles, ui, renderer, scene, camera, controls, quality, postfx,
  /** Advance and draw one frame by hand (useful when the tab is hidden and rAF is paused). */
  frame(dt = 1 / 60) {
    intro = 1;
    update(dt);
    controls.update(dt);
    clampCamera(camera);
    postfx.render(dt);
    if (verifyPipeline) checkPipeline();
  },
  /** Dev: make the runtime governor see frames at least `ms` long (0 = off), to test the drop to Low in auto mode. */
  simulateSlowFrames(ms = 45) {
    quality.simulateSlowFrames(ms);
    return `governor now sees frames of at least ${quality.simulatedFrameMs} ms`;
  },
  /** Dev check: distance from every visible spray's hub to the nearest branch surface (loaded on demand). */
  async checkSprayAttachment(options) {
    const { checkSprayAttachment } = await import('./dev/sprayCheck.js');
    return checkSprayAttachment({ tree, seasons, windDir: shared.uWindDir.value }, options);
  },
  /** Dev check: frame-to-frame flicker in the canopy (loaded on demand). */
  async measureFlicker(run) {
    const { measureFlicker } = await import('./dev/flickerCheck.js');
    return measureFlicker({ app: window.__sakura, tree, particles, seasons, lighting, camera, controls, renderer, postfx }, run);
  },
};
