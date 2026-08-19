// QA-2 host-side mock ratchet (issue #7684, entry-based check #9731). Host
// suites (CLI + desktop, in src/test-kernel/cli and src/test-kernel/desktop)
// and the shared support modules extracted from them (#10361, in
// src/test-kernel/support) reach into `@agent/*` internals via
// `mock('@agent/...')` or
// `doMock('@agent/...')` — on `vi` or on a suite's `createModuleMocks()`
// recorder — pinning agent's current internal module layout from outside
// src/agent.
//
// The ratchet is entry-based on the (file, form, specifier) tuple: a live site
// absent from the baseline is a new edge; a baseline entry with no live site
// is stale headroom that could silently absorb a future new edge. Regenerating
// to remove stale entries (or retiring a mock) is welcome and should shrink
// config/ratchets/host-agent-mock-baseline.json.

// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  parseSourceFile,
  REPO_ROOT,
  sourceFilesUnder,
  toRepoPath,
} from '../support/repoScan';

const MOCK_FORMS = ['mock', 'doMock'] as const;

type MockForm = (typeof MOCK_FORMS)[number];

interface MockSite {
  file: string;
  form: MockForm;
  specifier: string;
}

interface MockBaseline {
  semantics: string;
  sites: MockSite[];
}

function compareSites(a: MockSite, b: MockSite): number {
  return (
    a.file.localeCompare(b.file) ||
    a.form.localeCompare(b.form) ||
    a.specifier.localeCompare(b.specifier)
  );
}

function siteKey(site: MockSite): string {
  return `${site.file}\0${site.form}\0${site.specifier}`;
}

function formatSite(site: MockSite): string {
  return `${site.file}: ${site.form}('${site.specifier}')`;
}

const BASELINE_FILE = 'config/ratchets/host-agent-mock-baseline.json';
const BASELINE_PATH = resolve(REPO_ROOT, BASELINE_FILE);

const HOST_DIRS = [
  resolve(REPO_ROOT, 'src/test-kernel/cli'),
  resolve(REPO_ROOT, 'src/test-kernel/desktop'),
  // The shared mock modules the host suites import; #10361 moved the last
  // live `@agent/*` registrations here, out of the per-host dirs (#10376).
  resolve(REPO_ROOT, 'src/test-kernel/support'),
];

const AGENT_SPECIFIER = /^@agent(?:\/|$)/;

function mockFormFromCall(
  node: ts.Node,
): { call: ts.CallExpression; form: MockForm } | null {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(node.expression) ||
    !ts.isIdentifier(node.expression.expression)
  ) {
    return null;
  }

  switch (node.expression.name.text) {
    case 'mock':
    case 'doMock':
      return { call: node, form: node.expression.name.text };
    default:
      return null;
  }
}

function collectAgentMockSites(file: string): MockSite[] {
  const sourceFile = parseSourceFile(file);

  const sites: MockSite[] = [];
  const visit = (node: ts.Node): void => {
    const mock = mockFormFromCall(node);
    if (mock != null) {
      const [specifierArg] = mock.call.arguments;
      if (specifierArg != null && ts.isStringLiteralLike(specifierArg)) {
        const specifier = specifierArg.text;
        if (AGENT_SPECIFIER.test(specifier)) {
          sites.push({ file: toRepoPath(file), form: mock.form, specifier });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

/** Distinct (file, form, specifier) mock edges, sorted. */
function collectHostAgentMockSites(): MockSite[] {
  const byKey = new Map<string, MockSite>();
  for (const dir of HOST_DIRS) {
    for (const file of sourceFilesUnder(dir)) {
      for (const site of collectAgentMockSites(file)) {
        byKey.set(siteKey(site), site);
      }
    }
  }
  return [...byKey.values()].toSorted(compareSites);
}

function readBaseline(): MockBaseline {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as MockBaseline;
}

function assertKnownForms(sites: readonly MockSite[]): void {
  for (const { form } of sites) {
    if (!(MOCK_FORMS as readonly string[]).includes(form)) {
      throw new Error(
        `${BASELINE_FILE} entry has unknown form ${JSON.stringify(form)} — expected one of: ${MOCK_FORMS.join(', ')}`,
      );
    }
  }
}

describe('QA-2 host-side @agent mock ratchet', () => {
  const baseline = readBaseline();
  const current = collectHostAgentMockSites();

  it('rejects any live @agent mock edge that is not in the baseline', () => {
    assertKnownForms(baseline.sites);
    assertKnownForms(current);
    const baselineKeys = new Set(baseline.sites.map(siteKey));
    const added = current.filter((site) => !baselineKeys.has(siteKey(site)));

    expect(
      added,
      `New host-side @agent mock edge(s) not in ${BASELINE_FILE}:\n` +
        added.map((site) => `  + ${formatSite(site)}`).join('\n') +
        `\n\nIf this growth is intentional, update ${BASELINE_FILE} in this PR.`,
    ).toEqual([]);
  });

  it('rejects baseline entries with no live site (stale headroom)', () => {
    const currentKeys = new Set(current.map(siteKey));
    const stale = baseline.sites.filter(
      (site) => !currentKeys.has(siteKey(site)),
    );

    expect(
      stale,
      `Stale host-side @agent mock baseline entries in ${BASELINE_FILE}:\n` +
        stale.map((site) => `  - ${formatSite(site)}`).join('\n') +
        `\n\nRemove them from ${BASELINE_FILE} so they cannot absorb a future new edge.`,
    ).toEqual([]);
  });

  it('keeps the baseline ordered and duplicate-free (an empty baseline is a valid, welcome outcome)', () => {
    const sortedUnique = [
      ...new Map(baseline.sites.map((site) => [siteKey(site), site])).values(),
    ].toSorted(compareSites);

    expect(baseline.sites).toEqual(sortedUnique);
  });
});
