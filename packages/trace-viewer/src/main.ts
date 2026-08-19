import './themeTokens.css';
import './shell.css';

import '@shared/wa';

// Registers <progress-app> (and transitively <stream-conversation>,
// <stream-tabs>, etc.) as custom elements via side effect. Per PRD
// docs/prds/2026-05-08-electron-shell-layout.md §7.C, we deliberately never
// create a <progress-app> element — the same pattern packages/desktop/src/
// renderer/main.ts already uses to run these components outside VS Code.
import '@progressView/frontend';
import type { ArchivableElement } from '@progressView/frontend/streamContexts';
import {
  handleFileAction,
  handlePermissionAction,
  handleToolbarCommand,
} from '@progressView/frontend/eventHandlers';

import type { TraceDocument } from '@transcript';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { replayTrace, traceDisplayName } from './replayTrace';
import { parseTraceData } from './traceDataSchema';

const rootElement = document.querySelector<HTMLElement>('#app');
if (rootElement == null) {
  throw new Error('Trace viewer root (#app) not found.');
}
// Non-nullable alias for the hoisted function declarations below — TS drops
// the pre-guard narrowing at closure boundaries.
const root: HTMLElement = rootElement;

const conversationView = document.createElement(
  'stream-conversation',
) as ArchivableElement;
conversationView.archived = true;
root.append(conversationView);

// Wired for defense-in-depth even though `archived` mode already makes
// `emitAction`/toolbar dispatches no-ops — nothing here reaches a live host.
conversationView.addEventListener(
  'toolbar-command',
  handleToolbarCommand as EventListener,
);
conversationView.addEventListener(
  'permission-action',
  handlePermissionAction as EventListener,
);
conversationView.addEventListener(
  'file-action',
  handleFileAction as EventListener,
);

/**
 * Loads trace data two ways: inline (`window.__TEXRA_TRACE__`, set by the CLI
 * export so the page is a single self-contained file with no `fetch()` of a
 * sidecar JSON — `fetch()` of a local file fails entirely under `file://`,
 * regardless of bundling), or a fetched `trace.json` next to the page (the
 * default when served over http/https, e.g. a static site hosting many
 * traces that shouldn't duplicate the bundle per page). Both paths are
 * externally-authored (exported by whatever TeXRA version produced them), so
 * both get validated through the same `parseTraceData` boundary before
 * feeding the exact same `replayTrace` — a stale/malformed trace file throws
 * a clear error here instead of failing deep inside `dispatchMessage`.
 */
async function loadTrace(): Promise<TraceDocument> {
  const globalWindow = window as { __TEXRA_TRACE__?: unknown };
  const inline = globalWindow.__TEXRA_TRACE__;
  if (inline) {
    // Once consumed, drop the raw copy — nothing else reads this global, and
    // this is a single-page app with no further navigation, so otherwise the
    // whole raw trace document sits on `window` for the page's entire
    // lifetime alongside whatever the progress-view store now holds.
    delete globalWindow.__TEXRA_TRACE__;
    return parseTraceData(inline);
  }

  const params = new URLSearchParams(window.location.search);
  const file = params.get('trace') ?? 'trace.json';
  const res = await fetch(file);
  if (!res.ok) throw new Error(`Failed to fetch ${file}: ${res.status}`);
  return parseTraceData(await res.json());
}

/**
 * Last-resort error surface for a trace that fails to load or parse. A static
 * export opened from file:// has no devtools audience, so the console.error
 * alone would leave a permanently blank page with no recovery hint — render
 * the underlying schema/fetch message into #app instead.
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
  // Replace (not append) — the empty <stream-conversation> mounted above has
  // nothing to show without a successful replay.
  root.replaceChildren(errorRegion);
}

loadTrace()
  .then((trace) => {
    replayTrace(trace);
    // Landmark + title carry the run's identity once known, so AT users and
    // browser tabs can tell exported traces apart.
    const label = `Trace: ${traceDisplayName(trace)}`;
    root.setAttribute('aria-label', label);
    document.title = label;
  })
  .catch((err: unknown) => {
    console.error('[trace-viewer] failed to load/replay trace', err);
    renderLoadError(err);
  });
