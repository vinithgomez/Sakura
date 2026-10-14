// Snowfall: points falling through a column above the island, wrapping from
// bottom to top. Flakes that reach the island's surface disappear (the
// ground shader shows the accumulation); the rest fall on into the clouds.
// Requires wind.glsl, terrain (layout.js).

attribute vec4 aSeed; // xz: disc position · y: phase · w: random

uniform float uRate;
uniform float uSize;
uniform float uScale; // viewport height * 0.5 (perspective size attenuation)

varying float vAlpha;

const float TOP = 17.0;
const float SPAN = 32.0;

void main() {
  float speed = 0.85 + 0.55 * aSeed.w;
  float fallen = mod(uTime * speed + aSeed.y * SPAN, SPAN);
  float y = TOP - fallen;

  vec2 xz = aSeed.xz * 17.0;
  xz += uWindDir * fallen * 0.3 * (0.4 + uWindStrength);
  xz += vec2(sin(uTime * 0.7 + aSeed.y * 20.0), cos(uTime * 0.6 + aSeed.x * 17.0)) * 0.45;

  float ground = length(xz) < ISLAND_R * 0.97 ? terrainHeight(xz) : -100.0;
  float vis = smoothstep(ground, ground + 0.35, y) * smoothstep(-SPAN + TOP, -SPAN + TOP + 4.0, y) * smoothstep(TOP, TOP - 2.0, y);
  float gate = smoothstep(aSeed.w * 0.9, aSeed.w * 0.9 + 0.1, uRate);

  vec4 mvPosition = viewMatrix * vec4(xz.x, y, xz.y, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  float size = uSize * (0.6 + 0.8 * fract(aSeed.w * 7.31));
  gl_PointSize = size * uScale / -mvPosition.z * step(0.01, gate * vis);
  vAlpha = gate * vis;
}
