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
import { normalizeFilePath } from '@texra-ai/harness/schemas';

import escapeRegExp from 'escape-string-regexp';
import {
  app,
  type WebContents,
  type WebContentsConsoleMessageEventParams,
} from 'electron';

import { redactSecrets } from '@texra-ai/harness/host';
import { setLogSink, type LogEntry } from '@texra-ai/harness/node';

import type { DesktopLogSnapshot } from '../shared/desktopLogMessages.js';

const LOG_FILE_NAME = 'texra-desktop.log';
const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_VIEWER_LOG_BYTES = 160 * 1024;
const CONSOLE_LEVELS = ['debug', 'error', 'info', 'log', 'warn'] as const;
type ConsoleLevel = (typeof CONSOLE_LEVELS)[number];

/** The process's one log file, set by {@link installDesktopAppLog} and read
 *  by the console mirror and Electron's event handlers, which run outside
 *  any runtime; undefined while file logging is off. */
let logFilePath: string | undefined;

/** Called once, by the process's bootstrap: a second call would mirror the
 *  console twice. */
export function installDesktopAppLog(): void {
  logFilePath = initializeDesktopLogFile();
  if (logFilePath == null) return;

  rotateDesktopLogFile(logFilePath);
  // Core diagnostics reach the file as the structured entries they were
  // written as. Before this the desktop installed no sink at all, so every
  // core entry fell to the console fallback and reached the file stamped
  // `info` with its real level buried in the message text (#12134).
  setLogSink({ write: appendDesktopLogEntry });
  appendDesktopLogLine('info', '--- TeXRA desktop session started ---');
  installConsoleMirror();
}

export function getDesktopLogDirectory(): string {
  try {
    app.setAppLogsPath();
    return app.getPath('logs');
  } catch {
    // Where Electron cannot name a logs folder, the log lives under userData;
    // this is the one answer the writer, the viewer and "Open log folder" read.
    return join(app.getPath('userData'), 'logs');
  }
}

/** Where the desktop log is on disk (the snapshot carries it redacted). */
export function getDesktopLogFilePath(): string {
  return join(getDesktopLogDirectory(), LOG_FILE_NAME);
}

export function readDesktopLogSnapshot(options: {
  workspaceRoot?: string | undefined;
}): DesktopLogSnapshot {
  const path = getDesktopLogFilePath();
  const workspaceRoot =
    options.workspaceRoot == null
      ? undefined
      : normalizeFilePath(options.workspaceRoot);
  const redactedPath = redactDesktopLogText(
    normalizeFilePath(path),
    workspaceRoot,
  );
  try {
    const buffer = readFileSync(path);
    const truncated = buffer.length > MAX_VIEWER_LOG_BYTES;
    const excerpt = truncated
      ? buffer.subarray(buffer.length - MAX_VIEWER_LOG_BYTES)
      : buffer;
    return {
      path: redactedPath,
      truncated,
      text: redactDesktopLogText(excerpt.toString('utf8'), workspaceRoot),
    };
  } catch (error) {
    return {
      path: redactedPath,
      truncated: false,
      text: redactDesktopLogText(
        format('Desktop log is not available: %s', error),
        workspaceRoot,
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
  for (const level of CONSOLE_LEVELS) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      appendDesktopLogLine(level, ...args);
      original(...args);
    };
  }
}

/** Console levels as the names Effect's structured entry uses. */
const ENTRY_LEVEL: Record<ConsoleLevel, LogEntry['level']> = {
  debug: 'DEBUG',
  error: 'ERROR',
  info: 'INFO',
  log: 'INFO',
  warn: 'WARN',
};

/**
 * Record output that arrives as console arguments rather than as an entry:
 * Electron's own logging, the renderer's console, and the process-level
 * signals below. These have no fiber and no channel of their own.
 */
function appendDesktopLogLine(level: ConsoleLevel, ...args: unknown[]): void {
  appendDesktopLogEntry({
    level: ENTRY_LEVEL[level],
    fiberId: '',
    timestamp: new Date().toISOString(),
    message: format(...args),
    cause: undefined,
    annotations: {},
    spans: {},
  });
}

/** One entry, one JSON line. The `data` payload arrives already rendered and
 * bounded by the write path, so the file keeps it on the entries the
 * runtime's emission threshold let through. Nothing is written when the log
 * file could not be set up. */
function appendDesktopLogEntry(entry: LogEntry): void {
  if (logFilePath === undefined) return;
  try {
    appendFileSync(logFilePath, `${JSON.stringify(entry)}\n`);
  } catch {
    // Logging must never become a startup dependency.
  }
}

function initializeDesktopLogFile(): string | undefined {
  try {
    mkdirSync(getDesktopLogDirectory(), { recursive: true });
    return getDesktopLogFilePath();
  } catch (error) {
    console.warn('TeXRA desktop file logging is disabled.', error);
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
  workspaceRoot: string | undefined,
): string {
  return redactSecrets(
    redactPathPrefixes(text, workspaceRoot, normalizeFilePath(homedir())),
  );
}

/**
 * Replace each sensitive path prefix with `[path]`, whatever spelling its
 * separators have in the log: native or forward slashes, a mix of both, or
 * backslashes doubled once by JSON encoding and again by `util.format`
 * inspecting an object before the entry is serialized. A prefix is matched by
 * its segments joined with any run of separators, so every encoding layer is
 * one pattern rather than one more enumerated spelling. Longer prefixes go
 * first, so a workspace inside the home directory is not cut at home.
 */
function redactPathPrefixes(
  text: string,
  ...prefixes: readonly (string | undefined)[]
): string {
  return prefixes
    .map((prefix) => prefix?.trim() ?? '')
    .filter((prefix) => prefix.length > 0)
    .map((prefix) => prefix.split(/[\\/]+/))
    .toSorted(
      (a, b) => b.length - a.length || b.join('/').length - a.join('/').length,
    )
    .reduce((redacted, segments) => {
      // The POSIX root: a slash that starts a path, never one inside a URL
      // or a relative path.
      if (segments.every((segment) => segment === '')) {
        return redacted.replaceAll(/(?<![A-Za-z0-9:/])\//g, '[path]');
      }
      const pattern = segments.map(escapeRegExp).join('[\\\\/]+');
      // A separator-terminated prefix already ends on a boundary; any other
      // must stop where the path does, never inside a longer sibling name.
      const boundary =
        segments.at(-1) === ''
          ? ''
          : `(?=$|[\\s\\\\/,:;!?\\])}'"]|\\.(?:$|\\s))`;
      return redacted.replaceAll(
        new RegExp(`${pattern}${boundary}`, 'g'),
        '[path]',
      );
    }, text);
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
