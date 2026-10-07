/**
 * `executions query`: one read-only SQL statement over the session's run
 * history (`HistoryQuery`), answered as a bounded page. A statement the store
 * refuses comes back as a `ToolError` in SQLite's own words, so the model can
 * correct it; a page that stops at the row cap says so.
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import type {
  HistoryCell,
  HistoryPage,
} from '@agent/runtime/historyQuery/HistoryQuery';
import { ToolError } from '@shared/schemas';

// Local file imports
import { executed } from '../core/result';

const CELL_CHARACTER_LIMIT = 2000;

function formatCell(cell: HistoryCell): string {
  if (cell === null) return 'NULL';
  const text = String(cell).replaceAll(/\r?\n/g, '\\n').replaceAll('|', '\\|');
  return text.length <= CELL_CHARACTER_LIMIT
    ? text
    : `${text.slice(0, CELL_CHARACTER_LIMIT)}… (${text.length - CELL_CHARACTER_LIMIT} more characters; select a substr() to read them)`;
}

function formatPage(page: HistoryPage): string {
  const lines = [
    page.columns.join(' | '),
    ...page.rows.map((row) => row.map(formatCell).join(' | ')),
  ];
  if (page.rows.length === 0) lines.push('(no rows)');
  if (page.more) {
    lines.push(
      `More rows exist past these ${page.rows.length}; add LIMIT/OFFSET or a narrower WHERE to page.`,
    );
  }
  return lines.join('\n');
}

export const queryHistory = Effect.fn('ExecutionsTool.query')(function* (
  session: SessionHandle,
  sql: string,
  params: readonly string[],
) {
  const page = yield* session.history
    .query(sql, params)
    .pipe(
      Effect.catchTag('HistoryQueryRefused', (refused) =>
        Effect.fail(
          new ToolError(
            refused.reason === 'rejected'
              ? `SQLite rejected the query: ${refused.message}`
              : refused.message,
          ),
        ),
      ),
    );
  return executed(
    formatPage(page),
    `${page.rows.length}${page.more ? '+' : ''} rows`,
  );
});
