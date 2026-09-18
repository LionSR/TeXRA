import { it } from '@effect/vitest';
import { Effect } from 'effect';
import { beforeEach, describe, expect, vi } from 'vitest';

import { platform } from '@platform/platform';
import {
  LanguageModel,
  UNAVAILABLE_LANGUAGE_MODEL_PORT,
} from '@platform/languageModel';
import type { ModelOptionStores } from '@model/computeModelOptions';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { ModelOptionData, ToolDefinition } from '@shared/schemas';
import { fakeProcessServices, hostStores } from '@test/support/setupPlatform';

const mocks = vi.hoisted(() => ({
  getVisibleAgents: vi.fn(),
  getVisibleAgent: vi.fn(),
  readModelAvailabilityInputs: vi.fn(),
  isWorktreeSupportEnabled: vi.fn(),
}));

vi.mock('@agent/index/agentRegistry', () => ({
  getVisibleAgents: mocks.getVisibleAgents,
  getVisibleAgent: mocks.getVisibleAgent,
  // No test here pins a delegation scope, so this
  // always falls through to the workspace-visible roster.
  resolveDelegationScopeAgents: (
    _stores: unknown,
    scope: unknown,
    category: string,
  ) => (scope ? [] : mocks.getVisibleAgents(category)),
}));

vi.mock('@model/computeModelOptions', () => ({
  readModelAvailabilityInputs: mocks.readModelAvailabilityInputs,
  // Availability is read once and finished purely, so a case seeds the option
  // rows on the read and the pure finisher hands them straight back.
  modelOptionsFrom: (rows: readonly ModelOptionData[]) => rows,
}));

vi.mock('@utils/config/worktreeConfig', () => ({
  isWorktreeSupportEnabled: mocks.isWorktreeSupportEnabled,
}));

const {
  annotateDelegationAvailability,
  availableModelNamesFromOptions,
  formatAgentList,
  readDelegationAnnotationState,
  selectAvailableDelegationModel,
} = await import('@tools/delegation/delegationAvailability');
const { resolveAgentTools } =
  await import('@agent/runtime/agentToolResolution');
const { MapToolRegistry } = await import('@agent/core/tools/ToolTypes');
const { ToolInjectionRegistry } = await import('@agent/runtime/toolInjection');

const DELEGATE_AGENT_DESCRIPTION = [
  'Delegate a task to a tool-use agent.',
  '',
  'Available agents: loaded from the active roster at runtime.',
  '',
  'Agent selection: choose the most specific agent whose description matches.',
  '',
  'Available models: loaded from the active API mode at runtime.',
].join('\n');

const DELEGATE_WORKFLOW_DESCRIPTION = [
  'Delegate to a workflow agent.',
  '',
  'Available agents: loaded from the active roster at runtime.',
  '',
  'Pick the agent whose description matches the task.',
].join('\n');

const WORKTREE_PLACEHOLDER =
  'Git worktree support: resolved from the active workspace at runtime.';

const DELEGATE_AGENT_WORKTREE_DESCRIPTION = [
  'Delegate a task to a tool-use agent.',
  '',
  'Available agents: loaded from the active roster at runtime.',
  '',
  'Available models: loaded from the active API mode at runtime.',
  '',
  WORKTREE_PLACEHOLDER,
].join('\n');

type ToolInput = {
  name: string;
  description?: ToolDefinition['description'];
  availabilityCategory?: ToolDefinition['availabilityCategory'];
};

const DELEGATE_AGENT_TOOL: ToolInput = {
  name: 'delegate_agent',
  availabilityCategory: 'toolUse',
  description: DELEGATE_AGENT_DESCRIPTION,
};

/**
 * The slots the direct-annotation cases read their worktree opt-in from; the
 * mocked reader answers off the value, so any stores value serves.
 */
const annotationSettings = hostStores();

const RESEARCH_NUMERICS_AGENTS = [
  { name: 'research', description: 'Derive and verify.' },
  { name: 'numerics', description: 'Run simulations.', tools: ['bash'] },
];

/**
 * Annotate with the given roster visible and no model list, so only the
 * "Available agents:" block moves.
 */
function rewriteRoster(
  agents: { name: string; description?: string; tools?: string[] }[],
  tool: ToolDefinition = {
    name: 'delegate_agent',
    availabilityCategory: 'toolUse',
    description: DELEGATE_AGENT_DESCRIPTION,
  },
) {
  mocks.getVisibleAgents.mockReturnValue(agents);
  return annotateDelegationAvailability(
    tool,
    undefined,
    readDelegationAnnotationState(annotationSettings),
  );
}

/**
 * A registry holding exactly these definitions: `resolveAgentTools` advertises
 * the registry's own contract, not the one the declaration carries.
 */
function delegationRegistry(tools: readonly ToolInput[]) {
  return new MapToolRegistry(
    Object.fromEntries(
      tools.map((tool) => [
        tool.name,
        {
          definition: tool,
          call: () =>
            Effect.succeed({ status: 'executed', summary: '', output: '' }),
        },
      ]),
    ),
  );
}

function resolveToolList(
  tools: ToolInput[] = [DELEGATE_AGENT_TOOL],
  stores: ModelOptionStores = hostStores(),
) {
  return Effect.suspend(() => {
    return resolveAgentTools({
      tools,
      registry: delegationRegistry(tools),
      logger: { warn: () => {} },
      toolInjections: new ToolInjectionRegistry(),
      stores,
    });
  }).pipe(
    // The delegation-annotation availability read yields `LanguageModel`;
    // this host has no editor models.
    Effect.provide(LanguageModel.layer(UNAVAILABLE_LANGUAGE_MODEL_PORT)),
  );
}

function resolveDelegateAgent(extraTools: ToolInput[] = []) {
  return resolveToolList([DELEGATE_AGENT_TOOL, ...extraTools]).pipe(
    Effect.map((tools) => tools.find((t) => t.name === 'delegate_agent')),
  );
}

function model(
  value: string,
  overrides: Partial<ModelOptionData> = {},
): ModelOptionData {
  return {
    value,
    label: value,
    ...overrides,
  };
}

describe('delegation agent availability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('replaces the placeholder Available agents line with the live roster', () => {
    const rewritten = rewriteRoster([
      { name: 'research', description: 'Derive things.' },
    ]);

    expect(rewritten.description).toContain(
      'Available agents:\n- research: Derive things.',
    );
    expect(rewritten.description).not.toContain(
      'loaded from the active roster at runtime',
    );
    // Following sections survive the block replacement untouched.
    expect(rewritten.description).toContain(
      'Agent selection: choose the most specific',
    );
    expect(rewritten.description).toContain(
      'Available models: loaded from the active API mode at runtime.',
    );
  });

  it('treats a $ in an agent description as a literal, not a replacement token', () => {
    const rewritten = rewriteRoster([
      { name: 'prover', description: 'Prove $\\forall x$ statements.' },
    ]);

    expect(rewritten.description).toContain('Prove $\\forall x$ statements.');
  });
});

describe('delegation model availability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVisibleAgents.mockReturnValue([]);
  });

  it('filters model options to only currently runnable models', () => {
    expect(
      availableModelNamesFromOptions([
        model('sonnet46T'),
        model('opus48T', { availability: 'retired' }),
        model('gemini31p', { availability: 'missing-key' }),
        model('deepseekT', { availability: 'provider-key' }),
      ]),
    ).toEqual(['sonnet46T', 'deepseekT']);
  });

  it('tells the agent not to guess models when availability cannot be loaded', () => {
    const rewritten = annotateDelegationAvailability(
      {
        name: 'delegate_workflow',
        availabilityCategory: 'workflow',
        description: 'Available models: loaded at runtime.',
      },
      null,
      readDelegationAnnotationState(annotationSettings),
    );

    expect(rewritten.description).toContain(
      'Available models: unavailable to load; omit model unless the user explicitly requested one.',
    );
    expect(rewritten.description).not.toContain('loaded at runtime');
  });

  it.effect(
    'rejects an explicitly requested model that is not currently available',
    () =>
      Effect.gen(function* () {
        mocks.readModelAvailabilityInputs.mockReturnValue(
          Effect.succeed([model('sonnet46T'), model('deepseekT')]),
        );

        const failure = yield* Effect.flip(
          selectAvailableDelegationModel({
            requestedModel: 'opus48T',
            parentModel: 'sonnet46T',
            settings: hostStores(),
          }),
        );

        expect(failure.message).toContain(
          'Model "opus48T" is not currently available for delegation with the currently configured model access. Available models: sonnet46T, deepseekT.',
        );
      }).pipe(Effect.provide(fakeProcessServices())),
  );

  it.effect('uses the parent model only when it is available', () =>
    Effect.gen(function* () {
      mocks.readModelAvailabilityInputs.mockReturnValue(
        Effect.succeed([model('deepseekT'), model('sonnet46T')]),
      );

      expect(
        yield* selectAvailableDelegationModel({
          parentModel: 'sonnet46T',
          settings: hostStores(),
        }),
      ).toBe('sonnet46T');

      expect(
        yield* selectAvailableDelegationModel({
          parentModel: 'opus48T',
          settings: hostStores(),
        }),
      ).toBe('deepseekT');
    }).pipe(Effect.provide(fakeProcessServices())),
  );

  it.effect('rejects delegation when no models are currently available', () =>
    Effect.gen(function* () {
      mocks.readModelAvailabilityInputs.mockReturnValue(Effect.succeed([]));

      const failure = yield* Effect.flip(
        selectAvailableDelegationModel({
          parentModel: 'opus48T',
          settings: hostStores(),
        }),
      );

      expect(failure.message).toContain(
        'No models are currently available for delegation. Review or configure model access before delegating.',
      );
    }).pipe(Effect.provide(fakeProcessServices())),
  );
});

describe('delegation worktree availability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getVisibleAgents.mockReturnValue([
      { name: 'research', description: 'Derive and verify.' },
    ]);
  });

  function delegateTool(): ToolDefinition {
    return {
      name: 'delegate_agent',
      availabilityCategory: 'toolUse',
      description: DELEGATE_AGENT_WORKTREE_DESCRIPTION,
    };
  }

  it('substitutes the ENABLED guidance when worktrees are on', () => {
    mocks.isWorktreeSupportEnabled.mockReturnValue(true);

    const rewritten = annotateDelegationAvailability(
      delegateTool(),
      undefined,
      readDelegationAnnotationState(annotationSettings),
    );

    expect(rewritten.description).toContain('Git worktree support: ENABLED.');
    expect(rewritten.description).toContain('Pass `working_directory`');
    expect(rewritten.description).not.toContain(
      'resolved from the active workspace at runtime',
    );
    // The lines above the worktree line are left intact.
    expect(rewritten.description).toContain(
      'Available models: loaded from the active API mode at runtime.',
    );
  });
});

describe('resolveAgentTools delegation annotation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readModelAvailabilityInputs.mockReturnValue(
      Effect.succeed([
        {
          value: 'deepseekT',
          label: 'DeepSeek',
          availability: 'provider-key',
        },
      ]),
    );
  });

  it.effect(
    'reflects the current roster on each call, not a frozen snapshot',
    () =>
      Effect.gen(function* () {
        // The #6655 regression: the roster was captured once and reused.
        // Resolving twice with a roster change between calls must yield a
        // refreshed list.
        mocks.getVisibleAgents.mockReturnValue([
          { name: 'research', description: 'Derive.' },
          { name: 'numerics', description: 'Simulate.' },
        ]);
        const first = yield* resolveDelegateAgent();
        expect(first?.description).toContain('- research:');
        expect(first?.description).toContain('- numerics:');

        mocks.getVisibleAgents.mockReturnValue([
          { name: 'coder', description: 'Write code.' },
        ]);
        const second = yield* resolveDelegateAgent();
        expect(second?.description).toContain('- coder:');
        expect(second?.description).not.toContain('- research:');
        expect(second?.description).not.toContain('- numerics:');
      }),
  );

  it.effect(
    'reads the annotation facts from the slots the resolution was given',
    () =>
      Effect.gen(function* () {
        // The annotation's worktree read answers for the session whose slots
        // were handed in: a multi-session host resolving another project's
        // tools must not get this project's answer.
        mocks.getVisibleAgents.mockReturnValue([]);
        const worktreeTool: ToolInput = {
          name: 'delegate_agent',
          availabilityCategory: 'toolUse',
          description: DELEGATE_AGENT_WORKTREE_DESCRIPTION,
        };
        const enabledStores: ModelOptionStores = { ...hostStores() };
        mocks.isWorktreeSupportEnabled.mockImplementation(
          (stores: SettingsStores) => stores === enabledStores,
        );

        const enabled = yield* resolveToolList([worktreeTool], enabledStores);
        const other = yield* resolveToolList([worktreeTool]);

        expect(enabled[0]?.description).toContain(
          'Git worktree support: ENABLED.',
        );
        expect(other[0]?.description).toContain(
          'Git worktree support: DISABLED',
        );
      }),
  );

  it.effect('annotates each delegation tool from its own agent category', () =>
    Effect.gen(function* () {
      mocks.getVisibleAgents.mockImplementation((category: string) =>
        category === 'toolUse'
          ? [{ name: 'coder', description: 'Write code.' }]
          : [{ name: 'apply', description: 'Apply review suggestions.' }],
      );

      const tools = yield* resolveToolList([
        DELEGATE_AGENT_TOOL,
        {
          name: 'delegate_workflow',
          availabilityCategory: 'workflow',
          description: DELEGATE_WORKFLOW_DESCRIPTION,
        },
      ]);

      const delegateAgent = tools.find((t) => t.name === 'delegate_agent');
      const delegateWorkflow = tools.find(
        (t) => t.name === 'delegate_workflow',
      );
      expect(delegateAgent?.description).toContain('- coder:');
      expect(delegateAgent?.description).not.toContain('- apply:');
      expect(delegateWorkflow?.description).toContain('- apply:');
      expect(delegateWorkflow?.description).not.toContain('- coder:');
      expect(mocks.getVisibleAgents).toHaveBeenCalledWith('toolUse');
      expect(mocks.getVisibleAgents).toHaveBeenCalledWith('workflow');
    }),
  );
});
