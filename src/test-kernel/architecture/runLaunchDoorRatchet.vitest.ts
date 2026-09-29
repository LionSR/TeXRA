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
 * Rule R2 of the core concepts: every run starts through one door,
 * `Runs.launch`, forked from the session's context. Every Effect fork starts
 * with its caller's context, so a run forked from a tool call reads that
 * call's run-scoped services as its own (#13348). In the run and tool trees a
 * detached or keyed fork is therefore a launch until it proves otherwise: the
 * sites below are the ones that start no run, each counted, and the counts
 * only shrink. A new one either launches through `Runs.launch` or joins this
 * list with its reason in the same PR.
 */
const LAUNCH_ROOTS = ['src/agent', 'src/tools', 'packages/agent/src'] as const;

const DETACHED_FORK = /\b(?:forkDetach|FiberMap\.run|FiberSet\.run)\s*\(/g;

const DETACHED_FORK_ALLOWLIST: Readonly<Record<string, number>> = {
  // A host presentation notice, reported rather than awaited.
  'src/agent/runtime/HostInteractions.ts': 1,
  // The host's `onRun` observer, which may last as long as the run.
  'src/agent/runtime/AgentRunLifecycle.ts': 1,
  // A late child-loop failure's diagnosis, joined on the launched fiber.
  'src/tools/delegation/detachedChildRun.ts': 1,
  // A GitHub delivery into its poller's own set.
  'src/tools/github/PollingSourceBase.ts': 1,
  // The package boundary: the awaiter of `runAgent` (whose run starts at
  // the door) and the view drain a `Run` owns.
  'packages/agent/src/effect/sessionPrograms.ts': 2,
};

/**
 * `Effect.serviceOption` hides its requirement from `R`, so an inherited
 * run- or session-lifetime tag never shows up in a type (#13348). It stays
 * allowed only for optional process ports.
 */
const SERVICE_OPTION = /\bEffect\.serviceOption\(\s*([A-Za-z_$][\w$]*)/g;

const OPTIONAL_PROCESS_PORTS = new Set([
  'InlineComments',
  'SupabaseAuth',
  'ToolMissingReporter',
]);

function source(file: string): string {
  return stripComments(readFileSync(resolve(REPO_ROOT, file), 'utf8'));
}

describe('run launch door (R2)', () => {
  it('starts no run from a detached or keyed fork in the run and tool trees', () => {
    const counts = new Map<string, number>();
    for (const file of LAUNCH_ROOTS.flatMap(productionFilesUnder)) {
      const found = source(file).match(DETACHED_FORK)?.length ?? 0;
      if (found > 0) counts.set(file, found);
    }
    const drift = [
      ...new Set([...counts.keys(), ...Object.keys(DETACHED_FORK_ALLOWLIST)]),
    ]
      .toSorted()
      .flatMap((file) => {
        const found = counts.get(file) ?? 0;
        const allowed = DETACHED_FORK_ALLOWLIST[file] ?? 0;
        return found === allowed
          ? []
          : [`${file}: allowlisted ${allowed}, found ${found}`];
      });
    expect(
      drift,
      'launch a run through Runs.launch; a fork that starts no run joins DETACHED_FORK_ALLOWLIST with its reason, and a removed one lowers its count',
    ).toEqual([]);
  });

  it('reads no run- or session-lifetime tag through Effect.serviceOption', () => {
    const offenders = ALL_HOST_PRODUCTION_ROOTS.flatMap(productionFilesUnder)
      .flatMap((file) =>
        [...source(file).matchAll(SERVICE_OPTION)]
          .map((match) => match[1]!)
          .filter((tag) => !OPTIONAL_PROCESS_PORTS.has(tag))
          .map((tag) => `${file}: ${tag}`),
      )
      .toSorted();
    expect(
      offenders,
      'read a run- or session-lifetime service with `yield* Tag`; serviceOption is for optional process ports only',
    ).toEqual([]);
  });

  it('actually scans the production source roots', () => {
    expectRealCoverage(LAUNCH_ROOTS);
    expectRealCoverage(ALL_HOST_PRODUCTION_ROOTS);
  });
});
