import { ShaderChunk } from 'three';

// ---------------------------------------------------------------------------
// Softer, cleaner PCF. three r186 filters directional shadows with 5 hardware
// PCF taps on a per-pixel rotated Vogel disk: fine for small radii, grainy for
// the wide penumbrae a tree canopy throws. This swaps in an N-tap loop over
// the same disk (each tap is still a 2×2 hardware-filtered lookup).
// Imported once, before any material compiles.
// ---------------------------------------------------------------------------

export const SHADOW_TAPS = 12;

/** Objects on this layer are seen by the sun's shadow camera but not by the main camera. */
export const SHADOW_ONLY_LAYER = 1;

const fivetap =
  /shadow = \(\s*texture\( shadowMap, vec3\( shadowCoord\.xy \+ vogelDiskSample\( 0, 5, phi \) \* radius, shadowCoord\.z \) \)[\s\S]*?\) \* 0\.2;/;

const ntap = `shadow = 0.0;
				for ( int i = 0; i < ${SHADOW_TAPS}; i ++ ) {
					shadow += texture( shadowMap, vec3( shadowCoord.xy + vogelDiskSample( i, ${SHADOW_TAPS}, phi ) * radius, shadowCoord.z ) );
				}
				shadow /= ${SHADOW_TAPS}.0;`;

if (fivetap.test(ShaderChunk.shadowmap_pars_fragment)) {
  ShaderChunk.shadowmap_pars_fragment = ShaderChunk.shadowmap_pars_fragment.replace(fivetap, ntap);
} else {
  console.warn('[sakura] shadow filter patch did not apply (three.js shader chunk changed) — using the default 5-tap PCF');
}

/** World-space penumbra width → `light.shadow.radius` in texels for a given map size. */
export function shadowRadiusFor(worldSoftness, frustumWidth, mapSize) {
  return (worldSoftness / frustumWidth) * mapSize;
}
