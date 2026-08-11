// Per-user input history persisted as JSONL under the global storage path.
//
// File format: one `{"t": <ms>, "v": "<line>"}` record per line. We avoid a
// single-JSON-blob format so partial writes never corrupt the history; the
// session reader skips malformed lines silently.

import { z } from 'zod';

import { parseJsonWith } from '@common/parsing/safeParseJson';
import { GlobalStorageFS } from '@utils/files/storageFS';

const HISTORY_DIR = 'tui';
const HISTORY_PATH = `${HISTORY_DIR}/input-history.jsonl`;
const MAX_LINES = 1000;
const MAX_LINE_CHARS = 4000;

const HistoryRecordSchema = z.object({ t: z.number(), v: z.string() });
type HistoryRecord = z.infer<typeof HistoryRecordSchema>;

export interface InputHistory {
  /** Append a new entry. Duplicates of the most-recent entry are skipped. */
  push(line: string): Promise<void>;
  /** Reverse-incremental search: returns the most recent entry containing
   *  `needle`, or undefined. */
  reverseFind(
    needle: string,
    from?: number,
  ): { value: string; index: number } | undefined;
  /** Entry at `index` (0 = oldest), for ↑/↓ history browsing. */
  at(index: number): string | undefined;
  /** Number of stored entries. */
  length(): number;
}

/** Serialise the in-memory ring back to JSONL. Records keep their original
 *  timestamp so a compaction doesn't collapse the entire history to "now"
 *  in case anything ever reads the file externally. */
function serializeRecords(records: readonly HistoryRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join('\n') + '\n';
}

export async function loadInputHistory(): Promise<InputHistory> {
  let records: HistoryRecord[] = [];
  if (await GlobalStorageFS.exists(HISTORY_PATH)) {
    try {
      const raw = await GlobalStorageFS.read(HISTORY_PATH);
      for (const line of raw.split('\n')) {
        const rec = parseJsonWith(line, HistoryRecordSchema).unwrapOr(
          undefined,
        );
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

  return {
    async push(line: string) {
      const trimmed = line.trim();
      if (!trimmed) return;
      const stored = trimmed.slice(0, MAX_LINE_CHARS);
      if (records.at(-1)?.v === stored) return;
      const record: HistoryRecord = { t: Date.now(), v: stored };
      records.push(record);
      await GlobalStorageFS.ensureDir(HISTORY_DIR);
      if (records.length > MAX_LINES) {
        const drop = records.length - MAX_LINES;
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
      const start = from === undefined ? records.length - 1 : from - 1;
      for (let i = start; i >= 0; i--) {
        const record = records[i];
        if (record?.v.includes(needle)) {
          return { value: record.v, index: i };
        }
      }
      return undefined;
    },
    at(index) {
      return records[index]?.v;
    },
    length() {
      return records.length;
    },
  };
}
