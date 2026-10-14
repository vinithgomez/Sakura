import {
  DataTexture,
  RGBAFormat,
  UnsignedByteType,
  RepeatWrapping,
  LinearMipmapLinearFilter,
  LinearFilter,
  SRGBColorSpace,
  NoColorSpace,
} from 'three';
import { Rng } from '../core/random.js';

// ---------------------------------------------------------------------------
// Procedural cherry bark — albedo, normal and roughness maps from one tileable
// height field. Cherry bark is smooth and fairly glossy, reddish grey-brown,
// with distinctive *horizontal* lenticels (raised corky dashes with a dark
// slit) and horizontal peel bands. u runs around the branch, v along it, so
// "horizontal" means along u.
// ---------------------------------------------------------------------------

function periodicNoise(x, y, px, py, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const h = (i, j) => {
    const a = ((i % px) + px) % px;
    const b = ((j % py) + py) % py;
    let n = Math.imul(a, 374761393) ^ Math.imul(b, 668265263) ^ Math.imul(seed, 2246822519);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
  };
  const a = h(ix, iy);
  const b = h(ix + 1, iy);
  const c = h(ix, iy + 1);
  const d = h(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

/** Tileable fbm: frequencies are integers so the pattern wraps exactly. */
function fbm(u, v, fx, fy, octaves, seed) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += periodicNoise(u * fx, v * fy, fx, fy, seed + o) * amp;
    norm += amp;
    amp *= 0.5;
    fx *= 2;
    fy *= 2;
  }
  return sum / norm;
}

export function createBarkTextures({ size = 512, anisotropy = 4 } = {}) {
  const rng = new Rng(1234);
  const W = size;
  const H = size;
  const height = new Float32Array(W * H);
  const lent = new Float32Array(W * H); // lenticel mask (lighter, rougher)
  const slit = new Float32Array(W * H); // dark slits + grooves

  // base surface: soft horizontal banding + fine grain
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / H;
      const band = fbm(u, v, 3, 22, 3, 11); // stretched along u → horizontal bands
      const grain = fbm(u, v, 24, 48, 2, 23);
      height[y * W + x] = band * 0.55 + grain * 0.18;
    }
  }

  // stamp a value with horizontal & vertical wrap-around
  const stamp = (cx, cy, rx, ry, fn) => {
    const x0 = Math.floor(cx - rx - 1);
    const x1 = Math.ceil(cx + rx + 1);
    const y0 = Math.floor(cy - ry - 1);
    const y1 = Math.ceil(cy + ry + 1);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x - cx) / rx;
        const dy = (y - cy) / ry;
        const d = dx * dx + dy * dy;
        if (d >= 1) continue;
        const i = (((y % H) + H) % H) * W + (((x % W) + W) % W);
        fn(i, d, dx, dy);
      }
    }
  };

  // horizontal lenticels
  const count = Math.round((W * H) / 1500);
  for (let k = 0; k < count; k++) {
    const cx = rng.float(0, W);
    const cy = rng.float(0, H);
    const rx = rng.float(5, 16) * (W / 512);
    const ry = rng.float(1.3, 2.6) * (H / 512);
    stamp(cx, cy, rx, ry, (i, d, dx, dy) => {
      const bump = 1 - d;
      height[i] += bump * 0.55;
      lent[i] = Math.max(lent[i], Math.min(1, bump * 2.2));
      const s = Math.max(0, 1 - Math.abs(dy) * 3.2) * Math.max(0, 1 - dx * dx * 1.3);
      height[i] -= s * 0.45;
      slit[i] = Math.max(slit[i], s * 0.9);
    });
  }

  // horizontal peel bands: thin wavy grooves right around the branch
  const bands = 7;
  for (let k = 0; k < bands; k++) {
    const y0 = rng.float(0, H);
    const amp = rng.float(1, 4);
    const phase = rng.float(0, Math.PI * 2);
    const width = rng.float(0.8, 1.8);
    for (let x = 0; x < W; x++) {
      const yc = y0 + Math.sin((x / W) * Math.PI * 2 * 2 + phase) * amp;
      for (let dy = -3; dy <= 3; dy++) {
        const y = Math.round(yc) + dy;
        const t = Math.max(0, 1 - Math.abs(y - yc) / (width + 1));
        if (t <= 0) continue;
        const i = (((y % H) + H) % H) * W + x;
        height[i] -= t * 0.3;
        slit[i] = Math.max(slit[i], t * 0.6);
      }
    }
  }

  // --- encode ---------------------------------------------------------------
  const albedo = new Uint8Array(W * H * 4);
  const normalMap = new Uint8Array(W * H * 4);
  const rough = new Uint8Array(W * H * 4);

  // palette in sRGB 0..1 (the albedo texture is tagged sRGB, so mix in sRGB)
  const srgb = (hex) => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
  const base = srgb(0x86695e);
  const dark = srgb(0x5c4640);
  const cork = srgb(0xc9b29a);
  const slitCol = srgb(0x2e211c);
  const c = [0, 0, 0];
  const mix = (out, a, b, t) => {
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
  };
  const strength = 8;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const h = height[i];
      const xl = y * W + ((x - 1 + W) % W);
      const xr = y * W + ((x + 1) % W);
      const yu = ((y - 1 + H) % H) * W + x;
      const yd = ((y + 1) % H) * W + x;

      mix(c, dark, base, Math.min(1, Math.max(0, h * 1.4)));
      mix(c, c, cork, lent[i] * 0.85);
      mix(c, c, slitCol, slit[i]);
      albedo[i * 4] = Math.round(c[0] * 255);
      albedo[i * 4 + 1] = Math.round(c[1] * 255);
      albedo[i * 4 + 2] = Math.round(c[2] * 255);
      albedo[i * 4 + 3] = 255;

      // normal from height (tangent space: +x = u, +y = v)
      let nx = -(height[xr] - height[xl]) * 0.5 * strength;
      let ny = -(height[yd] - height[yu]) * 0.5 * strength;
      let nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      nz /= len;
      normalMap[i * 4] = Math.round((nx * 0.5 + 0.5) * 255);
      normalMap[i * 4 + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      normalMap[i * 4 + 2] = Math.round((nz * 0.5 + 0.5) * 255);
      normalMap[i * 4 + 3] = 255;

      // roughness in G (three's convention): smooth glossy bark, rough cork & cracks
      const r = 0.5 + (0.5 - h) * 0.12 + lent[i] * 0.32 + slit[i] * 0.25;
      rough[i * 4 + 1] = Math.round(Math.min(1, Math.max(0.3, r)) * 255);
      rough[i * 4 + 3] = 255;
    }
  }

  const make = (data, colorSpace) => {
    const t = new DataTexture(data, W, H, RGBAFormat, UnsignedByteType);
    t.wrapS = t.wrapT = RepeatWrapping;
    t.minFilter = LinearMipmapLinearFilter;
    t.magFilter = LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = anisotropy;
    t.colorSpace = colorSpace;
    t.needsUpdate = true;
    return t;
  };

  return {
    map: make(albedo, SRGBColorSpace),
    normalMap: make(normalMap, NoColorSpace),
    roughnessMap: make(rough, NoColorSpace),
  };
}
