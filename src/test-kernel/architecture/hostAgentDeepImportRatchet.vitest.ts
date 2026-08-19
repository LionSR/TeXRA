// R-b host deep-import ratchet (issue #7684). Each host package (CLI,
// desktop, extension) reaches past the `@agent` barrel into `@agent/*`
// internals, pinning agent's current internal module layout from outside
// src/agent. `agent` here is the `@texra-ai/agent` SDK package itself
// (packages/agent/src): it assembles the public run surface from `@agent/*`
// internals, so its own distinct-specifier set is exactly the surface a
// Tier-1 barrel would have to re-export or seal. Clones the
// checked-in-baseline + AST-scanning vitest pattern from LAY-1
// (subsystemEdgeRatchet.vitest.ts, PR #7774) and the set-based two-check
// form from QA-2 (hostAgentMockRatchet.vitest.ts, PR #7817): the baseline
// is the exact set of DISTINCT `@agent/*` deep-import specifiers per
// package. A live specifier absent from the baseline is a new edge; a
// baseline specifier with no live import is stale headroom that could
// silently absorb a future new edge (under the old count-only form, any
// specifier could swap for any other). Removing a deep import (or an
// @agent restructor that removes the need for one) is always welcome and
// should shrink config/ratchets/host-agent-import-baseline.json.

// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

import {
  collectModuleSpecifiers,
  parseSourceFile,
  REPO_ROOT,
  sourceFilesUnder,
} from '../support/repoScan';

const HOSTS = ['cli', 'desktop', 'extension', 'agent'] as const;

type Host = (typeof HOSTS)[number];

interface HostBaseline {
  semantics: string;
  hosts: Record<Host, string[]>;
}

const BASELINE_FILE = 'config/ratchets/host-agent-import-baseline.json';
const BASELINE_PATH = resolve(REPO_ROOT, BASELINE_FILE);

const HOST_DIRS: Record<Host, string> = {
  cli: resolve(REPO_ROOT, 'packages/cli/src'),
  desktop: resolve(REPO_ROOT, 'packages/desktop/src'),
  extension: resolve(REPO_ROOT, 'packages/extension/src'),
  agent: resolve(REPO_ROOT, 'packages/agent/src'),
};

const AGENT_DEEP_IMPORT = /^@agent\//;

function sortedSpecifiers(specifiers: Iterable<string>): string[] {
  return [...specifiers].toSorted((a, b) => a.localeCompare(b));
}

function collectAgentDeepImportSpecifiers(file: string): string[] {
  return collectModuleSpecifiers(parseSourceFile(file)).filter((specifier) =>
    AGENT_DEEP_IMPORT.test(specifier),
  );
}

function collectHostAgentDeepImportSpecifiers(host: Host): string[] {
  const specifiers = new Set<string>();
  for (const file of sourceFilesUnder(HOST_DIRS[host])) {
    for (const specifier of collectAgentDeepImportSpecifiers(file)) {
      specifiers.add(specifier);
    }
  }
  return sortedSpecifiers(specifiers);
}

function collectCurrentHosts(): Record<Host, string[]> {
  const hosts = {} as Record<Host, string[]>;
  for (const host of HOSTS) {
    hosts[host] = collectHostAgentDeepImportSpecifiers(host);
  }
  return hosts;
}

function readBaseline(): HostBaseline {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as HostBaseline;
}

describe('R-b host deep-import ratchet', () => {
  // Scanned once for the whole suite — the per-host cases and the baseline
  // invariants read the same snapshot instead of rescanning three trees per
  // it.each case.
  const baseline = readBaseline();
  const current = collectCurrentHosts();

  it.each(HOSTS)(
    'rejects any @agent/* deep-import specifier in %s that is not in the baseline',
    (host) => {
      const baselineSet = new Set(baseline.hosts[host]);
      const added = current[host].filter(
        (specifier) => !baselineSet.has(specifier),
      );
      expect(
        added,
        `New ${host} @agent/* deep-import specifier(s) not in ${BASELINE_FILE}:\n` +
          added.map((specifier) => `  + ${specifier}`).join('\n') +
          `\n\nRemove the import or route it through an approved public surface; do not widen ${BASELINE_FILE}.`,
      ).toEqual([]);
    },
  );

  it.each(HOSTS)(
    'rejects baseline specifiers with no live %s import (stale headroom)',
    (host) => {
      const currentSet = new Set(current[host]);
      const stale = baseline.hosts[host].filter(
        (specifier) => !currentSet.has(specifier),
      );
      expect(
        stale,
        `Stale ${host} specifier(s) in ${BASELINE_FILE}:\n` +
          stale.map((specifier) => `  - ${specifier}`).join('\n') +
          `\n\nRemove them from ${BASELINE_FILE} so they cannot absorb a future new edge.`,
      ).toEqual([]);
    },
  );

  it('keeps the baseline ordered and duplicate-free per host (an empty list is a valid, welcome outcome)', () => {
    for (const host of HOSTS) {
      // Sorted AND distinct: a duplicated entry would inflate the allowed
      // count and silently weaken the ratchet.
      const sortedUnique = sortedSpecifiers(new Set(baseline.hosts[host]));
      expect(baseline.hosts[host], `${BASELINE_FILE} hosts.${host}`).toEqual(
        sortedUnique,
      );
    }
  });
});
