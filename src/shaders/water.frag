// Koi pond surface.
//   • soft ripples: a few slow directional swells + one fine noise octave,
//     with an analytic gradient (cheap, no finite differences)
//   • depth-based colour: light travelling through water loses red first, so
//     the deeper the floor (along the view ray) the more teal/green the tint
//   • REFRACTION (High preset): the opaque scene behind the water is sampled
//     from the frame's own resolve and offset by the ripple normal; Low
//     alpha-blends a tinted surface instead
//   • fresnel sky reflection, sun/moon glints (HDR → bloom), floating petal
//     rafts (花筏 hanaikada) in spring, leaves in autumn, ice in deep winter
// Requires common.glsl, snowCover.glsl, terrain (layout.js).

uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSkyAmbient;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uDeep;
uniform vec3 uShallow;
uniform float uIce;
uniform float uPetals;
uniform float uLeaves;
uniform vec3 uSnowColor;
#ifdef REFRACTION
uniform sampler2D uSceneColor;
uniform vec2 uResolution;
#endif

varying vec3 vWorldPos;

#include <fog_pars_fragment>

// Height field h(p) = Σ a sin(k·p − ωt) + fine noise; returns ∇h.
vec2 rippleGradient(vec2 p) {
  float t = uTime;
  vec2 g = vec2(0.0);
  const vec2 k1 = vec2(1.9, 0.7);
  const vec2 k2 = vec2(-0.8, 2.3);
  const vec2 k3 = vec2(2.7, -1.6);
  g += k1 * cos(dot(k1, p) - t * 0.9) * 0.05;
  g += k2 * cos(dot(k2, p) - t * 1.1 + 1.7) * 0.04;
  g += k3 * cos(dot(k3, p) - t * 1.4 + 4.1) * 0.025;
  // fine, slowly drifting cat's-paw ripples
  vec2 q = p * 5.0 + vec2(t * 0.25, -t * 0.18);
  float e = 0.15;
  float n0 = vnoise(q);
  g += vec2(vnoise(q + vec2(e, 0.0)) - n0, vnoise(q + vec2(0.0, e)) - n0) / e * 0.06;
  return g;
}

void main() {
  vec2 p = vWorldPos.xz;
  float depth = max(WATER_Y - terrainHeight(p), 0.0);
  float calm = 1.0 - uIce;

  vec2 g = rippleGradient(p) * calm;
  vec3 N = normalize(vec3(-g.x * 0.35, 1.0, -g.y * 0.35));
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec3 R = reflect(-V, N);

  float fresnel = 0.02 + 0.98 * pow(1.0 - saturate(dot(N, V)), 5.0);
  vec3 sky = mix(uSkyHorizon, uSkyZenith, saturate(R.y * 1.2));
  vec3 light = (uSkyAmbient + uSunColor * 0.45) * RECIPROCAL_PI;

  // distance the view ray travels through the water before reaching the floor;
  // capped, because koi swim far shallower than the floor and must keep their
  // colour even at grazing angles
  float path = min(depth / max(V.y, 0.3), 0.9);
  vec3 transmit = exp(-path * vec3(1.15, 0.55, 0.45)); // red is absorbed first
  vec3 scatter = mix(uShallow, uDeep, 1.0 - exp(-path * 1.4)) * light;
  float shore = smoothstep(0.0, 0.06, depth);

#ifdef REFRACTION
  vec2 suv = gl_FragCoord.xy / uResolution;
  // bend the view of the floor by the ripples; less in the shallows
  vec2 offs = N.xz * 0.04 * saturate(depth * 3.0) / max(length(cameraPosition - vWorldPos) * 0.15, 1.0);
  vec3 floorCol = texture2D(uSceneColor, suv + offs).rgb;
  vec3 body = floorCol * transmit + scatter * (1.0 - transmit);
  vec3 col = mix(body, sky, fresnel * 0.85);
  float alpha = shore; // the water is composited here, not blended
#else
  // no image of the floor: blend a tinted surface over it instead
  vec3 col = mix(scatter, sky, fresnel * 0.85);
  float alpha = mix(0.35, 0.92, 1.0 - exp(-path * 2.0)) * shore + fresnel * 0.1;
#endif

  float spec = pow(saturate(dot(R, uSunDir)), 180.0);
  col += uSunColor * spec * 0.9 * calm;
  col += light * 0.18 * smoothstep(0.05, 0.0, depth) * calm; // bright waterline at the shore

  // floating petals / leaves drifting slowly, gathering toward the banks
  vec2 drift = p + vec2(uTime * 0.035, uTime * 0.02);
  float bank = smoothstep(0.35, 1.0, length(p - POND_C) / POND_R);
  // rafts are loose drifts of individual petals: a soft density field (thicker
  // toward the banks) decides how many petal-sized flecks show through
  float density = smoothstep(0.42, 0.78, fbm2(drift * 1.4) + bank * 0.3) * uPetals;
  float fleck = max(vnoise(drift * 34.0), vnoise(drift * 23.0 + 5.3) * 0.96);
  float cut = 1.0 - density * 0.27;
  float petals = smoothstep(cut, cut + 0.035, fleck) * step(0.02, density);
  vec3 lit = (uSkyAmbient + uSunColor * saturate(uSunDir.y)) * RECIPROCAL_PI;
  col = mix(col, vec3(1.0, 0.74, 0.82) * lit, petals);
  float leafN = vnoise(drift * 7.0 + 31.0);
  float leaves = step(0.83, leafN) * step(0.4, fbm2(drift * 2.0 + 7.0) + bank * 0.2) * uLeaves;
  col = mix(col, mix(vec3(0.85, 0.35, 0.08), vec3(0.75, 0.12, 0.08), vnoise(drift * 3.0)) * lit, leaves);
  alpha = max(alpha, max(petals, leaves));

  // ice: frosted, cracked, then dusted with snow
  if (uIce > 0.001) {
    float crack = 1.0 - smoothstep(0.0, 0.035, abs(vnoise(p * 3.0) - 0.5)) * 0.6;
    vec3 iceCol = vec3(0.78, 0.88, 0.94) * crack * lit * 1.1;
    iceCol += uSunColor * pow(saturate(dot(reflect(-V, vec3(0.0, 1.0, 0.0)), uSunDir)), 30.0) * 0.25;
    float snowOnIce = smoothstep(0.45, 0.7, fbm2(p * 1.5) + uSnowCover * 0.5 - 0.2) * uSnowCover;
    iceCol = mix(iceCol, uSnowColor * lit, snowOnIce * 0.55);
    col = mix(col, iceCol, uIce);
    alpha = mix(alpha, 0.97, uIce);
  }

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
