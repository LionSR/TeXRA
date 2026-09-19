import { describe, expect, it, vi } from 'vitest';

import { DESKTOP_LOG_COMMANDS } from '@desktop/shared/desktopLogMessages';
import { useLitComponentTestDom } from '../settings/litComponentTestUtils';

interface LogsPaneController {
  readonly element: HTMLElement;
  applySnapshot(message: {
    command: typeof DESKTOP_LOG_COMMANDS.SET_LOG;
    log: { text: string; truncated: boolean; path: string };
  }): void;
  setActive(active: boolean): void;
}

interface LogsPaneModule {
  createLogsPane(options?: {
    sendCommand?: (command: string) => void;
    scheduleRefresh?: (callback: () => void, intervalMs: number) => number;
    refreshIntervalMs?: number;
  }): LogsPaneController;
}

async function loadLogsPane(): Promise<LogsPaneModule> {
  return import('@desktop/renderer/logsPane') as unknown as Promise<LogsPaneModule>;
}

/** One line of the log file: the structured entry the main process writes. */
function logLine(
  level: string,
  timestamp: string,
  message: string,
  cause?: string,
): string {
  return JSON.stringify({
    level,
    fiberId: '#1',
    timestamp,
    message,
    ...(cause === undefined ? {} : { cause }),
    annotations: {},
    spans: {},
  });
}

const MULTILINE_LOG = [
  logLine('INFO', '2026-07-26T02:10:00.123Z', 'Renderer ready'),
  logLine(
    'ERROR',
    '2026-07-26T02:10:01.456Z',
    'Could not open file',
    'Error: permission denied\n    at openFile (desktop.js:10:4)',
  ),
  logLine('WARN', '2026-07-26T02:10:02.789Z', 'Retrying'),
  '',
].join('\n');

describe('desktop logs pane', () => {
  useLitComponentTestDom(loadLogsPane);

  /** A mounted pane showing `text`, newest entry first. */
  async function mountWithLog(text: string): Promise<LogsPaneController> {
    const { createLogsPane } = await loadLogsPane();
    const controller = createLogsPane({ sendCommand: vi.fn() });
    document.body.append(controller.element);
    controller.applySnapshot({
      command: DESKTOP_LOG_COMMANDS.SET_LOG,
      log: {
        path: '/redacted/texra-desktop.log',
        text,
        truncated: false,
      },
    });
    return controller;
  }

  function logRows(controller: LogsPaneController): Element[] {
    return [
      ...controller.element.querySelectorAll('wa-details.desktop-log-entry'),
    ];
  }

  it('renders one expandable row per entry, with severity and time as fields', async () => {
    const controller = await mountWithLog(MULTILINE_LOG);

    const details = logRows(controller);
    expect(details).toHaveLength(3);
    // Newest first: WARN, ERROR, INFO. Severity and time are the writer's own
    // fields, so nothing is recovered from formatted text.
    expect(details[0]?.getAttribute('data-level')).toBe('warn');
    const oldest = details[2];
    expect(oldest?.getAttribute('data-level')).toBe('info');
    const time = oldest?.querySelector('.desktop-log-entry-time');
    expect(time?.getAttribute('datetime')).toBe('2026-07-26T02:10:00.123Z');
    expect(time?.textContent).toBe('2026-07-26 02:10:00');
    // The stack rides the entry's own cause, so a multi-line failure is one
    // row without the viewer stitching continuation lines back together.
    expect(
      details[1]?.querySelector('.desktop-log-entry-content')?.textContent,
    ).toContain('Error: permission denied');
    expect(
      controller.element.querySelector('.desktop-log-viewer-list'),
    ).not.toBeNull();
  });

  it('keeps a truncated leading fragment as its own partial row', async () => {
    const controller = await mountWithLog(
      `middle of an earlier stack\n${MULTILINE_LOG}`,
    );

    const details = logRows(controller);
    expect(details).toHaveLength(4);
    const fragment = details[3];
    expect(fragment?.getAttribute('data-level')).toBe('unknown');
    expect(
      fragment?.querySelector('.desktop-log-entry-time')?.textContent,
    ).toBe('Partial entry');
  });

  it('keeps each row keyed across a refresh that appends entries', async () => {
    const controller = await mountWithLog(MULTILINE_LOG);
    const before = logRows(controller);

    controller.applySnapshot({
      command: DESKTOP_LOG_COMMANDS.SET_LOG,
      log: {
        path: '/redacted/texra-desktop.log',
        text: `${MULTILINE_LOG}${logLine('DEBUG', '2026-07-26T02:10:03.000Z', 'Refreshed')}\n`,
        truncated: false,
      },
    });

    // Entry IDs derive from contents, so the already-rendered rows are the
    // same DOM nodes after the refresh and keep whatever the user expanded.
    const after = logRows(controller);
    expect(after).toHaveLength(4);
    expect(after.slice(1)).toEqual(before);
  });

  it('runs one guarded refresh timer only while the Logs tab is active', async () => {
    const { createLogsPane } = await loadLogsPane();
    const sendCommand = vi.fn();
    const cancelRefresh = vi.spyOn(window, 'clearInterval');
    let refreshTick: (() => void) | undefined;
    const controller = createLogsPane({
      sendCommand,
      scheduleRefresh: (callback, intervalMs) => {
        expect(intervalMs).toBe(2_500);
        refreshTick = callback;
        return 17;
      },
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
    cancelRefresh.mockRestore();
  });
});
