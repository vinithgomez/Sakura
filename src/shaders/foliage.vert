// Canopy sprites: buds → blossoms (BLOSSOM) or leaves → autumn colours (LEAF).
// Spherical billboards built in *view space*, so the same shader renders the
// shadow pass correctly from the sun's point of view.
// Requires common.glsl + wind.glsl.

attribute vec3 aCenter;
attribute vec4 aRand;  // x presence threshold · y timing · z hue/rotation · w size
attribute vec4 aOut;   // xyz outward canopy normal · w shade (0 inner → 1 outer)
attribute float aFlex;

uniform float uPresence; // fraction of sprites present (blossoms / leaves)
uniform float uGrowth;   // bloom openness / leaf growth
uniform float uAutumn;
uniform float uSize;

#ifndef DEPTH_ONLY
uniform vec3 uTintA;
uniform vec3 uTintB;
uniform vec3 uTintC;
uniform vec3 uTintD;
uniform vec3 uTintE;
varying vec3 vTint;
varying vec3 vNormalW;
varying vec3 vWorldPos;
varying float vShade;
varying float vOpen;
#include <fog_pars_vertex>
#endif

varying vec2 vUv;
varying float vCell;

void main() {
  float present = smoothstep(aRand.x * 0.9, aRand.x * 0.9 + 0.1, uPresence);
  float grow = smoothstep(aRand.y * 0.55, aRand.y * 0.55 + 0.45, uGrowth);

#ifdef BLOSSOM
  float size = uSize * (0.8 + 0.4 * aRand.w) * present * mix(0.36, 1.0, grow);
  vCell = aRand.w > 0.5 ? 1.0 : 3.0;
#else
  float size = uSize * (0.8 + 0.4 * aRand.w) * present * mix(0.4, 1.0, grow);
  vCell = 2.0;
#endif

  vec3 world = aCenter + windOffset(aCenter, aFlex);
  float flutter = windFlutter(aCenter, 4.0 + aRand.w * 3.0) * 0.14;
  vec2 corner = rotate2(position.xy, aRand.z * 6.2831 + flutter);

  vec4 mvPosition = viewMatrix * vec4(world, 1.0);
  mvPosition.xy += corner * size;
  gl_Position = projectionMatrix * mvPosition;
  vUv = uv;

#ifndef DEPTH_ONLY
  vWorldPos = world;
  // bulge the normal across the sprite (camera right/up in world space) so each
  // cluster shades like a little rounded puff instead of a flat card
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vNormalW = normalize(aOut.xyz + (camRight * corner.x + camUp * corner.y) * 0.9);
  vShade = aOut.w;
  vOpen = grow;
  #ifdef BLOSSOM
    vTint = mix(uTintA, uTintB, aRand.z);
  #else
    // green → gold / orange / crimson, each leaf on its own schedule
    float turn = smoothstep(aRand.y * 0.6, aRand.y * 0.6 + 0.4, uAutumn);
    vec3 green = mix(uTintA, uTintB, aRand.z);
    vec3 fall = aRand.z < 0.5 ? mix(uTintC, uTintD, aRand.z * 2.0) : mix(uTintD, uTintE, aRand.z * 2.0 - 1.0);
    vTint = mix(green, fall, turn);
  #endif
  #include <fog_vertex>
#endif
}
