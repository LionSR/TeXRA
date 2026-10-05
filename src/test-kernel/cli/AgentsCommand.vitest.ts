import { Effect } from 'effect';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Shared mock registrations must evaluate before anything that loads
// the mocked modules — keep these imports immediately after the vitest
// import (enforced by architecture/supportMockImportOrder.vitest.ts).
import { agentCatalogMock } from '@test/support/agentCatalogMock';
import { cliInitPlatformMock } from '@test/support/cliInitPlatformMock';
import { cliLogSinksMock } from '@test/support/cliLogSinksMock';
import { cliOutputMock } from '@test/support/cliOutputMock';

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

// Both entries are programs now; the command runs them on the process runtime
// it installs, and here that is the harness's.
const runListAgents = (...args: Parameters<typeof listAgents>) =>
  testRuntime().runPromise(listAgents(...args));
const runShowAgent = (...args: Parameters<typeof showAgent>) =>
  testRuntime().runPromise(showAgent(...args));

const LEAN_AGENT = {
  name: 'lean',
  source: 'builtIn',
  path: '/tmp/resources/tool_use_agents/lean.yaml',
  task: null,
  description: 'Lean 4 proof assistant.',
};

const CHAT_AGENT = {
  name: 'chat',
  source: 'builtIn',
  path: '/tmp/resources/tool_use_agents/chat.yaml',
  task: null,
  description: 'Interactive assistant.',
};

const CORRECT_AGENT = {
  name: 'correct',
  source: 'builtIn',
  path: '/tmp/resources/agents/correct.yaml',
  task: { outputs: ['corrected.tex'] },
  description: 'Corrects LaTeX.',
};

function stubCatalog(catalog: {
  visible?: readonly unknown[];
  all: readonly unknown[];
}): void {
  agentCatalogMock.getVisibleAgents.mockReturnValue(
    Effect.succeed(catalog.visible ?? []),
  );
  agentCatalogMock.getCatalogAgents.mockReturnValue(catalog.all);
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
    agentCatalogMock.getCatalogAgents.mockReturnValue([]);
    agentCatalogMock.getVisibleAgents.mockReturnValue(Effect.succeed([]));
  });

  it('lists visible agents by default and reports hidden agents', async () => {
    stubCatalog({ visible: [LEAN_AGENT], all: [LEAN_AGENT, CHAT_AGENT] });

    const exitCode = await runListAgents(createRunCommandCliContext());

    expect(exitCode).toBe(0);
    expectEmittedAgents({
      json: [LEAN_AGENT],
      ndjson: [{ kind: 'agent', agent: LEAN_AGENT }],
      text: 'chat\tlean\tLean 4 proof assistant.',
    });
    expect(cliLogSinksMock.writeTextStderr).toHaveBeenCalledWith(
      'Showing visible agents only; 1 hidden agent omitted. Use `texra agents list --all` to show all agents.',
    );
  });

  it('keeps quiet empty agent lists byte-empty for shell completion', async () => {
    stubCatalog({ all: [CORRECT_AGENT] });

    const exitCode = await runListAgents(
      createRunCommandCliContext({ quietLogs: true }),
      { tasks: true },
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
    mocks.resolveCliAgent.mockReturnValue(undefined);

    const exitCode = await runShowAgent(
      createRunCommandCliContext(),
      'missing-agent',
    );

    expect(exitCode).toBe(2);
    expect(cliLogSinksMock.writeTextStderr).toHaveBeenCalledWith(
      'Agent not found: missing-agent. Use `texra agents list` for visible starter agents, `texra agents list --all` for every agent, or pass a known launchable agent name from a team.',
    );
    expect(cliOutputMock.emitCliResult).not.toHaveBeenCalled();
  });
});
