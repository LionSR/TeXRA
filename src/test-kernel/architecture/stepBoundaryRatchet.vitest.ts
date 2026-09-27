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
 * Invariant 7 of the core concepts: a run's tools change only at a step
 * boundary, and the change is recorded there. The step
 * (`src/agent/runtime/loop/step.ts`) is the one module that applies the
 * plugin switches to the live catalog, pins a generation, installs the
 * run's current step, and authors the `tools.offered` row. Anything else
 * doing one of these would change a run's tools between steps, or change
 * them unrecorded. Failure modes guarded:
 *
 * - a host or tool pins the catalog, or syncs the switches into it, and
 *   hands a run tools no step offered;
 * - code outside the step swaps `run.steps`, so a dispatch runs against a
 *   set no `tools.offered` row records;
 * - a second author of `tools.offered` records a set no step offered.
 */
const STEP = 'src/agent/runtime/loop/step.ts';

const RULES: readonly {
  readonly what: string;
  readonly pattern: RegExp;
  /** Files allowed to match, besides the step. */
  readonly also: readonly string[];
}[] = [
  { what: 'pins a catalog generation', pattern: /\bregistry\.pin\b/, also: [] },
  {
    what: 'applies the plugin switches to the live catalog',
    pattern: /\b(?:live|LiveTools)\b[^;]*?\.sync\(/,
    also: [],
  },
  {
    what: "writes a run's current step",
    pattern:
      /SynchronizedRef\.(?:set|getAndSet|update\w*|modify\w*)\(\s*run\.steps\b/,
    also: [],
  },
  {
    what: 'authors a tools.offered row',
    pattern: /type:\s*'tools\.offered'/,
    also: [],
  },
  {
    what: 'reads the live catalog service',
    pattern: /yield\*\s*\(?\s*(?:yield\*\s*)?LiveTools\b/,
    // The run's loaded-plugin hold (MCP servers for its life); it offers
    // nothing and pins no generation.
    also: ['src/agent/runtime/run/AgentRun.ts'],
  },
];

function source(file: string): string {
  return stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf8'));
}

describe('step boundary (invariant 7)', () => {
  it('changes and records a run’s tools only in the step', () => {
    const files = ALL_HOST_PRODUCTION_ROOTS.flatMap(productionFilesUnder);
    const offenders = RULES.flatMap(({ what, pattern, also }) =>
      files
        .filter((file) => file !== STEP && !also.includes(file))
        .filter((file) => pattern.test(source(file)))
        .map((file) => `${file} ${what}`),
    );
    expect(
      offenders,
      'a run’s tools change only where a step opens (loop/step.ts): route the change through the step',
    ).toEqual([]);
  });

  it('finds each rule in the step itself', () => {
    const step = source(STEP);
    const missing = RULES.filter(({ pattern }) => !pattern.test(step)).map(
      ({ what }) => what,
    );
    expect(missing).toEqual([]);
  });

  it('actually scans the production source roots', () => {
    expectRealCoverage(ALL_HOST_PRODUCTION_ROOTS);
  });
});
