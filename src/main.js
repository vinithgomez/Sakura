import './styles.css';
import { loader, hasWebGL2, NO_WEBGL_DETAIL } from './systems/loader.js';

// ---------------------------------------------------------------------------
// Entry point, kept tiny so the loading veil and the WebGL check work before
// three.js (the big chunk) has even downloaded. app.js builds the world and
// reports its own progress through the same loader.
// ---------------------------------------------------------------------------

if (!hasWebGL2()) {
  loader.fail('WebGL 2 isn’t available', NO_WEBGL_DETAIL);
} else {
  loader.step('loading…', 0.06);
  import('./app.js').catch((err) => {
    console.error(err);
    const noContext = /webgl|context/i.test(String(err?.message));
    loader.fail(
      noContext ? 'The graphics card couldn’t be reached' : 'Something went wrong while planting the seed',
      noContext
        ? NO_WEBGL_DETAIL
        : 'Reloading the page usually helps. If it keeps happening, the browser console has the details.',
    );
  });
}
