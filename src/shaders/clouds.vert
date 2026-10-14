// Billboard cloud puffs drifting slowly around the island.

attribute vec3 aCenter;
attribute vec3 aParams; // x: width, y: height, z: random

uniform float uTime;

varying vec2 vUv;
varying float vRand;

#include <fog_pars_vertex>

void main() {
  vUv = uv;
  vRand = aParams.z;

  // slow orbit around the island
  float a = uTime * (0.004 + aParams.z * 0.004);
  float c = cos(a);
  float s = sin(a);
  vec3 center = vec3(c * aCenter.x - s * aCenter.z, aCenter.y + sin(uTime * 0.05 + aParams.z * 10.0) * 0.6, s * aCenter.x + c * aCenter.z);

  vec4 mvPosition = modelViewMatrix * vec4(center, 1.0);
  mvPosition.xy += position.xy * aParams.xy;
  gl_Position = projectionMatrix * mvPosition;

  #include <fog_vertex>
}
