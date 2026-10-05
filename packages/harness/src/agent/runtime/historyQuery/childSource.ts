/**
 * The query store's process: an in-memory SQLite database that holds only
 * the rows the session side sends it, answering one JSON line per request
 * line on stdio. It runs as its own process so a runaway statement ends with
 * a kill: `node:sqlite` has no interrupt or progress handler, and a thread
 * cannot be stopped inside SQLite's native loop.
 *
 * It never opens the session database. `query_only` is on except while an
 * append runs, so the model's statement cannot write even through a
 * `WITH … INSERT`; the session side admits only one `SELECT`/`WITH`/`EXPLAIN`
 * statement, which also keeps `PRAGMA` out. Stdin closing (its host exited,
 * by any means) ends the process.
 *
 * Plain CommonJS in a string: it runs under `node -e`, so no host bundles or
 * resolves a file for it.
 */
export const HISTORY_QUERY_CHILD_SOURCE = String.raw`
'use strict';
const { DatabaseSync } = require('node:sqlite');
const readline = require('node:readline');
const db = new DatabaseSync(':memory:');
let insert;
let remove;
const cell = (value) =>
  typeof value === 'bigint'
    ? Number(value)
    : value instanceof Uint8Array
      ? '<blob ' + value.byteLength + ' bytes>'
      : value;
const writable = (body) => {
  db.exec('PRAGMA query_only = OFF');
  try {
    body();
  } finally {
    db.exec('PRAGMA query_only = ON');
  }
};
const handle = (message) => {
  switch (message.kind) {
    case 'init':
      db.exec('PRAGMA hard_heap_limit = ' + message.heapLimit);
      db.exec(message.schema);
      insert = db.prepare(message.insert);
      remove = db.prepare(message.remove);
      db.exec('PRAGMA query_only = ON');
      return null;
    case 'append':
      writable(() => {
        db.exec('BEGIN');
        try {
          for (const op of message.ops) {
            if (op[0] === 'insert') insert.run(op[1], op[2], op[3], op[4]);
            else remove.run(op[1]);
          }
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
      });
      return null;
    case 'query': {
      const statement = db.prepare(message.sql);
      statement.setReturnArrays(true);
      const columns = statement.columns().map((column) => column.name);
      const rows = [];
      for (const row of statement.iterate(...message.params)) {
        if (rows.length === message.cap) return { columns, rows, more: true };
        rows.push(row.map(cell));
      }
      return { columns, rows, more: false };
    }
    default:
      throw new Error('Unknown request kind: ' + message.kind);
  }
};
const lines = readline.createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let reply;
  try {
    reply = { ok: true, value: handle(JSON.parse(line)) };
  } catch (error) {
    reply = { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(JSON.stringify(reply) + '\n');
});
lines.on('close', () => process.exit(0));
`;
