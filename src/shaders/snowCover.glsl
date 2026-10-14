// Snow accumulating on upward-facing surfaces. As uSnowCover rises from 0 to
// 1 the threshold sweeps from "only perfectly flat tops" down to "anything
// facing reasonably upward", broken up by noise so it gathers in patches first.
// The noise varies in all three axes (not just x/z), so steep surfaces like a
// trunk get blotches rather than vertical streaks; near-vertical surfaces
// never hold snow.
// Requires common.glsl.

uniform float uSnowCover;

float snowMask(vec3 worldNormal, vec3 worldPos) {
  vec2 a = worldPos.xz * 1.7 + worldPos.y * vec2(1.3, -0.9);
  vec2 b = worldPos.xz * 6.3 + worldPos.y * vec2(-4.1, 3.7);
  float n = vnoise(a) * 0.6 + vnoise(b) * 0.4;
  float threshold = 1.02 - uSnowCover * 0.72;
  float m = smoothstep(threshold - 0.1, threshold + 0.06, worldNormal.y + (n - 0.5) * 0.4);
  return m * smoothstep(0.0, 0.12, uSnowCover);
}
