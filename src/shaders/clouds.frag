uniform sampler2D uMap;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
uniform float uOpacity;

varying vec2 vUv;
varying float vRand;

#include <fog_pars_fragment>

void main() {
  vec4 t = texture2D(uMap, vUv);
  if (t.a < 0.01) discard;
  // texture RGB is a light factor: lit tops, cool undersides
  vec3 light = uSkyAmbient * 0.9 + uSunColor * 0.32 * t.r;
  vec3 col = light * RECIPROCAL_PI * (0.95 + vRand * 0.1);
  gl_FragColor = vec4(col, t.a * uOpacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
