// QA-2 host-side mock ratchet (issue #7684). Host suites (CLI + desktop, in
// src/test-kernel/cli and src/test-kernel/desktop) reach into `@agent/*`
// internals via `vi.mock('@agent/...')`, pinning agent's current internal
// module layout from outside src/agent. Clones the checked-in-baseline +
// AST-scanning vitest pattern from LAY-1 (subsystemEdgeRatchet.vitest.ts,
// PR #7774): baseline the current site count and fail only on an increase;
// a decrease (or an @agent restructor removing the need for a mock) is
// always welcome and should shrink host-agent-mock-baseline.json.

// Node imports
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

interface MockSite {
  file: string;
  specifier: string;
}

interface MockBaseline {
  semantics: string;
  sites: MockSite[];
}

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);
const BASELINE_PATH = resolve(REPO_ROOT, 'host-agent-mock-baseline.json');

const HOST_DIRS = [
  resolve(REPO_ROOT, 'src/test-kernel/cli'),
  resolve(REPO_ROOT, 'src/test-kernel/desktop'),
];

const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/;
const AGENT_SPECIFIER = /^@agent(?:\/|$)/;

function repoRelative(path: string): string {
  return relative(REPO_ROOT, path).replaceAll('\\', '/');
}

function sourceFilesUnder(dir: string): string[] {
  return (readdirSync(dir, { recursive: true }) as string[])
    .filter((entry) => SOURCE_FILE.test(entry) && !entry.endsWith('.d.ts'))
    .map((entry) => join(dir, entry));
}

function isViMockCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    ts.isIdentifier(node.expression.expression) &&
    node.expression.expression.text === 'vi' &&
    node.expression.name.text === 'mock'
  );
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
    if (isViMockCall(node)) {
      const [specifierArg] = node.arguments;
      if (specifierArg != null && ts.isStringLiteralLike(specifierArg)) {
        const specifier = specifierArg.text;
        if (AGENT_SPECIFIER.test(specifier)) {
          sites.push({ file: repoRelative(file), specifier });
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
  ).toSorted(
    (a, b) =>
      a.file.localeCompare(b.file) || a.specifier.localeCompare(b.specifier),
  );
}

function readBaseline(): MockBaseline {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as MockBaseline;
}

describe('QA-2 host-side @agent mock ratchet', () => {
  it("does not increase the count of vi.mock('@agent/...') sites in CLI/desktop suites", () => {
    const baseline = readBaseline();
    const current = collectHostAgentMockSites();

    expect(
      current.length,
      `host-side @agent mock sites grew from ${baseline.sites.length} to ${current.length}:\n` +
        `${current.map((site) => `${site.file}: ${site.specifier}`).join('\n')}\n\n` +
        'If this growth is intentional, update host-agent-mock-baseline.json in this PR.',
    ).toBeLessThanOrEqual(baseline.sites.length);
  });

  it('keeps the baseline non-empty and ordered', () => {
    const baseline = readBaseline();
    const sortedSites = baseline.sites.toSorted(
      (a, b) =>
        a.file.localeCompare(b.file) || a.specifier.localeCompare(b.specifier),
    );

    expect(baseline.sites.length).toBeGreaterThan(0);
    expect(baseline.sites).toEqual(sortedSites);
  });
});
