// Node imports
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { Schema } from 'effect';

// Third-party imports
import { describe, expect, it } from 'vitest';

import { WORKSPACE_STORES } from '@shared/session/valueFamily';
import { DESKTOP_PROJECTS } from '@desktop/main/desktopProjectRecords';
import {
  CURRENT_VALUE_VERSION,
  RETIRED_ROW_KINDS,
  ROW_KINDS,
  SessionRowDraftSchema,
} from '@shared/schemas';
import { APP_STATE, REPO_STATE } from '@shared/session/valueFamily';
import { TEXRA_SERVICE } from '@texra/controllers/server/protocol';
import { INQUIRY_THREADS } from '@texra/shared/plugins/externalInquiry';
import { UPDATE_CHECKS } from '@texra/utils/system/updateCheck';
import { texraPlugins } from '@texra/tools/registry';
import { factKindsOf } from '@tools/plugins';
import { REPO_ROOT } from '../support/repoScan';

/**
 * The release watermark of the session store:
 * `config/storage/frozen/<name>.v<N>.json` is the JSON Schema of version N of
 * a row kind, fact kind or current-value family as a release shipped it, and
 * the frozen versions bound that name's released history. A later build reads
 * a released version forever, so its schema never changes in place: a change
 * is a new version with an upcaster from the released one, and this build
 * has no upcaster, so a released kind's version does not move.
 *
 * `npm run storage:freeze` (vitest `--mode freeze`, a `releasing` step)
 * writes each name's current version, which moves the watermark.
 */
const FROZEN = resolve(REPO_ROOT, 'config/storage/frozen');
const FREEZING = process.env.MODE === 'freeze';

interface Versioned {
  readonly name: string;
  readonly version: number;
  readonly schema: Schema.Top;
}

/** Every current-value family, each declared by its owner; the first case
 *  checks this list against the declarations in the production tree. */
const VALUE_FAMILIES = [
  APP_STATE,
  REPO_STATE,
  WORKSPACE_STORES,
  DESKTOP_PROJECTS,
  INQUIRY_THREADS,
  UPDATE_CHECKS,
  TEXRA_SERVICE,
];

const VERSIONED: readonly Versioned[] = [
  ...SessionRowDraftSchema.members.map((arm) => {
    const kind = ROW_KINDS[arm.fields.type.literal];
    return {
      name: arm.fields.type.literal,
      version: kind.version,
      schema: arm,
    };
  }),
  ...Object.entries(factKindsOf(texraPlugins({ name: 'vscode' }))).map(
    ([name, factKind]) => ({
      name: `plugin.fact.${name.replace('/', '.')}`,
      version: factKind.version,
      schema: factKind.schema,
    }),
  ),
  ...VALUE_FAMILIES.map(({ name, schema }) => ({
    name: `current-value.${name.replace('/', '.')}`,
    version: CURRENT_VALUE_VERSION,
    schema,
  })),
];

/** A version's fingerprint: its schema as JSON Schema, as the store reads it. */
const fingerprint = (schema: Schema.Top): string =>
  `${JSON.stringify(Schema.toJsonSchemaDocument(schema), null, 2)}\n`;

/** The latest released version of `name`, or null before its first release. */
const released = (name: string): number | null => {
  if (!existsSync(FROZEN)) return null;
  const versions = readdirSync(FROZEN).flatMap((file) => {
    const match = /^(.+)\.v(\d+)\.json$/.exec(file);
    return match?.[1] === name ? [Number(match[2])] : [];
  });
  return versions.length === 0 ? null : Math.max(...versions);
};

describe('row versions', () => {
  it('names every stored kind once', () => {
    const names = VERSIONED.map(({ name }) => name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('model.message');
    expect(names).toContain('current-value.app-state');
    // Every workspace package's `src`, read from the tree, so a new package
    // is covered the day it lands.
    const packages = resolve(REPO_ROOT, 'packages');
    const declared = readdirSync(packages)
      .map((name) => resolve(packages, name, 'src'))
      .filter((root) => existsSync(root))
      .flatMap((root) =>
        readdirSync(root, { recursive: true, encoding: 'utf8' })
          .filter(
            (entry) =>
              /\.(?:ts|tsx|mts|cts)$/.test(entry) && !entry.endsWith('.d.ts'),
          )
          .map((entry) => resolve(root, entry)),
      )
      .flatMap((file) => [
        ...readFileSync(file, 'utf8').matchAll(
          /:\s*ValueFamily<[^=]*=\s*\{\s*name:\s*'([^']+)'/g,
        ),
      ])
      .map((match) => match[1]);
    expect(declared.toSorted()).toEqual(
      VALUE_FAMILIES.map(({ name }) => name).toSorted(),
    );
  });

  it('reads or retires every row kind ever stored', () => {
    // A kind deleted without a retirement would make every store that holds
    // it refuse to open. The list only grows: check-row-kinds-ever fails a
    // name the base branch lists and the tree does not.
    const { kinds } = Schema.decodeUnknownSync(
      Schema.Struct({ kinds: Schema.Array(Schema.String) }),
    )(
      JSON.parse(
        readFileSync(
          resolve(REPO_ROOT, 'config/storage/row-kinds-ever.json'),
          'utf8',
        ),
      ),
    );
    expect(kinds, 'kept sorted and unique').toEqual(
      [...new Set(kinds)].toSorted(),
    );
    const current = Object.keys(ROW_KINDS);
    expect(
      current.filter((kind) => !kinds.includes(kind)),
      'a new row kind is added to config/storage/row-kinds-ever.json',
    ).toEqual([]);
    expect(
      kinds.filter(
        (kind) => !current.includes(kind) && !RETIRED_ROW_KINDS.has(kind),
      ),
      'a deleted row kind moves to RETIRED_ROW_KINDS',
    ).toEqual([]);
    expect(
      [...RETIRED_ROW_KINDS.keys()].filter((kind) => !kinds.includes(kind)),
      'a retired row kind stays in config/storage/row-kinds-ever.json',
    ).toEqual([]);
  });

  it.each(VERSIONED)(
    '$name reads its released version',
    ({ name, version, schema }) => {
      const latest = released(name);
      if (latest === null) return;
      expect(
        version,
        `${name} v${latest} was released, and a released kind changes only as a new version with an upcaster from it, the first this build would carry`,
      ).toBe(latest);
      expect(
        fingerprint(schema),
        `${name} v${version} was released: change it as a new version with an upcaster`,
      ).toBe(readFileSync(resolve(FROZEN, `${name}.v${version}.json`), 'utf8'));
    },
  );

  it.runIf(FREEZING)('freezes every current version', () => {
    mkdirSync(FROZEN, { recursive: true });
    for (const { name, version, schema } of VERSIONED) {
      writeFileSync(
        resolve(FROZEN, `${name}.v${version}.json`),
        fingerprint(schema),
      );
    }
  });
});
