// ---------------------------------------------------------------------------
// Dev check: does the canopy flicker?
//
// Renders consecutive frames and compares them per pixel, restricted to the
// canopy (pixels that change when the blossom / leaf sprites are hidden).
// Reports, per run:
//   meanDiff  — mean |Δluminance| between consecutive frames in the canopy;
//   spikeRate — share of canopy pixels per frame that jump by more than
//               `threshold` and jump straight back on the next frame
//               (A → B → A). Smooth sway, orbiting or season change move
//               edges monotonically; popping and depth fighting are spikes
//               (so is fine texture detail shimmering under motion);
//   popsPerFrame — 8×8 tiles where a quarter of the pixels spike in the
//               same frame: whole-spray blinks rather than edge shimmer.
// Film grain and the falling particles (petals, leaves, snow, fireflies) are
// switched off while measuring: both legitimately change pixels every frame.
// Loaded on demand: __sakura.measureFlicker(...).
// ---------------------------------------------------------------------------

function readLuma(gl, w, h, rgba, out) {
  gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) out[i] = (rgba[p] * 54 + rgba[p + 1] * 183 + rgba[p + 2] * 19) >> 8;
  return out;
}

/**
 * @param ctx { app: { frame }, tree, seasons, lighting, camera, controls, renderer, postfx }
 * @param run { mode: 'static'|'orbit'|'scrub', year, camera: {pos, target}, frames, orbitDegPerFrame, scrubPerFrame, threshold }
 */
export function measureFlicker(ctx, run) {
  const { app, tree, seasons, lighting, camera, controls, renderer, postfx } = ctx;
  const { mode = 'static', year = 0.17, frames = 60, orbitDegPerFrame = 0.15, scrubPerFrame = 0.0004, threshold = 26 } = run;
  const gl = renderer.getContext();
  const w = gl.drawingBufferWidth;
  const h = gl.drawingBufferHeight;
  const n = w * h;
  const rgba = new Uint8Array(n * 4);
  const lumaA = new Uint8Array(n);
  const lumaM = new Uint8Array(n);
  let prev2 = null;
  let prev1 = null;

  const grain = postfx.final.uniforms.uGrain.value;
  postfx.final.uniforms.uGrain.value = 0;
  const update = tree.update;
  let hideCanopy = false;
  tree.update = function (state) {
    update.call(this, state);
    if (hideCanopy) this.blossoms.visible = this.leaves.visible = false;
  };
  // falling petals / leaves / snow are real motion through the frame, not
  // canopy flicker: keep them out of the measurement
  const { particles } = ctx;
  const particlesUpdate = particles?.update;
  if (particles) {
    particles.update = function (state) {
      particlesUpdate.call(this, state);
      for (const k of ['petals', 'leaves', 'snow', 'fireflies']) if (this[k]) this[k].visible = false;
    };
  }

  seasons.autoplay = false;
  seasons.year = seasons.target = year;
  lighting.setTime(0);
  lighting.day = 1;
  controls.target.set(...run.camera.target);
  camera.position.set(...run.camera.pos);
  controls.update();
  for (let i = 0; i < 20; i++) app.frame(1 / 60); // settle (damping, shadows)

  const masks = [];
  let canopyPx = 0;
  let diffSum = 0;
  let diffCount = 0;
  let spikes = 0;
  let spikeCount = 0;
  let pops = 0;
  const tw = Math.ceil(w / 8);
  const tiles = new Uint16Array(tw * Math.ceil(h / 8));
  const offset = camera.position.clone().sub(controls.target);
  const step = (orbitDegPerFrame * Math.PI) / 180;

  for (let f = 0; f < frames; f++) {
    if (mode === 'orbit') {
      offset.applyAxisAngle({ x: 0, y: 1, z: 0 }, step);
      camera.position.copy(controls.target).add(offset);
    }
    if (mode === 'scrub') seasons.year = seasons.target = year + scrubPerFrame * f;

    // the frame as shown
    app.frame(1 / 60);
    const cur = readLuma(gl, w, h, rgba, new Uint8Array(n));
    // same instant without the canopy → mask
    hideCanopy = true;
    app.frame(0);
    readLuma(gl, w, h, rgba, lumaM);
    hideCanopy = false;
    const mask = new Uint8Array(n);
    // (a clear difference: hiding the canopy also nudges the bloom glow around
    // it, which must not pull the grass or sky nearby into the mask)
    for (let i = 0; i < n; i++) if (Math.abs(cur[i] - lumaM[i]) > 12) mask[i] = 1;
    masks.push(mask);
    if (masks.length > 3) masks.shift();

    if (prev1) {
      const m0 = masks[masks.length - 2];
      const m1 = masks[masks.length - 1];
      for (let i = 0; i < n; i++) {
        if (!(m0[i] || m1[i])) continue;
        diffSum += Math.abs(cur[i] - prev1[i]);
        diffCount++;
      }
    }
    if (prev2) {
      const ma = masks[0], mb = masks[1], mc = masks[2];
      tiles.fill(0);
      for (let i = 0; i < n; i++) {
        if (!(ma[i] || mb[i] || mc[i])) continue;
        spikeCount++;
        const d1 = prev1[i] - prev2[i];
        const d2 = cur[i] - prev1[i];
        if (Math.abs(d1) > threshold && Math.abs(d2) > threshold && Math.sign(d1) !== Math.sign(d2)) {
          spikes++;
          tiles[((i / w / 8) | 0) * tw + (((i % w) / 8) | 0)]++;
        }
      }
      // a spray-sized blink: a quarter of an 8×8 tile spiking in the same frame
      for (let t = 0; t < tiles.length; t++) if (tiles[t] >= 16) pops++;
    }
    canopyPx += mask.reduce((a, b) => a + b, 0);
    prev2 = prev1;
    prev1 = cur;
  }
  lumaA.fill(0);

  tree.update = update;
  if (particles) particles.update = particlesUpdate;
  postfx.final.uniforms.uGrain.value = grain;
  app.frame(0);
  return {
    mode,
    year,
    frames,
    canopyShare: +(canopyPx / (frames * n)).toFixed(3),
    meanDiff: +(diffSum / Math.max(1, diffCount)).toFixed(3),
    spikeRate: +((spikes / Math.max(1, spikeCount)) * 1e3).toFixed(3), // per 1,000 canopy pixels per frame
    spikes,
    popsPerFrame: +(pops / Math.max(1, frames - 2)).toFixed(2), // spray-sized blinks
  };
}
