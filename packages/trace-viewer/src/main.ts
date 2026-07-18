import './themeTokens.css';
import './shell.css';

import '@shared/wa';

// Registers <progress-app> (and transitively <stream-conversation>,
// <stream-tabs>, etc.) as custom elements via side effect. Per PRD
// docs/prds/2026-05-08-electron-shell-layout.md §7.C, we deliberately never
// create a <progress-app> element — the same pattern packages/desktop/src/
// renderer/main.ts already uses to run these components outside VS Code.
import '@progressView/frontend';
import type { ArchivableElement } from '@progressView/frontend/contexts/streamContexts';
import {
  handleFileAction,
  handlePermissionAction,
  handleToolbarCommand,
} from '@progressView/frontend/eventHandlers';

import { replayTrace } from './replayTrace';
import { parseTraceData } from './traceDataSchema';
import type { TraceDocument } from '@transcript';

const root = document.querySelector<HTMLElement>('#app');
if (root == null) throw new Error('Trace viewer root (#app) not found.');

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
  const inline = (window as { __TEXRA_TRACE__?: unknown }).__TEXRA_TRACE__;
  if (inline) return parseTraceData(inline);

  const params = new URLSearchParams(window.location.search);
  const file = params.get('trace') ?? 'trace.json';
  const res = await fetch(file);
  if (!res.ok) throw new Error(`Failed to fetch ${file}: ${res.status}`);
  return parseTraceData(await res.json());
}

loadTrace()
  .then((trace) => replayTrace(trace))
  .catch((err) => {
    console.error('[trace-viewer] failed to load/replay trace', err);
  });
