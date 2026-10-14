import commonGLSL from '../shaders/common.glsl?raw';
import windGLSL from '../shaders/wind.glsl?raw';
import snowGLSL from '../shaders/snowCover.glsl?raw';
import { shared } from './uniforms.js';

export const GLSL = { common: commonGLSL, wind: windGLSL, snow: snowGLSL };

/**
 * Extends a built-in three material through onBeforeCompile so it keeps all of
 * three's lighting, shadows and fog while gaining:
 *   wind  — vertex sway from windOffset(), weighted by the `aFlex` attribute
 *   snow  — snow gathering on upward-facing surfaces (uSnowCover)
 *   patch — any extra (shader) => void edits (e.g. bark pattern)
 */
export function enhanceMaterial(material, { wind = false, snow = false, patch = null, key = '' } = {}) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = shared.uTime;
    shader.uniforms.uWindStrength = shared.uWindStrength;
    shader.uniforms.uWindDir = shared.uWindDir;
    shader.uniforms.uSnowCover = shared.uSnowCover;
    shader.uniforms.uSnowColor = shared.uSnowColor;

    let vHead = '#include <common>\n' + commonGLSL;
    let fHead = '#include <common>\n' + commonGLSL;

    if (wind) {
      vHead += windGLSL + '\nattribute float aFlex;\n';
      shader.vertexShader = shader.vertexShader.replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\ntransformed += windOffset(transformed, aFlex);',
      );
    }

    if (snow) {
      vHead += 'varying vec3 vSnowPos;\nvarying vec3 vSnowNormal;\n';
      fHead += snowGLSL + '\nuniform vec3 uSnowColor;\nvarying vec3 vSnowPos;\nvarying vec3 vSnowNormal;\n';
      shader.vertexShader = shader.vertexShader.replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
        vec4 snowWorld = vec4(transformed, 1.0);
        mat3 snowNM = mat3(modelMatrix);
        #ifdef USE_INSTANCING
          snowWorld = instanceMatrix * snowWorld;
          snowNM = snowNM * mat3(instanceMatrix);
        #endif
        vSnowPos = (modelMatrix * snowWorld).xyz;
        vSnowNormal = normalize(snowNM * objectNormal);`,
      );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <color_fragment>',
          `#include <color_fragment>
          float snowAmt = snowMask(normalize(vSnowNormal), vSnowPos);
          diffuseColor.rgb = mix(diffuseColor.rgb, uSnowColor, snowAmt);`,
        )
        .replace(
          '#include <roughnessmap_fragment>',
          '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.75, snowAmt);',
        );
    }

    shader.vertexShader = shader.vertexShader.replace('#include <common>', vHead);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', fHead);

    if (patch) patch(shader);
  };
  material.customProgramCacheKey = () => `sakura:${wind}:${snow}:${key}`;
  return material;
}
