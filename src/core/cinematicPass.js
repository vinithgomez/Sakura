import { HalfFloatType, Matrix4, ShaderMaterial, Vector2, Vector3, WebGLRenderTarget, Color } from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// ---------------------------------------------------------------------------
// Cinematic preset only. Everything here works from the depth buffer the
// scene pass already rendered (so billboarded blossoms, instanced grass and
// wind-swayed branches are all exactly where they appear — no re-render with
// override materials), plus the sun's existing shadow map.
//
//   1. SSAO (half res)      — scalable ambient obscurance from depth, with
//                             normals reconstructed from neighbouring depths
//   2. volumetric fog (half)— a 24-step raymarch along each view ray through
//                             low-lying mist, sampling the sun's shadow map:
//                             light shafts ("god rays") wherever the canopy
//                             breaks the sunlight, from any camera angle
//   3. composite (full)     — colour × AO × fog transmittance + in-scatter
//   4. depth of field (full)— a gentle disc blur whose circle of confusion
//                             grows with distance *beyond* the orbit target (far field only)
// ---------------------------------------------------------------------------

const VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

// shared: reconstruct view-space position from the depth texture
const DEPTH_GLSL = /* glsl */ `
  uniform sampler2D tDepth;
  uniform mat4 uProjInv;
  vec3 viewPos(vec2 uv) {
    float d = texture2D(tDepth, uv).x;
    vec4 v = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
    return v.xyz / v.w;
  }
  float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }`;

const AO_FRAG = /* glsl */ `
  ${DEPTH_GLSL}
  uniform mat4 uProj;
  uniform vec2 uTexel;     // of the depth texture
  uniform float uRadius;   // world units
  varying vec2 vUv;
  void main() {
    float d = texture2D(tDepth, vUv).x;
    if (d >= 1.0) { gl_FragColor = vec4(1.0); return; }
    vec3 P = viewPos(vUv);
    // normal from the smaller of the forward/backward differences (sharp at edges)
    vec3 px = viewPos(vUv + vec2(uTexel.x, 0.0)) - P;
    vec3 nx = P - viewPos(vUv - vec2(uTexel.x, 0.0));
    vec3 py = viewPos(vUv + vec2(0.0, uTexel.y)) - P;
    vec3 ny = P - viewPos(vUv - vec2(0.0, uTexel.y));
    vec3 dx = abs(px.z) < abs(nx.z) ? px : nx;
    vec3 dy = abs(py.z) < abs(ny.z) ? py : ny;
    vec3 N = normalize(cross(dx, dy));
    float rUv = uRadius * uProj[1][1] / max(-P.z, 0.1) * 0.5; // projected radius in uv
    float phi = ign(gl_FragCoord.xy) * 6.2831;
    float sum = 0.0;
    const int TAPS = 12;
    for (int i = 0; i < TAPS; i++) {
      float r = sqrt((float(i) + 0.5) / float(TAPS));
      float a = float(i) * 2.39996 + phi;
      vec2 o = vec2(cos(a), sin(a)) * r * rUv * vec2(uTexel.x / uTexel.y, 1.0); // radius was projected vertically
      vec3 v = viewPos(vUv + o) - P;
      float vv = dot(v, v);
      float range = 1.0 - smoothstep(uRadius * uRadius * 0.6, uRadius * uRadius, vv);
      sum += max(dot(v, N) - 0.02 * -P.z * 0.05, 0.0) / (vv + 0.02) * range;
    }
    float ao = clamp(1.0 - sum * 2.2 / float(TAPS), 0.0, 1.0);
    gl_FragColor = vec4(ao, ao, ao, 1.0);
  }`;

const FOG_FRAG = /* glsl */ `
  ${DEPTH_GLSL}
  uniform sampler2DShadow tShadow;
  uniform mat4 uShadowMatrix;
  uniform mat4 uViewToWorld;
  uniform vec3 uCamPos;
  uniform vec3 uSunDir;
  uniform vec3 uSunColor;
  uniform vec3 uAmbient;
  uniform float uDensity;
  uniform float uShadowOn;
  uniform float uShafts;
  varying vec2 vUv;

  float phaseHG(float c, float g) {
    float g2 = g * g;
    return (1.0 - g2) / (12.566 * pow(1.0 + g2 - 2.0 * g * c, 1.5));
  }

  void main() {
    float d = texture2D(tDepth, vUv).x;
    vec3 Pv = viewPos(vUv);
    vec3 world = (uViewToWorld * vec4(Pv, 1.0)).xyz;
    vec3 ray = world - uCamPos;
    float dist = d >= 1.0 ? 60.0 : min(length(ray), 60.0);
    vec3 dir = normalize(ray);
    // forward-scattering, but blended with isotropic and capped so looking into
    // a low sun glows rather than blowing out (1 = isotropic)
    float phase = min(mix(1.0, phaseHG(dot(dir, uSunDir), 0.6) * 12.566, 0.6), 4.0);
    const int STEPS = 24;
    float dt = dist / float(STEPS);
    float jitter = ign(gl_FragCoord.xy);
    vec3 inscatter = vec3(0.0);
    float T = 1.0;
    for (int i = 0; i < STEPS; i++) {
      vec3 p = uCamPos + dir * (float(i) + jitter) * dt;
      // mist hugging the island, thinning with height and away from it
      float h = p.y;
      float density = uDensity * exp(-max(h - 0.2, 0.0) / 4.5) * (1.0 - smoothstep(9.0, 16.0, length(p.xz)));
      if (h < -1.5) density *= exp((h + 1.5) * 0.6);
      vec4 sc = uShadowMatrix * vec4(p, 1.0);
      float lit = 1.0;
      if (uShadowOn > 0.5 && all(greaterThan(sc.xyz, vec3(0.0))) && all(lessThan(sc.xyz, vec3(1.0)))) {
        lit = texture(tShadow, vec3(sc.xy, sc.z - 0.002));
      }
      vec3 light = uSunColor * lit * phase * uShafts + uAmbient * 0.4; // shafts = lit vs shadowed contrast
      float a = density * dt;
      inscatter += T * a * light;
      T *= exp(-a);
    }
    gl_FragColor = vec4(inscatter * 0.0795, T); // 1/(4π): radiance from in-scattered irradiance
  }`;

const COMPOSITE_FRAG = /* glsl */ `
  uniform sampler2D tColor;
  uniform sampler2D tAO;
  uniform sampler2D tFog;
  uniform vec2 uHalfTexel;
  uniform float uAOStrength;
  varying vec2 vUv;
  void main() {
    vec3 c = texture2D(tColor, vUv).rgb;
    float ao = 0.0;
    for (int y = -1; y <= 1; y++)
      for (int x = -1; x <= 1; x++) ao += texture2D(tAO, vUv + vec2(float(x), float(y)) * uHalfTexel).r;
    ao /= 9.0;
    vec4 fog = texture2D(tFog, vUv);
    c = c * mix(1.0, ao, uAOStrength) * fog.a + fog.rgb;
    gl_FragColor = vec4(c, 1.0);
  }`;

const DOF_FRAG = /* glsl */ `
  ${DEPTH_GLSL}
  uniform sampler2D tColor;
  uniform vec2 uTexel;
  uniform float uFocus;      // distance to the orbit target
  uniform float uAperture;   // blur growth per unit of relative defocus
  uniform float uMaxBlur;    // px
  varying vec2 vUv;
  // Far field only: everything nearer than the orbit target stays sharp, so
  // grass blades right in front of a low camera never smear into a blur.
  float coc(vec2 uv) {
    float z = -viewPos(uv).z;
    return clamp(max(z - uFocus, 0.0) / max(z, 0.1) * uAperture, 0.0, 1.0) * uMaxBlur;
  }
  void main() {
    vec3 base = texture2D(tColor, vUv).rgb;
    float r = coc(vUv);
    if (r < 0.5) { gl_FragColor = vec4(base, 1.0); return; }
    vec3 sum = base;
    float wsum = 1.0;
    const int TAPS = 16;
    for (int i = 0; i < TAPS; i++) {
      float rr = sqrt((float(i) + 0.5) / float(TAPS)) * r;
      float a = float(i) * 2.39996;
      vec2 uv = vUv + vec2(cos(a), sin(a)) * rr * uTexel;
      // a sharp foreground sample shouldn't smear onto a blurred background
      float w = smoothstep(0.0, 1.0, coc(uv) - rr * 0.5 + 1.0);
      sum += texture2D(tColor, uv).rgb * w;
      wsum += w;
    }
    gl_FragColor = vec4(sum / wsum, 1.0);
  }`;

export class CinematicPass extends Pass {
  constructor({ camera, sun, sceneTarget, getFocus }) {
    super();
    this.camera = camera;
    this.sun = sun;
    this.sceneTarget = sceneTarget;
    this.getFocus = getFocus;
    this.needsSwap = true;
    this.enabled = false;

    const half = () => new WebGLRenderTarget(2, 2, { type: HalfFloatType, depthBuffer: false });
    this.aoTarget = half();
    this.fogTarget = half();
    this.compositeTarget = new WebGLRenderTarget(2, 2, { type: HalfFloatType, depthBuffer: false });

    const make = (fragmentShader, uniforms) =>
      new FullScreenQuad(new ShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false }));
    const common = () => ({ tDepth: { value: null }, uProjInv: { value: new Matrix4() } });

    this.ao = make(AO_FRAG, { ...common(), uProj: { value: new Matrix4() }, uTexel: { value: new Vector2() }, uRadius: { value: 0.7 } });
    this.fog = make(FOG_FRAG, {
      ...common(),
      tShadow: { value: null },
      uShadowMatrix: { value: new Matrix4() },
      uViewToWorld: { value: new Matrix4() },
      uCamPos: { value: new Vector3() },
      uSunDir: { value: new Vector3() },
      uSunColor: { value: new Color() },
      uAmbient: { value: new Color() },
      uDensity: { value: 0.05 },
      uShafts: { value: 1.6 },
      uShadowOn: { value: 0 },
    });
    this.composite = make(COMPOSITE_FRAG, {
      tColor: { value: null },
      tAO: { value: this.aoTarget.texture },
      tFog: { value: this.fogTarget.texture },
      uHalfTexel: { value: new Vector2() },
      uAOStrength: { value: 0.85 },
    });
    this.dof = make(DOF_FRAG, {
      ...common(),
      tColor: { value: this.compositeTarget.texture },
      uTexel: { value: new Vector2() },
      uFocus: { value: 20 },
      uAperture: { value: 1.6 },
      uMaxBlur: { value: 4.5 },
    });
  }

  /** Light colours for the fog (set by main from the shared light uniforms). */
  setLight(sunDir, sunColor, ambient) {
    const u = this.fog.material.uniforms;
    u.uSunDir.value.copy(sunDir);
    u.uSunColor.value.copy(sunColor);
    u.uAmbient.value.copy(ambient);
    // A low sun shines along the whole haze layer and straight into the lens,
    // so thin the haze and soften the shafts as it sets (dusk keeps ~35%).
    const high = Math.min(Math.max((sunDir.y - 0.1) / 0.6, 0), 1);
    const k = 0.35 + 0.65 * high * high * (3 - 2 * high);
    u.uShafts.value = 1.6 * k;
    u.uDensity.value = 0.05 * (0.55 + 0.45 * k);
  }

  setSize(width, height) {
    const hw = Math.max(1, Math.round(width / 2));
    const hh = Math.max(1, Math.round(height / 2));
    this.aoTarget.setSize(hw, hh);
    this.fogTarget.setSize(hw, hh);
    this.compositeTarget.setSize(width, height);
    this.ao.material.uniforms.uTexel.value.set(1 / width, 1 / height);
    this.composite.material.uniforms.uHalfTexel.value.set(1 / hw, 1 / hh);
    this.dof.material.uniforms.uTexel.value.set(1 / width, 1 / height);
  }

  render(renderer, writeBuffer, readBuffer) {
    const depth = this.sceneTarget.depthTexture;
    const cam = this.camera;
    for (const q of [this.ao, this.fog, this.dof]) {
      q.material.uniforms.tDepth.value = depth;
      q.material.uniforms.uProjInv.value.copy(cam.projectionMatrixInverse);
    }
    this.ao.material.uniforms.uProj.value.copy(cam.projectionMatrix);

    const fu = this.fog.material.uniforms;
    fu.uViewToWorld.value.copy(cam.matrixWorld);
    fu.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
    const shadow = this.sun.shadow;
    const shadowTex = shadow.map?.depthTexture ?? null;
    fu.tShadow.value = shadowTex;
    fu.uShadowOn.value = shadowTex ? 1 : 0;
    fu.uShadowMatrix.value.copy(shadow.matrix);

    this.dof.material.uniforms.uFocus.value = this.getFocus();

    renderer.setRenderTarget(this.aoTarget);
    this.ao.render(renderer);
    renderer.setRenderTarget(this.fogTarget);
    this.fog.render(renderer);
    this.composite.material.uniforms.tColor.value = readBuffer.texture;
    renderer.setRenderTarget(this.compositeTarget);
    this.composite.render(renderer);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.dof.render(renderer);
  }
}
