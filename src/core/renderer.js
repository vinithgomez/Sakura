import {
  WebGLRenderer,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  ACESFilmicToneMapping,
  PCFShadowMap,
  Vector3,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { LATE_LAYER } from './layers.js';
import { ISLAND_RADIUS, POND, TREE, terrainHeight } from './layout.js';

const params = new URLSearchParams(location.search);

/** ?quality=auto (default: benchmark decides) | high | low | cinematic (opt-in only) */
export const QUALITY = params.get('quality') ?? 'auto';

export function createStage(canvas) {
  const renderer = new WebGLRenderer({
    canvas,
    antialias: false, // MSAA lives on the scene render target instead
    powerPreference: 'high-performance',
    stencil: false,
  });
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping; // applied by OutputPass
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;

  const scene = new Scene();

  // near 0.05 lets the camera come right up to the bark without slicing it open;
  // far 800 still holds the 500-unit sky dome. A 16 000:1 range keeps 24-bit
  // depth precise enough without a logarithmic depth buffer (which would also
  // disable early-z).
  const camera = new PerspectiveCamera(38, innerWidth / innerHeight, 0.05, 800);
  const target = new Vector3(-0.4, 3.0, 0);
  camera.position.set(15.5, 12.8, 26.2);
  camera.lookAt(target);
  camera.layers.enable(LATE_LAYER);

  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(target);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;
  controls.minDistance = 3.5; // close enough to read the bark; clampCamera() keeps it out of the ground
  controls.maxDistance = 52;
  controls.minPolarAngle = 0.15;
  controls.maxPolarAngle = 1.85; // a little below the horizon: see the island's underside
  controls.rotateSpeed = 0.6;
  controls.zoomSpeed = 0.8;
  controls.autoRotateSpeed = 0.35;

  return { renderer, scene, camera, controls };
}

// ---------------------------------------------------------------------------
// Quality presets. Every expensive effect is gated by one of two presets:
//
//   high — devicePixelRatio up to 2×, 4× MSAA, 2048² shadows, refracting
//          water, caustics on the pond floor, snow sparkle, dense fine grass
//   low  — 1× pixels, SMAA, 1024² shadows, alpha-blended water, no caustics,
//          no sparkle, fewer and coarser grass tufts
//
// A GPU-synced benchmark behind the loading veil renders the High preset; if
// that runs under 30 fps the app starts on Low. At runtime, three seconds
// under 30 fps on High also drops to Low (never back up on its own —
// flip-flopping is worse than a steady, cheaper image). ?quality=high|low
// pins a preset. ?quality=cinematic adds SSAO, volumetric fog with god rays and
// depth of field on top of High; it is opt-in only and never falls back.
// ---------------------------------------------------------------------------

export const QUALITY_PRESETS = {
  high: { name: 'high', pixelRatio: 2, samples: 4, shadow: 2048, refraction: true, caustics: true, sparkle: true },
  low: { name: 'low', pixelRatio: 1, samples: 0, shadow: 1024, refraction: false, caustics: false, sparkle: false },
  // opt-in only (?quality=cinematic): High + SSAO, volumetric fog / god rays, depth of field
  cinematic: { name: 'cinematic', pixelRatio: 2, samples: 4, shadow: 2048, refraction: true, caustics: true, sparkle: true, cinematic: true },
};

const MIN_FPS = 30;

export class Quality {
  constructor(onChange) {
    this.onChange = onChange;
    // a forced preset is never changed — in particular Cinematic, which is
    // never auto-selected and never falls back on its own
    this.locked = QUALITY in QUALITY_PRESETS;
    this.preset = this.locked ? QUALITY : 'high';
    this.fps = 60;
    this._acc = 0;
    this._frames = 0;
    this._cooldown = 3;
    this._slow = 0;
  }

  get settings() {
    const p = QUALITY_PRESETS[this.preset];
    return { ...p, pixelRatio: Math.min(window.devicePixelRatio || 1, p.pixelRatio) };
  }

  set(preset) {
    if (preset === this.preset || !QUALITY_PRESETS[preset]) return;
    this.preset = preset;
    this.onChange(this.settings);
  }

  /** Start on Low if the High preset measured under 30 fps. */
  calibrate(msAtHigh) {
    if (this.locked) return;
    this.set(1000 / msAtHigh < MIN_FPS ? 'low' : 'high');
    this._cooldown = 3;
  }

  sample(dt) {
    if (dt > 0.25) return; // tab switch / hitch — not representative
    this._acc += dt;
    this._frames++;
    if (this._acc < 1) return;

    this.fps = this._frames / this._acc;
    this._acc = 0;
    this._frames = 0;

    if (this.locked || this.preset === 'low') return;
    if (this._cooldown > 0) {
      this._cooldown--;
      return;
    }
    if (this.fps < MIN_FPS) {
      if (++this._slow >= 3) this.set('low');
    } else {
      this._slow = 0;
    }
  }
}

// ---------------------------------------------------------------------------
// Camera bounds: the orbit camera may come in to 3.5 units, so keep it from
// sinking into the ground or the pond, and out of the trunk.
// ---------------------------------------------------------------------------

const CLEARANCE = 0.35;

export function clampCamera(camera) {
  const p = camera.position;
  const r = Math.hypot(p.x, p.z);
  if (r < ISLAND_RADIUS + 0.6) {
    let floor = terrainHeight(p.x, p.z);
    if (Math.hypot(p.x - POND.x, p.z - POND.z) < POND.r + 0.2) floor = Math.max(floor, POND.water);
    if (p.y < floor + CLEARANCE) p.y = floor + CLEARANCE;
  }
  // trunk: a soft cylinder around the lower trunk
  let dx = p.x - TREE.x;
  let dz = p.z - TREE.z;
  let d = Math.hypot(dx, dz);
  const trunkR = 1.0;
  if (p.y < 3.4 && d < trunkR) {
    if (d < 1e-4) {
      // dead on the axis: step out toward +x (any direction will do)
      dx = 1;
      dz = 0;
      d = 1;
    }
    p.x = TREE.x + (dx / d) * trunkR;
    p.z = TREE.z + (dz / d) * trunkR;
  }
}
