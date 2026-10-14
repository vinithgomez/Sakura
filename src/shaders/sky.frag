// Gradient sky with sun glow, a moon and twinkling stars. Values above 1.0
// (sun disc, bright stars) are HDR and get picked up by the bloom pass.

uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uNadir;
uniform vec3 uSunDir;
uniform vec3 uGlowColor;
uniform float uSunAmount;
uniform float uMoonAmount;
uniform float uStars;
uniform float uTime;

varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;

  vec3 col = h > 0.0
    ? mix(uHorizon, uZenith, pow(h, 0.5))
    : mix(uHorizon, uNadir, pow(-h, 0.42));
  col += uHorizon * 0.18 * exp(-abs(h) * 14.0); // haze band

  float sd = dot(d, uSunDir);
  float facing = max(sd, 0.0);

  // High cirrus drifting slowly across the dome: projected onto a plane high
  // above, thinning toward the horizon; lit by the sun (warm at dusk) and
  // tinted by the sky around it.
  if (h > 0.0) {
    vec2 cp = d.xz / (h + 0.15) * 1.4 + vec2(uTime * 0.006, uTime * 0.0025);
    float streak = fbm2(cp * vec2(1.0, 2.6)) * 0.75 + vnoise(cp * 5.0) * 0.25;
    float cover = smoothstep(0.5, 0.82, streak) * smoothstep(0.02, 0.3, h);
    vec3 cloud = mix(uHorizon, uZenith, 0.25) * 1.18 + uGlowColor * (0.08 + pow(facing, 5.0) * 0.5) * uSunAmount;
    col = mix(col, cloud, cover * 0.55);
  }

  // Sun: a soft disc with a bright aureole and a broad, warm glow (HDR → bloom)
  col += uGlowColor * (pow(facing, 5.0) * 0.18 + pow(facing, 60.0) * 0.45 + pow(facing, 700.0) * 1.6) * uSunAmount;
  col += uGlowColor * smoothstep(0.99905, 0.99975, sd) * 6.0 * uSunAmount;

  // Moon: soft halo + mottled disc
  if (uMoonAmount > 0.001) {
    float disc = smoothstep(0.9989, 0.99925, sd);
    float maria = 0.72 + 0.28 * vnoise(d.xz * 700.0 + d.y * 300.0);
    col += vec3(0.85, 0.9, 1.0) * (disc * maria * 2.6 + pow(facing, 160.0) * 0.35 + pow(facing, 12.0) * 0.05) * uMoonAmount;
  }

  // Stars
  if (uStars > 0.001) {
    vec3 p = d * 150.0;
    vec3 cell = floor(p);
    float r = hash13(cell);
    if (r > 0.986) {
      vec3 o = hash33(cell) * 0.7 + 0.15;
      float s = smoothstep(0.16, 0.0, length(fract(p) - o));
      float twinkle = 0.55 + 0.45 * sin(uTime * (1.3 + r * 4.0) + r * 91.0);
      float bright = (r - 0.986) / 0.014;
      col += vec3(0.82, 0.88, 1.0) * s * twinkle * (0.6 + bright * 2.4) * uStars * smoothstep(-0.02, 0.2, h);
    }
  }

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
