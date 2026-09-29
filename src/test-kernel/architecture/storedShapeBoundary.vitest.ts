// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { SessionEventDraftSchema } from '@shared/schemas';
import {
  ALL_HOST_PRODUCTION_ROOTS,
  expectRealCoverage,
  parseSourceFile,
  productionFilesUnder,
  REPO_ROOT,
  stripComments,
} from '../support/repoScan';

/**
 * Architecture ratchet for the 1.0 store
 * (`.agents/docs/proposed/architecture/2026-09-28-storage-v1-design.md` §1):
 * the row codec is the one module that knows a stored shape. Nothing above
 * it sees a `'<type>.<N>'` string, a `version` column or an upcaster, and
 * nothing below it reads a payload field: the only SQLite JSON function a
 * production file runs is `json_each(?)` over a bound parameter, so no
 * statement parses `event.data`, `blob.value`, `current_value.value` or a
 * projection's data.
 *
 * Exempt by name: the history query store (`src/agent/runtime/historyQuery/`),
 * a separate `:memory:` database built from decoded display rows, whose
 * `json_extract` views are the query contract offered to the model, not
 * reads of the session store. The write ratchet exempts it the same way.
 */
const PRODUCTION_ROOTS = [...ALL_HOST_PRODUCTION_ROOTS, 'packages/agent/src'];
const HISTORY_QUERY_STORE = 'src/agent/runtime/historyQuery/';
const ROW_CODEC = 'src/controllers/session/rowCodec.ts';
const ROW_VERSIONS = 'src/shared/schemas/rowVersions.ts';

/** A SQLite JSON function other than `json_each` over one bound parameter. */
const PAYLOAD_JSON_READ =
  /\bjson_(?:extract|type|patch|object|array|group_array|group_object|set|insert|replace|remove|valid|quote|tree)\s*\(|\bjson\(|\bjson_each\s*\(\s*(?!\?\s*\))/;
/** The JSON operators, in a literal that reads as SQL. */
const JSON_OPERATOR = /\w\s*->>?\s*'/;
const SQL_WORD = /\b(?:SELECT|INSERT|UPDATE|DELETE|WHERE|CREATE)\b/;
/** A stored `type.version` string of any row kind. */
const STORED_TYPE = new RegExp(
  `(?:^|[^\\w.])(?:${SessionEventDraftSchema.options
    .map((schema) => schema.shape.type.value.replaceAll('.', '\\.'))
    .join('|')})\\.\\d+(?![\\w.])`,
);
/** The event's version column, selected or compared. */
const VERSION_COLUMN = /\be\.version\b/;
/** The registry and the upcasters it carries. */
const REGISTRY_READ = /\bROW_KINDS\b|\.upcast(?:ers)?\b/;

/** Every string and template-literal piece of one production file. */
function literals(file: string): string[] {
  const text = readFileSync(resolve(REPO_ROOT, file), 'utf8');
  const source = parseSourceFile(file, { text, setParentNodes: false });
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateLiteralToken(node))
      found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

const files = () =>
  PRODUCTION_ROOTS.flatMap(productionFilesUnder).filter(
    (file) => !file.startsWith(HISTORY_QUERY_STORE),
  );

function offenders(
  test: (text: string) => boolean,
  allowed: readonly string[] = [],
): string[] {
  return files()
    .filter((file) => !allowed.includes(file))
    .filter((file) => literals(file).some(test))
    .toSorted();
}

describe('stored shape boundary', () => {
  it('scans the shared, host, and SDK production roots', () => {
    expectRealCoverage(PRODUCTION_ROOTS);
    expect(files()).toContain(ROW_CODEC);
  });

  it('runs no SQLite JSON function but json_each over a bound parameter', () => {
    const found = offenders(
      (text) =>
        PAYLOAD_JSON_READ.test(text) ||
        (SQL_WORD.test(text) && JSON_OPERATOR.test(text)),
    );
    expect(
      found,
      found.length === 0
        ? undefined
        : 'Read a payload field in TypeScript, from the decoded event the row codec answers (or a projection the projector maintains), never in SQL.',
    ).toEqual([]);
    // Not vacuous: each shape the store used to run is refused.
    for (const shape of [
      "json_extract(e.data, '$.payload.usage')",
      'json_group_array(json(data) ORDER BY "commit")',
      'json_each(\'["run.start.1"]\')',
      "SELECT data->>'$.kind' FROM event",
    ]) {
      expect(
        PAYLOAD_JSON_READ.test(shape) ||
          (SQL_WORD.test(shape) && JSON_OPERATOR.test(shape)),
      ).toBe(true);
    }
    expect(PAYLOAD_JSON_READ.test('SELECT value FROM json_each(?)')).toBe(
      false,
    );
  });

  it("spells no stored '<type>.<version>' string", () => {
    const found = offenders((text) => STORED_TYPE.test(text));
    expect(
      found,
      found.length === 0
        ? undefined
        : 'A stored type is the `type` column alone; its version is the row codec’s (`rowCodec.ts`).',
    ).toEqual([]);
    expect(STORED_TYPE.test("e.type = 'run.removed.1'")).toBe(true);
    expect(STORED_TYPE.test("e.type = 'run.removed'")).toBe(false);
  });

  it('reads versions and upcasters in the row codec alone', () => {
    const found = [
      ...offenders((text) => VERSION_COLUMN.test(text), [ROW_CODEC]),
      ...files()
        .filter((file) => file !== ROW_CODEC && file !== ROW_VERSIONS)
        .filter((file) =>
          REGISTRY_READ.test(
            stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf8')),
          ),
        ),
    ].toSorted();
    expect(
      found,
      found.length === 0
        ? undefined
        : `Only ${ROW_CODEC} selects the version column, reads ROW_KINDS, or runs an upcaster.`,
    ).toEqual([]);
    // Not vacuous: the codec itself does all three.
    const codec = readFileSync(resolve(REPO_ROOT, ROW_CODEC), 'utf8');
    expect(VERSION_COLUMN.test(codec)).toBe(true);
    expect(REGISTRY_READ.test(stripComments(codec))).toBe(true);
  });
});
