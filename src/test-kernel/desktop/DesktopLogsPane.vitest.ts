import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import { DESKTOP_LOCAL_COMMANDS } from '@desktop/shared/desktopCommandSurface';
import { DESKTOP_LOG_COMMANDS } from '@desktop/shared/desktopLogMessages';
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';
import { repoPath } from './desktopTestPaths.ts';

interface DesktopLogEntry {
  id: string;
  level: string;
  message: string;
  raw: string;
  summary: string;
  timestamp?: string;
  timestampLabel: string;
}

interface LogsPaneController {
  readonly element: HTMLElement;
  applySnapshot(message: {
    command: typeof DESKTOP_LOG_COMMANDS.SET_LOG;
    log: { text: string; truncated: boolean; path?: string };
  }): void;
  setActive(active: boolean): void;
}

interface LogsPaneModule {
  createLogsPane(options?: {
    sendCommand?: (command: string) => void;
    scheduleRefresh?: (callback: () => void, intervalMs: number) => number;
    cancelRefresh?: (handle: number) => void;
    refreshIntervalMs?: number;
  }): LogsPaneController;
  parseDesktopLogEntries(text: string): DesktopLogEntry[];
}

async function loadLogsPane(): Promise<LogsPaneModule> {
  return import('@desktop/renderer/logsPane') as unknown as Promise<LogsPaneModule>;
}

const MULTILINE_LOG = [
  '2026-07-26T02:10:00.123Z [info] Renderer ready',
  '2026-07-26T02:10:01.456Z [error] Could not open file',
  'Error: permission denied',
  '    at openFile (desktop.js:10:4)',
  '2026-07-26T02:10:02.789Z [warn] Retrying',
  '',
].join('\n');

describe('desktop logs pane', () => {
  useLitComponentTestDom(loadLogsPane);

  it('parses timestamped entries and keeps continuation lines together', async () => {
    const { parseDesktopLogEntries } = await loadLogsPane();

    const entries = parseDesktopLogEntries(MULTILINE_LOG);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({
      level: 'info',
      message: 'Renderer ready',
      timestamp: '2026-07-26T02:10:00.123Z',
      timestampLabel: '2026-07-26 02:10:00',
    });
    expect(entries[1]).toMatchObject({
      level: 'error',
      message:
        'Could not open file\nError: permission denied\n    at openFile (desktop.js:10:4)',
    });
    expect(entries[1]?.raw).toContain(
      '2026-07-26T02:10:01.456Z [error] Could not open file',
    );
  });

  it('assigns deterministic IDs that survive later snapshot refreshes', async () => {
    const { parseDesktopLogEntries } = await loadLogsPane();
    const before = parseDesktopLogEntries(MULTILINE_LOG);
    const after = parseDesktopLogEntries(
      `${MULTILINE_LOG}2026-07-26T02:10:03.000Z [debug] Refreshed\n`,
    );

    expect(after.slice(0, before.length).map((entry) => entry.id)).toEqual(
      before.map((entry) => entry.id),
    );
    expect(new Set(after.map((entry) => entry.id)).size).toBe(after.length);
  });

  it('retains a truncated leading fragment as a partial entry', async () => {
    const { parseDesktopLogEntries } = await loadLogsPane();

    const entries = parseDesktopLogEntries(
      `middle of an earlier stack\n${MULTILINE_LOG}`,
    );

    expect(entries[0]).toMatchObject({
      level: 'unknown',
      message: 'middle of an earlier stack',
      timestampLabel: 'Partial entry',
    });
  });

  it('shows a status-announced loading state before the first snapshot arrives', async () => {
    const { createLogsPane } = await loadLogsPane();
    const controller = createLogsPane({ sendCommand: vi.fn() });
    document.body.append(controller.element);

    const loading = controller.element.querySelector('.loading-state');
    expect(loading).not.toBeNull();
    expect(loading?.getAttribute('role')).toBe('status');
    expect(loading?.textContent).toContain('Loading recent entries…');
  });

  it('shows a status-announced empty state when a snapshot has no entries', async () => {
    const { createLogsPane } = await loadLogsPane();
    const controller = createLogsPane({ sendCommand: vi.fn() });
    document.body.append(controller.element);

    controller.applySnapshot({
      command: DESKTOP_LOG_COMMANDS.SET_LOG,
      log: { path: '/redacted/texra-desktop.log', text: '', truncated: false },
    });

    expect(controller.element.querySelector('.loading-state')).toBeNull();
    const empty = controller.element.querySelector('.desktop-log-viewer-empty');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toContain('No desktop log entries yet.');
    expect(empty?.closest('[role="status"]')).not.toBeNull();
  });

  it('renders one expandable Web Awesome details row per parsed entry', async () => {
    const { createLogsPane } = await loadLogsPane();
    const controller = createLogsPane({ sendCommand: vi.fn() });
    document.body.append(controller.element);

    controller.applySnapshot({
      command: DESKTOP_LOG_COMMANDS.SET_LOG,
      log: {
        path: '/redacted/texra-desktop.log',
        text: MULTILINE_LOG,
        truncated: false,
      },
    });

    const details = controller.element.querySelectorAll(
      'wa-details.desktop-log-entry',
    );
    expect(details).toHaveLength(3);
    expect(details[0]?.getAttribute('data-level')).toBe('warn');
    expect(
      details[1]?.querySelector('.desktop-log-entry-content')?.textContent,
    ).toContain('Error: permission denied');
    expect(
      controller.element.querySelector('.desktop-log-viewer-list'),
    ).not.toBeNull();
  });

  it('runs one guarded refresh timer only while the Logs tab is active', async () => {
    const { createLogsPane } = await loadLogsPane();
    const sendCommand = vi.fn();
    const cancelRefresh = vi.fn();
    let refreshTick: (() => void) | undefined;
    const controller = createLogsPane({
      sendCommand,
      scheduleRefresh: (callback, intervalMs) => {
        expect(intervalMs).toBe(2_500);
        refreshTick = callback;
        return 17;
      },
      cancelRefresh,
      refreshIntervalMs: 2_500,
    });
    document.body.append(controller.element);

    controller.setActive(true);
    controller.setActive(true);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenLastCalledWith(
      DESKTOP_LOG_COMMANDS.REQUEST_LOG,
    );

    refreshTick?.();
    expect(sendCommand).toHaveBeenCalledTimes(2);

    controller.setActive(false);
    refreshTick?.();
    expect(cancelRefresh).toHaveBeenCalledWith(17);
    expect(sendCommand).toHaveBeenCalledTimes(2);
  });

  it('preserves the four existing toolbar commands', async () => {
    const { createLogsPane } = await loadLogsPane();
    const sendCommand = vi.fn();
    const controller = createLogsPane({ sendCommand });
    document.body.append(controller.element);

    const buttons = [
      ...controller.element.querySelectorAll<HTMLElement>(
        '.desktop-log-viewer-actions wa-button',
      ),
    ];
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'Refresh',
      'Copy',
      'Export',
      'Open Folder',
    ]);
    for (const button of buttons) {
      button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }

    expect(sendCommand.mock.calls.map(([command]) => command)).toEqual([
      DESKTOP_LOG_COMMANDS.REQUEST_LOG,
      DESKTOP_LOG_COMMANDS.COPY_LOG,
      DESKTOP_LOG_COMMANDS.EXPORT_LOG,
      DESKTOP_LOCAL_COMMANDS.OPEN_LOG_FOLDER,
    ]);
  });

  it('keeps the toolbar single-row and the entry list internally scrollable', () => {
    const styles = readFileSync(
      repoPath('packages/desktop/src/renderer/styles.css'),
      'utf8',
    );

    expect(styles).toMatch(
      /\.desktop-log-viewer-actions\s*\{[\s\S]*?flex-wrap:\s*nowrap;[\s\S]*?overflow-x:\s*auto;/u,
    );
    expect(styles).toMatch(
      /\.desktop-log-viewer-list\s*\{[\s\S]*?min-height:\s*0;[\s\S]*?overflow:\s*auto;/u,
    );
  });
});
