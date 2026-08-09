import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { format } from 'node:util';

import {
  app,
  type WebContents,
  type WebContentsConsoleMessageEventParams,
} from 'electron';

import { redactSecrets } from '@logger/redaction';
import { normalizeFilePath } from '@utils/core';

import type { DesktopLogSnapshot } from '../shared/desktopLogMessages.js';

const LOG_FILE_NAME = 'texra-desktop.log';
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_VIEWER_LOG_BYTES = 160 * 1024;
const CONSOLE_LEVELS = ['debug', 'error', 'info', 'log', 'warn'] as const;
type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

let logFilePath: string | undefined;
let consoleInstalled = false;
let logSetupFailed = false;

export function installDesktopAppLog(): string | undefined {
  logSetupFailed = false;
  logFilePath = initializeDesktopLogFile();
  if (logFilePath == null) return undefined;

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

function getDesktopLogFilePath(): string {
  return logFilePath ?? join(getDesktopLogDirectory(), LOG_FILE_NAME);
}

export function readDesktopLogSnapshot(options: {
  workspacePath?: string | undefined;
  maxBytes?: number | undefined;
}): DesktopLogSnapshot {
  const path = getDesktopLogFilePath();
  const maxBytes = Math.max(0, options.maxBytes ?? MAX_VIEWER_LOG_BYTES);
  const workspacePath = options.workspacePath;
  const displayWorkspacePath =
    workspacePath == null ? undefined : normalizeFilePath(workspacePath);
  try {
    const buffer = readFileSync(path);
    const truncated = buffer.length > maxBytes;
    const excerpt = truncated
      ? buffer.subarray(buffer.length - maxBytes)
      : buffer;
    return {
      path: redactDesktopLogPath(normalizeFilePath(path), displayWorkspacePath),
      truncated,
      text: redactDesktopLogText(excerpt.toString('utf8'), workspacePath),
    };
  } catch (error) {
    return {
      path: redactDesktopLogPath(normalizeFilePath(path), displayWorkspacePath),
      truncated: false,
      text: redactDesktopLogText(
        format('Desktop log is not available: %s', error),
        workspacePath,
      ),
    };
  }
}

export function attachRendererConsoleLog(webContents: WebContents): void {
  webContents.on('console-message', (event) => {
    appendDesktopLogLine(
      toConsoleLevel(event.level),
      `[renderer] ${event.message} (${event.sourceId}:${event.lineNumber})`,
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
  const path = resolveActiveLogFilePath();
  if (path == null) return;

  const message = format(...args);
  try {
    appendFileSync(path, `${new Date().toISOString()} [${level}] ${message}\n`);
  } catch {
    // Logging must never become a startup dependency.
  }
}

function initializeDesktopLogFile(): string | undefined {
  try {
    const logDir = getDesktopLogDirectory();
    mkdirSync(logDir, { recursive: true });
    return join(logDir, LOG_FILE_NAME);
  } catch (error) {
    logSetupFailed = true;
    console.warn('TeXRA desktop file logging is disabled.', error);
    return undefined;
  }
}

function resolveActiveLogFilePath(): string | undefined {
  if (logFilePath != null) return logFilePath;
  if (logSetupFailed) return undefined;

  try {
    return getDesktopLogFilePath();
  } catch {
    logSetupFailed = true;
    return undefined;
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

function redactDesktopLogText(
  text: string,
  workspacePath: string | undefined,
): string {
  return redactSecrets(redactPathPrefixes(text, workspacePath, homedir()));
}

function redactDesktopLogPath(
  path: string,
  workspacePath: string | undefined,
): string {
  return redactSecrets(
    redactPathPrefixes(path, workspacePath, normalizeFilePath(homedir())),
  );
}

function redactPathPrefixes(
  text: string,
  ...prefixes: readonly (string | undefined)[]
): string {
  return prefixes
    .filter((prefix): prefix is string => Boolean(prefix))
    .toSorted((a, b) => b.length - a.length)
    .reduce((redacted, prefix) => {
      const boundary = /[\\/]$/.test(prefix)
        ? ''
        : `(?=$|[\\s\\\\/,:;!?\\])}'"])`;
      return redacted.replaceAll(
        new RegExp(`${escapeRegex(prefix)}${boundary}`, 'g'),
        '[path]',
      );
    }, text);
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toConsoleLevel(
  level: WebContentsConsoleMessageEventParams['level'],
): ConsoleLevel {
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
