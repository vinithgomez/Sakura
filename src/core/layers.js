// Render layers (three.js Object3D.layers).
//
//   0  — the opaque scene + sky (default)
//   1  — shadow-only proxies: seen by the sun's shadow camera, never on screen
//        (see SHADOW_ONLY_LAYER in shadows.js)
//   2  — "late" transparent things drawn after the opaque scene has been
//        captured, so the pond can refract it: water, clouds, snow, fireflies

export const LATE_LAYER = 2;

/** Put an object (and its children) on the late layer only. */
export function drawLate(object) {
  object.traverse((o) => o.layers.set(LATE_LAYER));
  return object;
}
