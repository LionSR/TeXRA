// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import type { AgentConfig } from '@agent/core/definition/AgentConfig';

const resolveAgentForLaunch = vi.hoisted(() => vi.fn());
const getHelperModelName = vi.hoisted(() => vi.fn());
const getModelUnavailableReason = vi.hoisted(() => vi.fn());

vi.mock('@agent/index', () => ({ resolveAgentForLaunch }));
vi.mock('@agent/runtime/helperModelName', () => ({ getHelperModelName }));
vi.mock('@model/computeModelOptions', () => ({ getModelUnavailableReason }));
vi.mock('llm-zoo', () => ({
  MODEL_CONFIGS: {
    deepseek: { capabilities: { supportsFunctionCalling: true } },
    chatonly: { capabilities: { supportsFunctionCalling: false } },
  },
}));

function configFor(
  agent: string,
  model: string,
  extra: Partial<AgentConfig> = {},
): AgentConfig {
  return {
    agent,
    model,
    agentCategory: 'toolUse',
    ...extra,
  } as unknown as AgentConfig;
}

describe('preferHelperModelForAssistive', () => {
  beforeEach(() => {
    vi.resetModules();
    resolveAgentForLaunch.mockReset();
    getHelperModelName.mockReset();
    getModelUnavailableReason.mockReset();
  });

  // resolveAgentForLaunch returns a ResolvedAgent ({ entry, ... }); only .entry
  // is read here.
  const resolved = (entry: Record<string, unknown> | undefined) =>
    entry ? { entry } : undefined;

  async function resolve(config: AgentConfig): Promise<AgentConfig> {
    const { preferHelperModelForAssistive } =
      await import('@agent/runtime/assistiveModel');
    return preferHelperModelForAssistive(config);
  }

  it('swaps an assistive agent onto the available helper model', async () => {
    resolveAgentForLaunch.mockReturnValue(
      resolved({ name: 'latexFixer', category: 'toolUse', assistive: true }),
    );
    getHelperModelName.mockReturnValue('deepseek');
    getModelUnavailableReason.mockResolvedValue(undefined);

    const result = await resolve(configFor('latexFixer', 'opus'));

    expect(result.model).toBe('deepseek');
    expect(getModelUnavailableReason).toHaveBeenCalledWith('deepseek');
  });

  it('leaves a non-assistive agent on its selected model', async () => {
    resolveAgentForLaunch.mockReturnValue(
      resolved({ name: 'coder', category: 'toolUse' }),
    );
    getHelperModelName.mockReturnValue('deepseek');

    const result = await resolve(configFor('coder', 'opus'));

    expect(result.model).toBe('opus');
    expect(getHelperModelName).not.toHaveBeenCalled();
    expect(getModelUnavailableReason).not.toHaveBeenCalled();
  });

  it('falls back to the selected model when the helper model is unavailable', async () => {
    resolveAgentForLaunch.mockReturnValue(
      resolved({ name: 'latexFixer', category: 'toolUse', assistive: true }),
    );
    getHelperModelName.mockReturnValue('deepseek');
    getModelUnavailableReason.mockResolvedValue('No API key configured.');

    const result = await resolve(configFor('latexFixer', 'opus'));

    expect(result.model).toBe('opus');
  });

  it('keeps the model when the helper model already equals it', async () => {
    resolveAgentForLaunch.mockReturnValue(
      resolved({ name: 'latexFixer', category: 'toolUse', assistive: true }),
    );
    getHelperModelName.mockReturnValue('opus');

    const result = await resolve(configFor('latexFixer', 'opus'));

    expect(result.model).toBe('opus');
    // No availability probe needed — the model is unchanged.
    expect(getModelUnavailableReason).not.toHaveBeenCalled();
  });

  it('keeps the selected model when the helper model cannot call tools', async () => {
    resolveAgentForLaunch.mockReturnValue(
      resolved({ name: 'latexFixer', category: 'toolUse', assistive: true }),
    );
    getHelperModelName.mockReturnValue('chatonly');

    const result = await resolve(configFor('latexFixer', 'opus'));

    // A tool-use agent must not be switched onto a non-function-calling model.
    expect(result.model).toBe('opus');
    expect(getModelUnavailableReason).not.toHaveBeenCalled();
  });

  it('detects assistiveness through the launch resolver, honoring agentSource', async () => {
    resolveAgentForLaunch.mockReturnValue(
      resolved({ name: 'latexFixer', category: 'toolUse', assistive: true }),
    );
    getHelperModelName.mockReturnValue('deepseek');
    getModelUnavailableReason.mockResolvedValue(undefined);

    const result = await resolve(
      configFor('latexFixer', 'opus', { agentSource: 'builtInToolUse' }),
    );

    // Resolution goes through the same launch resolver, with the pinned source
    // threaded through, so detection cannot diverge from the launched entry.
    expect(resolveAgentForLaunch).toHaveBeenCalledWith(
      'toolUse',
      'latexFixer',
      'builtInToolUse',
    );
    expect(result.model).toBe('deepseek');
  });

  it('leaves the model unchanged when the agent does not resolve for launch', async () => {
    resolveAgentForLaunch.mockReturnValue(undefined);

    const result = await resolve(configFor('latexFixer', 'opus'));

    expect(result.model).toBe('opus');
    expect(getHelperModelName).not.toHaveBeenCalled();
  });
});
