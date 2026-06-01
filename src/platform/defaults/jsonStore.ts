import { mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import writeFileAtomic from 'write-file-atomic';

import { isFileNotFoundError } from '@common/errors';

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
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

/**
 * File-backed key-value store, persisted as a flat JSON object.
 *
 * Shared building block for non-VS-Code platform implementations (Electron,
 * CLI). Writes go through `write-file-atomic`, which stages to a sibling temp
 * path, `fsync`s, then renames — so a crash mid-flush leaves the previous file
 * intact rather than corrupting the snapshot. It also serializes concurrent
 * writes to the same path internally, so no caller-side write queue is needed.
 */
export class JsonStore {
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
    await this.flush(this.snapshot());
  }

  snapshot(): JsonRecord {
    return { ...this.data };
  }

  private async flush(snapshot: JsonRecord): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFileAtomic(
      this.filePath,
      `${JSON.stringify(snapshot, null, 2)}\n`,
    );
  }
}
