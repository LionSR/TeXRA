import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import writeFileAtomic from 'write-file-atomic';

import { isFileNotFoundError } from '@common/errors';
import * as logger from '@logger/logUtils';

import type { StateStore } from '../interfaces';

const CHANNEL = 'JsonStore';

type JsonRecord = Record<string, unknown>;

async function readJsonRecord(filePath: string): Promise<JsonRecord> {
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : {};
  } catch (error) {
    if (isFileNotFoundError(error)) return {};
    if (error instanceof SyntaxError) {
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
  ) {}

  static async open(filePath: string): Promise<JsonStore> {
    await mkdir(dirname(filePath), { recursive: true });
    return new JsonStore(filePath, await readJsonRecord(filePath));
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
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFileAtomic(
      this.filePath,
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );
  }
}
