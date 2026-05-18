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
 * Simple file-backed key-value store, persisted as a flat JSON object.
 * Mirrors `packages/desktop/src/main/platform/jsonStore.ts`.
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
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`);
      await rename(tempPath, this.filePath);
    } catch (error) {
      try {
        await unlink(tempPath);
      } catch {
        // ignore
      }
      throw error;
    }
  }
}
