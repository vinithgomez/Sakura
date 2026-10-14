import { Color, Vector2, Vector3 } from 'three';

// Uniform objects shared *by reference* across many materials. Three.js reads
// `uniform.value` at draw time, so writing these once per frame updates every
// shader that sways in the wind or reacts to light — no per-material syncing.

export const shared = {
  uTime: { value: 0 },

  // Wind (written by seasons → main loop)
  uWindStrength: { value: 0.6 },
  uWindDir: { value: new Vector2(0.86, 0.5).normalize() },

  // Snow lying on upward-facing surfaces, 0..1
  uSnowCover: { value: 0 },
  uSnowColor: { value: new Color('#dfe5ee') },

  // Simplified light model for custom ShaderMaterials (written by lighting.js).
  // Colours are pre-multiplied by intensity, matching three's physical units.
  uSunDir: { value: new Vector3(0.5, 0.8, 0.3).normalize() },
  uSunColor: { value: new Color(3, 3, 3) },
  uSkyAmbient: { value: new Color(1, 1, 1) },
  uGroundAmbient: { value: new Color(0.4, 0.4, 0.4) },

  // Sky colours (for reflections on the pond)
  uSkyZenith: { value: new Color('#3d84d4') },
  uSkyHorizon: { value: new Color('#bad6ee') },

  // 1 = day, 0.5 = dusk, 0 = night
  uDay: { value: 1 },

  // Drawing-buffer height in pixels (thin twigs keep a minimum on-screen width)
  uViewportHeight: { value: 720 },
};

/** Picks a subset of the shared uniforms for a material's `uniforms` block. */
export function sharedUniforms(...names) {
  const out = {};
  for (const n of names) out[n] = shared[n];
  return out;
}
