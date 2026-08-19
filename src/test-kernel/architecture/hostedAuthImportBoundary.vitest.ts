// Node imports
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

import {
  collectModuleSpecifiers,
  parseSourceFile,
  REPO_ROOT,
  sourceFilesUnder,
  toRepoPath,
} from '../support/repoScan';

const SCAN_ROOTS = [
  'src/model',
  'src/agent/modelHandlers',
  'src/agent/core',
  'src/agent/runtime',
] as const;

// New providers require a deliberate policy update in the backend-decoupling
// proposal and an allowlist update here.
const PERMITTED_THIRD_PARTY_OAUTH_ROOTS = new Set(['@auth/codex', '@auth/xai']);
const PERMITTED_THIRD_PARTY_OAUTH_PATHS = [
  'src/auth/codex',
  'src/auth/xai',
] as const;

function authRoot(specifier: string): string | null {
  if (specifier === '@auth') return '@auth';
  if (!specifier.startsWith('@auth/')) return null;

  const segments = specifier.split('/');
  if (
    segments.slice(2).some((segment) => segment === '.' || segment === '..')
  ) {
    return '@auth';
  }

  const root = segments.at(1);
  return root == null || root.length === 0 ? '@auth' : `@auth/${root}`;
}

function relativeAuthPath(file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;

  const path = toRepoPath(resolve(dirname(file), specifier)).replace(
    /\.(?:[cm]?[jt]sx?)$/,
    '',
  );
  return path === 'src/auth' || path.startsWith('src/auth/') ? path : null;
}

function isPermittedAuthPath(path: string): boolean {
  return PERMITTED_THIRD_PARTY_OAUTH_PATHS.some(
    (permittedPath) =>
      path === permittedPath || path.startsWith(`${permittedPath}/`),
  );
}

function isForbiddenAuthImport(file: string, specifier: string): boolean {
  const root = authRoot(specifier);
  if (root != null) return !PERMITTED_THIRD_PARTY_OAUTH_ROOTS.has(root);

  const path = relativeAuthPath(file, specifier);
  return path != null && !isPermittedAuthPath(path);
}

function findForbiddenAuthImports(file: string, source: string): string[] {
  return collectModuleSpecifiers(
    parseSourceFile(file, { text: source }),
  ).filter((specifier) => isForbiddenAuthImport(file, specifier));
}

describe('hosted auth import boundary', () => {
  it('permits only documented third-party OAuth roots in model and runtime zones', () => {
    const violations = SCAN_ROOTS.flatMap((root) =>
      sourceFilesUnder(resolve(REPO_ROOT, root)).flatMap((file) =>
        findForbiddenAuthImports(file, readFileSync(file, 'utf8')).map(
          (specifier) => `${toRepoPath(file)}: ${specifier}`,
        ),
      ),
    );

    expect(violations).toEqual([]);
  });

  it('scans non-empty production zones', () => {
    const scannedFiles = SCAN_ROOTS.flatMap((root) =>
      sourceFilesUnder(resolve(REPO_ROOT, root)),
    );

    expect(scannedFiles.length).toBeGreaterThan(100);
  });

  it('rejects TeXRA-hosted and unapproved auth roots while permitting documented subpaths', () => {
    expect(
      findForbiddenAuthImports(
        resolve(REPO_ROOT, 'src/agent/runtime/fixture.ts'),
        `
          import { SupabaseClient } from '@auth/SupabaseClient';
          const sessionToken = require('@auth/sessionToken');
          const futureProvider = import('@auth/future-provider/oauth');
          const traversedSession = import('@auth/codex/../sessionToken');
          import { login } from '@auth/codex/oauth';
          export { login as xaiLogin } from '@auth/xai/callback';
        `,
      ),
    ).toEqual([
      '@auth/SupabaseClient',
      '@auth/sessionToken',
      '@auth/future-provider/oauth',
      '@auth/codex/../sessionToken',
    ]);
  });

  it('rejects relative static and dynamic imports into hosted auth', () => {
    expect(
      findForbiddenAuthImports(
        resolve(REPO_ROOT, 'src/agent/runtime/fixture.ts'),
        `
          import { SupabaseClient } from '../../auth/SupabaseClient';
          const sessionToken = import('../../auth/sessionToken', { with: { type: 'json' } });
          const codex = import('../../auth/codex/oauth');
        `,
      ),
    ).toEqual(['../../auth/SupabaseClient', '../../auth/sessionToken']);
  });

  // Regression: the collector this suite shares with the other ratchets grew
  // its `ts.isImportTypeNode` branch unevenly — agentRuntimeProgressEventsBoundary
  // had none, so a `typeof import(…)` reference slipped past a
  // single-permitted-importer guard while two siblings caught the same form.
  // Nothing else in the repo exercises a type position, so pin it here.
  it('rejects typeof-import type positions, aliased and relative', () => {
    expect(
      findForbiddenAuthImports(
        resolve(REPO_ROOT, 'src/agent/runtime/fixture.ts'),
        `
          type Client = typeof import('@auth/SupabaseClient');
          type Session = import('../../auth/sessionToken').Session;
          type Codex = typeof import('@auth/codex/oauth');
        `,
      ),
    ).toEqual(['@auth/SupabaseClient', '../../auth/sessionToken']);
  });

  it('rejects asserted module arguments and dynamic imports with options', () => {
    expect(
      findForbiddenAuthImports(
        resolve(REPO_ROOT, 'src/agent/runtime/fixture.ts'),
        `
          const sessionToken = require((('@auth/sessionToken' as string)));
          const futureProvider = import((('@auth/future-provider' satisfies string)), {
            with: { type: 'json' },
          });
        `,
      ),
    ).toEqual(['@auth/sessionToken', '@auth/future-provider']);
  });
});
