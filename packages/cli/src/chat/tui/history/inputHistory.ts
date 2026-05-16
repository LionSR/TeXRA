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

/** Serialise the in-memory ring back to JSONL. Records keep their original
 *  timestamp so a compaction doesn't collapse the entire history to "now"
 *  in case anything ever reads the file externally. */
function serializeRecords(records: readonly HistoryRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

export async function loadInputHistory(): Promise<InputHistory> {
  // Each record keeps its original timestamp so compactions don't rewrite
  // every entry's `t` to `now`.
  let records: HistoryRecord[] = [];
  if (await GlobalStorageFS.exists(HISTORY_PATH)) {
    try {
      const raw = await GlobalStorageFS.read(HISTORY_PATH);
      for (const line of raw.split('\n')) {
        const rec = parseRecord(line);
        if (rec && rec.v.length > 0) records.push(rec);
      }
    } catch {
      // A read failure (EIO, permission, race-after-exists) must not block
      // the TUI from mounting — the user can still type, just without
      // history this session.
      records = [];
    }
  }
  // Cap on load; older entries fall off when the ring is full.
  if (records.length > MAX_LINES) records = records.slice(-MAX_LINES);
  let entries = records.map((r) => r.v);

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
      const record: HistoryRecord = { t: Date.now(), v: stored };
      entries.push(stored);
      records.push(record);
      await GlobalStorageFS.ensureDir(HISTORY_DIR);
      if (entries.length > MAX_LINES) {
        const drop = entries.length - MAX_LINES;
        entries.splice(0, drop);
        records.splice(0, drop);
        await GlobalStorageFS.write(HISTORY_PATH, serializeRecords(records));
        return;
      }
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
