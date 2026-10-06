// Node imports
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { DESKTOP_PROJECTS } from '@desktop/main/desktopProjectRecords';
import { INQUIRY_THREADS } from '@shared/plugins/externalInquiry';
import {
  CURRENT_VALUE_VERSION,
  RETIRED_ROW_KINDS,
  ROW_KINDS,
  SessionEventDraftSchema,
} from '@shared/schemas';
import {
  APP_STATE,
  REPO_STATE,
  WORKSPACE_STORES,
} from '@shared/session/valueFamily';
import { UPDATE_CHECKS } from '@texra/utils/system/updateCheck';
import { PLUGIN_ARMS } from '@tools/pluginArms';
import {
  productionFilesUnder,
  productionRoots,
  REPO_ROOT,
} from '../support/repoScan';

/**
 * The release watermark of the session store
 * (`.agents/docs/proposed/architecture/2026-09-28-storage-v1-design.md` §3):
 * `config/storage/frozen/<name>.v<N>.json` is the JSON Schema of version N of
 * a row kind, plugin arm or current-value family as a release shipped it, and
 * the highest N frozen is that name's released version. A later build reads
 * a released version forever, so its schema never changes in place: a change
 * is a new version with an upcaster from the released one.
 *
 * `npm run storage:freeze` (vitest `--mode freeze`, a `releasing` step)
 * writes each name's current version, which moves the watermark.
 */
const FROZEN = resolve(REPO_ROOT, 'config/storage/frozen');
const FREEZING = process.env.MODE === 'freeze';

interface Versioned {
  readonly name: string;
  readonly version: number;
  /** The upcasters from version 1, `upcast[i]` taking `i + 1` to `i + 2`. */
  readonly upcasts: number;
  readonly schema: z.ZodType;
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
];

const VERSIONED: readonly Versioned[] = [
  ...SessionEventDraftSchema.options.map((arm) => {
    const kind = ROW_KINDS[arm.shape.type.value];
    return {
      name: arm.shape.type.value,
      version: kind.version,
      upcasts: kind.upcast.length,
      schema: arm,
    };
  }),
  ...[...PLUGIN_ARMS].map(([name, arm]) => ({
    name: `plugin.fact.${name.replace('/', '.')}`,
    version: arm.version,
    upcasts: arm.upcasters.length,
    schema: arm.schema,
  })),
  ...VALUE_FAMILIES.map(({ name, schema }) => ({
    name: `current-value.${name.replace('/', '.')}`,
    version: CURRENT_VALUE_VERSION,
    upcasts: 0,
    schema,
  })),
];

/** A version's fingerprint: its schema as JSON Schema, as the store reads it. */
const fingerprint = (schema: z.ZodType): string =>
  `${JSON.stringify(
    z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }),
    null,
    2,
  )}\n`;

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
    const declared = productionRoots()
      .flatMap(productionFilesUnder)
      .flatMap((file) => [
        ...readFileSync(resolve(REPO_ROOT, file), 'utf8').matchAll(
          /:\s*ValueFamily<[^=]*=\s*\{\s*name:\s*'([^']+)'/g,
        ),
      ])
      .map((match) => match[1]);
    expect(declared.toSorted()).toEqual(
      VALUE_FAMILIES.map(({ name }) => name).toSorted(),
    );
  });

  it('reads or retires every row kind ever stored', () => {
    // Append-only: a kind deleted without a retirement would make every
    // store that holds it refuse to open, so a name never leaves the list.
    const { kinds } = z
      .object({ kinds: z.array(z.string()) })
      .parse(
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
  });

  it.each(VERSIONED)(
    '$name reads its released version',
    ({ name, version, upcasts, schema }) => {
      const floor = released(name);
      if (floor === null) return;
      expect(version, `${name} is below its released version`).toBe(
        Math.max(version, floor),
      );
      if (version > floor) {
        expect(
          upcasts,
          `${name} v${floor} has no upcaster chain to v${version}`,
        ).toBeGreaterThanOrEqual(version - 1);
        return;
      }
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
