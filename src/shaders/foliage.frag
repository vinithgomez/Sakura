uniform sampler2D uAtlas;

#ifndef DEPTH_ONLY
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
uniform vec3 uGroundAmbient;
uniform float uTranslucency;
varying vec3 vTint;
varying vec3 vNormalW;
varying vec3 vWorldPos;
varying float vShade;
varying float vOpen;
#include <fog_pars_fragment>
#endif

varying vec2 vUv;
varying float vCell;

// Atlas is 2×2, painted top-down (flipY = false).
vec2 cellUv(float cell, vec2 uv) {
  vec2 c = vec2(mod(cell, 2.0), floor(cell * 0.5));
  return (c + vec2(uv.x, 1.0 - uv.y)) * 0.5;
}

void main() {
#ifdef DEPTH_ONLY
  if (texture2D(uAtlas, cellUv(vCell, vUv)).a < 0.5) discard;
  gl_FragColor = vec4(1.0);
#else

  #ifdef BLOSSOM
    vec4 flower = texture2D(uAtlas, cellUv(vCell, vUv));
    vec4 t = vec4(flower.rgb * vTint, flower.a);
    float opened = smoothstep(0.3, 0.7, vOpen);
    if (opened < 1.0) { // still (partly) a bud — skip the second fetch once open
      vec4 bud = texture2D(uAtlas, cellUv(0.0, vUv));
      t = mix(bud, t, opened);
    }
  #else
    vec4 t = texture2D(uAtlas, cellUv(2.0, vUv));
    t.rgb *= vTint;
  #endif

  float alpha = t.a;
  #ifdef ALPHA_TO_COVERAGE
    alpha = smoothstep(0.42, 0.42 + fwidth(alpha), alpha);
    if (alpha <= 0.0) discard;
  #else
    if (alpha < 0.5) discard;
  #endif

  vec3 N = normalize(vNormalW);
  vec3 V = normalize(cameraPosition - vWorldPos);
  float ndl = dot(N, uSunDir);
  float diffuse = saturate(ndl * 0.6 + 0.4);
  float back = pow(saturate(dot(-V, uSunDir)), 3.0) * uTranslucency; // light glowing through petals
  vec3 ambient = mix(uGroundAmbient, uSkyAmbient, N.y * 0.5 + 0.5);

  vec3 light = ambient * mix(0.5, 1.0, vShade)
             + uSunColor * (diffuse * mix(0.35, 1.0, vShade) + back * (0.4 + 0.6 * vShade));
  vec3 col = t.rgb * light * RECIPROCAL_PI;

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
#endif
}
