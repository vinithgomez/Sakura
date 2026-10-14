// THE wind function. Every swaying thing (branches, canopy sprites, grass)
// calls windOffset() with its rest position and a flexibility weight, so
// blossoms stay glued to the twigs they grow on while everything moves.
// Requires common.glsl.

uniform float uTime;
uniform float uWindStrength;
uniform vec2 uWindDir;

// Slow gust envelope travelling across the island in the wind direction.
float windGust(vec3 p) {
  float w = dot(p.xz, uWindDir);
  return 0.55 + 0.45 * sin(uTime * 0.6 - w * 0.22) * sin(uTime * 0.27 + 1.7 - w * 0.09);
}

// p: rest position (world), flex: 0 at the root → ~1 at the outermost tips.
vec3 windOffset(vec3 p, float flex) {
  float phase = dot(p, vec3(0.21, 0.13, 0.17));
  float gust = windGust(p);
  vec3 dir = vec3(uWindDir.x, 0.0, uWindDir.y);
  vec3 side = vec3(-uWindDir.y, 0.0, uWindDir.x);

  float bend = gust * 0.75
             + sin(uTime * 1.25 + phase) * 0.32
             + sin(uTime * 2.4 + phase * 1.7) * 0.1;
  float sway = sin(uTime * 1.65 + phase * 1.3) * 0.22
             + sin(uTime * 3.3 + phase * 2.3) * 0.06;

  vec3 off = (dir * bend + side * sway) * (flex * uWindStrength * 0.42);
  off.y -= dot(off.xz, off.xz) * 0.35; // arc rather than shear
  return off;
}

// Fast, small flutter for leaves and blossoms (not for wood).
float windFlutter(vec3 p, float speed) {
  float g = windGust(p);
  return sin(uTime * speed + dot(p, vec3(3.1, 2.3, 1.7))) * (0.35 + 0.65 * g) * uWindStrength;
}
