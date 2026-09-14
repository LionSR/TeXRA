import './themeTokens.css';
import './shell.css';

// The page-local host installs at module evaluation, before the progress
// bundle resolves its bridge; the shell then mounts on the
// `<progress-app data-session>` the HTML carries, as in every host. This
// page owns the mount (rather than the bundle's entry) because the scrubber
// remounts it: a fresh shell is a fresh generation, and the bridge answers
// that generation at the new cut.
import '@shared/wa';
import 'katex/dist/katex.min.css';
import '@progressView/frontend/ProgressApp';
import { mountProgressWebview } from '@progressView/frontend/progressWebview';
import type { ProgressApp } from '@progressView/frontend/ProgressApp';
import {
  flowPosition,
  formatFlowPositionLabel,
} from '@shared/runs/runStatusDisplay';
import type { TraceDocument } from '@transcript';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { setTraceCut, trace } from './traceHostBridge';
import { traceDisplayName, traceSteps, type TraceStep } from './traceFrames';

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

/** One step's position, as the slider's readout spells it: the single
 *  coordinate the step's family counts in, in the wording every run surface
 *  prints. A row carries all three coordinates, the ones its family never
 *  advances included, so reading them all would label a tool-use turn with
 *  the round and cycle it never left. */
function stepLabel(step: TraceStep): string {
  const where = formatFlowPositionLabel(flowPosition(step.payload));
  return `${step.payload.family} ${step.payload.step}${where ? ` (${where})` : ''}`;
}

/**
 * The scrubber over the run's `flow.step` rows: a position slider whose
 * change remounts the shell, so the folded view is read at that step. The
 * last position is the whole document, which is what a fresh page shows.
 */
function installScrubber(loaded: TraceDocument, remount: () => void): void {
  const scrubber = document.querySelector<HTMLElement>('.trace-scrubber');
  const slider = scrubber?.querySelector<HTMLInputElement>('input[type=range]');
  const readout = scrubber?.querySelector<HTMLOutputElement>('output');
  if (!scrubber || !slider || !readout) {
    throw new Error('The trace viewer HTML carries no scrubber');
  }
  const steps = traceSteps(loaded);
  const last = steps.length - 1;
  if (last < 0) return;
  const show = (index: number): void => {
    const step = steps[index];
    if (!step) return;
    readout.textContent = `Step ${index + 1} of ${last + 1}: ${stepLabel(step)}`;
  };
  slider.max = String(last);
  slider.value = String(last);
  show(last);
  slider.addEventListener('input', () => show(Number(slider.value)));
  slider.addEventListener('change', () => {
    const index = Number(slider.value);
    setTraceCut(index === last ? null : index);
    remount();
  });
  scrubber.hidden = false;
}

const app = document.querySelector<ProgressApp>('progress-app');
if (!app) throw new Error('The trace viewer HTML carries no <progress-app>');
let mounted = { app, unmount: mountProgressWebview(app) };

/** Replace the shell with a fresh one: a new graph, generation, and fold. */
function remount(): void {
  mounted.unmount();
  const fresh = mounted.app.cloneNode(false) as ProgressApp;
  mounted.app.replaceWith(fresh);
  mounted = { app: fresh, unmount: mountProgressWebview(fresh) };
}

trace.then(
  (loaded) => {
    // The title carries the run's identity once known, so browser tabs can
    // tell exported traces apart.
    document.title = `Trace: ${traceDisplayName(loaded)}`;
    installScrubber(loaded, remount);
  },
  (err: unknown) => {
    console.error('[trace-viewer] failed to load trace', err);
    renderLoadError(err);
  },
);
