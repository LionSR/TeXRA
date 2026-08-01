// QA-2 host-side mock ratchet (issue #7684). Host suites (CLI + desktop, in
// src/test-kernel/cli and src/test-kernel/desktop) reach into `@agent/*`
// internals via `mock('@agent/...')` or `doMock('@agent/...')` — on `vi` or on
// a suite's `createModuleMocks()` recorder — pinning agent's current internal
// module layout from outside src/agent.
// Clones the checked-in-baseline +
// AST-scanning vitest pattern from LAY-1 (subsystemEdgeRatchet.vitest.ts,
// PR #7774): baseline the current site count and fail only on an increase;
// a decrease (or an @agent restructor removing the need for a mock) is
// always welcome and should shrink
// config/ratchets/host-agent-mock-baseline.json.

// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, sourceFilesUnder, toRepoPath } from '../support/repoScan';

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

const BASELINE_FILE = 'config/ratchets/host-agent-mock-baseline.json';
const BASELINE_PATH = resolve(REPO_ROOT, BASELINE_FILE);

const HOST_DIRS = [
  resolve(REPO_ROOT, 'src/test-kernel/cli'),
  resolve(REPO_ROOT, 'src/test-kernel/desktop'),
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
  const sourceFile = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

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

function collectHostAgentMockSites(): MockSite[] {
  return HOST_DIRS.flatMap((dir) =>
    sourceFilesUnder(dir).flatMap(collectAgentMockSites),
  ).toSorted(compareSites);
}

function countSitesByForm(sites: MockSite[]): Record<MockForm, number> {
  const counts: Record<MockForm, number> = { mock: 0, doMock: 0 };
  for (const { form } of sites) {
    if (!(form in counts)) {
      throw new Error(
        `${BASELINE_FILE} entry has unknown form ${JSON.stringify(form)} — expected one of: ${MOCK_FORMS.join(', ')}`,
      );
    }
    counts[form] += 1;
  }
  return counts;
}

function readBaseline(): MockBaseline {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as MockBaseline;
}

describe('QA-2 host-side @agent mock ratchet', () => {
  it("does not increase the count of either mock or doMock('@agent/...') sites in CLI/desktop suites", () => {
    const baseline = readBaseline();
    const current = collectHostAgentMockSites();
    const baselineCounts = countSitesByForm(baseline.sites);
    const currentCounts = countSitesByForm(current);

    for (const form of MOCK_FORMS) {
      expect(
        currentCounts[form],
        `host-side @agent ${form} sites grew from ${baselineCounts[form]} to ${currentCounts[form]}:\n` +
          `${current
            .filter((site) => site.form === form)
            .map((site) => `${site.file}: ${site.form}('${site.specifier}')`)
            .join('\n')}\n\n` +
          `If this growth is intentional, update ${BASELINE_FILE} in this PR.`,
      ).toBeLessThanOrEqual(baselineCounts[form]);
    }
  });

  it('keeps the baseline ordered (an empty baseline is a valid, welcome outcome)', () => {
    const baseline = readBaseline();
    const sortedSites = baseline.sites.toSorted(compareSites);

    expect(baseline.sites).toEqual(sortedSites);
  });
});
