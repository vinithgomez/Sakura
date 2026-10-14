uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;

varying float vAlpha;

void main() {
  float d = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.12, d) * vAlpha;
  if (a < 0.01) discard;
  vec3 col = (uSkyAmbient * 1.1 + uSunColor * 0.6) * RECIPROCAL_PI;
  gl_FragColor = vec4(col, a * 0.9);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
