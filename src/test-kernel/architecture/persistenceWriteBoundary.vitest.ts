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
 * (`.agents/docs/proposed/architecture/2026-09-03-persistence-substrate-decision.md`, stage 1):
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

/** `import … from 'node:sqlite'`, `require('node:sqlite')`, and the dynamic
 *  form; the bare `sqlite` specifier too, so a re-export cannot hide it. */
const SQLITE_IMPORT =
  /\b(?:from|import|require)\s*\(?\s*['"](?:node:)?sqlite['"]/;

/** A statement naming either C1 table that could change its rows: the plain
 *  `INSERT INTO`, every `INSERT OR <conflict>` and `REPLACE INTO` upsert form
 *  (the allowlisted module's own sequence assignment is an upsert, so that is
 *  the likeliest shape of a second writer), `UPDATE`, `DELETE FROM`, and
 *  `DROP TABLE`. A schema qualifier (`main.event`) is part of the name.
 *  Written to survive the line breaks a formatted SQL template literal
 *  introduces. */
const EVENT_TABLE_WRITE =
  /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE|DELETE\s+FROM|DROP\s+TABLE(?:\s+IF\s+EXISTS)?)\s+(?:"?\w+"?\s*\.\s*)?"?(?:event|event_sequence)"?\b/i;

function offenders(pattern: RegExp): string[] {
  return PRODUCTION_ROOTS.flatMap(productionFilesUnder)
    .filter((file) => file !== DATABASE_MODULE)
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
  });

  it('opens the substrate in the Database layer and nowhere else', () => {
    const found = offenders(SQLITE_IMPORT);

    expect(
      found,
      found.length === 0
        ? undefined
        : `Reach the substrate through the Database service (${DATABASE_MODULE}); a second connection is a second writer with its own busy timeout and its own transaction.`,
    ).toEqual([]);
  });

  it('writes the C1 tables in the Database layer and nowhere else', () => {
    const found = offenders(EVENT_TABLE_WRITE);

    expect(
      found,
      found.length === 0
        ? undefined
        : `Append through Database.appendAll (${DATABASE_MODULE}); it is the only assigner of seq and commit (contract C6).`,
    ).toEqual([]);
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
  });
});
