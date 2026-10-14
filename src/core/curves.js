import { Color } from 'three';

// Cyclic keyframe tracks over the year (x in [0, 1)). Keys are [x, value]
// pairs sorted by x. If the first key isn't at 0 / the last isn't at 1, the
// track wraps from the last key back around to the first — so the year loops
// seamlessly from winter into spring.

export const ease = {
  linear: (t) => t,
  smooth: (t) => t * t * (3 - 2 * t),
};

function locate(keys, x, out) {
  const n = keys.length;
  for (let i = 0; i < n - 1; i++) {
    const a = keys[i][0];
    const b = keys[i + 1][0];
    if (x >= a && x < b) {
      out.i = i;
      out.j = i + 1;
      out.t = (x - a) / (b - a);
      return out;
    }
  }
  // Wrap segment: last key → first key of the next year.
  const a = keys[n - 1][0];
  const span = keys[0][0] + 1 - a;
  let dx = x - a;
  if (dx < 0) dx += 1;
  out.i = n - 1;
  out.j = 0;
  out.t = span > 0 ? dx / span : 0;
  return out;
}

const _seg = { i: 0, j: 0, t: 0 };

/** Returns (x) => number. */
export function scalarTrack(keys, easing = ease.smooth) {
  return (x) => {
    const s = locate(keys, x, _seg);
    const a = keys[s.i][1];
    const b = keys[s.j][1];
    return a + (b - a) * easing(s.t);
  };
}

/** Returns (x, target: Color) => target. Hex keys are sRGB; lerp is linear-space. */
export function colorTrack(keys, easing = ease.smooth) {
  const colors = keys.map(([x, hex]) => [x, new Color(hex)]);
  return (x, target) => {
    const s = locate(colors, x, _seg);
    return target.lerpColors(colors[s.i][1], colors[s.j][1], easing(s.t));
  };
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (a, b, v) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const damp = (current, target, lambda, dt) =>
  current + (target - current) * (1 - Math.exp(-lambda * dt));
