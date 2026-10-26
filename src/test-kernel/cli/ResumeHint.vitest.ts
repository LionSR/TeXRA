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
import { type RunId, type TokenUsageStats } from '@shared/schemas';
import type { RunView } from '@shared/session/sessionView';
import { makeRunView, viewWith } from './fixtures/sessionViewFixture';

const ROOT = 'root' as RunId;

function root(usage?: TokenUsageStats): RunView {
  return makeRunView({
    id: ROOT,
    label: 'task',
    ...(usage ? { usage } : {}),
  });
}

/** A child of the root, as the fold states it. */
function child(over: Partial<RunView> & { readonly id: string }): RunView {
  return makeRunView({
    parentId: ROOT,
    ancestors: [{ id: ROOT, label: 'task' }],
    ...over,
  });
}

/** Root plus one subagent: the shared fixture for multi-line hint cases. */
const TWO_RESUME_TARGETS: readonly ResumeTarget[] = [
  { runId: 'root', label: 'task' },
  { runId: 'rev', label: 'reviewer' },
];

describe('collectResumeTargets', () => {
  it('lists subagents TeXRA drives, chats and document tasks alike', () => {
    const view = viewWith([
      root(),
      child({ id: 'rev' as RunId, label: 'reviewer' }),
      child({
        id: 'flow' as RunId,
        label: 'builder',
        recipe: 'task',
      }),
    ]);
    expect(
      collectResumeTargets({
        view,
        rootRunId: ROOT,
      }),
    ).toEqual([
      { runId: 'root', label: 'task' },
      { runId: 'flow', label: 'builder' },
      { runId: 'rev', label: 'reviewer' },
    ]);
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
      name: 'preserves a non-default approval policy',
      commandName: 'texra-local',
      options: { approvalPolicy: 'never' },
      expected: 'texra-local resume root --approval-policy never',
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
  ])('formats resume commands: $name', ({ commandName, options, expected }) => {
    expect(formatResumeCommand(commandName, 'root', options)).toBe(expected);
  });

  it('renders one resume line per target', () => {
    expect(formatResumeHint(TWO_RESUME_TARGETS)).toBe(
      [
        'Resume this task with:',
        '  texra resume root  (task)',
        '  texra resume rev  (reviewer)',
      ].join('\n'),
    );
  });
});

describe('collectResumeUsage', () => {
  it("reports the root's tree total, and nothing before a priced turn", () => {
    const treeUsage = {
      inputTokens: 140,
      outputTokens: 28,
      cost: 0.5,
      cacheReadInputTokens: 10,
    };
    const view = viewWith([
      makeRunView({ id: ROOT, label: 'task', treeUsage }),
      child({ id: 'rev' as RunId }),
    ]);
    expect(collectResumeUsage(view, ROOT)).toEqual(treeUsage);
    expect(collectResumeUsage(viewWith([root()]), ROOT)).toBeUndefined();
  });
});
