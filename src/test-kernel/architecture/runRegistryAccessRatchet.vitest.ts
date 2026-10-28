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
 * A session's runs reach hosts and tools as `Runs` alone (`RunsShape`:
 * launch, resume, stop, get). The registry behind them (`RunRegistry`, and
 * `registryOf` that reaches it) is the harness internals' own: the run loop,
 * its lifecycle and child loops, the session layer that builds and closes
 * the runs, and the delegation helpers that are no tool. Failure mode
 * guarded: a host or a tool imports the registry and drives a run past the
 * one surface (tracks a handle, interrupts a fiber, skips a stop's child
 * policy). The list names files, and only shrinks.
 */
const REGISTRY_IMPORTERS: Readonly<Record<string, string>> = {
  // The session layer builds each session's registry and closes it.
  'packages/harness/src/controllers/session/sessionLayer.ts': 'session layer',
  // A deletion is an inactive-run step on the registry's lane.
  'packages/harness/src/controllers/session/SessionRequests.ts':
    'session layer',
  // The run loop: its birth.
  'packages/harness/src/agent/runtime/loop/runProgram.ts': 'run loop',
  // The lifecycle tracks and untracks a run's handle.
  'packages/harness/src/agent/runtime/AgentRunLifecycle.ts': 'run lifecycle',
  // A root launch and a resume start their runs at the door.
  'packages/harness/src/agent/runtime/rootLaunch.ts': 'run lifecycle',
  'packages/harness/src/agent/runtime/resumeRun.ts': 'run lifecycle',
  // A child loop reserves its stop target and its budget.
  'packages/harness/src/agent/runtime/childRunLoop.ts': 'child loop',
  // A native child runs the session's run programs.
  'packages/harness/src/agent/runtime/nativeSubagentStrategy.ts': 'child loop',
  // A follow-up's routing and the wake's fork onto the session.
  'packages/harness/src/agent/followUp/ToolUseFollowUp.ts': 'follow-ups',
  // The SDK's run handle interrupts the fiber it handed over.
  'packages/harness/src/effect/runHandle.ts': 'SDK run handle',
  // Delegation helpers, no tool: a child's handle, an in-band child's stop.
  'packages/harness/src/tools/delegation/childRun.ts': 'delegation helper',
  'packages/harness/src/tools/delegation/inBandSubagentRun.ts':
    'delegation helper',
};

// A named import of either, or the whole module under a namespace.
const REGISTRY_IMPORT =
  /import\s*(?:type\s*)?(?:\{[^}]*\b(?:registryOf|RunRegistry)\b[^}]*\}|\*\s*as\s+\w+)\s*from\s*'[^']*runRegistry'/;

describe('run registry access', () => {
  it('reaches the registry from the named harness internals alone', () => {
    const importers = ALL_HOST_PRODUCTION_ROOTS.flatMap(productionFilesUnder)
      .filter((file) =>
        REGISTRY_IMPORT.test(
          stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf8')),
        ),
      )
      .toSorted();
    expect(
      importers.filter((file) => REGISTRY_IMPORTERS[file] === undefined),
      'a host or a tool reaches runs through `Runs` (launch, resume, stop, get); the registry is the harness internals’',
    ).toEqual([]);
    expect(
      Object.keys(REGISTRY_IMPORTERS).filter(
        (file) => !importers.includes(file),
      ),
      'a file that no longer imports the registry leaves REGISTRY_IMPORTERS',
    ).toEqual([]);
  });

  it('actually scans the production source roots', () => {
    expectRealCoverage(ALL_HOST_PRODUCTION_ROOTS);
  });
});
