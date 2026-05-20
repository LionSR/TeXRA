import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

type JsonRecord = Record<string, unknown>;

async function readJsonRecord(filePath: string): Promise<JsonRecord> {
  try {
    const content = await readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(content);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as JsonRecord)
      : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

/**
 * File-backed key-value store, persisted as a flat JSON object.
 *
 * Shared building block for non-VS-Code platform implementations (Electron,
 * CLI). All writes are atomic (stage to sibling temp path, then rename) so a
 * crash mid-flush leaves the previous file intact rather than corrupting the
 * snapshot.
 */
export class JsonStore {
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

  snapshot(): JsonRecord {
    return { ...this.data };
  }

  private async enqueueFlush(snapshot: JsonRecord): Promise<void> {
    const flush = () => this.flush(snapshot);
    this.writeChain = this.writeChain.then(flush, flush);
    await this.writeChain;
  }

  private async flush(snapshot: JsonRecord): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    // The temp suffix is process-unique so concurrent JsonStore writers
    // (different files in the same dir) don't collide.
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`);
      await rename(tempPath, this.filePath);
    } catch (error) {
      // Best-effort cleanup of stale temp file. Swallow ENOENT (rename
      // already consumed it) and similar — the original error is what
      // matters.
      try {
        await unlink(tempPath);
      } catch {
        // ignore
      }
      throw error;
    }
  }
}
