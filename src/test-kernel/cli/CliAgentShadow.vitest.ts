// Node imports
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Third-party imports
import { Effect } from 'effect';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Local imports
import { getAgentsByCategory } from '@agent/index';
import { refresh } from '@agent/index/agentRegistry';
import {
  applyInitialCliAgentSelection,
  chatToolUseAgentUsageError,
} from '@cli/chat/tui/commands/handlers/agentModelCommands';
import { patchSessionMeta, sessionMeta } from '@cli/chat/tui/state/cliState';
import {
  checkCliAgentLaunch,
  formatCliAgentList,
  resolveCliAgentInCategory,
  resolveCliRunAgent,
} from '@cli/runtime/agents';
import { AgentDirectories } from '@platform/interfaces';
import type { ProcessServices } from '@platform/processRuntime';
import { GlobalStorageFs } from '@platform/rootedFs';
import { AgentCategory } from '@shared/schemas';
import { nodePlatformLayer } from '@test/support/fsTestUtils';
import { testRuntime } from '@test/support/testProcessRuntime';
import { REPO_ROOT } from '@test/support/repoScan';
import { makeFakeSettingsStores } from '@test/support/settingsStoresFake';
import {
  fakeHostAgentDirectories,
  hostStores,
  installPlatform,
} from '@test/support/setupPlatform';
import { cleanupTempDirs, makeTempDir } from '@test/support/tempDirPlatform';
import type { RootedFileSystem } from '@utils/files/rootedFileSystem';

// The root-agent selection writes a local notice, whose sink reads the bound
// session view. Nothing here renders a TUI, so the sink stands in for it.
vi.mock('@cli/chat/tui/state/transcript', () => ({
  appendLocalAssistantTranscript: vi.fn(),
}));

/**
 * A custom *workflow* agent named `assistant` shadows the bundled *tool-use*
 * `assistant`. CLI validation used to resolve by source priority, which picked
 * the workflow shadow: `texra chat --agent assistant` failed with a category
 * mismatch while the extension launched the tool-use agent, and the delegation
 * probe read `tools` off the shadow. Validation now resolves through the same
 * category-scoped launch resolver the run itself uses.
 */
/** Settle a CLI agent lookup the way a CLI entry point does. */
function runCliAgentLookup<A, E>(
  lookup: Effect.Effect<A, E, ProcessServices>,
): Promise<A> {
  return testRuntime().runPromise(lookup);
}

describe('CLI agent validation with a shadowed name', () => {
  const tempDirs: string[] = [];

  beforeAll(async () => {
    const customDir = await makeTempDir('texra-cli-shadow-', tempDirs);
    await writeFile(
      resolve(customDir, 'assistant.yaml'),
      [
        'name: assistant',
        'description: Custom workflow agent that shadows a built-in name.',
        'settings:',
        '  agentCategory: workflow',
        'prompts:',
        '  systemPrompt: Custom workflow assistant.',
        '',
      ].join('\n'),
    );

    await installPlatform(
      {},
      {
        agentDirectories: {
          custom: () => Effect.sync(() => customDir),
          builtIn: () =>
            Effect.sync(() =>
              resolve(REPO_ROOT, 'packages/extension/resources/agents'),
            ),
          builtInToolUse: () =>
            Effect.sync(() =>
              resolve(
                REPO_ROOT,
                'packages/extension/resources/tool_use_agents',
              ),
            ),
        },
      },
    );

    // The fake host answers `custom()` from a temp directory of its own, so
    // nothing in this load reaches the global storage view.
    await Effect.runPromise(
      Effect.provide(
        Effect.provideService(
          refresh({ includeRemote: false }),
          GlobalStorageFs,
          {} as RootedFileSystem,
        ).pipe(
          Effect.provideService(AgentDirectories, fakeHostAgentDirectories),
        ),
        nodePlatformLayer,
      ),
    );
  });

  afterAll(async () => {
    await cleanupTempDirs(tempDirs);
  });

  it('validates the shadowed name against the tool-use entry launch will run', () => {
    const entry = resolveCliAgentInCategory(
      hostStores(),
      'assistant',
      AgentCategory.ToolUse,
    );

    expect(entry?.source).toBe('builtInToolUse');
    expect(entry?.category).toBe(AgentCategory.ToolUse);
    expect(checkCliAgentLaunch(hostStores(), 'assistant', entry, 'chat')).toBe(
      entry,
    );
    expect(
      chatToolUseAgentUsageError(hostStores(), 'assistant'),
    ).toBeUndefined();
  });

  it('reads delegation support off the tool-use entry, not the shadow', () => {
    expect(
      resolveCliAgentInCategory(
        hostStores(),
        'assistant',
        AgentCategory.Workflow,
      )?.source,
    ).toBe('custom');
  });

  it('still reports the category mismatch for a workflow-only agent', () => {
    expect(
      resolveCliAgentInCategory(hostStores(), 'polish', AgentCategory.ToolUse),
    ).toBeUndefined();
    expect(chatToolUseAgentUsageError(hostStores(), 'polish')).toContain(
      'Agent "polish" is a workflow agent; `texra chat` only handles tool-use agents.',
    );
  });

  it('reports an unknown name as missing rather than mismatched', () => {
    expect(chatToolUseAgentUsageError(hostStores(), 'no-such-agent')).toContain(
      'Tool-use agent not found: no-such-agent.',
    );
  });

  // `texra run` serves both categories, so a shadowed name has two candidate
  // run shapes. Picking one silently would change what an existing invocation
  // does without saying so; the qualified spellings the error offers are
  // unambiguous because the registry is keyed by `source:name`.
  it('refuses a shadowed name for `texra run` and names both candidates', async () => {
    await expect(
      runCliAgentLookup(resolveCliRunAgent(hostStores(), 'assistant')),
    ).rejects.toThrow(
      'Agent name "assistant" is ambiguous: it matches the workflow agent custom:assistant and the toolUse agent builtInToolUse:assistant. Re-run with the source-qualified name to pick one: `texra run custom:assistant` or `texra run builtInToolUse:assistant`.',
    );
    expect(
      (
        await runCliAgentLookup(
          resolveCliRunAgent(hostStores(), 'custom:assistant'),
        )
      ).category,
    ).toBe(AgentCategory.Workflow);
    expect(
      (
        await runCliAgentLookup(
          resolveCliRunAgent(hostStores(), 'builtInToolUse:assistant'),
        )
      ).category,
    ).toBe(AgentCategory.ToolUse);
  });

  // Shell completion feeds `texra run` from the name column of
  // `agents list --quiet --all`, so that column has to hold spellings the
  // command accepts: the qualified keys for the shadowed name, whose bare form
  // the test above shows is refused, and the plain name for everything else.
  it('lists a name two agents share as their source-qualified keys', () => {
    const names = formatCliAgentList([
      ...getAgentsByCategory(AgentCategory.Workflow),
      ...getAgentsByCategory(AgentCategory.ToolUse),
    ])
      .split('\n')
      .map((row) => row.split('\t')[1]);

    expect(names).toContain('custom:assistant');
    expect(names).toContain('builtInToolUse:assistant');
    expect(names).not.toContain('assistant');
    expect(names).toContain('polish');
  });

  it('resolves a source-qualified identifier to that exact source', () => {
    expect(
      resolveCliAgentInCategory(
        hostStores(),
        'builtInToolUse:assistant',
        AgentCategory.ToolUse,
      )?.source,
    ).toBe('builtInToolUse');
    // The workflow shadow's own key stays out of the tool-use category.
    expect(
      resolveCliAgentInCategory(
        hostStores(),
        'custom:assistant',
        AgentCategory.ToolUse,
      ),
    ).toBeUndefined();
  });

  // Changing the root agent explicitly is a departure from a team preset, so
  // the selection drops the team slots rather than leaving a preset name
  // pointing at an agent the user replaced.
  it('leaves team mode when the root agent is changed explicitly', () => {
    patchSessionMeta({
      teamName: 'Physicist',
      cliMultiAgentPresetId: 'physicist',
      delegationAgentScope: {
        workflow: ['builtInWorkflow:polish'],
        toolUse: ['builtInToolUse:assistant'],
      },
    });
    const context = {
      // The roster slots only gate visibility, which this registry leaves
      // unconfigured, so empty chat slots resolve the same names as the host.
      stores: makeFakeSettingsStores().stores,
      session: {
        runSettled: undefined,
        runCompleted: false,
        stopRequested: false,
      },
    } as Parameters<typeof applyInitialCliAgentSelection>[1];

    applyInitialCliAgentSelection('assistant', context);

    expect(sessionMeta.get()).toMatchObject({ agent: 'assistant' });
    expect(sessionMeta.get().teamName).toBeUndefined();
    expect(sessionMeta.get().cliMultiAgentPresetId).toBeUndefined();
    expect(sessionMeta.get().delegationAgentScope).toBeUndefined();
  });
});
