// Node imports
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

import {
  ALL_HOST_PRODUCTION_ROOTS,
  expectRealCoverage,
  productionFilesUnder,
  REPO_ROOT,
  sourceFilesUnder as sharedSourceFilesUnder,
  stripComments,
  toRepoPath,
} from '../support/repoScan';

/**
 * Architecture ratchet: the platform-independent ("VS Code-free") source zones
 * must never import the `vscode` module. They reach host services through
 * `platform()` / host adapters instead (see CLAUDE.md "Separation of Concerns").
 *
 * This duplicates the guard already enforced by the `local/no-vscode-import-in-
 * free-zones` ESLint rule, on purpose: a stray `// eslint-disable` line can
 * silently neuter the lint rule, but it cannot bypass a test in the `npm test`
 * gate. The two layers are independent on purpose — if you add a zone here, add
 * it to `VSCODE_FREE_ZONE_DIRS` in `eslint.config.mjs` too (and vice versa).
 */

// Keep in sync with `VSCODE_FREE_ZONE_DIRS` in eslint.config.mjs.
const VSCODE_FREE_ZONES = [
  'src/agent',
  'src/model',
  'src/latex',
  'src/tools',
  'src/controllers',
  'src/shared',
  'src/replacement',
  'src/eventBus',
  'src/hosts',
  'src/common',
  'src/utils',
  'src/logger',
  'packages/agent/src',
  'packages/llm/src',
  'packages/desktop/src',
  'packages/extension/src/webview/frontend',
  'packages/extension/src/progressView/frontend',
  'packages/extension/src/settingsView/frontend',
] as const;

// `import … from 'vscode'` / `export … from 'vscode'`, CommonJS `require('vscode')`
// (incl. `import x = require('vscode')`), and dynamic `import('vscode')`.
const VSCODE_IMPORT_PATTERNS = [
  /\bfrom\s+['"]vscode['"]/,
  /\brequire\s*\(\s*['"]vscode['"]\s*\)/,
  /\bimport\s*\(\s*['"]vscode['"]\s*\)/,
];

const AGENT_IMPORT_PATTERNS = [
  /\bfrom\s+['"]@agent\//,
  /\brequire\s*\(\s*['"]@agent\//,
  /\bimport\s*\(\s*['"]@agent\//,
];

// The one pre-existing shared-to-agent edge (src/shared/agent/
// terminalResultPresentation.ts) was deleted by folding its mapper back into
// `@agent/runtime/terminalResultToast.ts` — the file it always needed
// `ResultEvent` from. Keep this allowlist empty; a new entry would recreate
// the inversion.
const SHARED_AGENT_IMPORT_ALLOWLIST: readonly string[] = [];
const SHARED_AGENT_IMPORT_ALLOWLIST_SET = new Set<string>(
  SHARED_AGENT_IMPORT_ALLOWLIST,
);

const HOST_LAYER_IMPORT_SPECIFIERS = [
  '@common/state',
  '@common/webview',
] as const;

const HOST_LAYER_IMPORT_PREFIXES = [
  '@webview/',
  '@commands/',
  '@progressView/',
  '@settingsView/',
  '@frontend/',
  '@resources/',
  '@common/state/',
  '@common/webview/',
  '@cli/',
  '@desktop/',
] as const;

/**
 * Effect run boundary (PRD R1, .agents/docs/proposed/architecture/2026-08-26-effect-4-runtime-migration.md
 * "Execution strategy" rule 3): production code enters Effect through the
 * host-owned runtime, `effectRuntime()` from `@platform/processRuntime`, and
 * the SDK public entry. The pre-runtime exemption this once carried (the platform
 * stores every host opens in its `initPlatform`, and the file-lock provider
 * those stores flush through) is gone: each host now installs the process
 * runtime before it opens a store. Only the SDK public entry sites are pinned.
 */
const EFFECT_RUN_ROOTS = [
  ...ALL_HOST_PRODUCTION_ROOTS,
  'packages/agent/src',
  'packages/trace-viewer/src',
] as const;
const EFFECT_RUN_CALL =
  /\bEffect\.run(?:Promise|PromiseExit|Sync|SyncExit|Fork|Callback)(?:With)?\s*\(/g;
const BARE_EFFECT_RUN_SITES: Readonly<Record<string, number>> = {
  // The published SDK's Promise entry, which is rule R1's third boundary
  // kind and the one module in `packages/agent` allowed to run an Effect at
  // all. It cannot borrow `effectRuntime()`: the process runtime does not
  // exist until this entry's own composition installs it, and `closeSession`
  // has to answer for a process no run initialized and for one whose
  // shutdown already disposed that runtime.
  'packages/agent/src/index.ts': 6,
  // The CLI platform shutdown sequence, which cannot borrow `effectRuntime()`
  // for the same reason the SDK entry cannot: `lifecycle.runShutdown()`
  // disposes the process runtime (`disposeProcessRuntime`) before the
  // stderr/stdout flushes run, and a teardown path must not depend on the
  // runtime it is tearing down.
  'packages/cli/src/runtime/initPlatform.ts': 1,
  // The clipboard write's interrupted-at-disposal reap, which runs only
  // after the process runtime's `dispose()` interrupted the in-flight
  // fiber — no process runtime is left to borrow, and the wedged-helper
  // reap must still run so a `void`-ed TUI copy settles instead of
  // rejecting unhandled.
  'packages/cli/src/runtime/clipboardText.ts': 1,
};

function sourceFilesUnder(
  zone: string,
  opts?: { readonly excludeTestKernel?: boolean },
): string[] {
  // A renamed/removed zone surfaces as the file-count guard below failing,
  // not as a silently green ratchet.
  return sharedSourceFilesUnder(resolve(REPO_ROOT, zone), {
    missingDirReturnsEmpty: true,
    excludeTestKernel: opts?.excludeTestKernel,
  });
}

function productionSrcFiles(): string[] {
  return sourceFilesUnder('src', { excludeTestKernel: true });
}

function importsMatching(file: string, patterns: readonly RegExp[]): boolean {
  const source = stripComments(readFileSync(file, 'utf8'));
  return patterns.some((pattern) => pattern.test(source));
}

function importSpecifiers(file: string): string[] {
  const source = stripComments(readFileSync(file, 'utf8'));
  return [...source.matchAll(/\b(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)]
    .map((match) => match[1])
    .filter((specifier): specifier is string => specifier !== undefined);
}

function importsHostLayer(file: string): boolean {
  return importSpecifiers(file).some(
    (specifier) =>
      HOST_LAYER_IMPORT_SPECIFIERS.includes(
        specifier as (typeof HOST_LAYER_IMPORT_SPECIFIERS)[number],
      ) ||
      HOST_LAYER_IMPORT_PREFIXES.some((prefix) => specifier.startsWith(prefix)),
  );
}

function importsAgentModelHandlers(file: string): boolean {
  return importSpecifiers(file).some((specifier) => {
    if (
      specifier === '@agent/modelHandlers' ||
      specifier.startsWith('@agent/modelHandlers/')
    ) {
      return true;
    }
    if (!specifier.startsWith('.')) {
      return false;
    }

    const repoRelative = toRepoPath(resolve(dirname(file), specifier));
    return (
      repoRelative === 'src/agent/modelHandlers' ||
      repoRelative.startsWith('src/agent/modelHandlers/')
    );
  });
}

describe('VS Code-free zones never import vscode', () => {
  for (const zone of VSCODE_FREE_ZONES) {
    it(`${zone} has no vscode imports`, () => {
      const offenders = sourceFilesUnder(zone)
        .filter((file) => importsMatching(file, VSCODE_IMPORT_PATTERNS))
        .map(toRepoPath);
      expect(offenders).toEqual([]);
    });
  }

  it('actually scans the zones (guards against a broken file walk)', () => {
    const scanned = VSCODE_FREE_ZONES.reduce(
      (total, zone) => total + sourceFilesUnder(zone).length,
      0,
    );
    expect(scanned).toBeGreaterThan(100);
  });
});

describe('Shared layer dependency direction', () => {
  it('does not grow shared-to-agent imports', () => {
    const offenders = sourceFilesUnder('src/shared')
      .filter((file) => importsMatching(file, AGENT_IMPORT_PATTERNS))
      .map(toRepoPath)
      .filter((file) => !SHARED_AGENT_IMPORT_ALLOWLIST_SET.has(file))
      .toSorted();

    expect(offenders).toEqual([]);
  });
});

describe('Latex layer dependency direction', () => {
  it('does not grow latex-to-agent imports', () => {
    const offenders = sourceFilesUnder('src/latex')
      .filter((file) => importsMatching(file, AGENT_IMPORT_PATTERNS))
      .map(toRepoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });
});

describe('Production core never imports host layers', () => {
  it('has no imports from extension, CLI, or desktop aliases', () => {
    const offenders = productionSrcFiles()
      .filter(importsHostLayer)
      .map(toRepoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  it('actually scans production src files', () => {
    expect(productionSrcFiles().length).toBeGreaterThan(500);
  });
});

describe('Agent core dependency direction', () => {
  it('does not import model handler implementations', () => {
    const offenders = sourceFilesUnder('src/agent/core')
      .filter(importsAgentModelHandlers)
      .map(toRepoPath)
      .toSorted();

    expect(offenders).toEqual([]);
  });
});

describe('Effect run boundaries', () => {
  it('runs Effect only through effectRuntime() outside the pinned pre-runtime sites', () => {
    const sites: Record<string, number> = {};
    for (const root of EFFECT_RUN_ROOTS) {
      for (const file of productionFilesUnder(root).toSorted()) {
        const source = stripComments(
          readFileSync(resolve(REPO_ROOT, file), 'utf8'),
        );
        const count = source.match(EFFECT_RUN_CALL)?.length ?? 0;
        if (count > 0) sites[file] = count;
      }
    }

    expect(
      sites,
      'bare Effect.run* sites must use the process runtime except for the SDK public entry sites pinned in BARE_EFFECT_RUN_SITES',
    ).toEqual(BARE_EFFECT_RUN_SITES);
  });

  it('actually scans the Effect run roots', () => {
    expectRealCoverage(EFFECT_RUN_ROOTS);
  });
});
