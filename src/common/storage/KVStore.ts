/**
 * Generic StorageFS-backed key-value store.
 *
 * Each key is one plain-JSON file, `encodeURIComponent(key).json`, in the
 * store's directory; the directory listing is the index. Failures are never
 * swallowed: a missing file reads as `undefined`, every other error throws to
 * the caller, so a genuine I/O failure can never masquerade as absent data.
 */

import * as path from 'node:path';

import { isFileNotFoundError } from '@common/errors/errorPredicates';
import { FileReadLimitError } from '@common/storage/fileReadLimit';
import { isFile } from '@utils/files/fsEntryType';
import { hasExtension } from '@utils/core/pathCore';
import { StorageFS } from '@utils/files/storageFS';

/** Count top-level array values before JSON.parse allocates the decoded array. */
function checkArrayRows(raw: string, maxRows: number): void {
  if (!raw.trimStart().startsWith('[')) return;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let started = false;
  let rows = 0;
  for (const char of raw) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (depth === 1) {
      if (char === ',') started = false;
      else if (!started && char !== ']' && !/\s/.test(char)) {
        started = true;
        if (++rows > maxRows) throw new FileReadLimitError('rows');
      }
    }
    if (char === '"') quoted = true;
    else if (char === '[' || char === '{') depth += 1;
    else if (char === ']' || char === '}') depth -= 1;
  }
}

function keyToPath(dir: string, key: string): string {
  return path.join(dir, `${encodeURIComponent(key)}.json`);
}

function filenameToKey(filename: string): string {
  return decodeURIComponent(filename.replace(/\.json$/, ''));
}

async function withMissingFallback<T>(
  operation: () => Promise<T>,
  fallback: T,
): Promise<T> {
  try {
    return await operation();
  } catch (err) {
    if (isFileNotFoundError(err)) return fallback;
    throw err;
  }
}

export interface KVStoreOptions {
  /**
   * Write JSON without indentation. Use this for high-churn machine-owned
   * stores where repeated pretty-printing adds avoidable CPU and disk I/O.
   */
  compactJson?: boolean;
}

export class KVStore {
  private readonly indent: number | undefined;

  constructor(
    private readonly dir: string,
    options: KVStoreOptions = {},
  ) {
    this.indent = options.compactJson ? undefined : 2;
  }

  async read<T = unknown>(
    key: string,
    budget?: { readonly bytes: number; readonly rows: number },
  ): Promise<T | undefined> {
    const raw = await withMissingFallback(
      () => StorageFS.read(keyToPath(this.dir, key), budget?.bytes),
      undefined,
    );
    if (raw === undefined) return undefined;
    if (budget) checkArrayRows(raw, budget.rows);
    return JSON.parse(raw) as T;
  }

  /** Decode one array value at a time without retaining the preceding values. */
  async *readArray(key: string, maxRowBytes: number): AsyncGenerator<unknown> {
    const pieces: string[] = [];
    let bytes = 0;
    let opened = false;
    let closed = false;
    let active = false;
    let afterComma = false;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    const append = (piece: string): void => {
      bytes += Buffer.byteLength(piece, 'utf8');
      if (bytes > maxRowBytes) throw new FileReadLimitError('bytes');
      pieces.push(piece);
    };
    const take = (): unknown => {
      const raw = pieces.join('');
      pieces.length = 0;
      bytes = 0;
      return JSON.parse(raw);
    };
    try {
      for await (const chunk of StorageFS.createReadStream(
        keyToPath(this.dir, key),
        { encoding: 'utf8', highWaterMark: 64 * 1024 },
      )) {
        const text = String(chunk);
        let start = active ? 0 : -1;
        for (let index = 0; index < text.length; index += 1) {
          const char = text[index];
          const whitespace =
            char === ' ' || char === '\n' || char === '\r' || char === '\t';
          if (!opened) {
            if (whitespace) continue;
            if (char !== '[')
              throw new SyntaxError('Stored value is not a JSON array.');
            opened = true;
            continue;
          }
          if (closed) {
            if (!whitespace)
              throw new SyntaxError(
                'Unexpected content after stored JSON array.',
              );
            continue;
          }
          if (!active) {
            if (whitespace) continue;
            if (char === ']') {
              if (afterComma)
                throw new SyntaxError('Trailing comma in stored JSON array.');
              closed = true;
              continue;
            }
            active = true;
            start = index;
          }
          if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
          } else if (char === '"') quoted = true;
          else if (char === '[' || char === '{') depth += 1;
          else if (char === '}' || (char === ']' && depth > 0)) depth -= 1;
          else if (depth === 0 && (char === ',' || char === ']')) {
            append(text.slice(start, index));
            yield take();
            active = false;
            start = -1;
            afterComma = char === ',';
            closed = char === ']';
          }
        }
        if (active) append(text.slice(start));
      }
      if (!opened || !closed || active)
        throw new SyntaxError('Incomplete stored JSON array.');
    } catch (error) {
      if (!isFileNotFoundError(error)) throw error;
    }
  }

  async write<T = unknown>(key: string, value: T): Promise<void> {
    // Ensured on every write, not latched once: `dir` is storage-root
    // relative, so a cached store outlives the root it first saw (workspace
    // switch, test temp platform) and a latch would write into a directory
    // that no longer exists. mkdir on an existing directory is cheap.
    await StorageFS.ensureDir(this.dir);
    // Atomic: a torn flow_{id}.json on an unclean exit makes the run fail to
    // parse on resume and silently restart from scratch (losing applied edits).
    await StorageFS.writeAtomic(
      keyToPath(this.dir, key),
      JSON.stringify(value, null, this.indent),
    );
  }

  async delete(key: string): Promise<void> {
    await withMissingFallback(
      () => StorageFS.delete(keyToPath(this.dir, key)),
      undefined,
    );
  }

  async exists(key: string): Promise<boolean> {
    return StorageFS.exists(keyToPath(this.dir, key));
  }

  async modifiedAt(key: string): Promise<number | undefined> {
    return withMissingFallback(
      async () => (await StorageFS.stat(keyToPath(this.dir, key))).mtime,
      undefined,
    );
  }

  async listKeys(prefix?: string): Promise<string[]> {
    const entries = await withMissingFallback(
      () => StorageFS.readDir(this.dir),
      [],
    );
    return entries
      .filter(([name, type]) => isFile(type) && hasExtension(name, '.json'))
      .map(([name]) => filenameToKey(name))
      .filter((key) => !prefix || key.startsWith(prefix));
  }

  async deleteDir(): Promise<void> {
    await withMissingFallback(
      () => StorageFS.delete(this.dir, { recursive: true }),
      undefined,
    );
  }
}
