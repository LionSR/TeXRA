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
  sourceFilesUnder as sharedSourceFilesUnder,
  stripComments,
  toRepoPath,
} from '../support/repoScan';

/**
 * Architecture ratchet: the platform-independent ("VS Code-free") source zones
 * must never import the `vscode` module. They reach host services through
 * process-runtime services / host adapters instead (see CLAUDE.md "Separation of Concerns").
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
  'src/tools',
  'src/controllers',
  'src/shared',
  'src/eventBus',
  'src/hosts',
  'src/common',
  'src/utils',
  'src/logger',
  'packages/harness/src',
  'packages/texra/src',
  'packages/llm/src',
  'packages/desktop/src',
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

const HOST_LAYER_IMPORT_SPECIFIERS = ['@common/webview'] as const;

const HOST_LAYER_IMPORT_PREFIXES = [
  '@commands/',
  '@progressView/',
  '@settingsView/',
  '@frontend/',
  '@resources/',
  '@common/webview/',
  '@cli/',
  '@desktop/',
] as const;

/**
 * Effect run boundary (PRD R1, 2026-08-26-effect-4-runtime-migration.md
 * "Execution strategy" rule 3): production code enters Effect through the
 * runtime its composition root holds and threads to it, the SDK public
 * entry, and the composition roots that open a store the runtime they are
 * about to install will serve. Everything else must take the runtime it runs
 * on; each entry below names why it cannot.
 */
const EFFECT_RUN_ROOTS = [
  ...ALL_HOST_PRODUCTION_ROOTS,
  'packages/harness/src',
  'packages/trace-viewer/src',
] as const;
const EFFECT_RUN_CALL =
  /\b(?:Effect\.run(?:Promise|PromiseExit|Sync|SyncExit|Fork|Callback)(?:With)?|NodeRuntime\.runMain)\s*\(/g;
const BARE_EFFECT_RUN_SITES: Readonly<Record<string, number>> = {
  // The CLI platform shutdown sequence, which cannot run on the process
  // runtime for the same reason the SDK entry cannot: `cliPlatformShutdown`
  // disposes it (`disposeCliProcessRuntime`) before the stderr/stdout flushes
  // run, and a teardown path must not depend on the runtime it is tearing
  // down. The init itself is a program now, so the failed-init disposal is an
  // `Effect.onError` on that program rather than a second run here.
  'packages/cli/src/runtime/initPlatform.ts': 1,
  // The CLI process entry: one run for the command and its two finalizers,
  // the platform's shutdown drain and the final NDJSON flush. It is the
  // outermost boundary of the process, so there is nothing above it to run on
  // and no runtime left once the drain has disposed the process one.
  'packages/cli/src/bin/texra.ts': 1,
  // The headless service entry the extension and the desktop app ship: the
  // same outermost boundary as the CLI's, for `texra serve` alone.
  'packages/cli/src/bin/texraServe.ts': 1,
  // `defineCliCommand`'s first step, the CLI's pre-runtime context edge: the
  // one program it runs (`contextFromArgs`) builds the whole `CliContext`,
  // which opens the project and user `config.json` stores BEFORE
  // `initCliPlatform` (and with it `installCliProcessRuntime`), so no process
  // runtime exists to borrow; the program needs the filesystem and the process
  // environment (as a ConfigProvider). `initCliPlatform` installs that same
  // provider as the workspace roots' config, so every post-init reader
  // resolves its rows through the roots rather than coming through here. Every
  // command but `doctor` enters through this one run and hands the resolved
  // context to its builder as a value.
  'packages/cli/src/commands/_helpers/defineCliCommand.ts': 1,
  // `texra doctor`, the one command whose whole job is to report on a process
  // whose platform may not have initialized. Its one program builds the
  // context (`contextFromArgs`, which `defineCliCommand` runs for every other
  // command), then folds
  // `initCliPlatform`'s outcome into data and renders the report from it, and
  // it can borrow a process runtime at neither end: none exists when the fold
  // begins, and an init that fails disposes the runtime it installed before it
  // re-raises (see `initPlatform.ts` above), leaving the degraded report —
  // node, workspace, resources, LaTeX, config and the platform-failure row —
  // nothing to run on. That report provides the Node platform services (the
  // filesystem its probes read, the spawner its LaTeX probes run on) itself,
  // and nothing in it logs through Effect; the healthy one settles on the
  // context the init hands back.
  'packages/cli/src/commands/doctor.ts': 1,
  // Electron's `before-quit`, the desktop host's shutdown entry: it holds the
  // host's shutdown and no runtime — the shutdown it runs is what disposes
  // the process runtime — so the quit follows it on the default runner.
  'packages/desktop/src/main/desktopWindowLifecycle.ts': 1,
  // The desktop entry: one program from `whenReady` to the wired window,
  // which builds the process runtime (its stores resolve before
  // `installProcessRuntime`, being the values that install is given)
  // and, when startup fails, runs the drain that disposes it.
  'packages/desktop/src/main/index.ts': 1,
  // The VS Code entry: one program from `activate` to the last registration,
  // which builds the process runtime and
  // closes its scope when activation fails; and `deactivate`, which closes
  // that same scope. The scope's finalizer is the shutdown drain that
  // disposes the process runtime, so neither can settle on it. Every other
  // Effect in this file settles on the local `ProcessRuntime` the entry holds.
  'packages/extension/src/extension.ts': 2,
  // Worker entry: no process runtime exists in the worker. The code sandbox
  // worker runs its one program under `NodeRuntime.runMain`; every host
  // embeds this file as the worker's source (scripts/code-sandbox-worker.mjs).
  'src/agent/codeSandbox/worker.ts': 1,
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
  // The UI kit is held to the same rule as `src/shared`: the toolkit renders a
  // host-neutral view model handed to it, so an `@agent/*` import there would
  // be the run system leaking into the render layer.
  it('does not grow shared-to-agent imports', () => {
    const offenders = ['src/shared', 'packages/texra/src/ui']
      .flatMap((root) => sourceFilesUnder(root))
      .filter((file) => importsMatching(file, AGENT_IMPORT_PATTERNS))
      .map(toRepoPath)
      .filter((file) => !SHARED_AGENT_IMPORT_ALLOWLIST_SET.has(file))
      .toSorted();

    expect(offenders).toEqual([]);
  });
});

describe('Latex layer dependency direction', () => {
  it('does not grow latex-to-agent imports', () => {
    const offenders = sourceFilesUnder('packages/texra/src/latex')
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

describe('Effect run boundaries', () => {
  it('runs Effect only on a held runtime outside the pinned pre-runtime sites', () => {
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
