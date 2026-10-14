import { CanvasTexture, SRGBColorSpace, LinearMipmapLinearFilter, LinearFilter } from 'three';
import { Rng } from '../core/random.js';

// Everything is painted at startup on 2D canvases — no image assets to load.

const CELL = 256;

/**
 * 2×2 atlas used by the canvas sprites:
 *   [0] buds           [1] blossoms A
 *   [2] leaves         [3] blossoms B
 * Painted light/neutral so the shader can tint them per season.
 */
export function createFoliageAtlas() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = CELL * 2;
  const ctx = canvas.getContext('2d');
  const rng = new Rng(2024);

  paintCell(ctx, 0, 0, () => paintBuds(ctx, rng));
  paintCell(ctx, 1, 0, () => paintBlossoms(ctx, rng, 5));
  paintCell(ctx, 0, 1, () => paintLeaves(ctx, rng));
  paintCell(ctx, 1, 1, () => paintBlossoms(ctx, rng, 4));

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearMipmapLinearFilter;
  tex.magFilter = LinearFilter;
  tex.anisotropy = 2;
  tex.flipY = false; // atlas cell (0,0) = top-left; uv math in the shader matches
  return tex;
}

function paintCell(ctx, cx, cy, fn) {
  ctx.save();
  ctx.translate(cx * CELL + CELL / 2, cy * CELL + CELL / 2);
  fn();
  ctx.restore();
}

// --- blossoms ---------------------------------------------------------------

function petalPath(ctx, len, wid) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(wid * 0.95, -len * 0.22, wid * 1.08, -len * 0.78, wid * 0.36, -len);
  ctx.lineTo(0, -len * 0.84); // the notch that makes it a cherry petal
  ctx.lineTo(-wid * 0.36, -len);
  ctx.bezierCurveTo(-wid * 1.08, -len * 0.78, -wid * 0.95, -len * 0.22, 0, 0);
  ctx.closePath();
}

function paintFlower(ctx, x, y, r, rot, rng) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);

  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
  g.addColorStop(0, '#e98fac');
  g.addColorStop(0.3, '#f7c9d7');
  g.addColorStop(0.75, '#fff2f6');
  g.addColorStop(1, '#ffffff');

  for (let i = 0; i < 5; i++) {
    ctx.save();
    ctx.rotate((i / 5) * Math.PI * 2 + rng.spread(0.08));
    petalPath(ctx, r * rng.float(0.92, 1.05), r * 0.5);
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(214, 120, 150, 0.45)';
    ctx.lineWidth = 1.1;
    ctx.stroke();
    ctx.restore();
  }

  // stamens
  ctx.lineWidth = 1;
  for (let i = 0; i < 12; i++) {
    const a = rng.float(0, Math.PI * 2);
    const l = r * rng.float(0.25, 0.42);
    ctx.strokeStyle = 'rgba(190, 70, 105, 0.8)';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(Math.cos(a) * l, Math.sin(a) * l);
    ctx.stroke();
    ctx.fillStyle = '#e9b25e';
    ctx.beginPath();
    ctx.arc(Math.cos(a) * l, Math.sin(a) * l, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#c94d74';
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function paintBlossoms(ctx, rng, count) {
  const spots = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rng.spread(0.4);
    const d = i === 0 ? 0 : rng.float(42, 66);
    spots.push([Math.cos(a) * d, Math.sin(a) * d, rng.float(36, 46)]);
  }
  // paint back-to-front by size so the centre flower sits on top
  spots.sort((a, b) => a[2] - b[2]);
  for (const [x, y, r] of spots) paintFlower(ctx, x, y, r, rng.float(0, 6.28), rng);
}

// --- buds -------------------------------------------------------------------

function paintBuds(ctx, rng) {
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + rng.spread(0.3);
    const d = rng.float(30, 72);
    const x = Math.cos(a) * d;
    const y = Math.sin(a) * d;

    ctx.strokeStyle = '#6a4636';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.quadraticCurveTo(x * 0.5 + rng.spread(10), y * 0.5 + rng.spread(10), x, y);
    ctx.stroke();

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(a + Math.PI / 2);
    const g = ctx.createLinearGradient(0, 12, 0, -24);
    g.addColorStop(0, '#b8325c');
    g.addColorStop(0.6, '#ea7c9f');
    g.addColorStop(1, '#ffd0de');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(0, -8, rng.float(9, 12), rng.float(15, 19), 0, 0, Math.PI * 2);
    ctx.fill();
    // sepals
    ctx.fillStyle = '#7a4a3c';
    for (const s of [-1, 1]) {
      ctx.beginPath();
      ctx.moveTo(0, 8);
      ctx.lineTo(s * 9, -2);
      ctx.lineTo(s * 2, 2);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
}

// --- leaves -----------------------------------------------------------------

function paintLeaf(ctx, len, wid, shade) {
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.bezierCurveTo(wid, -len * 0.2, wid * 0.95, -len * 0.75, 0, -len);
  ctx.bezierCurveTo(-wid * 0.95, -len * 0.75, -wid, -len * 0.2, 0, 0);
  ctx.closePath();
  const g = ctx.createLinearGradient(-wid, 0, wid, 0);
  g.addColorStop(0, `rgb(${200 * shade}, ${214 * shade}, ${190 * shade})`);
  g.addColorStop(0.5, `rgb(${238 * shade}, ${245 * shade}, ${230 * shade})`);
  g.addColorStop(1, `rgb(${210 * shade}, ${222 * shade}, ${198 * shade})`);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(80, 100, 70, 0.55)';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  // midrib + veins
  ctx.strokeStyle = 'rgba(120, 140, 105, 0.7)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -len * 0.95);
  ctx.stroke();
  ctx.lineWidth = 0.9;
  for (let i = 1; i < 7; i++) {
    const y = -len * (i / 8);
    const w = wid * 0.75 * Math.sin((i / 8) * Math.PI);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y - len * 0.08);
    ctx.moveTo(0, y);
    ctx.lineTo(-w, y - len * 0.08);
    ctx.stroke();
  }
}

function paintLeaves(ctx, rng) {
  const n = 5;
  for (let i = 0; i < n; i++) {
    ctx.save();
    ctx.rotate((i / n) * Math.PI * 2 + rng.spread(0.35));
    ctx.translate(0, -6);
    paintLeaf(ctx, rng.float(84, 108), rng.float(28, 34), rng.float(0.82, 1));
    ctx.restore();
  }
}

// --- clouds -----------------------------------------------------------------

export function createCloudTexture() {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  const rng = new Rng(77);

  for (let i = 0; i < 22; i++) {
    const x = size / 2 + rng.spread(78);
    const y = size * 0.56 + rng.spread(22) - Math.max(0, 50 - Math.abs(x - size / 2)) * 0.5;
    const r = rng.float(26, 52);
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, 'rgba(255,255,255,0.55)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.3)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  // Shade: bright tops, cooler undersides (RGB is used as a light factor)
  ctx.globalCompositeOperation = 'source-atop';
  const shade = ctx.createLinearGradient(0, size * 0.25, 0, size * 0.8);
  shade.addColorStop(0, '#ffffff');
  shade.addColorStop(1, '#8f97a6');
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, size, size);

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}
