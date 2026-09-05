import '@test/support/defaultSessionTestSetup';
import { describe, expect, it } from 'vitest';
import {
  collectResumeUsage,
  collectResumeTargets,
  formatResumeCommand,
  formatResumeHint,
  type ResumeCommandOptions,
  type ResumeTarget,
} from '@cli/chat/tui/state/resumeHint';
import {
  AgentCategory,
  type StreamTabId,
  type TokenUsageStats,
} from '@shared/schemas';
import type { StreamView } from '@shared/session/sessionView';
import { makeStreamView, viewWith } from './fixtures/sessionViewFixture';

const ROOT = 'main@m#root' as StreamTabId;

function root(usage?: TokenUsageStats): StreamView {
  return makeStreamView({
    id: ROOT,
    executionId: 'root',
    label: 'main',
    usage: usage ? { 'root-usage': usage } : {},
  });
}

/** A child of the root, as the fold states it. */
function child(
  over: Partial<StreamView> & {
    readonly id: string;
    readonly executionId: string;
  },
): StreamView {
  return makeStreamView({
    parentId: ROOT,
    ancestors: [{ id: ROOT, label: 'main' }],
    ...over,
  });
}

/** Root plus one subagent: the shared fixture for multi-line hint cases. */
const TWO_RESUME_TARGETS: readonly ResumeTarget[] = [
  { executionId: 'root', label: 'main', isRoot: true },
  { executionId: 'rev', label: 'reviewer', isRoot: false },
];

describe('collectResumeTargets', () => {
  it('returns just the main session when there are no subagents', () => {
    expect(
      collectResumeTargets({
        view: viewWith([root()]),
        rootStreamId: ROOT,
        rootExecutionId: 'root',
      }),
    ).toEqual([{ executionId: 'root', label: 'main', isRoot: true }]);
  });

  it('lists running and finished plain tool-use subagents', () => {
    const view = viewWith([
      root(),
      child({ id: 'reviewer@m#rev', executionId: 'rev', label: 'reviewer' }),
      child({
        id: 'builder@m#flow',
        executionId: 'flow',
        label: 'builder',
        category: AgentCategory.Workflow,
      }),
    ]);
    expect(
      collectResumeTargets({
        view,
        rootStreamId: ROOT,
        rootExecutionId: 'root',
      }),
    ).toEqual(TWO_RESUME_TARGETS);
  });

  it('skips children that are not plain agent runs', () => {
    const view = viewWith([
      root(),
      child({
        id: 'bash@tool#sh',
        executionId: 'sh',
        label: 'bash',
        identity: { kind: 'process', tool: 'bash' },
      }),
    ]);
    expect(
      collectResumeTargets({
        view,
        rootStreamId: ROOT,
        rootExecutionId: 'root',
      }),
    ).toEqual([{ executionId: 'root', label: 'main', isRoot: true }]);
  });

  it('returns nothing when there is no root execution yet', () => {
    expect(
      collectResumeTargets({
        view: viewWith([]),
        rootStreamId: undefined,
        rootExecutionId: undefined,
      }),
    ).toEqual([]);
  });
});

describe('formatResumeHint', () => {
  it.each<{
    name: string;
    commandName: string | undefined;
    options?: ResumeCommandOptions;
    expected: string;
  }>([
    {
      name: 'falls back to the default texra command name',
      commandName: undefined,
      expected: 'texra resume root',
    },
    {
      name: 'uses a local launcher when provided',
      commandName: 'texra-local',
      expected: 'texra-local resume root',
    },
    {
      name: 'adds a quoted cwd when the session workspace differs from the shell cwd',
      commandName: 'texra-local',
      options: { cwd: "/tmp/texra user's paper", processCwd: '/tmp/launcher' },
      expected: 'texra-local resume root --cwd "/tmp/texra user\'s paper"',
    },
    {
      name: 'omits cwd when the resume command is already printed from that workspace',
      commandName: 'texra-local',
      options: { cwd: '/tmp/paper', processCwd: '/tmp/paper' },
      expected: 'texra-local resume root',
    },
    {
      name: 'preserves whitespace in a stored workspace path',
      commandName: 'texra-local',
      options: { cwd: '/tmp/paper ', processCwd: '/tmp/launcher' },
      expected: "texra-local resume root --cwd '/tmp/paper '",
    },
    {
      name: 'omits the default approval policy',
      commandName: 'texra-local',
      options: { approvalPolicy: 'ask' },
      expected: 'texra-local resume root',
    },
    {
      name: 'preserves a non-default approval policy',
      commandName: 'texra-local',
      options: { approvalPolicy: 'never' },
      expected: 'texra-local resume root --approval-policy never',
    },
    {
      name: 'preserves a non-default approval policy with the default command name',
      commandName: undefined,
      options: { approvalPolicy: 'yolo' },
      expected: 'texra resume root --approval-policy yolo',
    },
    {
      name: 'preserves a non-default output format',
      commandName: 'texra-local',
      options: { outputFormat: 'ndjson' },
      expected: 'texra-local resume root --output-format ndjson',
    },
    {
      name: 'preserves headless mode and custom skill sources',
      commandName: 'texra-local',
      options: {
        print: true,
        includeInteropSkills: true,
        skillSourcePaths: ['/tmp/shared skills', './local-skills'],
      },
      expected:
        "texra-local resume root --print --include-interop --source '/tmp/shared skills' --source ./local-skills",
    },
    {
      name: 'includes both cwd and approval policy when both are needed',
      commandName: 'texra-local',
      options: {
        cwd: '/tmp/paper',
        processCwd: '/tmp/launcher',
        approvalPolicy: 'never',
      },
      expected:
        'texra-local resume root --cwd /tmp/paper --approval-policy never',
    },
  ])('formats resume commands: $name', ({ commandName, options, expected }) => {
    expect(formatResumeCommand(commandName, 'root', options)).toBe(expected);
  });

  it('renders one resume line per target', () => {
    expect(formatResumeHint(TWO_RESUME_TARGETS)).toBe(
      [
        'Resume this session with:',
        '  texra resume root  (main)',
        '  texra resume rev  (reviewer)',
      ].join('\n'),
    );
  });

  it('uses the provided command name for every resume target', () => {
    expect(
      formatResumeHint(TWO_RESUME_TARGETS, undefined, 'texra-local', {
        approvalPolicy: 'never',
      }),
    ).toBe(
      [
        'Resume this session with:',
        '  texra-local resume root --approval-policy never  (main)',
        '  texra-local resume rev --approval-policy never  (reviewer)',
      ].join('\n'),
    );
  });

  it('includes cwd on every resume target when needed', () => {
    expect(
      formatResumeHint(TWO_RESUME_TARGETS, undefined, 'texra-local', {
        cwd: '/tmp/paper',
        processCwd: '/tmp/launcher',
      }),
    ).toBe(
      [
        'Resume this session with:',
        '  texra-local resume root --cwd /tmp/paper  (main)',
        '  texra-local resume rev --cwd /tmp/paper  (reviewer)',
      ].join('\n'),
    );
  });

  it('prepends token usage when available', () => {
    expect(
      formatResumeHint([{ executionId: 'root', label: 'main', isRoot: true }], {
        inputTokens: 186_189_742,
        outputTokens: 11_042_600,
        cost: 0,
        cacheReadInputTokens: 6_470_327_168,
        reasoningTokens: 3_489_148,
      } satisfies TokenUsageStats),
    ).toBe(
      [
        'Token usage: total=197,232,342 input=186,189,742 (+ 6,470,327,168 cached) output=11,042,600 (reasoning 3,489,148)',
        'Resume this session with:',
        '  texra resume root  (main)',
      ].join('\n'),
    );
  });

  it.each<{
    usageRoute: TokenUsageStats['usageRoute'];
    cost: number;
    expected: string;
  }>([
    {
      usageRoute: 'relay',
      cost: 0.012,
      expected: '$0.012 via included access',
    },
    {
      usageRoute: 'chatgpt-subscription',
      cost: 0,
      expected: 'Free via ChatGPT',
    },
    {
      usageRoute: 'api-key',
      cost: 0.5,
      expected: '$0.500 via your own API keys',
    },
  ])(
    'includes the $usageRoute session cost in the full hint',
    ({ usageRoute, cost, expected }) => {
      expect(
        formatResumeHint(
          [{ executionId: 'root', label: 'main', isRoot: true }],
          {
            inputTokens: 100,
            outputTokens: 20,
            cost,
            usageRoute,
          } satisfies TokenUsageStats,
        ),
      ).toBe(
        [
          'Token usage: total=120 input=100 output=20',
          `Session cost: ${expected}`,
          'Resume this session with:',
          '  texra resume root  (main)',
        ].join('\n'),
      );
    },
  );

  it('is undefined when there is nothing to resume', () => {
    expect(formatResumeHint([])).toBeUndefined();
  });
});

describe('collectResumeUsage', () => {
  it('sums usage from every stream under the root', () => {
    const view = viewWith([
      root({
        inputTokens: 100,
        outputTokens: 20,
        cost: 0.2,
        cacheReadInputTokens: 7,
      }),
      child({
        id: 'review@m#rev',
        executionId: 'rev',
        usage: {
          'rev-usage': {
            inputTokens: 40,
            outputTokens: 8,
            cost: 0.3,
            cacheReadInputTokens: 3,
            reasoningTokens: 5,
          } as TokenUsageStats,
        },
      }),
    ]);
    expect(collectResumeUsage(view, ROOT)).toEqual({
      inputTokens: 140,
      outputTokens: 28,
      cost: 0.5,
      cacheReadInputTokens: 10,
      cacheMissInputTokens: 0,
      cacheCreationInputTokens: 0,
      reasoningTokens: 5,
    });
  });
});
