import { chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import writeFileAtomic from 'write-file-atomic';

import { isFileNotFoundError } from '@common/errors';
import * as logger from '@logger/logUtils';

import type { StateStore } from '../interfaces';

const CHANNEL = 'JsonStore';

type JsonRecord = Record<string, unknown>;

export interface JsonStoreOptions {
  /**
   * POSIX mode for the store file (e.g. `0o600` to restrict a secrets file
   * to its owner). The containing directory is created/chmod'd with the
   * same owner permissions plus execute — `0o600` -> `0o700` — so it stays
   * traversable. Left unset, `mkdir`/`writeFileAtomic` use their platform
   * defaults, matching prior `JsonStore` behavior.
   */
  mode?: number;
  /**
   * When true, malformed JSON is a hard failure (rethrown) instead of being
   * silently treated as an empty store. Callers that overwrite the whole
   * file on every write (read-mutate-write, e.g. `CliSecrets`) need this:
   * defaulting a transient parse failure to `{}` would permanently wipe
   * every other stored value on the very next write. Defaults to false,
   * preserving the self-healing behavior existing state/config stores rely
   * on.
   */
  strict?: boolean;
}

/** `0o600` -> `0o700`: adds owner-execute wherever owner-read is set. */
function dirModeFor(fileMode: number): number {
  return fileMode | ((fileMode & 0o444) >> 2);
}

async function readJsonRecord(
  filePath: string,
  strict: boolean,
): Promise<JsonRecord> {
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : {};
  } catch (error) {
    if (isFileNotFoundError(error)) return {};
    if (error instanceof SyntaxError && !strict) {
      logger.warn(
        CHANNEL,
        `Discarding unreadable ${filePath}; treating as empty.`,
        { data: error },
      );
      return {};
    }
    throw error;
  }
}

/**
 * File-backed key-value store, persisted as a flat JSON object.
 *
 * Shared building block for non-VS-Code platform implementations (Electron,
 * CLI). Writes go through `write-file-atomic`, which stages to a sibling temp
 * path, `fsync`s, then renames — so a crash mid-flush leaves the previous file
 * intact rather than corrupting the snapshot. Flushes are chained on
 * {@link writeChain} so they persist in `set()` call order: `write-file-atomic`
 * only guarantees same-path writes don't clobber each other's temp files, not
 * that they land in call order (the per-flush `mkdir` await could otherwise let
 * an earlier snapshot overtake a later one and silently revert it).
 */
export class JsonStore implements StateStore {
  private writeChain = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    private data: JsonRecord,
    private readonly options: JsonStoreOptions,
  ) {}

  static async open(
    filePath: string,
    options: JsonStoreOptions = {},
  ): Promise<JsonStore> {
    await ensureDir(dirname(filePath), options.mode);
    return new JsonStore(
      filePath,
      await readJsonRecord(filePath, options.strict ?? false),
      options,
    );
  }

  get<T>(key: string, defaultValue?: T): T {
    const value = this.data[key];
    return value === undefined ? (defaultValue as T) : (value as T);
  }

  has(key: string): boolean {
    return Object.hasOwn(this.data, key);
  }

  async set(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      delete this.data[key];
    } else {
      this.data[key] = value;
    }
    await this.enqueueFlush(this.snapshot());
  }

  /** {@link StateStore} conformance; same persistence semantics as `set`. */
  update(key: string, value: unknown): Promise<void> {
    return this.set(key, value);
  }

  snapshot(): JsonRecord {
    return { ...this.data };
  }

  /**
   * Chain the flush onto {@link writeChain} so flushes run in `set()` call
   * order. The link is established synchronously, before any await, so order is
   * captured at call time rather than racing on `mkdir`/`write-file-atomic`
   * timing. A failed flush doesn't break the chain (`.then(flush, flush)`).
   */
  private enqueueFlush(snapshot: JsonRecord): Promise<void> {
    const flush = () => this.flush(snapshot);
    this.writeChain = this.writeChain.then(flush, flush);
    return this.writeChain;
  }

  private async flush(snapshot: JsonRecord): Promise<void> {
    await ensureDir(dirname(this.filePath), this.options.mode);
    await writeFileAtomic(
      this.filePath,
      `${JSON.stringify(snapshot, null, 2)}\n`,
      this.options.mode === undefined ? undefined : { mode: this.options.mode },
    );
  }
}

/**
 * Creates `dir` if missing. When `fileMode` is set, also chmods the
 * directory to {@link dirModeFor} — `mkdir`'s own `mode` only applies at
 * creation time, so a pre-existing directory with looser permissions needs
 * the explicit follow-up chmod too.
 */
async function ensureDir(
  dir: string,
  fileMode: number | undefined,
): Promise<void> {
  const dirMode = fileMode === undefined ? undefined : dirModeFor(fileMode);
  await mkdir(dir, { recursive: true, mode: dirMode });
  if (dirMode !== undefined) await chmod(dir, dirMode);
}
