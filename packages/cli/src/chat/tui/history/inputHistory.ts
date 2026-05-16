// Per-user input history persisted as JSONL under the global storage path.
//
// File format: one `{"t": <ms>, "v": "<line>"}` record per line. We avoid a
// single-JSON-blob format so partial writes never corrupt the history; the
// session reader skips malformed lines silently.

// Local imports - filesystem
import { GlobalStorageFS } from '@utils/files/storageFS';

const HISTORY_DIR = 'tui';
const HISTORY_PATH = `${HISTORY_DIR}/input-history.jsonl`;
const MAX_LINES = 1000;
const MAX_LINE_CHARS = 4000;

interface HistoryRecord {
  readonly t: number;
  readonly v: string;
}

export interface InputHistory {
  /** All distinct entries, most-recent last. */
  all(): readonly string[];
  /** Append a new entry. Duplicates of the most-recent entry are skipped. */
  push(line: string): Promise<void>;
  /** Reverse-incremental search: returns the most recent entry containing
   *  `needle`, or undefined. */
  reverseFind(
    needle: string,
    from?: number,
  ): { value: string; index: number } | undefined;
}

function parseRecord(raw: string): HistoryRecord | undefined {
  try {
    const obj = JSON.parse(raw) as unknown;
    if (
      typeof obj === 'object' &&
      obj !== null &&
      typeof (obj as { v?: unknown }).v === 'string'
    ) {
      const v = (obj as { v: string }).v;
      const t = (obj as { t?: unknown }).t;
      return { t: typeof t === 'number' ? t : 0, v };
    }
  } catch {
    // ignore malformed line
  }
  return undefined;
}

function serializeRecords(entries: readonly string[]): string {
  const now = Date.now();
  return entries.map((v) => JSON.stringify({ t: now, v })).join('\n') + '\n';
}

export async function loadInputHistory(): Promise<InputHistory> {
  let entries: string[] = [];
  if (await GlobalStorageFS.exists(HISTORY_PATH)) {
    const raw = await GlobalStorageFS.read(HISTORY_PATH);
    for (const line of raw.split('\n')) {
      const rec = parseRecord(line);
      if (rec && rec.v.length > 0) entries.push(rec.v);
    }
  }
  // Cap on load; older entries fall off when the ring is full.
  if (entries.length > MAX_LINES) entries = entries.slice(-MAX_LINES);

  return {
    all() {
      return entries;
    },
    async push(line: string) {
      const trimmed = line.trim();
      if (!trimmed) return;
      const stored =
        trimmed.length > MAX_LINE_CHARS
          ? trimmed.slice(0, MAX_LINE_CHARS)
          : trimmed;
      if (entries.at(-1) === stored) return;
      entries.push(stored);
      await GlobalStorageFS.ensureDir(HISTORY_DIR);
      if (entries.length > MAX_LINES) {
        entries.splice(0, entries.length - MAX_LINES);
        await GlobalStorageFS.write(HISTORY_PATH, serializeRecords(entries));
        return;
      }
      const record: HistoryRecord = { t: Date.now(), v: stored };
      await GlobalStorageFS.appendFile(
        HISTORY_PATH,
        `${JSON.stringify(record)}\n`,
      );
    },
    reverseFind(needle, from) {
      if (!needle) return undefined;
      const start = from === undefined ? entries.length - 1 : from - 1;
      for (let i = start; i >= 0; i--) {
        const value = entries[i];
        if (value !== undefined && value.includes(needle)) {
          return { value, index: i };
        }
      }
      return undefined;
    },
  };
}
