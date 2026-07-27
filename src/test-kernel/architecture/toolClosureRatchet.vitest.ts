/**
 * Architecture ratchet: generic tools must not pull domain subsystems
 * (LaTeX, Lean, arxiv, Zotero) into their transitive closure.
 *
 * Before #9327, 19 of 50 tool modules shared a 630-file closure that
 * included ~20 `src/latex/` files, 6 `src/tools/lean/`, 6 arxiv, and
 * 5 Zotero files. The cycle went:
 *   bash.ts → childStream.ts → AgentRunLifecycle.ts → …
 *   → agentLoad.ts → registry.ts → domain tools → @latex/*
 *
 * Severing the eager domain-tool imports from registry.ts breaks that
 * path, dropping the closure from ~630 to ~150 files per generic tool.
 */

// Node imports
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

/** Path aliases from tsconfig.json — resolved so esbuild can follow them. */
const TSCONFIG_PATH = resolve(REPO_ROOT, 'tsconfig.json');

/** Domain subsystem prefixes whose files must NOT appear in generic-tool closures. */
const DOMAIN_SUBSYSTEMS = [
  'src/latex/',
  'src/tools/lean/',
  'src/tools/arxiv/',
  'src/tools/zotero/',
] as const;

/**
 * Maximum files in a generic tool's value-import closure.
 * Before #9327: 630; target: < 200.
 */
const MAX_CLOSURE_FILES = 200;

interface ClosureResult {
  toolPath: string;
  fileCount: number;
  domainFiles: string[];
  allFiles: string[];
}

async function measureClosure(toolPath: string): Promise<ClosureResult> {
  const result = await build({
    entryPoints: [toolPath],
    bundle: true,
    write: false,
    metafile: true,
    packages: 'external',
    platform: 'node',
    format: 'esm',
    tsconfig: TSCONFIG_PATH,
    logLevel: 'silent',
  });

  const allFiles = Object.keys(result.metafile?.inputs ?? {})
    .filter((f) => !f.includes('node_modules'))
    .map((f) => f.replaceAll('\\', '/'))
    .sort();

  const repoPrefix = `${REPO_ROOT.replaceAll('\\', '/')}/`;
  const repoRelative = allFiles.map((f) =>
    f.startsWith(repoPrefix) ? f.slice(repoPrefix.length) : f,
  );

  const domainFiles = repoRelative.filter((f) =>
    DOMAIN_SUBSYSTEMS.some((prefix) => f.startsWith(prefix)),
  );

  return {
    toolPath,
    fileCount: repoRelative.length,
    domainFiles,
    allFiles: repoRelative,
  };
}

describe('tool closure ratchet', () => {
  it('bash.ts closure contains zero domain-subsystem files', async () => {
    const bashPath = resolve(REPO_ROOT, 'src/tools/bash.ts');
    const closure = await measureClosure(bashPath);

    expect(closure.domainFiles).toEqual([]);
  });

  it('bash.ts closure is under the file-count ceiling', async () => {
    const bashPath = resolve(REPO_ROOT, 'src/tools/bash.ts');
    const closure = await measureClosure(bashPath);

    expect(closure.fileCount).toBeLessThan(MAX_CLOSURE_FILES);
  });
});
