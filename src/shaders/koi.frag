// Kohaku, Ogon, Showa and Chagoi colourings from a little noise.
// Requires common.glsl.

uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;

varying vec3 vNormalW;
varying vec3 vLocal;
varying float vPattern;
varying float vBody;
varying float vFin;

void main() {
  vec3 white = vec3(0.93, 0.9, 0.84);
  vec3 red = vec3(0.86, 0.22, 0.07);
  vec3 black = vec3(0.06, 0.05, 0.05);
  vec3 gold = vec3(0.95, 0.66, 0.2);
  vec3 orange = vec3(0.92, 0.42, 0.12);

  float seed = vPattern * 37.0;
  float blot = vnoise(vLocal.xz * 9.0 + seed);
  float spot = vnoise(vLocal.xz * 16.0 + seed * 2.0);
  float top = smoothstep(-0.02, 0.04, vLocal.y);

  vec3 col;
  if (vPattern < 0.25) {        // kohaku
    col = mix(white, red, step(0.5, blot) * top);
  } else if (vPattern < 0.5) {  // ogon
    col = gold;
  } else if (vPattern < 0.75) { // showa
    col = mix(white, red, step(0.55, blot) * top);
    col = mix(col, black, step(0.62, spot));
  } else {                      // chagoi
    col = orange * (0.85 + 0.15 * blot);
  }
  // fins are thin and pale: tint toward white, more at the tips
  float finAmt = step(0.5, vFin) * (0.35 + 0.4 * smoothstep(0.8, 1.0, vBody));
  col = mix(col, white * 0.95, finAmt);

  vec3 N = normalize(vNormalW);
  float diffuse = saturate(dot(N, uSunDir) * 0.5 + 0.5);
  vec3 light = uSkyAmbient * 0.8 + uSunColor * diffuse * 0.7;
  gl_FragColor = vec4(col * light * RECIPROCAL_PI, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
