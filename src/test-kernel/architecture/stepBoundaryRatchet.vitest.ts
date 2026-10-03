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
 * there. The step (`src/agent/runtime/loop/step.ts`) is the one module that
 * applies the plugin switches to the live catalog, pins its tool,
 * continuation and prompt generations, installs the run's current step, and authors the
 * `tools.offered` row. Anything else doing one of these would change a
 * run's tools or continuation between steps, or change them unrecorded.
 * Failure modes guarded:
 *
 * - a host or tool pins the catalog, or applies the switches to it, and
 *   hands a run tools no step offered;
 * - a loop reads a continuation no step pinned, so goal mode switched off
 *   still opens turns, or switched on opens them unrecorded;
 * - a prompt builder reads the pinned sections itself, so a plugin switched
 *   off keeps its section or skills in the system text, or one switched on
 *   adds them unrecorded;
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
  {
    what: 'applies the plugin switches and pins a tool, continuation or prompt generation',
    pattern:
      /\b(?:registry|continuations|sections)\.pin\b|\bpinSwitched\(|\.(?:continuations|sections)\.entries\b/,
    // The catalog itself, which serializes the switch read with the pin, and
    // the process's plugin catalog layer, which applies a switch flipped in this
    // process to the catalog at once (it pins nothing past the call).
    also: ['src/tools/liveTools.ts', 'src/tools/pluginCatalog.ts'],
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
    // The run's loaded-plugin hold (MCP servers for its life); the VS Code
    // Copilot tools, which follow the current generation; the plugin
    // catalog's switch follower (above); the shutdown protocol's plugin
    // drain; the settings Git tab's read of the GitHub plugin's process
    // services. None offers a run anything or pins a generation.
    also: [
      'src/agent/runtime/run/AgentRun.ts',
      'src/tools/pluginCatalog.ts',
      'src/controllers/session/sessionLayer.ts',
      'src/controllers/settingsView/githubSubscriptions.ts',
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
    const missing = RULES.filter(({ pattern }) => !pattern.test(step)).map(
      ({ what }) => what,
    );
    expect(missing).toEqual([]);
  });

  it('actually scans the production source roots', () => {
    expectRealCoverage(ALL_HOST_PRODUCTION_ROOTS);
  });
});
