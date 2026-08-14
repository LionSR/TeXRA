// Node imports
import { readFileSync } from 'node:fs';

// Third-party imports
import { build } from 'esbuild';
import PQueue from 'p-queue';
import { beforeAll, describe, expect, it } from 'vitest';

import { REPO_ROOT, sourceFilesUnder, toRepoPath } from '../support/repoScan';

/**
 * Architecture guard: `@tools/registry` imports every registered tool, so any
 * module that reaches it drags the LaTeX, Lean, arxiv and Zotero tool set — and
 * their `src/latex/` dependencies — into its own module closure.
 *
 * A tool module reaching the registry is a cycle, not a dependency: the
 * registry already imports the tool. That cycle used to run
 * `bash -> @agent/storage -> @agent/index/agentRegistry -> remoteAgentMeta ->
 * RemoteAgentLoader -> @tools/registry`, and it put an identical 630-file
 * closure on 19 of the 50 `defineTool()` modules. Splitting the remote-agent
 * client's listing half (`@agent/remote/remoteAgentList`, registry-free) from
 * its config-loading half (`RemoteAgentLoader`, which genuinely resolves tool
 * names) severed it.
 *
 * Measurement matches the closure census in the issue: an esbuild bundle per
 * `defineTool()` module with dependencies external, counting non-`node_modules`
 * inputs. Dynamic `import()` targets count — an npm consumer still installs
 * them — so a lazy import does not satisfy this guard.
 */

const TOOL_REGISTRY = 'src/tools/registry.ts';

/**
 * Tools whose closure may still contain the registry: both launch a subagent
 * in-band, and resolving that subagent's YAML tool list genuinely needs the
 * whole tool table (`inBandSubagentExecution -> executeAgent -> agentLoad ->
 * @tools/registry`). That is a real dependency, not a cycle artifact — but it
 * is also the only reason these two still ship the domain tools, so shrink this
 * list rather than growing it.
 */
const AGENT_LAUNCHING_TOOLS: readonly string[] = [
  'src/tools/delegation/DelegationTools.ts',
  'src/tools/delegation/WorkflowScriptTool.ts',
];

/** Domain subsystems no generic tool should have to install. */
const DOMAIN_PREFIXES = [
  'src/latex/',
  'src/tools/arxiv/',
  'src/tools/lean/',
  'src/tools/zotero/',
] as const;

function defineToolModules(): string[] {
  return sourceFilesUnder(`${REPO_ROOT}/src/tools`, { repoRelative: true })
    .filter((file) =>
      readFileSync(`${REPO_ROOT}/${file}`, 'utf8').includes('defineTool('),
    )
    .toSorted();
}

async function valueClosure(entry: string): Promise<string[]> {
  const result = await build({
    absWorkingDir: REPO_ROOT,
    entryPoints: [entry],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    tsconfig: 'tsconfig.json',
    logLevel: 'silent',
  });
  return Object.keys(result.metafile.inputs)
    .map(toRepoPath)
    .filter((file) => !file.includes('node_modules'));
}

describe('tool module closures', () => {
  const closures = new Map<string, string[]>();

  beforeAll(async () => {
    // Bounded concurrency: 50 unthrottled esbuild bundles saturate the box and
    // push the neighbouring architecture ratchets past their own timeouts.
    const queue = new PQueue({ concurrency: 4 });
    await queue.addAll(
      defineToolModules().map((entry) => async () => {
        closures.set(entry, await valueClosure(entry));
      }),
    );
  }, 120_000);

  it('enumerates every defineTool() module', () => {
    expect(closures.size).toBeGreaterThan(40);
    expect([...closures.keys()]).toContain('src/tools/bash.ts');
  });

  it('keeps @tools/registry out of tool module closures', () => {
    const offenders = [...closures.entries()]
      .filter(
        ([entry, files]) =>
          !AGENT_LAUNCHING_TOOLS.includes(entry) &&
          files.includes(TOOL_REGISTRY),
      )
      .map(([entry]) => entry)
      .toSorted();

    expect(offenders).toEqual([]);
  });

  it('keeps the agent-launching allowlist free of stale entries', () => {
    const stale = AGENT_LAUNCHING_TOOLS.filter(
      (entry) => !closures.get(entry)?.includes(TOOL_REGISTRY),
    );

    expect(stale).toEqual([]);
  });

  it('leaves no LaTeX, Lean, arxiv or Zotero file in bash’s closure', () => {
    const files = closures.get('src/tools/bash.ts') ?? [];

    expect(files).not.toEqual([]);
    expect(
      files.filter((file) =>
        DOMAIN_PREFIXES.some((prefix) => file.startsWith(prefix)),
      ),
    ).toEqual([]);
  });
});
