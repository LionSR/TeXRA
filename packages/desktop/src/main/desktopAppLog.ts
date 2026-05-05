import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { format } from 'node:util';

import {
  app,
  type Event,
  type WebContents,
  type WebContentsConsoleMessageEventParams,
} from 'electron';

type ConsoleLevel = 'debug' | 'error' | 'info' | 'log' | 'warn';
type RendererConsoleMessage = Pick<
  WebContentsConsoleMessageEventParams,
  'level' | 'lineNumber' | 'message' | 'sourceId'
>;

const LOG_FILE_NAME = 'texra-desktop.log';
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const CONSOLE_LEVELS = ['debug', 'error', 'info', 'log', 'warn'] as const;

let logFilePath: string | undefined;
let consoleInstalled = false;

export function installDesktopAppLog(): string {
  const logDir = getDesktopLogDirectory();
  mkdirSync(logDir, { recursive: true });
  logFilePath = join(logDir, LOG_FILE_NAME);
  rotateDesktopLogFile(logFilePath);
  appendDesktopLogLine('info', '--- TeXRA desktop session started ---');
  installConsoleMirror();
  return logFilePath;
}

export function getDesktopLogDirectory(): string {
  try {
    app.setAppLogsPath();
    return app.getPath('logs');
  } catch {
    return join(app.getPath('userData'), 'logs');
  }
}

export function getDesktopLogFilePath(): string {
  return logFilePath ?? join(getDesktopLogDirectory(), LOG_FILE_NAME);
}

export function attachRendererConsoleLog(webContents: WebContents): void {
  webContents.on('console-message', (event) => {
    const details = getConsoleMessageDetails(event);
    const consoleLevel = toConsoleLevel(details.level);
    appendDesktopLogLine(
      consoleLevel,
      `[renderer] ${details.message} (${details.sourceId}:${details.lineNumber})`,
    );
  });
  webContents.on('render-process-gone', (_event, details) => {
    appendDesktopLogLine('error', '[renderer] process gone', details);
  });
  webContents.on('unresponsive', () => {
    appendDesktopLogLine('warn', '[renderer] window became unresponsive');
  });
}

function installConsoleMirror(): void {
  if (consoleInstalled) return;
  consoleInstalled = true;

  for (const level of CONSOLE_LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      appendDesktopLogLine(level, ...args);
      original(...args);
    };
  }
}

function appendDesktopLogLine(level: ConsoleLevel, ...args: unknown[]): void {
  const path = logFilePath ?? getDesktopLogFilePath();
  const message = args.length === 0 ? '' : format(...args);
  try {
    appendFileSync(path, `${new Date().toISOString()} [${level}] ${message}\n`);
  } catch {
    // Logging must never become a startup dependency.
  }
}

function rotateDesktopLogFile(path: string): void {
  try {
    if (!existsSync(path) || statSync(path).size <= MAX_LOG_BYTES) return;
    renameSync(path, `${path}.old`);
  } catch {
    // Log rotation is best-effort; app startup should continue without it.
  }
}

function getConsoleMessageDetails(
  event: Event<WebContentsConsoleMessageEventParams>,
): RendererConsoleMessage {
  return {
    message: event.message,
    level: event.level,
    lineNumber: event.lineNumber,
    sourceId: event.sourceId,
  };
}

function toConsoleLevel(level: RendererConsoleMessage['level']): ConsoleLevel {
  switch (level) {
    case 'debug':
      return 'debug';
    case 'warning':
      return 'warn';
    case 'error':
      return 'error';
    default:
      return 'info';
  }
}
