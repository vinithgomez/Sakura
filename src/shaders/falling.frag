uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
uniform vec3 uGroundAmbient;
uniform float uTranslucency;

varying vec3 vNormalW;
varying vec3 vColor;

#include <fog_pars_fragment>

void main() {
  vec3 N = normalize(vNormalW) * (gl_FrontFacing ? 1.0 : -1.0);
  float ndl = dot(N, uSunDir);
  // thin petals/leaves: lit side + light passing through from behind
  float diffuse = saturate(ndl) + saturate(-ndl) * uTranslucency;
  vec3 ambient = mix(uGroundAmbient, uSkyAmbient, N.y * 0.5 + 0.5);
  vec3 col = vColor * (ambient + uSunColor * diffuse) * RECIPROCAL_PI;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
