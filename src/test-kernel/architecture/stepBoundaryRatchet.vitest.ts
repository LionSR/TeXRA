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
 * Invariant 7 of the core concepts: a run's tools, continuation and prompt
 * contributions change only at a step boundary, and the change is recorded
 * there. The step (`packages/harness/src/agent/runtime/loop/step.ts`) is the one module that
 * reads the plugin switches and pins the tools they give in its session's
 * catalog, with the plugins on (whose continuations and prompt sections it
 * reads), installs the run's current step, and authors the
 * `tools.offered` row. Anything else doing one of these would change a
 * run's tools or continuation between steps, or change them unrecorded.
 * Failure modes guarded:
 *
 * - a host or tool pins the catalog and hands a run tools no step offered;
 * - a loop reads a continuation no step pinned, so goal mode switched off
 *   still opens turns, or switched on opens them unrecorded;
 * - a prompt builder reads the pinned sections itself, so a plugin switched
 *   off keeps its section or skills in the system text, or one switched on
 *   adds them unrecorded;
 * - code outside the step swaps `run.steps`, so a dispatch runs against a
 *   set no `tools.offered` row records;
 * - a second author of `tools.offered` records a set no step offered.
 */
const STEP = 'packages/harness/src/agent/runtime/loop/step.ts';

const RULES: readonly {
  readonly what: string;
  readonly pattern: RegExp;
  /** Files allowed to match, besides the step. */
  readonly also: readonly string[];
  /** The step itself does not match (a door only others may not use). */
  readonly notInStep?: true;
}[] = [
  {
    what: 'reads the plugin switches and pins the tools they give and the plugins on',
    pattern: /\.tools\s*\.pin\(/,
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
    what: 'reads the tool catalog service',
    pattern: /yield\*\s*\(?\s*(?:yield\*\s*)?ToolCatalog\b/,
    notInStep: true,
    // The session layer, which builds each session's catalog and runs the
    // shutdown protocol's plugin drain; the VS Code Copilot tools, which
    // follow the built-in tools as the switches stand; the settings Git
    // tab's read of the GitHub plugin's process services. None offers a run
    // anything or pins a step's tools.
    also: [
      'packages/harness/src/controllers/session/sessionLayer.ts',
      'packages/texra/src/controllers/settingsView/githubSubscriptions.ts',
      // The availability probes, which run each plugin's probe with its
      // own process services while its layer is up; they pin nothing.
      'packages/harness/src/tools/toolAvailability.ts',
      'packages/extension/src/frontend/lm/registerLanguageModelTools.ts',
    ],
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
    const missing = RULES.filter(
      ({ pattern, notInStep }) => !notInStep && !pattern.test(step),
    ).map(({ what }) => what);
    expect(missing).toEqual([]);
  });

  it('actually scans the production source roots', () => {
    expectRealCoverage(ALL_HOST_PRODUCTION_ROOTS);
  });
});
