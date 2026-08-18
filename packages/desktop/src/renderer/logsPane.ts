import '@awesome.me/webawesome/dist/components/details/details.js';
import { html, nothing, render, type TemplateResult } from 'lit';
import { repeat } from 'lit/directives/repeat.js';
import { postMessage } from '@shared/hostBridge';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { renderEmptyState } from '@shared/wa/emptyState';
import type { TeXRAIconName } from '@shared/wa/iconNames';
import { renderLoadingState } from '@shared/wa/loadingState';
import { waIcon } from '@shared/wa/webAwesomeIcons';
import { formatTimestamp, truncateSummary } from '@utils/text/stringUtils';
import { DESKTOP_LOCAL_COMMANDS } from '../shared/desktopCommandSurface';
import {
  DESKTOP_LOG_COMMANDS,
  type DesktopSetLogMessage,
} from '../shared/desktopLogMessages';

export type DesktopLogLevel =
  'debug' | 'error' | 'info' | 'log' | 'warn' | 'unknown';

export interface DesktopLogEntry {
  readonly id: string;
  readonly level: DesktopLogLevel;
  readonly message: string;
  readonly raw: string;
  readonly summary: string;
  readonly timestamp?: string;
  readonly timestampLabel: string;
}

interface LogViewerState {
  entries: readonly DesktopLogEntry[];
  status: 'loading' | 'ready';
  meta: string;
}

interface DesktopLogEntryDraft {
  readonly level: DesktopLogLevel;
  readonly messageLines: string[];
  readonly rawLines: string[];
  readonly timestamp?: string;
}

export interface LogsPaneOptions {
  readonly sendCommand?: (command: string) => void;
  readonly scheduleRefresh?: (
    callback: () => void,
    intervalMs: number,
  ) => number;
  readonly cancelRefresh?: (handle: number) => void;
  readonly refreshIntervalMs?: number;
}

export interface LogsPaneController {
  /**
   * Root element, hosted by the Logs tab. Previously this lived inside a
   * `wa-drawer`; logs are now a tab so they can stay open next to a running
   * stream instead of covering it.
   */
  readonly element: HTMLElement;
  applySnapshot(message: DesktopSetLogMessage): void;
  /** Starts or stops polling as the singleton Logs tab gains or loses focus. */
  setActive(active: boolean): void;
  /** Re-render the viewer template with the current state (used during recovery). */
  rerenderViewer(): void;
}

const LOG_LINE_PATTERN =
  /^(?<timestamp>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) \[(?<level>debug|error|info|log|warn)\](?: (?<message>.*))?$/u;
const LOG_SUMMARY_MAX_LENGTH = 180;
const LOG_AUTO_REFRESH_INTERVAL_MS = 5_000;
const LOG_LEVEL_PRESENTATION = {
  debug: { icon: 'code', label: 'Debug' },
  error: { icon: 'circle-xmark', label: 'Error' },
  info: { icon: 'circle-info', label: 'Info' },
  log: { icon: 'terminal', label: 'Log' },
  unknown: { icon: 'file-lines', label: 'Partial' },
  warn: { icon: 'triangle-exclamation', label: 'Warning' },
} as const satisfies Record<
  DesktopLogLevel,
  { readonly icon: TeXRAIconName; readonly label: string }
>;

/**
 * Splits the redacted desktop log excerpt at its timestamped entry boundaries.
 * Stack traces and other continuation lines remain attached to the entry that
 * emitted them. IDs derive from entry contents, so keyed details rows preserve
 * their expanded state across automatic refreshes.
 */
export function parseDesktopLogEntries(text: string): DesktopLogEntry[] {
  const drafts: DesktopLogEntryDraft[] = [];
  let current: DesktopLogEntryDraft | undefined;
  const lines = text
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .split('\n');
  if (lines.at(-1) === '') lines.pop();

  for (const line of lines) {
    const match = LOG_LINE_PATTERN.exec(line);
    const timestamp = match?.groups?.timestamp;
    const level = match?.groups?.level as DesktopLogLevel | undefined;
    if (timestamp && level) {
      if (current) drafts.push(current);
      const message = match?.groups?.message ?? '';
      current = {
        level,
        messageLines: [message],
        rawLines: [line],
        timestamp,
      };
      continue;
    }

    if (current) {
      current.messageLines.push(line);
      current.rawLines.push(line);
      continue;
    }

    if (line.trim().length > 0) {
      current = {
        level: 'unknown',
        messageLines: [line],
        rawLines: [line],
      };
    }
  }
  if (current) drafts.push(current);

  const duplicateIds = new Map<string, number>();
  return drafts.map((draft) => {
    const raw = draft.rawLines.join('\n');
    let hash = 2_166_136_261;
    // charCodeAt is intentional: the same UTF-16 log contents must keep the same
    // row key across refreshes, including content outside the basic plane.
    for (let index = 0; index < raw.length; index += 1) {
      hash = Math.imul(hash ^ raw.charCodeAt(index), 16_777_619);
    }
    const baseId = `desktop-log-${(hash >>> 0).toString(36)}`;
    const duplicateCount = duplicateIds.get(baseId) ?? 0;
    duplicateIds.set(baseId, duplicateCount + 1);

    const message = draft.messageLines.join('\n');
    return {
      id: duplicateCount === 0 ? baseId : `${baseId}-${duplicateCount + 1}`,
      level: draft.level,
      message,
      raw,
      summary:
        truncateSummary(message, LOG_SUMMARY_MAX_LENGTH) || '(no message)',
      ...(draft.timestamp ? { timestamp: draft.timestamp } : {}),
      timestampLabel: draft.timestamp
        ? formatTimestamp(draft.timestamp)
        : 'Partial entry',
    };
  });
}

export function createLogsPane(
  options: LogsPaneOptions = {},
): LogsPaneController {
  const container: HTMLElement = document.createElement('div');
  container.setAttribute('data-desktop-view', 'logs');
  container.className = 'desktop-log-host';

  const sendCommand =
    options.sendCommand ?? ((command: string) => postMessage(command));
  const scheduleRefresh =
    options.scheduleRefresh ??
    ((callback: () => void, intervalMs: number) =>
      window.setInterval(callback, intervalMs));
  const cancelRefresh =
    options.cancelRefresh ?? ((handle: number) => window.clearInterval(handle));
  const refreshIntervalMs =
    options.refreshIntervalMs ?? LOG_AUTO_REFRESH_INTERVAL_MS;

  let state: LogViewerState = {
    entries: [],
    status: 'loading',
    meta: 'Recent redacted log entries appear here.',
  };
  let active = false;
  let refreshHandle: number | undefined;

  function requestSnapshot(): void {
    sendCommand(DESKTOP_LOG_COMMANDS.REQUEST_LOG);
  }

  function entryTemplate(entry: DesktopLogEntry): TemplateResult {
    const presentation = LOG_LEVEL_PRESENTATION[entry.level];
    return html`
      <wa-details
        class="desktop-log-entry"
        appearance="plain"
        icon-placement="start"
        data-entry-id=${entry.id}
        data-level=${entry.level}
        role="listitem"
      >
        <div slot="summary" class="desktop-log-entry-summary">
          <span class="desktop-log-entry-level-icon" aria-hidden="true">
            ${waIcon(presentation.icon)}
          </span>
          <span class="desktop-log-entry-level">${presentation.label}</span>
          <time class="desktop-log-entry-time" datetime=${entry.timestamp ?? ''}
            >${entry.timestampLabel}</time
          >
          <span class="desktop-log-entry-preview">${entry.summary}</span>
        </div>
        <pre class="desktop-log-entry-content">${entry.raw}</pre>
      </wa-details>
    `;
  }

  // role="status" lives on this permanently mounted wrapper — not on a node
  // that's created fresh per state — because assistive tech only reliably
  // announces content changing inside an already-present live region, not a
  // brand-new node that arrives with its content already populated.
  function logStatusContent(): TemplateResult | typeof nothing {
    if (state.entries.length > 0) return nothing;
    if (state.status === 'loading') {
      return renderLoadingState('Loading recent entries…');
    }
    return renderEmptyState({
      icon: 'file-lines',
      title: 'No desktop log entries yet.',
      headingTag: 'h3',
      className: 'desktop-log-viewer-empty',
    });
  }

  function viewerTemplate(): TemplateResult {
    const action = (
      icon: TeXRAIconName,
      label: string,
      onClick: () => void,
    ): TemplateResult =>
      renderLabeledActionButton({
        icon,
        text: label,
        className: 'btn-secondary',
        appearance: 'outlined',
        onClick,
      });
    return html`
      <section class="desktop-log-viewer">
        <header class="desktop-log-viewer-header">
          <div>
            <h2>Desktop logs</h2>
            <p>${state.meta}</p>
          </div>
          <div class="desktop-log-viewer-actions">
            ${action('rotate-right', 'Refresh', requestSnapshot)}
            ${action('copy', 'Copy', () =>
              sendCommand(DESKTOP_LOG_COMMANDS.COPY_LOG),
            )}
            ${action('download', 'Export', () =>
              sendCommand(DESKTOP_LOG_COMMANDS.EXPORT_LOG),
            )}
            ${action('folder-open', 'Open Folder', () =>
              sendCommand(DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER),
            )}
          </div>
        </header>
        <div
          class="desktop-log-viewer-list"
          role="list"
          aria-label="Recent desktop log entries"
        >
          <div role="status">${logStatusContent()}</div>
          ${repeat(
            state.entries.toReversed(),
            (entry) => entry.id,
            entryTemplate,
          )}
        </div>
      </section>
    `;
  }

  function rerenderViewer(): void {
    render(viewerTemplate(), container);
  }

  function setActive(nextActive: boolean): void {
    if (active === nextActive) return;
    active = nextActive;
    if (!active) {
      if (refreshHandle != null) cancelRefresh(refreshHandle);
      refreshHandle = undefined;
      return;
    }

    requestSnapshot();
    refreshHandle = scheduleRefresh(() => {
      if (!active) return;
      if (!container.isConnected) {
        setActive(false);
        return;
      }
      requestSnapshot();
    }, refreshIntervalMs);
  }

  function applySnapshot(message: DesktopSetLogMessage): void {
    const path = message.log.path ?? 'the desktop log file';
    const entries = parseDesktopLogEntries(message.log.text);
    state = {
      entries,
      status: 'ready',
      meta: message.log.truncated
        ? `Showing the most recent redacted entries from ${path}.`
        : `Showing redacted entries from ${path}.`,
    };
    rerenderViewer();
  }

  rerenderViewer();
  return { element: container, applySnapshot, setActive, rerenderViewer };
}
