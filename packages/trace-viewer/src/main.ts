import './themeTokens.css';
import './shell.css';

// The page-local host installs at module evaluation, before the progress
// bundle resolves its bridge; the bundle then mounts on the
// `<progress-app data-session>` the HTML carries, as in every host.
import { toErrorMessage } from '@utils/errors/errorMessage';

import { trace } from './traceHostBridge';
import '@progressView/frontend';
import { traceDisplayName } from './traceFrames';

/**
 * Last-resort error surface for a trace that fails to load or parse. A
 * static export opened from file:// has no devtools audience, so the
 * console.error alone would leave a permanently blank page with no recovery
 * hint: render the underlying schema or fetch message in the shell's place.
 */
function renderLoadError(err: unknown): void {
  const errorRegion = document.createElement('div');
  errorRegion.className = 'trace-viewer-error';
  errorRegion.setAttribute('role', 'alert');
  const heading = document.createElement('h1');
  heading.textContent = 'Unable to load trace';
  const detail = document.createElement('p');
  detail.textContent = toErrorMessage(err);
  errorRegion.append(heading, detail);
  document.querySelector('progress-app')?.replaceWith(errorRegion);
}

trace.then(
  (loaded) => {
    // The title carries the run's identity once known, so browser tabs can
    // tell exported traces apart.
    document.title = `Trace: ${traceDisplayName(loaded)}`;
  },
  (err: unknown) => {
    console.error('[trace-viewer] failed to load trace', err);
    renderLoadError(err);
  },
);
