import { DirectionalLight, HemisphereLight, PointLight, Fog, Color, Vector3 } from 'three';
import { colorTrack, scalarTrack, ease, smoothstep } from '../core/curves.js';
import { shared } from '../core/uniforms.js';
import { Sky } from './sky.js';
import { shadowRadiusFor, SHADOW_ONLY_LAYER } from '../core/shadows.js';

// ---------------------------------------------------------------------------
// Time of day is a continuous float `day`: 0 = night, 0.5 = dusk, 1 = day.
// The toggle cycles a *target* (day → dusk → night) and `day` glides toward
// it, so every palette below is sampled at in-between values while the sky
// turns. Season tints (from seasons.js) multiply on top.
// ---------------------------------------------------------------------------

export const TIMES = [
  { key: 'day', kanji: '昼', name: 'Day', value: 1 },
  { key: 'dusk', kanji: '夕', name: 'Dusk', value: 0.5 },
  { key: 'night', kanji: '夜', name: 'Night', value: 0 },
];

const L = ease.linear;
const palette = {
  zenith: colorTrack([[0, '#050918'], [0.5, '#2a3768'], [1, '#3d84d4']], L),
  horizon: colorTrack([[0, '#142040'], [0.5, '#ef9670'], [1, '#bad6ee']], L),
  nadir: colorTrack([[0, '#03050d'], [0.5, '#362f52'], [1, '#78a0c8']], L),
  sun: colorTrack([[0, '#8ea4ff'], [0.5, '#ff8d4c'], [1, '#fff2e0']], L),
  sunIntensity: scalarTrack([[0, 0.8], [0.5, 2.0], [1, 2.75]], L),
  hemiSky: colorTrack([[0, '#2a3a66'], [0.5, '#c98f84'], [1, '#c6ddf4']], L),
  hemiGround: colorTrack([[0, '#0b0d16'], [0.5, '#3c2e38'], [1, '#62704a']], L),
  hemiIntensity: scalarTrack([[0, 1.05], [0.5, 1.15], [1, 1.6]], L),
  exposure: scalarTrack([[0, 1.45], [0.5, 1.08], [1, 1.0]], L),
  bloomStrength: scalarTrack([[0, 0.85], [0.5, 0.6], [1, 0.32]], L),
  bounceIntensity: scalarTrack([[0, 0.25], [0.5, 0.55], [1, 0.8]], L),
  bloomThreshold: scalarTrack([[0, 0.55], [0.5, 0.85], [1, 1.05]], L),
};

// Light directions (toward the light) for day sun, dusk sun and moon.
const dirFromAngles = (azDeg, elDeg) => {
  const az = (azDeg * Math.PI) / 180;
  const el = (elDeg * Math.PI) / 180;
  return new Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
};
const DIR_DAY = dirFromAngles(38, 54);
const DIR_DUSK = dirFromAngles(-72, 8);
const DIR_NIGHT = dirFromAngles(150, 46);

const _c = new Color();

const SHADOW_EXTENT = 12.5; // half-size of the sun's shadow frustum (world units)
const SHADOW_SOFTNESS = 0.075; // penumbra width (world units)

export class Lighting {
  constructor(scene, postfx, renderer) {
    this.scene = scene;
    this.postfx = postfx;
    this.renderer = renderer;

    this.timeIndex = 0;
    this.dayTarget = 1;
    this.day = 1;
    this.listeners = new Set();

    // Sun & moon share one shadow-casting light. The frustum is fitted to the
    // island (±12.5 covers it from any sun angle) to spend every texel there.
    const sun = new DirectionalLight(0xffffff, 3);
    sun.castShadow = true;
    const cam = sun.shadow.camera;
    cam.left = -SHADOW_EXTENT;
    cam.right = SHADOW_EXTENT;
    cam.top = SHADOW_EXTENT;
    cam.bottom = -SHADOW_EXTENT;
    cam.near = 8;
    cam.far = 55;
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.045;
    sun.target.position.set(0, 1.5, 0);
    cam.layers.enable(SHADOW_ONLY_LAYER); // shadow-only proxies (see tree.js)
    scene.add(sun, sun.target);
    this.sun = sun;

    this.hemi = new HemisphereLight(0xffffff, 0x444444, 1);
    scene.add(this.hemi);

    // Soft bounce from the sunlit cloud sea below. Only surfaces facing down
    // receive it — chiefly the island's underside, which faces away from both
    // sun and sky — so its strata read without the lit top looking flat.
    this.bounce = new DirectionalLight(0xffffff, 0);
    this.bounce.position.set(0.35, -1, 0.25).multiplyScalar(30);
    scene.add(this.bounce);

    // Warm lantern glow (positioned by the island).
    this.lantern = new PointLight(0xffa04f, 0, 9, 1.6);
    scene.add(this.lantern);
    this.lanternLevel = 0;

    scene.fog = new Fog(0xbad6ee, 55, 190);

    this.sky = new Sky(scene);
    this.setShadowQuality(2048);

    this._dir = new Vector3();
    this._zenith = new Color();
    this._horizon = new Color();
    this._nadir = new Color();
    this._glow = new Color();
    this._sunCol = new Color();
  }

  get time() {
    return TIMES[this.timeIndex];
  }

  setTime(index) {
    this.timeIndex = index;
    this.dayTarget = TIMES[index].value;
    for (const fn of this.listeners) fn(this);
  }

  cycleTime() {
    this.setTime((this.timeIndex + 1) % TIMES.length);
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  setLanternPosition(v) {
    this.lantern.position.copy(v);
  }

  setShadowQuality(size) {
    const shadow = this.sun.shadow;
    // keep the penumbra the same size in the world whatever the map resolution
    shadow.radius = shadowRadiusFor(SHADOW_SOFTNESS, SHADOW_EXTENT * 2, size);
    if (shadow.mapSize.x === size && shadow.map) return;
    shadow.mapSize.set(size, size);
    shadow.map?.dispose();
    shadow.map = null;
  }

  update(state, dt, camera) {
    // Glide toward the target time at a calm, constant pace (~2.4 s per stop).
    const step = dt / 2.4;
    const diff = this.dayTarget - this.day;
    this.day += Math.abs(diff) <= step ? diff : Math.sign(diff) * step;
    const d = this.day;
    shared.uDay.value = d;

    // Light direction: night → dusk → day.
    if (d < 0.5) this._dir.lerpVectors(DIR_NIGHT, DIR_DUSK, smoothstep(0, 0.5, d));
    else this._dir.lerpVectors(DIR_DUSK, DIR_DAY, smoothstep(0.5, 1, d));
    this._dir.normalize();
    shared.uSunDir.value.copy(this._dir);
    this.sun.position.copy(this._dir).multiplyScalar(30).add(this.sun.target.position);

    // Sun / moon colour & intensity, tinted by the season.
    palette.sun(d, this._sunCol).multiply(state.sunTint);
    const sunI = palette.sunIntensity(d);
    this.sun.color.copy(this._sunCol);
    this.sun.intensity = sunI;
    shared.uSunColor.value.copy(this._sunCol).multiplyScalar(sunI);

    // Hemisphere ambient.
    const hemiI = palette.hemiIntensity(d);
    palette.hemiSky(d, this.hemi.color).multiply(state.skyTint);
    palette.hemiGround(d, this.hemi.groundColor);
    this.hemi.intensity = hemiI;
    shared.uSkyAmbient.value.copy(this.hemi.color).multiplyScalar(hemiI);
    shared.uGroundAmbient.value.copy(this.hemi.groundColor).multiplyScalar(hemiI);

    // Sky & fog.
    palette.zenith(d, this._zenith).multiply(state.skyTint);
    palette.horizon(d, this._horizon).multiply(state.skyTint);
    palette.nadir(d, this._nadir).multiply(state.skyTint);
    this._glow.copy(this._sunCol);
    this.sky.apply({
      zenith: this._zenith,
      horizon: this._horizon,
      nadir: this._nadir,
      glow: this._glow,
      sunAmount: smoothstep(0.25, 0.6, d),
      moonAmount: 1 - smoothstep(0.12, 0.42, d),
      stars: 1 - smoothstep(0.08, 0.48, d),
    });
    this.sky.follow(camera);
    shared.uSkyZenith.value.copy(this._zenith);
    shared.uSkyHorizon.value.copy(this._horizon);
    // bounce: horizon-coloured, warmed by the sun
    this.bounce.color.copy(this._horizon).lerp(this._sunCol, 0.35);
    this.bounce.intensity = palette.bounceIntensity(d);

    this.scene.fog.color.copy(_c.copy(this._horizon).lerp(this._nadir, 0.25));

    // Lantern: lit from dusk, with a gentle candle flicker.
    const t = shared.uTime.value;
    const flicker = 0.88 + 0.07 * Math.sin(t * 7.3) + 0.05 * Math.sin(t * 13.7 + 1.3);
    this.lanternLevel = 1 - smoothstep(0.25, 0.75, d);
    this.lantern.intensity = this.lanternLevel * 7 * flicker;

    // Exposure & bloom.
    this.renderer.toneMappingExposure = palette.exposure(d);
    this.postfx.setBloom(palette.bloomStrength(d), palette.bloomThreshold(d), 0.55);
  }
}
