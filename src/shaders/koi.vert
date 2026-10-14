// Koi swimming gentle loops under the surface — all motion is in this shader.
//   • path: a looping, slightly figure-of-eight curve around the pond, each
//     fish with its own size, radius, depth and direction
//   • glide-and-stroke: speed swells and eases; distance travelled drives the
//     tail beat, so a fish strokes harder when it speeds up
//   • body: a travelling sine wave growing toward the tail (aBody 0 → 1);
//     the tail fan ripples with a lag, pectorals flap, dorsal follows the body
// Requires terrain (layout.js).

attribute float aBody;
attribute float aFin;  // 0 body · 1 tail · 2 pectoral · 3 dorsal
attribute vec4 aSwim;  // x loop radius · y speed (sign = direction) · z phase · w pattern
attribute vec4 aPlace; // xy loop centre offset · z depth below surface · w size

uniform float uKoiTime;

varying vec3 vNormalW;
varying vec3 vLocal;
varying float vPattern;
varying float vBody;
varying float vFin;

vec2 loopPath(float u) {
  float r = aSwim.x;
  return POND_C + aPlace.xy + vec2(cos(u) * r, sin(u) * r * 0.7 + sin(2.0 * u + aSwim.z) * 0.22);
}

void main() {
  float dir = sign(aSwim.y);
  // distance along the loop: monotonic, but faster and slower in turn
  float travel = uKoiTime * abs(aSwim.y) + 0.35 * sin(uKoiTime * abs(aSwim.y) * 0.6 + aSwim.z * 3.0);
  float u = aSwim.z + dir * travel;

  vec2 p = loopPath(u);
  vec2 ahead = loopPath(u + 0.04 * dir);
  vec3 fwd = normalize(vec3(ahead.x - p.x, 0.0, ahead.y - p.y));
  vec3 side = vec3(-fwd.z, 0.0, fwd.x);

  float size = aPlace.w;
  vec3 local = position * size;

  // swimming wave: phase advances with distance travelled
  float beat = travel * 11.0 + aSwim.z * 10.0;
  float amp = (0.025 + 0.11 * aBody * aBody) * size;
  local.z += sin(beat - aBody * 5.0) * amp;
  if (aFin > 0.5 && aFin < 1.5) {
    // tail fan: extra lagging ripple toward the tips
    float tip = (aBody - 0.8) / 0.2;
    local.z += sin(beat - 6.2 - tip * 1.6) * 0.05 * size * tip;
    local.y += sin(beat * 0.5 + tip * 2.0) * 0.012 * size * tip;
  } else if (aFin > 1.5 && aFin < 2.5) {
    // pectorals: slow flap, more at the fin tips
    local.y += sin(beat * 0.45 + aSwim.z) * 0.05 * size * abs(position.z) / 0.24;
  }

  // gentle bob; never closer than a hand's width to the floor
  float y = WATER_Y - aPlace.z + sin(uKoiTime * 0.8 + aSwim.z * 4.0) * 0.025;
  y = max(y, terrainHeight(p) + 0.1 * size);
  y = min(y, WATER_Y - 0.07 * size);

  vec3 world = vec3(p.x, y, p.y) + fwd * local.x + vec3(0.0, local.y, 0.0) + side * local.z;
  vNormalW = normalize(fwd * normal.x + vec3(0.0, normal.y, 0.0) + side * normal.z);
  vLocal = position;
  vPattern = aSwim.w;
  vBody = aBody;
  vFin = aFin;
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
}
