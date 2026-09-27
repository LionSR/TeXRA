// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

import {
  ALL_HOST_PRODUCTION_ROOTS,
  expectRealCoverage,
  productionFilesUnder,
  REPO_ROOT,
  stripComments,
} from '../support/repoScan';

/**
 * Architecture ratchet for the persistence cutover
 * (`.agents/docs/archived/architecture/2026-09-03-persistence-substrate-decision.md`, stage 1):
 * the substrate has exactly one writer. The rule is one sentence, and section
 * 9 rules out adding a second mechanism to state it: all app-owned durable
 * state lives in the database, and the database is written in one place.
 *
 * Two halves, because there are two ways to write these rows. A file may not
 * open a SQLite connection of its own, and a file may not carry SQL that
 * mutates the C1 tables. The second half catches a module that reaches the
 * connection through the `Database` service and then hand-writes an insert:
 * the seq and commit assignment of C6 is the whole point of the service, and
 * a second insert site would assign neither.
 *
 * The allowlist is a single entry on purpose. Stage 2 onward adds the C7
 * reads to that same module rather than new writers; an entry here would mean
 * a second owner of the ordinals, which is the dual system the cutover
 * exists to remove.
 */
const PRODUCTION_ROOTS = [...ALL_HOST_PRODUCTION_ROOTS, 'packages/agent/src'];

const DATABASE_MODULE = 'src/controllers/session/Database.ts';
/** The history query store's process opens SQLite on its own `:memory:`
 *  database and never on the session file. It assigns no seq or commit and
 *  claims nothing, so it is not a second owner of the ordinals this ratchet
 *  guards; it stays under the write scan like every other file. */
const HISTORY_QUERY_STORE = 'src/agent/runtime/historyQuery/childSource.ts';

/** Both the official SQLite driver and raw SQLite imports create storage
 * authority. Imports, requires, and dynamic imports obey the same boundary. */
const SQLITE_IMPORT =
  /\b(?:from|import|require)\s*\(?\s*['"](?:(?:node:)?sqlite|@effect\/sql-sqlite-node(?:\/[^'"]*)?)['"]/;

/** A statement naming either C1 table that could change its rows: the plain
 *  `INSERT INTO`, every `INSERT OR <conflict>` and `REPLACE INTO` upsert form
 *  (the allowlisted module's own sequence assignment is an upsert, so that is
 *  the likeliest shape of a second writer), `UPDATE`, `DELETE FROM`, and
 *  `DROP TABLE`. A schema qualifier (`main.event`) is part of the name.
 *  Written to survive the line breaks a formatted SQL template literal
 *  introduces. */
const EVENT_TABLE_WRITE =
  /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+(?:"?\w+"?\s*\.\s*)?"?(?:event|event_sequence)"?\b/i;

/** The session publisher: per (process, root), every durable append is a
 *  job on its one inbox, so commit order is enqueue order (core concepts,
 *  invariant 1). */
const PUBLISHER_MODULE = 'src/agent/runtime/SessionEvents.ts';

/** A call of the database's append, or of the run removal whose transaction
 *  appends the tombstone; never a declaration or a `Pick` key. */
const APPEND_CALL = /(?:\.appendAll|\.prepareRunRemoval|\bappendPrepared)\s*\(/;

/**
 * The files that still append without the publisher, each with the reason it
 * may. Shrink only: an entry whose file stops appending fails below, and a new
 * appender is refused. Nothing is added here to make a change pass.
 */
const APPENDS_OUTSIDE_PUBLISHER: Readonly<Record<string, string>> = {
  [DATABASE_MODULE]:
    'defines appendAll and appendPrepared; its read-modify-append methods run appendPrepared inside their own write transaction, and the run-removal transaction it prepares runs as a publisher job',
  'src/controllers/session/appStateStore.ts':
    'project and profile application state: a project store is opened for the project scope with no session, so no publisher exists to route through (current values move to their own authority, move 12)',
  'packages/desktop/src/main/desktopProjectRecords.ts':
    'desktop project records on the global database, which holds no session and has no publisher',
};

function offenders(pattern: RegExp, allowed: readonly string[]): string[] {
  return PRODUCTION_ROOTS.flatMap(productionFilesUnder)
    .filter((file) => !allowed.includes(file))
    .filter((file) =>
      pattern.test(
        stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf8')),
      ),
    )
    .toSorted();
}

describe('persistence write boundary', () => {
  it('scans the shared, host, and SDK production roots', () => {
    expectRealCoverage(PRODUCTION_ROOTS);
    expect(PRODUCTION_ROOTS.flatMap(productionFilesUnder)).toContain(
      'src/controllers/session/deletionCleanup.ts',
    );
  });

  it('opens the substrate in the Database layer and nowhere else', () => {
    const found = offenders(SQLITE_IMPORT, [
      DATABASE_MODULE,
      HISTORY_QUERY_STORE,
    ]);

    expect(
      found,
      found.length === 0
        ? undefined
        : `Reach the substrate through the Database service (${DATABASE_MODULE}); a second connection is a second writer with its own busy timeout and its own transaction.`,
    ).toEqual([]);
  });

  it('writes the C1 tables in the Database layer and nowhere else', () => {
    const found = offenders(EVENT_TABLE_WRITE, [DATABASE_MODULE]);

    expect(
      found,
      found.length === 0
        ? undefined
        : `Append through Database.appendAll (${DATABASE_MODULE}); it is the only assigner of seq and commit (contract C6).`,
    ).toEqual([]);
  });

  it('appends through the session publisher and nowhere else', () => {
    const allowed = [
      PUBLISHER_MODULE,
      ...Object.keys(APPENDS_OUTSIDE_PUBLISHER),
    ];
    const found = offenders(APPEND_CALL, allowed);

    expect(
      found,
      found.length === 0
        ? undefined
        : `Append as a job on the session publisher (${PUBLISHER_MODULE}: publish, exclusive, detach); a direct append commits around its inbox and its tracking.`,
    ).toEqual([]);
    // Shrink only: an allowance whose file no longer appends goes.
    const stale = allowed.filter(
      (file) =>
        !APPEND_CALL.test(
          stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf8')),
        ),
    );
    expect(stale).toEqual([]);
  });

  it('keeps the Database layer itself the writer the ratchet names', () => {
    const source = stripComments(
      readFileSync(resolve(REPO_ROOT, DATABASE_MODULE), 'utf8'),
    );

    // A vacuous ratchet is the failure mode these scans have: if the module
    // is renamed or its writes move, the allowlist above silently protects a
    // file that no longer writes anything.
    expect(SQLITE_IMPORT.test(source)).toBe(true);
    expect(EVENT_TABLE_WRITE.test(source)).toBe(true);
    expect(
      SQLITE_IMPORT.test(
        stripComments(
          readFileSync(resolve(REPO_ROOT, HISTORY_QUERY_STORE), 'utf8'),
        ),
      ),
    ).toBe(true);
  });
});
