// Refuted-candidate shape ratchet (refactorability gates,
// .agents/docs/proposed/process/2026-09-20-agent-refactorability-gates.md
// section 2). The rulings that refused `withPerKeyLane` onto `Semaphore` and
// `ModelRetryGate` onto `Schedule` are prose, so every autonomous pass
// re-proposes them. config/ratchets/refuted-candidates.json holds them as
// data; this suite pins each refused symbol's shape against it.
//
// It is one of two enforcement points, because a pure-tier suite has no PR
// body: the other is .github/workflows/refuted-candidates.yml, which fails a
// PR that touches one of these declarations without citing the ruling id.
// This suite also proves that gate can still find every symbol, so a rename
// fails here rather than making the workflow silently blind.
//
// Neither gate forbids the change. They require the author to have read the
// ruling: a candidate that lands on NEW evidence updates or deletes its entry
// in the same PR.

// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Third-party imports
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { parseSourceFile, REPO_ROOT } from '../support/repoScan';

const { locateSymbol } = await import(
  // @ts-expect-error This internal JavaScript script intentionally has no declaration file.
  '../../../scripts/refutedCandidates.mjs'
);

const BASELINE_FILE = 'config/ratchets/refuted-candidates.json';

interface RefutedSymbol {
  file: string;
  symbol: string;
  signature: string;
}

interface RefutedCandidate {
  id: string;
  candidate: string;
  why: string;
  ruling: string;
  symbols: RefutedSymbol[];
}

interface RefutedBaseline {
  semantics: string;
  candidates: RefutedCandidate[];
}

/** The block body `node` carries, if it is a declaration that has one. */
function functionBody(node: ts.Node): ts.Block | undefined {
  const declaration =
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
      ? node
      : undefined;
  return declaration?.body && ts.isBlock(declaration.body)
    ? declaration.body
    : undefined;
}

/** The body blocks inside `node`, including its own, as [start, end) ranges. */
function bodyRanges(node: ts.Node): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  const visit = (current: ts.Node): void => {
    const body = functionBody(current);
    if (body) {
      ranges.push([body.getStart(), body.end] as const);
      // Nested functions sit inside a range that is already elided.
      return;
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return ranges;
}

/** Drop comments so a reworded JSDoc is not read as a change of shape. Naive
 *  `//` stripping, the same rule repoScan.stripComments uses. */
function stripComments(text: string): string {
  return text
    .replaceAll(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => {
      const commentStart = line.indexOf('//');
      return commentStart === -1 ? line : line.slice(0, commentStart);
    })
    .join('\n');
}

/**
 * A declaration's shape: its own source with every function body replaced by
 * `{…}`, comments dropped and whitespace collapsed. A reformatted or
 * re-commented declaration reads as unchanged; a renamed parameter, a changed
 * type, a new method or a converted return channel does not.
 */
function signatureOf(sourceFile: ts.SourceFile, node: ts.Node): string {
  const text = sourceFile.text;
  let out = '';
  let cursor = node.getStart(sourceFile);
  for (const [from, to] of bodyRanges(node).toSorted((a, b) => a[0] - b[0])) {
    if (from < cursor) continue;
    out += `${text.slice(cursor, from)}{…}`;
    cursor = to;
  }
  out += text.slice(cursor, node.end);
  return stripComments(out).replaceAll(/\s+/g, ' ').trim();
}

/** The top-level declaration of `symbol`, or undefined when it is gone. */
function findDeclaration(
  sourceFile: ts.SourceFile,
  symbol: string,
): ts.Node | undefined {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isClassDeclaration(node) ||
        ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) ||
        ts.isEnumDeclaration(node)) &&
      node.name?.text === symbol
    ) {
      found = node;
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === symbol
    ) {
      // Pin the whole statement, so `export const` reads as part of the shape.
      found = node.parent.parent;
      return;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return found;
}

function readBaseline(): RefutedBaseline {
  return JSON.parse(
    readFileSync(resolve(REPO_ROOT, BASELINE_FILE), 'utf8'),
  ) as RefutedBaseline;
}

const baseline = readBaseline();
/** One case per refused symbol, flattened so the case name can name both. */
const cases = baseline.candidates.flatMap((candidate) =>
  candidate.symbols.map((entry) => ({
    id: candidate.id,
    candidate: candidate.candidate,
    why: candidate.why,
    ruling: candidate.ruling,
    ...entry,
  })),
);

describe('refuted-candidate shape ratchet', () => {
  it('has at least one candidate and no duplicate ids', () => {
    const ids = baseline.candidates.map((candidate) => candidate.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it.each(cases)('$id: pins the shape of $symbol', (entry) => {
    const sourceFile = parseSourceFile(resolve(REPO_ROOT, entry.file));
    const declaration = findDeclaration(sourceFile, entry.symbol);
    expect(
      declaration,
      `${entry.file} no longer declares \`${entry.symbol}\`.\n\n` +
        `It is a refused refactor candidate (${entry.id}); the evidence is in ` +
        `${entry.ruling}. If this PR deliberately reworks it, cite ${entry.id} ` +
        `in the PR body and update ${BASELINE_FILE}.`,
    ).toBeDefined();
    expect(
      signatureOf(sourceFile, declaration as ts.Node),
      `\`${entry.symbol}\` changed shape.\n\n` +
        `Refused candidate ${entry.id}: ${entry.candidate}.\n` +
        `Why it was refused: ${entry.why}\n` +
        `Ruling: ${entry.ruling}\n\n` +
        `Re-proposing it as specified is what this ratchet stops. A change on ` +
        `new evidence is legal: cite ${entry.id} in the PR body and update its ` +
        `signature in ${BASELINE_FILE} in the same PR.`,
    ).toBe(entry.signature);
  });

  it.each(cases)(
    '$id: keeps $symbol findable by the CI gate text locator',
    (entry) => {
      const source = readFileSync(resolve(REPO_ROOT, entry.file), 'utf8');
      const { startLine, endLine } = locateSymbol(source, entry.symbol) as {
        startLine: number;
        endLine: number;
      };
      // A range that collapsed to nothing would let the workflow pass a PR
      // that rewrote the declaration.
      expect(endLine).toBeGreaterThanOrEqual(startLine);
      expect(
        source.split('\n')[startLine - 1],
        `scripts/refutedCandidates.mjs located the wrong line for ${entry.symbol}`,
      ).toContain(entry.symbol);
    },
  );
});
