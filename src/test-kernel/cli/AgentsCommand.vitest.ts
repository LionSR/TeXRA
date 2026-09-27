/* eslint-disable import/order -- Vitest mocks must be declared before importing the runtime under test. */
import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Shared mock registrations must evaluate before anything that loads
// the mocked modules — keep these imports immediately after the vitest
// import (enforced by architecture/supportMockImportOrder.vitest.ts).
import { agentCatalogMock } from '@test/support/agentCatalogMock';
import { cliInitPlatformMock } from '@test/support/cliInitPlatformMock';
import { cliLogSinksMock } from '@test/support/cliLogSinksMock';
import { cliOutputMock } from '@test/support/cliOutputMock';

import { AgentCategory } from '@shared/schemas';
import { createRunCommandCliContext } from '@test/cli/fixtures/cliContext';
import { testRuntime } from '@test/support/testProcessRuntime';

const mocks = vi.hoisted(() => ({
  resolveCliAgent: vi.fn(),
}));

vi.mock('@cli/runtime/agents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cli/runtime/agents')>()),
  resolveCliAgent: mocks.resolveCliAgent,
}));

// Import the modules under test after the mock factories above are registered
// so their imports resolve to the mocked modules. Top-level (not beforeAll) so
// the import cost lands in file load, not the first test's timeout budget.
const { listAgents, showAgent } = await import('@cli/commands/agents');
const { parseCliAgentCategoryFilter } = await import('@cli/runtime/agents');

// Both entries are programs now; the command runs them on the process runtime
// it installs, and here that is the harness's.
const runListAgents = (...args: Parameters<typeof listAgents>) =>
  testRuntime().runPromise(listAgents(...args));
const runShowAgent = (...args: Parameters<typeof showAgent>) =>
  testRuntime().runPromise(showAgent(...args));

const LEAN_AGENT = {
  name: 'lean',
  source: 'builtInToolUse',
  path: '/tmp/resources/tool_use_agents/lean.yaml',
  category: AgentCategory.ToolUse,
  description: 'Lean 4 proof assistant.',
};

const CHAT_AGENT = {
  name: 'chat',
  source: 'builtInToolUse',
  path: '/tmp/resources/tool_use_agents/chat.yaml',
  category: AgentCategory.ToolUse,
  description: 'Interactive assistant.',
};

const CORRECT_AGENT = {
  name: 'correct',
  source: 'builtInWorkflow',
  path: '/tmp/resources/agents/correct.yaml',
  category: AgentCategory.Workflow,
  description: 'Corrects LaTeX.',
};

type CategoryCatalog = Partial<
  Record<
    AgentCategory,
    { visible?: readonly unknown[]; all: readonly unknown[] }
  >
>;

function stubCatalog(catalog: CategoryCatalog): void {
  agentCatalogMock.getVisibleAgents.mockImplementation(
    (_stores: unknown, category: AgentCategory) =>
      Effect.succeed(catalog[category]?.visible ?? []),
  );
  agentCatalogMock.getAgentsByCategory.mockImplementation(
    (category: AgentCategory) => catalog[category]?.all ?? [],
  );
}

interface EmittedAgentsPayload {
  json: unknown;
  ndjson: unknown;
  text: string;
}

function expectEmittedAgents(payload: EmittedAgentsPayload): void {
  expect(cliOutputMock.emitPagedCliResult).toHaveBeenCalledWith(
    expect.anything(),
    payload,
  );
}

describe('CLI agents command', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The CLI init hands its caller the composition root's services; these
    // commands read the process runtime off what it returns.
    cliInitPlatformMock.initCliPlatform.mockReturnValue(
      Effect.succeed({ runtime: testRuntime() }),
    );
    agentCatalogMock.getAgentsByCategory.mockReturnValue([]);
    agentCatalogMock.getVisibleAgents.mockReturnValue(Effect.succeed([]));
  });

  it('parses agent category filter spellings', () => {
    expect(parseCliAgentCategoryFilter('workflow')).toBe(
      AgentCategory.Workflow,
    );
    expect(parseCliAgentCategoryFilter('toolUse')).toBe(AgentCategory.ToolUse);
    expect(parseCliAgentCategoryFilter('tool-use')).toBe(AgentCategory.ToolUse);
    expect(parseCliAgentCategoryFilter('tool_use')).toBe(AgentCategory.ToolUse);
    expect(parseCliAgentCategoryFilter('work-flow')).toBeUndefined();
    expect(parseCliAgentCategoryFilter('unknown')).toBeUndefined();
  });

  it('lists visible agents by default and reports hidden agents', async () => {
    stubCatalog({
      [AgentCategory.ToolUse]: {
        visible: [LEAN_AGENT],
        all: [LEAN_AGENT, CHAT_AGENT],
      },
    });

    const exitCode = await runListAgents(createRunCommandCliContext());

    expect(exitCode).toBe(0);
    expect(agentCatalogMock.loadAgents).toHaveBeenCalledWith({
      includeRemote: false,
    });
    expectEmittedAgents({
      json: [LEAN_AGENT],
      ndjson: [{ kind: 'agent', agent: LEAN_AGENT }],
      text: 'toolUse\tlean\tLean 4 proof assistant.',
    });
    expect(cliLogSinksMock.writeTextStderr).toHaveBeenCalledWith(
      'Showing visible agents only; 1 hidden agent omitted. Use `texra agents list --all` to show all agents.',
    );
  });

  it('keeps quiet empty agent lists byte-empty for shell completion', async () => {
    stubCatalog({ [AgentCategory.Workflow]: { all: [CORRECT_AGENT] } });

    const exitCode = await runListAgents(
      createRunCommandCliContext({ quietLogs: true }),
      {
        category: AgentCategory.Workflow,
      },
    );

    expect(exitCode).toBe(0);
    expectEmittedAgents({
      json: [],
      ndjson: [],
      text: '',
    });
    expect(cliLogSinksMock.writeTextStderr).not.toHaveBeenCalled();
  });

  it('reports missing agents after CLI agent resolution misses', async () => {
    mocks.resolveCliAgent.mockReturnValue(Effect.succeed(undefined));

    const exitCode = await runShowAgent(
      createRunCommandCliContext(),
      'missing-agent',
    );

    expect(exitCode).toBe(2);
    expect(cliLogSinksMock.writeTextStderr).toHaveBeenCalledWith(
      'Agent not found: missing-agent. Use `texra agents list` for visible starter agents, `texra agents list --all` for every agent, or pass a known launchable agent name from a team preset.',
    );
    expect(cliOutputMock.emitCliResult).not.toHaveBeenCalled();
  });
});
