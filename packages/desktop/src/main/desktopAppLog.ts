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

import escapeRegExp from 'escape-string-regexp';
import {
  app,
  type WebContents,
  type WebContentsConsoleMessageEventParams,
} from 'electron';

import { parseLevelTag } from '@logger/logUtils';
import { redactSecrets } from '@logger/redaction';
import { normalizeFilePath } from '@utils/core';

import { pathSeparatorVariants } from './desktopPathVariants.js';
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
  const workspacePath =
    options.workspacePath == null
      ? undefined
      : normalizeFilePath(options.workspacePath);
  const redactedPath = redactDesktopLogText(
    normalizeFilePath(path),
    workspacePath,
  );
  try {
    const buffer = readFileSync(path);
    const truncated = buffer.length > maxBytes;
    const excerpt = truncated
      ? buffer.subarray(buffer.length - maxBytes)
      : buffer;
    return {
      path: redactedPath,
      truncated,
      text: redactDesktopLogText(excerpt.toString('utf8'), workspacePath),
    };
  } catch (error) {
    return {
      path: redactedPath,
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

/** @returns whether the line reached the file, so a caller with no other
 *  echo (unlike the console mirror below, which always falls through to the
 *  real `console[level]` regardless) can fall back on failure. */
function appendDesktopLogLine(
  level: ConsoleLevel,
  ...args: unknown[]
): boolean {
  const path = resolveActiveLogFilePath();
  if (path == null) return false;

  const message = format(...args);
  try {
    appendFileSync(path, `${new Date().toISOString()} [${level}] ${message}\n`);
    return true;
  } catch {
    // Logging must never become a startup dependency.
    return false;
  }
}

/** Appends a line with no `<ISO timestamp> [<level>]` header, so
 *  `parseDesktopLogEntries` treats it as continuation text of whatever entry
 *  precedes it instead of a new entry. @returns whether it reached the file. */
function appendRawDesktopLogLine(line: string): boolean {
  const path = resolveActiveLogFilePath();
  if (path == null) return false;
  try {
    appendFileSync(path, `${line}\n`);
    return true;
  } catch {
    // Logging must never become a startup dependency.
    return false;
  }
}

/**
 * Sink for `logUtils.setOutputChannelFactory`. A message that carries a
 * level tag (recovered via `parseLevelTag`, since `OutputSink.appendLine`
 * itself carries none) is a new `writeLine` header: write it through
 * {@link appendDesktopLogLine} at that real level instead of routing through
 * `console` and letting {@link installConsoleMirror} re-stamp it under
 * whichever `console[level]` a caller happened to invoke — which is always
 * `console.info` for the un-wired factory, mislabeling every ERROR/WARN line.
 * Matching {@link appendDesktopLogLine}'s `<ISO timestamp> [<level>]
 * <message>` shape (rather than writing `logUtils`' own already-tagged text
 * through verbatim) also matters beyond readability: `parseDesktopLogEntries`
 * (renderer/logsPane.ts) only recognizes that shape as the start of a new
 * entry, so any other shape would fold into whichever entry happened to
 * precede it and lose severity in the Logs tab regardless of what the text
 * says.
 *
 * A message with no level tag is `writeLine`'s untagged debug-data companion
 * line for the header written just before it (`options.data`, gated on
 * `texra.logger.debugMode`) — write it through {@link appendRawDesktopLogLine}
 * instead, so it stays attached to that header as continuation text rather
 * than becoming its own falsely-`info`-level entry.
 *
 * Either way, falls back to `console[level]`/`console.info` when the file
 * write didn't land (log setup never completed, or this specific append hit
 * a full disk/permission error), so a file-logging failure doesn't go
 * completely dark the way it would if this only ever wrote to the file.
 */
export function appendLogUtilsChannelLine(name: string, message: string): void {
  const level = parseLevelTag(message);
  const line = `[${name}] ${message}`;
  if (level == null) {
    if (!appendRawDesktopLogLine(line)) console.info(line);
    return;
  }
  if (!appendDesktopLogLine(level, line)) console[level](line);
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
  return redactSecrets(
    redactPathPrefixes(text, workspacePath, normalizeFilePath(homedir())),
  );
}

function redactPathPrefixes(
  text: string,
  ...prefixes: readonly (string | undefined)[]
): string {
  return prefixes
    .filter((prefix): prefix is string => Boolean(prefix))
    .flatMap(pathSeparatorVariants)
    .toSorted((a, b) => b.length - a.length)
    .reduce((redacted, prefix) => {
      if (prefix === '/') {
        return redacted.replaceAll(/(?<![A-Za-z0-9:/])\//g, '[path]');
      }
      const boundary = /[\\/]$/.test(prefix)
        ? ''
        : `(?=$|[\\s\\\\/,:;!?\\])}'"]|\\.(?:$|\\s))`;
      return redacted.replaceAll(
        new RegExp(`${escapeRegExp(prefix)}${boundary}`, 'g'),
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
