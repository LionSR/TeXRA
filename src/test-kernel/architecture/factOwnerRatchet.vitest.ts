// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { format, resolveConfig } from 'prettier';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  expectRealCoverage,
  parseSourceFile,
  productionFilesUnder,
  productionRoots,
  REPO_ROOT,
} from '../support/repoScan';

/**
 * One owner per fact. The other ratchets look at one file, one function or
 * one import edge; a fact decided in several files passes all of them,
 * because each file on its own is fine. These two rules count the places
 * that decide one fact.
 *
 * Readers per row type: a file that compares, switches on or lists a
 * session row's `type` outside the reducers below decides that row's fact
 * on its own. Each row type's readers outside the reducers are a baseline
 * (config/ratchets/row-readers-baseline.json) that only shrinks. A new
 * reader reads the state the row's reducer builds instead, or adds its rule
 * to that reducer.
 *
 * Owners per fact: a short table of facts, each with the one file that
 * writes it. No other file assigns the field, constructs the row, or reads
 * the input the owner decides from.
 *
 * Both scans read string literals and property names, not types: a literal
 * compared with or assigned to a property other than `type` (a request's
 * `kind: 'run.model'`) belongs to another union and is skipped, and a
 * same-named value of another union (the trace's `run.end` event) is
 * listed with its reason. Rows read in SQL text are not scanned, nor is a
 * field reached by a computed name (`entry['launchParent']`); an optional
 * chain (`entry?.launchParent`) is an ordinary property access here.
 */

const EVENTS = 'packages/harness/src/shared/schemas/sessionEvent.ts';
const BASELINE_FILE = 'config/ratchets/row-readers-baseline.json';
const BASELINE_PATH = resolve(REPO_ROOT, BASELINE_FILE);
const THIS_FILE = 'src/test-kernel/architecture/factOwnerRatchet.vitest.ts';

/** The files that may read any row type: what each one builds is what a
 *  reader reads instead of the rows. */
const REDUCERS: Readonly<Record<string, string>> = {
  'packages/harness/src/shared/session/runRows.ts':
    'what applyRunRow folds onto RunState and RunView (runRows.ts)',
  'packages/harness/src/shared/session/runState.ts': 'RunState (runState.ts)',
  'packages/harness/src/shared/session/turnRowHandlers.ts':
    'RunState (runState.ts)',
  'packages/harness/src/shared/session/sessionViewUpdate.ts':
    'RunView (sessionViewUpdate.ts)',
  'packages/harness/src/shared/session/transcriptUpdate.ts':
    'TranscriptView (transcriptUpdate.ts)',
  'packages/harness/src/controllers/session/projections.ts':
    'the store projections (projections.ts)',
};

/** The vocabulary: the row arms and their listing keys, and the version
 *  table keyed by row type. They name every type and decide no fact. */
const VOCABULARY = new Set([
  EVENTS,
  'packages/harness/src/shared/schemas/rowVersions.ts',
]);

const RUN_REGISTRY = 'packages/harness/src/agent/runtime/runRegistry.ts';
const RUN_LIFECYCLE = 'packages/harness/src/agent/storage/runLifecycle.ts';

type Use = 'assigns' | 'constructs' | 'reads';

/** Each fact, the one file that writes it, and the files that use a
 *  same-named thing for another fact. */
const OWNERS: readonly {
  readonly fact: string;
  readonly owner: string;
  readonly use: Use;
  /** A field name, or a row type for `constructs`. */
  readonly name: string;
  readonly also?: Readonly<Record<string, string>>;
}[] = [
  {
    fact: 'why a run is being stopped (precedence included)',
    owner: RUN_REGISTRY,
    use: 'assigns',
    name: 'stopReason',
    also: {
      'packages/harness/src/common/plugins/hookProtocol.ts':
        'a hook output field of the same name, not a run stop',
    },
  },
  {
    fact: "a run's parent edge before its rows exist",
    owner: RUN_REGISTRY,
    use: 'reads',
    name: 'unbornParent',
  },
  {
    fact: "a run's terminal row, written once per lifecycle",
    owner: RUN_LIFECYCLE,
    use: 'constructs',
    name: 'run.end',
    also: {
      'packages/harness/src/agent/runtime/AgentRunLifecycle.ts':
        "the trace's terminal event (`ResultEvent`), not the row",
    },
  },
  {
    fact: "a run's activation",
    owner: RUN_LIFECYCLE,
    use: 'constructs',
    name: 'run.activate',
  },
  {
    fact: 'a parent edge cut by a stop that detaches',
    owner: RUN_REGISTRY,
    use: 'constructs',
    name: 'run.detach',
  },
  {
    fact: "a run's removal",
    owner: 'packages/harness/src/controllers/session/Database.ts',
    use: 'constructs',
    name: 'run.removed',
  },
  {
    fact: "a run's input closed",
    owner: 'packages/harness/src/agent/followUp/Inbox.ts',
    use: 'constructs',
    name: 'followup.closed',
  },
];

const OWNED_FIELDS = new Set(
  OWNERS.filter(({ use }) => use !== 'constructs').map(({ name }) => name),
);

const ASSIGNMENTS = new Set([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
]);
const EQUALITIES = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** The row types: each `durable('<type>', …)` arm of the session events.
 *  The transcript arms are the trace's types too, so a literal scan cannot
 *  tell their readers apart; the transcript reducer owns them. */
function rowTypes(): ReadonlySet<string> {
  const types = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'durable' &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteral(node.arguments[0])
    )
      types.add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(parseSourceFile(resolve(REPO_ROOT, EVENTS)));
  return types;
}

function nameOf(name: ts.Node): string | undefined {
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name)
    ? name.text
    : undefined;
}

/** A wrapper that leaves its expression's value as it is. */
function isWrapper(node: ts.Node): node is ts.Expression & {
  readonly expression: ts.Expression;
} {
  return (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  );
}

/** Whether a literal compared with or switched on `expression` is a row
 *  type: it is unless `expression` is another property (`req.kind`). */
function isTypeSlot(expression: ts.Expression): boolean {
  let inner = expression;
  while (isWrapper(inner)) inner = inner.expression;
  return !ts.isPropertyAccessExpression(inner) || inner.name.text === 'type';
}

/**
 * What a row-type literal does where it stands. `listed` is a key of a
 * `{ type: true }` table, a membership list.
 */
function literalUse(
  literal: ts.StringLiteralLike,
): 'constructs' | 'reads' | 'listed' | null {
  if (ts.isLiteralTypeNode(literal.parent)) return null;
  let at: ts.Node = literal;
  while (isWrapper(at.parent)) at = at.parent;
  const parent = at.parent;
  if (ts.isPropertyAssignment(parent) && parent.initializer === at)
    return nameOf(parent.name) === 'type' ? 'constructs' : null;
  if (ts.isPropertyAssignment(parent))
    return parent.initializer.kind === ts.SyntaxKind.TrueKeyword
      ? 'listed'
      : 'reads';
  const call = ts.isArrayLiteralExpression(parent) ? parent.parent : parent;
  if (
    ts.isCallExpression(call) &&
    /^Schema\.Literals?$/.test(call.expression.getText())
  )
    return null;
  if (
    ts.isBinaryExpression(parent) &&
    EQUALITIES.has(parent.operatorToken.kind)
  )
    return isTypeSlot(parent.left === at ? parent.right : parent.left)
      ? 'reads'
      : null;
  if (ts.isCaseClause(parent))
    return isTypeSlot(parent.parent.parent.expression) ? 'reads' : null;
  return 'reads';
}

/** What one owned field name does where it stands. */
function fieldUse(node: ts.Node): Use | null {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) {
    const assigned =
      ts.isBinaryExpression(parent.parent) &&
      parent.parent.left === parent &&
      ASSIGNMENTS.has(parent.parent.operatorToken.kind);
    return assigned ? 'assigns' : 'reads';
  }
  if (
    (ts.isPropertyAssignment(parent) && parent.name === node) ||
    ts.isShorthandPropertyAssignment(parent) ||
    (ts.isPropertyDeclaration(parent) &&
      parent.name === node &&
      parent.initializer !== undefined)
  )
    return 'assigns';
  // `const { launchParent } = handle`, a destructured parameter included.
  return ts.isBindingElement(parent) && ts.isObjectBindingPattern(parent.parent)
    ? 'reads'
    : null;
}

interface FileUses {
  /** Row type → how this file uses it. */
  readonly rows: Map<string, Set<'constructs' | 'reads' | 'listed'>>;
  /** Owned field name → how this file uses it. */
  readonly fields: Map<string, Set<Use>>;
}

function scan(file: string, types: ReadonlySet<string>): FileUses {
  const uses: FileUses = { rows: new Map(), fields: new Map() };
  const add = <K, V>(map: Map<K, Set<V>>, key: K, value: V | null): void => {
    if (value === null) return;
    map.set(key, (map.get(key) ?? new Set()).add(value));
  };
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && types.has(node.text))
      add(uses.rows, node.text, literalUse(node));
    else if (ts.isIdentifier(node) && OWNED_FIELDS.has(node.text))
      add(uses.fields, node.text, fieldUse(node));
    ts.forEachChild(node, visit);
  };
  visit(parseSourceFile(resolve(REPO_ROOT, file)));
  return uses;
}

/** Whether a file uses an owned fact's name the way its owner does. */
function usesAs(found: FileUses | undefined, use: Use, name: string): boolean {
  return use === 'constructs'
    ? found?.rows.get(name)?.has(use) === true
    : found?.fields.get(name)?.has(use) === true;
}

const ROW_SEMANTICS =
  "For each session row type (a durable arm of packages/harness/src/shared/schemas/sessionEvent.ts), the production files that read it, by comparing, switching on or listing the type literal, outside its reducers and the row vocabulary (REDUCERS and VOCABULARY in src/test-kernel/architecture/factOwnerRatchet.vitest.ts). Each such file decides the row's fact on its own. Shrink-only: a file not listed fails (read the state the reducer builds instead); a listed file that stopped reading fails until the list is rewritten with `npx vitest run src/test-kernel/architecture/factOwnerRatchet.vitest.ts -u`, which only drops entries. A type absent from the list has no reader outside its reducers.";

describe('one owner per fact', () => {
  // Scanned once: the cases read the same snapshot.
  const types = rowTypes();
  const files = productionRoots().flatMap(productionFilesUnder);
  const uses = new Map(files.map((file) => [file, scan(file, types)]));
  const baseline = (
    JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as {
      readers: Record<string, string[]>;
    }
  ).readers;

  /** Each row type's readers outside the reducers and the vocabulary. */
  const readers = new Map<string, string[]>();
  for (const [file, { rows }] of uses) {
    if (REDUCERS[file] !== undefined || VOCABULARY.has(file)) continue;
    for (const [type, kinds] of rows)
      if (kinds.has('reads') || kinds.has('listed'))
        readers.set(type, [...(readers.get(type) ?? []), file]);
  }

  it('reads no row type outside its reducers, past the baseline', () => {
    const added = [...readers].flatMap(([type, found]) =>
      found
        .filter((file) => !(baseline[type] ?? []).includes(file))
        .map((file) => {
          const folds = new Set(
            Object.keys(REDUCERS)
              .filter((reducer) =>
                uses.get(reducer)?.rows.get(type)?.has('reads'),
              )
              .map((reducer) => REDUCERS[reducer]),
          );
          const instead =
            folds.size > 0
              ? `read ${[...folds].join(' or ')} instead`
              : 'no reducer folds it yet: add its rule to one (runRows.ts for a fact the loop and the view share) and read that';
          return `${file} reads '${type}' rows: ${instead}`;
        }),
    );
    expect(
      added,
      `a row's fact is decided by its reducer; a new reader is a second decider. Do not widen ${BASELINE_FILE}.`,
    ).toEqual([]);
  });

  it('lists only files that still read the row type', async () => {
    const kept = Object.fromEntries(
      Object.entries(baseline)
        .map(([type, listed]): [string, string[]] => [
          type,
          listed.filter((file) => readers.get(type)?.includes(file)),
        ])
        .filter(([, listed]) => listed.length > 0)
        .toSorted(([a], [b]) => a.localeCompare(b)),
    );
    const text = await format(
      JSON.stringify({ semantics: ROW_SEMANTICS, readers: kept }, null, 2),
      { ...(await resolveConfig(BASELINE_PATH)), filepath: BASELINE_PATH },
    );
    await expect(text).toMatchFileSnapshot(
      BASELINE_PATH,
      `a listed file stopped reading its row type: run \`npx vitest run ${THIS_FILE} -u\` to drop it from ${BASELINE_FILE}`,
    );
  });

  it('writes each owned fact in its owner alone', () => {
    const offenders = OWNERS.flatMap(({ fact, owner, use, name, also }) =>
      [...uses]
        .filter(([file]) => file !== owner && also?.[file] === undefined)
        .filter(([, found]) => usesAs(found, use, name))
        .map(([file]) => `${file} ${use} ${name}: ${fact} belongs to ${owner}`),
    );
    expect(
      offenders,
      'a fact has one owner: ask the owner (call it or read what it builds) instead of writing or deciding the fact again; a same-named field of another fact joins its `also` with the reason',
    ).toEqual([]);
  });

  it('finds each owned fact in its owner', () => {
    const missing = OWNERS.filter(
      ({ owner, use, name }) => !usesAs(uses.get(owner), use, name),
    ).map(({ fact, owner }) => `${owner}: ${fact}`);
    expect(
      missing,
      'an owner moved or renamed its fact: point OWNERS at the new owner',
    ).toEqual([]);
  });

  it('actually scans the production source roots', () => {
    expect(types.size).toBeGreaterThan(20);
    expectRealCoverage(productionRoots());
  });
});
