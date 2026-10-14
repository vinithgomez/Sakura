import { SEASONS, SEKKI } from './seasons.js';
import { TIMES } from './lighting.js';

// ---------------------------------------------------------------------------
// Minimal DOM UI in a washi-paper / sumi-ink idiom. It only talks to the
// public APIs of `seasons` and `lighting`, and only touches the DOM when a
// displayed value actually changes.
// ---------------------------------------------------------------------------

const ICONS = {
  photo: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 5.5 7 7.5H4.5A1.5 1.5 0 0 0 3 9v9a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 18V9a1.5 1.5 0 0 0-1.5-1.5H17l-1.5-2z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><circle cx="12" cy="13.2" r="3.6" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l10-6.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7.5 5.5h3v13h-3zM13.5 5.5h3v13h-3z" fill="currentColor"/></svg>',
  day: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="currentColor"/><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/></g></svg>',
  dusk: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 15.5a5.5 5.5 0 0 1 11 0z" fill="currentColor"/><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 18.5h18M6 21h12M12 5v2.2M5.2 8.6l1.5 1.5M18.8 8.6l-1.5 1.5"/></g></svg>',
  night: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15.5 3.8a8.5 8.5 0 1 0 4.7 13.9A7 7 0 0 1 15.5 3.8z" fill="currentColor"/></svg>',
};

export class UI {
  constructor(root, { seasons, lighting, controls, quality }) {
    this.root = root;
    this.seasons = seasons;
    this.lighting = lighting;
    this.controls = controls;
    this.quality = quality;
    this._last = { thumb: -1, season: -1, sekki: -1, autoplay: null, time: -1, fps: '' };
    this._dragging = false;
    this._userOrbitUntil = 0;

    root.innerHTML = this._template();
    this.el = {
      thumb: root.querySelector('.thumb'),
      thumbKanji: root.querySelector('.thumb span'),
      fill: root.querySelector('.track-fill'),
      timeline: root.querySelector('.timeline'),
      seasonMark: root.querySelector('.season-mark'),
      seasonKanji: root.querySelector('.season-kanji'),
      seasonRomaji: root.querySelector('.season-romaji'),
      seasonEnglish: root.querySelector('.season-english'),
      sekki: root.querySelector('.sekki'),
      sekkiKanji: root.querySelector('.sekki-kanji'),
      sekkiRomaji: root.querySelector('.sekki-romaji'),
      sekkiMeaning: root.querySelector('.sekki-meaning'),
      play: root.querySelector('.btn-play'),
      time: root.querySelector('.btn-time'),
      photo: root.querySelector('.btn-photo'),
      labels: [...root.querySelectorAll('.season-label')],
      hint: root.querySelector('.hint'),
      fps: root.querySelector('.fps'),
    };
    this._bind();
    this._syncTime();
    this._syncPlay();
  }

  _template() {
    const ticks = Array.from({ length: 24 }, (_, i) => `<i class="${i % 6 === 0 ? 'major' : ''}" style="left:${(i / 24) * 100}%"></i>`).join('');
    const labels = SEASONS.map(
      (s, i) => `<button class="season-label" data-season="${i}" style="left:${(i * 25 + 12.5).toFixed(1)}%" aria-label="Go to ${s.name}">
          <span class="k">${s.kanji}</span><span class="e">${s.name}</span>
        </button>`,
    ).join('');
    return `
      <header class="brand">
        <div class="brand-kanji" aria-hidden="true">桜</div>
        <div class="brand-text">
          <h1>Sakura</h1>
          <p>a year of life</p>
        </div>
      </header>

      <aside class="season-mark" aria-live="polite">
        <div class="season-kanji">春</div>
        <div class="season-name"><span class="season-romaji">Haru</span><span class="season-english">Spring</span></div>
      </aside>

      <div class="mist-band" aria-hidden="true"></div>
      <footer class="dock">
        <div class="sekki" title="The 24 sekki — traditional Japanese solar terms">
          <span class="sekki-kanji">清明</span>
          <span class="sekki-romaji">Seimei</span>
          <span class="sekki-meaning">Pure and clear</span>
        </div>
        <div class="dock-row">
          <button class="btn btn-play" aria-pressed="false" title="Play the year (Space)"></button>
          <div class="timeline-wrap">
            <div class="timeline" role="slider" tabindex="0" aria-label="Time of year"
                 aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
              <div class="track"><div class="track-fill"></div></div>
              <div class="ticks">${ticks}</div>
              <div class="thumb"><span>春</span></div>
            </div>
            <div class="season-labels">${labels}</div>
          </div>
          <button class="btn btn-time" title="Time of day (N)"></button>
          <button class="btn btn-icon btn-photo" title="Photo mode: hide everything for a clean shot (P)" aria-label="Photo mode">${ICONS.photo}</button>
        </div>
      </footer>

      <aside class="hint" role="note" aria-label="Controls">
        <h2><span lang="ja">操作</span> Controls</h2>
        <dl>
          <dt>drag</dt><dd>orbit the island</dd>
          <dt>scroll · pinch</dt><dd>zoom</dd>
          <dt>timeline</dt><dd>scrub the year · <b>space</b> plays it</dd>
          <dt>quality</dt><dd><span class="hint-quality">auto</span> · <code>?quality=low|high|cinematic</code></dd>
          <dt>P</dt><dd>photo mode</dd>
        </dl>
      </aside>
      <div class="fps" hidden></div>
    `;
  }

  _bind() {
    const { timeline, play, time, labels } = this.el;

    const fromPointer = (e) => {
      const r = timeline.getBoundingClientRect();
      return Math.min(Math.max((e.clientX - r.left) / r.width, 0), 0.9999);
    };
    timeline.addEventListener('pointerdown', (e) => {
      this._dragging = true;
      timeline.setPointerCapture(e.pointerId);
      timeline.classList.add('dragging');
      if (this.seasons.autoplay) this.seasons.setAutoplay(false);
      this.seasons.setTarget(fromPointer(e));
      this._dismissHint();
    });
    timeline.addEventListener('pointermove', (e) => {
      if (this._dragging) this.seasons.setTarget(fromPointer(e));
    });
    const end = () => {
      this._dragging = false;
      timeline.classList.remove('dragging');
    };
    timeline.addEventListener('pointerup', end);
    timeline.addEventListener('pointercancel', end);

    timeline.addEventListener('keydown', (e) => {
      const y = this.seasons.target - Math.floor(this.seasons.year);
      const step = 1 / 24;
      let v = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') v = y + step;
      if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') v = y - step;
      if (e.key === 'Home') v = 0;
      if (e.key === 'End') v = 0.9999;
      if (v !== null) {
        e.preventDefault();
        e.stopPropagation();
        this.seasons.setTarget(Math.min(Math.max(v, 0), 0.9999));
      }
    });

    labels.forEach((b) =>
      b.addEventListener('click', () => {
        this.seasons.goToSeason(Number(b.dataset.season));
        this._dismissHint();
      }),
    );
    play.addEventListener('click', () => {
      this.seasons.toggleAutoplay();
      this._dismissHint();
    });
    time.addEventListener('click', () => {
      this.lighting.cycleTime();
      this._dismissHint();
    });

    // photo mode: everything hidden; a small exit chip shows only while the pointer moves
    this.photoExit = document.createElement('button');
    this.photoExit.className = 'photo-exit';
    this.photoExit.innerHTML = `${ICONS.photo}<span>Exit photo mode</span>`;
    this.photoExit.setAttribute('aria-label', 'Exit photo mode (Esc)');
    document.body.appendChild(this.photoExit);
    this.el.photo.addEventListener('click', () => this.setPhotoMode(true));
    this.photoExit.addEventListener('click', () => this.setPhotoMode(false));
    let chipTimer = 0;
    addEventListener('pointermove', () => {
      if (!document.body.classList.contains('photo-mode')) return;
      this.photoExit.classList.add('show');
      clearTimeout(chipTimer);
      chipTimer = setTimeout(() => this.photoExit.classList.remove('show'), 1500);
    });

    this.seasons.onChange(() => this._syncPlay());
    this.lighting.onChange(() => this._syncTime());

    // Let the camera drift slowly while the year plays — until the user grabs it.
    this.controls.addEventListener('start', () => {
      this._userOrbitUntil = performance.now() + 8000;
    });

    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea')) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case ' ':
          if (e.target instanceof HTMLButtonElement) return; // let buttons handle Space themselves
          e.preventDefault();
          this.seasons.toggleAutoplay();
          break;
        case 'n':
        case 'N':
          this.lighting.cycleTime();
          break;
        case 'ArrowRight':
          this.seasons.step(1);
          break;
        case 'ArrowLeft':
          this.seasons.step(-1);
          break;
        case 'h':
        case 'H':
          document.body.classList.toggle('ui-hidden');
          break;
        case 'p':
        case 'P':
          this.setPhotoMode(!document.body.classList.contains('photo-mode'));
          break;
        case 'Escape':
          if (!document.body.classList.contains('photo-mode')) return;
          this.setPhotoMode(false);
          break;
        case 'f':
        case 'F':
          this.el.fps.hidden = !this.el.fps.hidden;
          break;
        default:
          return;
      }
      this._dismissHint();
    });
  }

  /** Show the controls card once the scene is up; it fades on its own after a few seconds. */
  showHint() {
    const q = this.quality;
    this.el.hint.querySelector('.hint-quality').textContent = `${q.settings.name}${q.locked ? '' : ' (auto)'}`;
    this.el.hint.classList.add('show');
    clearTimeout(this._hintTimer);
    this._hintTimer = setTimeout(() => this._dismissHint(), 7000);
  }

  /** Hide every piece of UI for clean screenshots (P / the camera button; Esc or the chip to leave). */
  setPhotoMode(on) {
    document.body.classList.toggle('photo-mode', on);
    this.photoExit.classList.remove('show');
    if (!on) this.el.photo.focus({ preventScroll: true });
    this._dismissHint();
  }

  _dismissHint() {
    this.el.hint.classList.add('gone');
  }

  _syncPlay() {
    const on = this.seasons.autoplay;
    if (this._last.autoplay === on) return;
    this._last.autoplay = on;
    this.el.play.innerHTML = `${on ? ICONS.pause : ICONS.play}<span>${on ? 'Pause' : 'Play'}</span>`;
    this.el.play.setAttribute('aria-pressed', String(on));
    this.el.play.setAttribute('aria-label', on ? 'Pause the year' : 'Play the year');
  }

  _syncTime() {
    const i = this.lighting.timeIndex;
    if (this._last.time === i) return;
    this._last.time = i;
    const t = TIMES[i];
    this.el.time.innerHTML = `${ICONS[t.key]}<span><em>${t.kanji}</em>${t.name}</span>`;
    this.el.time.setAttribute('aria-label', `Time of day: ${t.name}. Change`);
    document.body.dataset.time = t.key;
  }

  update(state) {
    const el = this.el;

    // autoplay → slow cinematic orbit unless the user is steering
    this.controls.autoRotate = this.seasons.autoplay && performance.now() > this._userOrbitUntil;

    const y = state.year;
    if (Math.abs(y - this._last.thumb) > 0.0004) {
      this._last.thumb = y;
      el.thumb.style.left = `${y * 100}%`;
      el.fill.style.transform = `scaleX(${y})`;
      el.timeline.setAttribute('aria-valuenow', String(Math.round(y * 100)));
      el.timeline.setAttribute('aria-valuetext', `${state.season.name}, ${state.sekki.romaji}`);
    }

    if (state.seasonIndex !== this._last.season) {
      this._last.season = state.seasonIndex;
      const s = state.season;
      el.thumbKanji.textContent = s.kanji;
      el.seasonMark.classList.remove('swap');
      void el.seasonMark.offsetWidth; // restart the ink-in animation
      el.seasonMark.classList.add('swap');
      el.seasonKanji.textContent = s.kanji;
      el.seasonRomaji.textContent = s.romaji;
      el.seasonEnglish.textContent = s.name;
      el.labels.forEach((b, i) => b.classList.toggle('active', i === state.seasonIndex));
      document.body.dataset.season = s.key;
    }

    if (state.sekkiIndex !== this._last.sekki) {
      this._last.sekki = state.sekkiIndex;
      const k = SEKKI[state.sekkiIndex];
      el.sekkiKanji.textContent = k.kanji;
      el.sekkiRomaji.textContent = k.romaji;
      el.sekkiMeaning.textContent = k.meaning;
    }

    if (!el.fps.hidden) {
      const q = this.quality.settings;
      const text = `${Math.round(this.quality.fps)} fps · ${q.name} · ${q.pixelRatio.toFixed(2)}× · ${q.samples ? `msaa ${q.samples}×` : 'smaa'}`;
      if (text !== this._last.fps) el.fps.textContent = this._last.fps = text;
    }
  }
}
