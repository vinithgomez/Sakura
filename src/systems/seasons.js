import { Color } from 'three';
import { scalarTrack, colorTrack, ease, damp } from '../core/curves.js';

// ---------------------------------------------------------------------------
// The year is one float. 0 = 立春 Risshun (start of spring, ~4 Feb), and it
// wraps at 1 back into spring. Every visual parameter below is a cyclic
// keyframe curve over that float, so any position on the timeline — including
// the in-betweens — is a valid, smoothly blended world state.
// ---------------------------------------------------------------------------

export const SEASONS = [
  { key: 'spring', name: 'Spring', kanji: '春', romaji: 'Haru', start: 0.0 },
  { key: 'summer', name: 'Summer', kanji: '夏', romaji: 'Natsu', start: 0.25 },
  { key: 'autumn', name: 'Autumn', kanji: '秋', romaji: 'Aki', start: 0.5 },
  { key: 'winter', name: 'Winter', kanji: '冬', romaji: 'Fuyu', start: 0.75 },
];

/** The 24 sekki (二十四節気), the traditional Japanese solar terms. */
export const SEKKI = [
  ['立春', 'Risshun', 'Spring begins'],
  ['雨水', 'Usui', 'Rain water'],
  ['啓蟄', 'Keichitsu', 'Insects awaken'],
  ['春分', 'Shunbun', 'Spring equinox'],
  ['清明', 'Seimei', 'Pure and clear'],
  ['穀雨', 'Kokuu', 'Grain rain'],
  ['立夏', 'Rikka', 'Summer begins'],
  ['小満', 'Shōman', 'Lesser ripening'],
  ['芒種', 'Bōshu', 'Grain in ear'],
  ['夏至', 'Geshi', 'Summer solstice'],
  ['小暑', 'Shōsho', 'Lesser heat'],
  ['大暑', 'Taisho', 'Greater heat'],
  ['立秋', 'Risshū', 'Autumn begins'],
  ['処暑', 'Shosho', 'Heat retreats'],
  ['白露', 'Hakuro', 'White dew'],
  ['秋分', 'Shūbun', 'Autumn equinox'],
  ['寒露', 'Kanro', 'Cold dew'],
  ['霜降', 'Sōkō', 'Frost descends'],
  ['立冬', 'Rittō', 'Winter begins'],
  ['小雪', 'Shōsetsu', 'Lesser snow'],
  ['大雪', 'Taisetsu', 'Greater snow'],
  ['冬至', 'Tōji', 'Winter solstice'],
  ['小寒', 'Shōkan', 'Lesser cold'],
  ['大寒', 'Daikan', 'Greater cold'],
].map(([kanji, romaji, meaning]) => ({ kanji, romaji, meaning }));

// --- keyframe tracks ---------------------------------------------------------

const tracks = {
  // Blossom sprites present on the branches (appear as buds, later shed).
  blossoms: scalarTrack([[0.0, 0], [0.025, 0], [0.09, 1], [0.19, 1], [0.29, 0]]),
  // How far the buds have opened.
  bloom: scalarTrack([[0.0, 0], [0.07, 0], [0.15, 1], [0.32, 1], [0.36, 0]]),
  // Drifting petals (light during full bloom, a storm while shedding: 花吹雪).
  petalRate: scalarTrack([[0.0, 0], [0.11, 0], [0.15, 0.3], [0.2, 0.55], [0.245, 1], [0.29, 0.45], [0.33, 0]]),
  // Fallen petals on the grass and floating on the pond (花筏 hanaikada).
  petalCover: scalarTrack([[0.0, 0], [0.15, 0], [0.24, 0.65], [0.29, 1], [0.34, 0.55], [0.42, 0]]),

  // Leaves: hazakura (葉桜) leaves emerge as the blossoms fall.
  leaves: scalarTrack([[0.0, 0], [0.2, 0], [0.33, 1], [0.71, 1], [0.825, 0]]),
  leafGrowth: scalarTrack([[0.0, 0.3], [0.2, 0.3], [0.37, 1], [0.8, 1], [0.86, 0.3]]),
  autumn: scalarTrack([[0.0, 0], [0.58, 0], [0.72, 1], [0.83, 1], [0.87, 0]]),
  leafFallRate: scalarTrack([[0.0, 0], [0.63, 0], [0.7, 0.45], [0.76, 1], [0.82, 0.35], [0.85, 0]]),
  leafCover: scalarTrack([[0.0, 0], [0.68, 0], [0.78, 1], [0.86, 0.7], [0.9, 0]]),

  // Winter.
  snowfall: scalarTrack([[0.0, 0.2], [0.035, 0], [0.775, 0], [0.81, 0.75], [0.88, 1], [0.96, 0.75], [1.0, 0.2]]),
  snowCover: scalarTrack([[0.0, 0.7], [0.075, 0], [0.795, 0], [0.88, 0.92], [0.95, 1], [1.0, 0.7]]),
  pondIce: scalarTrack([[0.0, 0.45], [0.05, 0], [0.845, 0], [0.93, 1], [0.98, 1], [1.0, 0.45]]),

  // Early-summer fireflies (蛍 hotaru) — the lighting system gates them to dusk/night.
  fireflies: scalarTrack([[0.0, 0], [0.31, 0], [0.37, 1], [0.5, 1], [0.56, 0]]),

  // Wind: breezy spring, still summer, gusty autumn.
  wind: scalarTrack(
    [[0.0, 0.55], [0.15, 0.7], [0.25, 0.8], [0.4, 0.42], [0.55, 0.5], [0.72, 0.95], [0.86, 0.75], [1.0, 0.55]],
    ease.smooth,
  ),

  grass: colorTrack([
    [0.0, '#848d5c'],
    [0.12, '#8daa58'],
    [0.3, '#6b9845'],
    [0.46, '#4a7a33'],
    [0.6, '#627a36'],
    [0.71, '#968546'],
    [0.8, '#7a6748'],
    [1.0, '#848d5c'],
  ]),
  skyTint: colorTrack([
    [0.0, '#f3f2f6'],
    [0.16, '#fff0f4'],
    [0.42, '#eaf4ff'],
    [0.68, '#fff2e2'],
    [0.9, '#eef2f9'],
    [1.0, '#f3f2f6'],
  ]),
  sunTint: colorTrack([
    [0.0, '#f6f4ff'],
    [0.16, '#fff3ee'],
    [0.42, '#fffaea'],
    [0.68, '#ffe4c4'],
    [0.9, '#eaf0ff'],
    [1.0, '#f6f4ff'],
  ]),
};

// --- the system --------------------------------------------------------------

// Each season's most iconic moment: full bloom, deep summer, peak momiji, deep snow.
const SHOWCASE = [0.17, 0.43, 0.715, 0.91];

export class Seasons {
  constructor() {
    // Start in full bloom — the hero moment.
    this.year = 0.165;
    this.target = this.year;
    this.autoplay = false;
    this.yearsPerSecond = 1 / 96; // a full year in ~1.6 minutes
    this.listeners = new Set();

    this.state = {
      year: 0,
      season: SEASONS[0],
      seasonIndex: 0,
      sekki: SEKKI[0],
      sekkiIndex: 0,
      blossoms: 0,
      bloom: 0,
      petalRate: 0,
      petalCover: 0,
      leaves: 0,
      leafGrowth: 0,
      autumn: 0,
      leafFallRate: 0,
      leafCover: 0,
      snowfall: 0,
      snowCover: 0,
      pondIce: 0,
      fireflies: 0,
      wind: 0,
      grass: new Color(),
      skyTint: new Color(),
      sunTint: new Color(),
    };
    this._evaluate();
  }

  /** Jump the timeline (eased). `v` in [0, 1] along the slider. */
  setTarget(v) {
    const base = Math.floor(this.year);
    this.target = base + Math.min(Math.max(v, 0), 0.9999);
  }

  /** Glide to a season's most iconic moment, along the slider (like a drag). */
  goToSeason(index) {
    if (this.autoplay) this.setAutoplay(false);
    this.target = Math.floor(this.year) + SHOWCASE[index];
  }

  /** Next / previous season; wraps through the new year instead of rewinding. */
  step(direction) {
    if (this.autoplay) this.setAutoplay(false);
    const base = Math.floor(this.target);
    const current = Math.min(3, Math.floor((this.target - base) * 4));
    const next = current + direction;
    this.target = base + Math.floor(next / 4) + SHOWCASE[(next + 4) % 4];
  }

  setAutoplay(on) {
    this.autoplay = on;
    if (on) this.target = this.year;
    this._emit();
  }

  toggleAutoplay() {
    this.setAutoplay(!this.autoplay);
  }

  onChange(fn) {
    this.listeners.add(fn);
  }

  _emit() {
    for (const fn of this.listeners) fn(this);
  }

  update(dt) {
    if (this.autoplay) {
      this.target += dt * this.yearsPerSecond;
      this.year = damp(this.year, this.target, 6, dt);
    } else {
      // Ease toward the slider target — a big jump plays as a quick, smooth blend.
      this.year = damp(this.year, this.target, 2.6, dt);
      if (Math.abs(this.target - this.year) < 1e-5) this.year = this.target;
    }
    this._evaluate();
    return this.state;
  }

  _evaluate() {
    const s = this.state;
    const y = this.year - Math.floor(this.year);
    s.year = y;
    s.seasonIndex = Math.min(3, Math.floor(y * 4));
    s.season = SEASONS[s.seasonIndex];
    s.sekkiIndex = Math.min(23, Math.floor(y * 24));
    s.sekki = SEKKI[s.sekkiIndex];

    s.blossoms = tracks.blossoms(y);
    s.bloom = tracks.bloom(y);
    s.petalRate = tracks.petalRate(y);
    s.petalCover = tracks.petalCover(y);
    s.leaves = tracks.leaves(y);
    s.leafGrowth = tracks.leafGrowth(y);
    s.autumn = tracks.autumn(y);
    s.leafFallRate = tracks.leafFallRate(y);
    s.leafCover = tracks.leafCover(y);
    s.snowfall = tracks.snowfall(y);
    s.snowCover = tracks.snowCover(y);
    s.pondIce = tracks.pondIce(y);
    s.fireflies = tracks.fireflies(y);
    s.wind = tracks.wind(y);
    tracks.grass(y, s.grass);
    tracks.skyTint(y, s.skyTint);
    tracks.sunTint(y, s.sunTint);
  }
}
