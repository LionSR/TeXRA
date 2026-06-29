// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import type { AgentConfig } from '@agent/core/definition/AgentConfig';

const getAgent = vi.hoisted(() => vi.fn());
const createKey = vi.hoisted(
  () => (source: string, name: string) => `${source}:${name}`,
);
const getHelperModelName = vi.hoisted(() => vi.fn());
const getModelUnavailableReason = vi.hoisted(() => vi.fn());

vi.mock('@agent/index', () => ({ getAgent, createKey }));
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
    getAgent.mockReset();
    getHelperModelName.mockReset();
    getModelUnavailableReason.mockReset();
  });

  async function resolve(config: AgentConfig): Promise<AgentConfig> {
    const { preferHelperModelForAssistive } = await import(
      '@agent/runtime/assistiveModel'
    );
    return preferHelperModelForAssistive(config);
  }

  it('swaps an assistive agent onto the available helper model', async () => {
    getAgent.mockReturnValue({
      name: 'latexFixer',
      category: 'toolUse',
      assistive: true,
    });
    getHelperModelName.mockReturnValue('deepseek');
    getModelUnavailableReason.mockResolvedValue(undefined);

    const result = await resolve(configFor('latexFixer', 'opus'));

    expect(result.model).toBe('deepseek');
    expect(getModelUnavailableReason).toHaveBeenCalledWith('deepseek');
  });

  it('leaves a non-assistive agent on its selected model', async () => {
    getAgent.mockReturnValue({ name: 'coder', category: 'toolUse' });
    getHelperModelName.mockReturnValue('deepseek');

    const result = await resolve(configFor('coder', 'opus'));

    expect(result.model).toBe('opus');
    expect(getHelperModelName).not.toHaveBeenCalled();
    expect(getModelUnavailableReason).not.toHaveBeenCalled();
  });

  it('falls back to the selected model when the helper model is unavailable', async () => {
    getAgent.mockReturnValue({
      name: 'latexFixer',
      category: 'toolUse',
      assistive: true,
    });
    getHelperModelName.mockReturnValue('deepseek');
    getModelUnavailableReason.mockResolvedValue('No API key configured.');

    const result = await resolve(configFor('latexFixer', 'opus'));

    expect(result.model).toBe('opus');
  });

  it('keeps the model when the helper model already equals it', async () => {
    getAgent.mockReturnValue({
      name: 'latexFixer',
      category: 'toolUse',
      assistive: true,
    });
    getHelperModelName.mockReturnValue('opus');

    const result = await resolve(configFor('latexFixer', 'opus'));

    expect(result.model).toBe('opus');
    // No availability probe needed — the model is unchanged.
    expect(getModelUnavailableReason).not.toHaveBeenCalled();
  });

  it('keeps the selected model when the helper model cannot call tools', async () => {
    getAgent.mockReturnValue({
      name: 'latexFixer',
      category: 'toolUse',
      assistive: true,
    });
    getHelperModelName.mockReturnValue('chatonly');

    const result = await resolve(configFor('latexFixer', 'opus'));

    // A tool-use agent must not be switched onto a non-function-calling model.
    expect(result.model).toBe('opus');
    expect(getModelUnavailableReason).not.toHaveBeenCalled();
  });

  it('honors a pinned agent source when detecting assistiveness', async () => {
    getAgent.mockImplementation((identifier: string) =>
      identifier === 'builtInToolUse:latexFixer'
        ? { name: 'latexFixer', category: 'toolUse', assistive: true }
        : { name: 'latexFixer', category: 'toolUse', assistive: undefined },
    );
    getHelperModelName.mockReturnValue('deepseek');
    getModelUnavailableReason.mockResolvedValue(undefined);

    const result = await resolve(
      configFor('latexFixer', 'opus', { agentSource: 'builtInToolUse' }),
    );

    // The source-pinned built-in entry is assistive even though the bare-name
    // lookup would resolve a non-assistive same-name agent.
    expect(getAgent).toHaveBeenCalledWith('builtInToolUse:latexFixer');
    expect(result.model).toBe('deepseek');
  });

  it('leaves the model unchanged when the agent is not in the registry', async () => {
    getAgent.mockReturnValue(undefined);

    const result = await resolve(configFor('latexFixer', 'opus'));

    expect(result.model).toBe('opus');
    expect(getHelperModelName).not.toHaveBeenCalled();
  });
});
