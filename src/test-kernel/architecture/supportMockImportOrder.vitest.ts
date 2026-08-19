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

/**
 * Architecture guard for the shared mock modules extracted by #10361.
 *
 * Those modules register `vi.mock(...)` when they evaluate, and their factories
 * close over `vi.hoisted` bags, so a suite must evaluate each shared-mock
 * import before anything that could load the mocked module. The mechanical
 * convention is: shared `@test/support/*Mock` imports sit immediately after
 * the `vitest` import (node builtins may still precede vitest), before any
 * other project import. This test pins that ordering and fails on type-only
 * shared-mock imports, which would not register the mock.
 */

const SUPPORT_MOCK_SPECIFIERS = new Set([
  '@test/support/agentCatalogMock',
  '@test/support/agentStorageFinalizationMock',
  '@test/support/cliInitPlatformMock',
  '@test/support/cliLogSinksMock',
  '@test/support/cliOutputMock',
]);

const HOST_SUITE_DIRS = [
  'src/test-kernel/cli',
  'src/test-kernel/desktop',
] as const;

/** The five suites #10361 migrated to the shared mock modules. */
const MIGRATED_SUITES = [
  'src/test-kernel/cli/AgentResolution.vitest.ts',
  'src/test-kernel/cli/AgentsCommand.vitest.ts',
  'src/test-kernel/cli/AgentsRunCommand.vitest.ts',
  'src/test-kernel/cli/MultiAgentRunCommand.vitest.ts',
  'src/test-kernel/cli/WorkflowRunCommand.vitest.ts',
] as const;

interface ImportSite {
  specifier: string;
  isTypeOnly: boolean;
}

function declarationIsTypeOnly(
  importClause: ts.ImportClause | undefined,
): boolean {
  if (importClause?.isTypeOnly) return true;
  if (importClause == null || importClause.name != null) return false;

  const { namedBindings } = importClause;
  return (
    namedBindings != null &&
    ts.isNamedImports(namedBindings) &&
    namedBindings.elements.length > 0 &&
    namedBindings.elements.every((element) => element.isTypeOnly)
  );
}

function collectImportsFromSource(file: string, source: string): ImportSite[] {
  const sourceFile = parseSourceFile(file, { text: source });

  const imports: ImportSite[] = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (specifier == null || !ts.isStringLiteralLike(specifier)) continue;
    imports.push({
      specifier: specifier.text,
      isTypeOnly: declarationIsTypeOnly(statement.importClause),
    });
  }
  return imports;
}

function collectImports(file: string): ImportSite[] {
  return collectImportsFromSource(file, readFileSync(file, 'utf8'));
}

function violation(file: string, message: string): string {
  return `${file}: ${message}`;
}

interface SuiteAudit {
  readonly hasSharedMockImport: boolean;
  readonly violations: string[];
}

function auditSuite(file: string, imports: readonly ImportSite[]): SuiteAudit {
  const shared = imports.filter((site) =>
    SUPPORT_MOCK_SPECIFIERS.has(site.specifier),
  );
  if (shared.length === 0) {
    return { hasSharedMockImport: false, violations: [] };
  }

  const repoPath = toRepoPath(file);
  const vitestIndex = imports.findIndex((site) => site.specifier === 'vitest');
  if (vitestIndex === -1) {
    return {
      hasSharedMockImport: true,
      violations: [
        violation(
          repoPath,
          `imports ${shared.map((site) => `'${site.specifier}'`).join(', ')} without a 'vitest' import`,
        ),
      ],
    };
  }

  const violations: string[] = [];
  for (const before of imports.slice(0, vitestIndex)) {
    if (!before.specifier.startsWith('node:')) {
      violations.push(
        violation(
          repoPath,
          `non-node import '${before.specifier}' precedes the vitest import`,
        ),
      );
    }
  }

  const firstAfterVitest = imports[vitestIndex + 1];
  if (
    firstAfterVitest == null ||
    !SUPPORT_MOCK_SPECIFIERS.has(firstAfterVitest.specifier)
  ) {
    violations.push(
      violation(
        repoPath,
        `first import after vitest is '${firstAfterVitest?.specifier ?? 'none'}', not a shared @test/support/*Mock import`,
      ),
    );
  }

  for (let offset = 0; offset < shared.length; offset += 1) {
    const site = imports[vitestIndex + 1 + offset];
    if (site == null || !SUPPORT_MOCK_SPECIFIERS.has(site.specifier)) {
      violations.push(
        violation(
          repoPath,
          'shared @test/support/*Mock imports must form one contiguous block immediately after the vitest import',
        ),
      );
      break;
    }
    if (site.isTypeOnly) {
      violations.push(
        violation(
          repoPath,
          `shared mock import '${site.specifier}' is type-only and would not register the mock`,
        ),
      );
    }
  }

  return { hasSharedMockImport: true, violations };
}

describe('shared test-kernel mock import order', () => {
  const checkedSuites: string[] = [];
  const violations: string[] = [];

  for (const dir of HOST_SUITE_DIRS) {
    for (const file of sourceFilesUnder(resolve(REPO_ROOT, dir))) {
      const imports = collectImports(file);
      const audit = auditSuite(file, imports);
      if (audit.hasSharedMockImport) checkedSuites.push(toRepoPath(file));
      violations.push(...audit.violations);
    }
  }

  it('keeps shared @test/support/*Mock imports immediately after the vitest import', () => {
    expect(
      violations,
      'Shared mock import-order violations:\n' + violations.join('\n'),
    ).toEqual([]);
  });

  it('covers the #10361 migrated suites', () => {
    expect(checkedSuites).toEqual(expect.arrayContaining([...MIGRATED_SUITES]));
  });

  it('detects inline type-only shared mock imports as type-only', () => {
    const source = `
      import { type agentCatalogMock } from '@test/support/agentCatalogMock';
      import { getAgent, type refresh } from '@test/support/agentCatalogMock';
      import type { cliOutputMock } from '@test/support/cliOutputMock';
    `;
    const imports = collectImportsFromSource('inline-type-only.ts', source);

    expect(imports).toEqual([
      { specifier: '@test/support/agentCatalogMock', isTypeOnly: true },
      { specifier: '@test/support/agentCatalogMock', isTypeOnly: false },
      { specifier: '@test/support/cliOutputMock', isTypeOnly: true },
    ]);
  });
});
