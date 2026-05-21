import { html, render, type TemplateResult } from 'lit';
import { postMessage } from '@shared/hostBridge';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { DESKTOP_LOCAL_COMMANDS } from '../desktopCommandSurface';
import {
  DESKTOP_LOG_COMMANDS,
  type DesktopSetLogMessage,
} from '../desktopLogMessages';
import type WaDrawer from '@awesome.me/webawesome/dist/components/drawer/drawer.js';

interface LogViewerState {
  meta: string;
  text: string;
}

export interface LogsDrawerController {
  open(): void;
  applySnapshot(message: DesktopSetLogMessage): void;
  /** Re-render the viewer template with the current state (used during recovery). */
  rerenderViewer(): void;
}

export function createLogsDrawer(appRoot: HTMLElement): LogsDrawerController {
  const container: HTMLElement = document.createElement('div');
  container.setAttribute('data-desktop-view', 'logs');
  container.className = 'desktop-log-host';

  let state: LogViewerState = {
    meta: 'Recent redacted log entries appear here.',
    text: 'Open Logs to load recent entries.',
  };

  let drawer: WaDrawer | null = null;

  function requestSnapshot(): void {
    postMessage(DESKTOP_LOG_COMMANDS.REQUEST_LOG);
  }

  function viewerTemplate(s: LogViewerState): TemplateResult {
    const action = (
      icon: 'rotate-right' | 'copy' | 'download' | 'folder-open',
      label: string,
      onClick: () => void,
    ): TemplateResult =>
      renderLabeledActionButton({
        icon,
        text: label,
        className: 'desktop-secondary-button',
        appearance: 'outlined',
        onClick,
      });
    return html`
      <section class="desktop-log-viewer">
        <header class="desktop-log-viewer-header">
          <div>
            <h2>Desktop Logs</h2>
            <p>${s.meta}</p>
          </div>
          <div class="desktop-log-viewer-actions">
            ${action('rotate-right', 'Refresh', requestSnapshot)}
            ${action('copy', 'Copy', () =>
              postMessage(DESKTOP_LOG_COMMANDS.COPY_LOG),
            )}
            ${action('download', 'Export', () =>
              postMessage(DESKTOP_LOG_COMMANDS.EXPORT_LOG),
            )}
            ${action('folder-open', 'Open Folder', () =>
              postMessage(DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER),
            )}
          </div>
        </header>
        <pre class="desktop-log-viewer-output">${s.text}</pre>
      </section>
    `;
  }

  function rerenderViewer(): void {
    render(viewerTemplate(state), container);
  }

  function ensure(): WaDrawer {
    if (drawer) return drawer;
    const d = document.createElement('wa-drawer') as WaDrawer;
    d.classList.add('desktop-logs-drawer');
    d.setAttribute('label', 'Desktop Logs');
    d.setAttribute('placement', 'bottom');
    d.append(container);
    appRoot.append(d);
    drawer = d;
    return d;
  }

  function open(): void {
    const d = ensure();
    d.open = true;
    requestSnapshot();
  }

  function applySnapshot(message: DesktopSetLogMessage): void {
    const path = message.log.path ?? 'desktop log file';
    state = {
      text: message.log.text || 'No desktop log entries yet.',
      meta: message.log.truncated
        ? `Showing the most recent redacted entries from ${path}.`
        : `Showing redacted entries from ${path}.`,
    };
    rerenderViewer();
  }

  return { open, applySnapshot, rerenderViewer };
}
