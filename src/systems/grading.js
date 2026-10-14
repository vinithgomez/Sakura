import { Vector3 } from 'three';
import { scalarTrack } from '../core/curves.js';

// ---------------------------------------------------------------------------
// Per-season colour grade, blended continuously over the year like every
// other seasonal parameter, applied in the final pass (core/finalPass.js):
//   spring — soft, pink-warm highlights, gentle contrast
//   summer — saturated, a touch more contrast, teal-ish shadows
//   autumn — amber white balance and highlights
//   winter — cool, desaturated, slightly flatter
// The grade eases toward neutral at night so moonlight isn't over-styled.
// Keyframes: [year, value] at each season's peak (wraps winter → spring).
// ---------------------------------------------------------------------------

const KEYS = { spring: 0.17, summer: 0.43, autumn: 0.71, winter: 0.91 };

const track = (spring, summer, autumn, winter) =>
  scalarTrack([
    [KEYS.spring, spring],
    [KEYS.summer, summer],
    [KEYS.autumn, autumn],
    [KEYS.winter, winter],
  ]);

const vecTrack = (spring, summer, autumn, winter) => [0, 1, 2].map((i) => track(spring[i], summer[i], autumn[i], winter[i]));

const grade = {
  whiteBalance: vecTrack([1.03, 0.99, 1.0], [1.0, 1.0, 0.98], [1.07, 1.0, 0.86], [0.92, 0.98, 1.08]),
  saturation: track(1.04, 1.16, 1.1, 0.74),
  contrast: track(1.0, 1.06, 1.05, 0.95),
  shadowTint: vecTrack([0.018, 0.0, 0.014], [-0.006, 0.006, 0.014], [0.012, 0.004, -0.01], [-0.008, 0.004, 0.024]),
  highlightTint: vecTrack([0.026, 0.0, 0.012], [0.012, 0.01, -0.004], [0.034, 0.012, -0.024], [-0.01, 0.004, 0.022]),
};

export class Grading {
  constructor(finalPass) {
    this.finalPass = finalPass;
    this.current = {
      whiteBalance: new Vector3(1, 1, 1),
      saturation: 1,
      contrast: 1,
      shadowTint: new Vector3(),
      highlightTint: new Vector3(),
    };
  }

  /** @param state season state · @param day 1 = day, 0.5 = dusk, 0 = night */
  update(state, day) {
    const y = state.year;
    const k = 0.45 + 0.55 * day; // grade strength: full by day, softer at night
    const c = this.current;
    const wb = grade.whiteBalance;
    const st = grade.shadowTint;
    const ht = grade.highlightTint;
    // (deviation from neutral) × k, written out to keep the frame loop allocation-free
    c.whiteBalance.set(1 + (wb[0](y) - 1) * k, 1 + (wb[1](y) - 1) * k, 1 + (wb[2](y) - 1) * k);
    c.saturation = 1 + (grade.saturation(y) - 1) * k;
    c.contrast = 1 + (grade.contrast(y) - 1) * k;
    c.shadowTint.set(st[0](y) * k, st[1](y) * k, st[2](y) * k);
    c.highlightTint.set(ht[0](y) * k, ht[1](y) * k, ht[2](y) * k);
    this.finalPass.setGrade(c);
    return c;
  }
}
