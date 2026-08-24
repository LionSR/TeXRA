import { mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';

import writeFileAtomic from 'write-file-atomic';

import { MAX_FOLLOW_UP_PAYLOAD_BYTES } from '@shared/schemas/progressView';

const MAX_DESKTOP_WEBVIEW_STATE_BYTES = MAX_FOLLOW_UP_PAYLOAD_BYTES;
const INVALID_STATE_SUFFIX = '.invalid';
const PERSISTENCE_ERROR = 'Desktop webview state could not be persisted.';

type WebviewState = Record<string, unknown>;

function isRecord(value: unknown): value is WebviewState {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function quarantine(filePath: string): void {
  try {
    renameSync(filePath, `${filePath}${INVALID_STATE_SUFFIX}`);
  } catch {
    try {
      rmSync(filePath, { force: true });
    } catch {
      // Read-only invalid state is treated as absent without logging it.
    }
  }
}

/**
 * Main-process authority for one logical desktop window's renderer state.
 * Reads reject oversized bytes before JSON.parse. Atomic writes preserve the
 * previous file if serialization or replacement fails.
 */
export class DesktopWebviewStateStore {
  constructor(private readonly filePath: string) {}

  getState(): WebviewState | undefined {
    let size: number;
    try {
      size = statSync(this.filePath).size;
    } catch {
      return undefined;
    }
    if (size > MAX_DESKTOP_WEBVIEW_STATE_BYTES) {
      quarantine(this.filePath);
      return undefined;
    }
    let serialized: string;
    try {
      serialized = readFileSync(this.filePath, 'utf8');
    } catch {
      return undefined;
    }
    if (
      Buffer.byteLength(serialized, 'utf8') > MAX_DESKTOP_WEBVIEW_STATE_BYTES
    ) {
      quarantine(this.filePath);
      return undefined;
    }
    try {
      const parsed: unknown = JSON.parse(serialized);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Invalid state is quarantined below without exposing its payload.
    }
    quarantine(this.filePath);
    return undefined;
  }

  setState(state: unknown): void {
    if (!isRecord(state)) throw new Error(PERSISTENCE_ERROR);
    let serialized: string;
    try {
      serialized = JSON.stringify(state);
    } catch {
      throw new Error(PERSISTENCE_ERROR);
    }
    if (
      Buffer.byteLength(serialized, 'utf8') > MAX_DESKTOP_WEBVIEW_STATE_BYTES
    ) {
      throw new Error(PERSISTENCE_ERROR);
    }
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      writeFileAtomic.sync(this.filePath, serialized, {
        encoding: 'utf8',
        mode: 0o600,
      });
    } catch {
      throw new Error(PERSISTENCE_ERROR);
    }
  }
}

/** Keep renderer state under userData and separate it by logical workspace window. */
export function desktopWebviewStatePath(
  userDataPath: string,
  workspacePath: string | undefined,
): string {
  const scope = createHash('sha256')
    .update(workspacePath ?? 'no-workspace')
    .digest('hex');
  return join(userDataPath, 'window-state', `${scope}.json`);
}
