import './themeTokens.css';
import './shell.css';

import '@shared/wa';

// Registers <progress-app> (and transitively <stream-conversation>,
// <stream-tabs>, etc.) as custom elements via side effect. Per PRD
// docs/prds/2026-05-08-electron-shell-layout.md §7.C, we deliberately never
// create a <progress-app> element — the same pattern packages/desktop/src/
// renderer/main.ts already uses to run these components outside VS Code.
import '@progressView/frontend';
import {
  handleFileAction,
  handlePermissionAction,
  handleToolbarCommand,
} from '@progressView/frontend/eventHandlers';
import type { FrontendEventHandlerContext } from '@progressView/frontend/messageHandlerTypes';
import {
  appState,
  permissions$,
  placement,
  setStreamLogsForId,
  setStreamStateForId,
} from '@progressView/frontend/progressState';

import { replayTrace, type ReplayableTrace } from './replayTrace';

const root = document.querySelector<HTMLElement>('#app');
if (root == null) throw new Error('Trace viewer root (#app) not found.');

const conversationView = document.createElement(
  'stream-conversation',
) as HTMLElement & {
  archived: boolean;
};
conversationView.archived = true;
root.append(conversationView);

function getEventHandlerContext(): FrontendEventHandlerContext {
  return {
    getState: () => appState.get(),
    setState: (updater) => appState.set(updater(appState.get())),
    setStreamState: (streamId, updater) =>
      setStreamStateForId(streamId, updater),
    setStreamLogs: (streamId, updater) => setStreamLogsForId(streamId, updater),
  };
}

function getMessageHandlerContext() {
  return {
    ...getEventHandlerContext(),
    getPermissions: () => permissions$.get(),
    setPermissions: (next: ReturnType<typeof permissions$.get>) => {
      permissions$.set(next);
    },
    setPlacement: (next: ReturnType<typeof placement.get>) => {
      placement.set(next);
    },
  };
}

// Wired for defense-in-depth even though `archived` mode already makes
// `emitAction`/toolbar dispatches no-ops — nothing here reaches a live host.
conversationView.addEventListener('toolbar-command', ((e: CustomEvent) =>
  handleToolbarCommand(e, getEventHandlerContext())) as EventListener);
conversationView.addEventListener('permission-action', ((e: CustomEvent) =>
  handlePermissionAction(e, getMessageHandlerContext())) as EventListener);
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
 * traces that shouldn't duplicate the bundle per page). Both paths feed the
 * exact same `replayTrace`.
 */
async function loadTrace(): Promise<ReplayableTrace> {
  const inline = (window as { __TEXRA_TRACE__?: ReplayableTrace })
    .__TEXRA_TRACE__;
  if (inline) return inline;

  const params = new URLSearchParams(window.location.search);
  const file = params.get('trace') ?? 'trace.json';
  const res = await fetch(file);
  if (!res.ok) throw new Error(`Failed to fetch ${file}: ${res.status}`);
  return res.json();
}

loadTrace()
  .then((trace) => replayTrace(trace, getMessageHandlerContext()))
  .catch((err) => {
    console.error('[trace-viewer] failed to load/replay trace', err);
  });
