import { ShaderMaterial, Vector2, Vector3 } from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

// ---------------------------------------------------------------------------
// The last step for every preset, in one full-screen pass (it replaces
// three's OutputPass, so it costs nothing extra):
//   white balance (linear) → ACES filmic tone mapping (with the renderer's
//   exposure) → saturation / contrast / split-toning (display-referred) →
//   vignette → sRGB → a very light, animated film grain.
// The grade itself is per-season and comes from systems/grading.js.
// ---------------------------------------------------------------------------

const shader = {
  vertex: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }`,
  fragment: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec3 uWhiteBalance;
    uniform float uSaturation;
    uniform float uContrast;
    uniform vec3 uShadowTint;
    uniform vec3 uHighlightTint;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uTime;
    uniform vec2 uResolution;
    varying vec2 vUv;

    // three only injects the tone-mapping chunk into a ShaderMaterial's prefix
    // when that material draws straight to the screen. This pass draws into an
    // intermediate target whenever SMAA follows it (the Low preset), so the
    // material opts out (toneMapped: false) and includes the chunk itself,
    // whichever target it renders to. (sRGBTransferOETF comes from the
    // colour-space chunk, which three always includes.)
    #include <tonemapping_pars_fragment>

    float grainHash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec3 c = texture2D(tDiffuse, vUv).rgb * uWhiteBalance;
      c = ACESFilmicToneMapping(c);

      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(l), c, uSaturation);
      c = (c - 0.5) * uContrast + 0.5;
      c += uShadowTint * (1.0 - smoothstep(0.0, 0.55, l)) + uHighlightTint * smoothstep(0.45, 1.0, l);

      vec2 d = (vUv - 0.5) * vec2(uResolution.x / uResolution.y, 1.0);
      c *= mix(1.0 - uVignette, 1.0, smoothstep(0.95, 0.3, length(d)));

      c = sRGBTransferOETF(vec4(max(c, 0.0), 1.0)).rgb;
      // grain: stronger in the mid-tones, like film, and different every frame
      float g = grainHash(gl_FragCoord.xy + fract(uTime * 7.31) * 911.0) - 0.5;
      c += g * uGrain * (0.4 + 0.6 * (1.0 - abs(l - 0.5) * 2.0));
      gl_FragColor = vec4(c, 1.0);
    }`,
};

export class FinalPass extends Pass {
  constructor() {
    super();
    this.uniforms = {
      tDiffuse: { value: null },
      toneMappingExposure: { value: 1 },
      uWhiteBalance: { value: new Vector3(1, 1, 1) },
      uSaturation: { value: 1 },
      uContrast: { value: 1 },
      uShadowTint: { value: new Vector3() },
      uHighlightTint: { value: new Vector3() },
      uVignette: { value: 0.3 },
      uGrain: { value: 0.022 },
      uTime: { value: 0 },
      uResolution: { value: new Vector2(1, 1) },
    };
    this.quad = new FullScreenQuad(
      new ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: shader.vertex,
        fragmentShader: shader.fragment,
        depthTest: false,
        depthWrite: false,
        toneMapped: false, // tone mapping is done explicitly above (see the shader)
      }),
    );
  }

  /** @param {{whiteBalance: Vector3, saturation, contrast, shadowTint: Vector3, highlightTint: Vector3}} g */
  setGrade(g) {
    const u = this.uniforms;
    u.uWhiteBalance.value.copy(g.whiteBalance);
    u.uSaturation.value = g.saturation;
    u.uContrast.value = g.contrast;
    u.uShadowTint.value.copy(g.shadowTint);
    u.uHighlightTint.value.copy(g.highlightTint);
  }

  setSize(width, height) {
    this.uniforms.uResolution.value.set(width, height);
  }

  render(renderer, writeBuffer, readBuffer) {
    this.uniforms.tDiffuse.value = readBuffer.texture;
    this.uniforms.toneMappingExposure.value = renderer.toneMappingExposure;
    this.uniforms.uTime.value = performance.now() / 1000;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.quad.render(renderer);
  }

  dispose() {
    this.quad.material.dispose();
    this.quad.dispose();
  }
}
