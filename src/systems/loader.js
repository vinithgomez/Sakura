// ---------------------------------------------------------------------------
// The loading veil: a thin progress line under the 桜 mark, a status line,
// and — when the scene can't run — a calm failure message in its place.
// Lives in the small entry chunk, so it works before three.js has loaded.
// ---------------------------------------------------------------------------

/** True when the browser can create a WebGL 2 context (three.js r163+ needs it). */
export function hasWebGL2() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    gl?.getExtension('WEBGL_lose_context')?.loseContext(); // give the probe context back
    return Boolean(gl);
  } catch {
    return false;
  }
}

// Resolve after the browser has had a chance to paint the veil (rAF → task),
// with a timeout so a background tab, where rAF is paused, never stalls.
const nextPaint = () =>
  new Promise((resolve) => {
    requestAnimationFrame(() => setTimeout(resolve, 0));
    setTimeout(resolve, 120);
  });

export class Loader {
  constructor(veil) {
    this.veil = veil;
    this.text = veil.querySelector('.veil-text');
    this.bar = veil.querySelector('.veil-bar');
    this.progress = 0;
  }

  /** Report a step (`p` in 0–1) and yield so it's painted before the next heavy step. */
  step(label, p) {
    this.progress = Math.max(this.progress, p);
    this.text.textContent = label;
    this.bar.style.setProperty('--p', this.progress.toFixed(3));
    this.bar.setAttribute('aria-valuenow', String(Math.round(this.progress * 100)));
    return nextPaint();
  }

  done() {
    this.veil.classList.add('hidden');
  }

  /** Replace the veil's contents with a message. `detail` may contain trusted HTML. */
  fail(title, detail) {
    this.veil.classList.remove('hidden');
    this.veil.classList.add('failed');
    this.veil.setAttribute('role', 'alert');
    this.veil.innerHTML = `
      <div class="veil-mark" aria-hidden="true">桜</div>
      <h1 class="veil-title"></h1>
      <p class="veil-detail">${detail}</p>`;
    this.veil.querySelector('.veil-title').textContent = title;
  }
}

/** The one loader, shared by main.js (entry) and app.js (world building). */
export const loader = new Loader(document.getElementById('veil'));

export const NO_WEBGL_DETAIL = `This little island is drawn live with WebGL&nbsp;2, which this browser
  doesn't have available right now. Try a current Chrome, Edge, Firefox or Safari,
  and check that hardware acceleration (graphics acceleration) is switched on in
  the browser's settings.`;
