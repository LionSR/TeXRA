// Third-party imports
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Local imports
import type { AgentConfig } from '@agent/core/definition/AgentConfig';

const getHelperModelName = vi.hoisted(() => vi.fn());
const getModelUnavailableReason = vi.hoisted(() => vi.fn());
const resolveRuntimeModelConfig = vi.hoisted(() => vi.fn());

vi.mock('@agent/runtime/helperModelName', () => ({ getHelperModelName }));
vi.mock('@model/computeModelOptions', () => ({ getModelUnavailableReason }));
vi.mock('@model/runtimeModelRegistry', () => ({ resolveRuntimeModelConfig }));

const MODEL_CONFIGS = {
  deepseek: { capabilities: { supportsFunctionCalling: true } },
  chatonly: { capabilities: { supportsFunctionCalling: false } },
  // Known model whose capabilities omit supportsFunctionCalling — the tool-use
  // flow treats this as "no function calling".
  undeclared: { capabilities: {} },
};

function configFor(model: string, agentCategory = 'toolUse'): AgentConfig {
  return {
    agent: 'latexFixer',
    model,
    agentCategory,
  } as unknown as AgentConfig;
}

describe('applyHelperModelPreference', () => {
  beforeEach(() => {
    vi.resetModules();
    getHelperModelName.mockReset();
    getModelUnavailableReason.mockReset();
    resolveRuntimeModelConfig.mockImplementation(async (model: string) =>
      Object.hasOwn(MODEL_CONFIGS, model)
        ? MODEL_CONFIGS[model as keyof typeof MODEL_CONFIGS]
        : undefined,
    );
  });

  async function resolve(config: AgentConfig): Promise<AgentConfig> {
    const { applyHelperModelPreference } =
      await import('@agent/runtime/helperModelPreference');
    return applyHelperModelPreference(config);
  }

  it('swaps onto the available helper model', async () => {
    getHelperModelName.mockReturnValue('deepseek');
    getModelUnavailableReason.mockResolvedValue(undefined);

    const result = await resolve(configFor('opus'));

    expect(result.model).toBe('deepseek');
    expect(getModelUnavailableReason).toHaveBeenCalledWith(
      'deepseek',
      undefined,
      { agentCategory: 'toolUse' },
    );
  });

  it('keeps the model when the helper model already equals it', async () => {
    getHelperModelName.mockReturnValue('opus');

    const result = await resolve(configFor('opus'));

    expect(result.model).toBe('opus');
    expect(getModelUnavailableReason).not.toHaveBeenCalled();
  });

  it('keeps the selected model when a tool-use helper cannot call functions', async () => {
    getHelperModelName.mockReturnValue('chatonly');

    const result = await resolve(configFor('opus', 'toolUse'));

    expect(result.model).toBe('opus');
    expect(getModelUnavailableReason).not.toHaveBeenCalled();
  });

  it('keeps the selected model when the tool-use helper model is unknown to the registry', async () => {
    getHelperModelName.mockReturnValue('mysteryModel');

    const result = await resolve(configFor('opus', 'toolUse'));

    expect(result.model).toBe('opus');
    expect(getModelUnavailableReason).not.toHaveBeenCalled();
  });

  it("keeps the selected model when the tool-use helper model doesn't declare function calling", async () => {
    // capabilities present but supportsFunctionCalling omitted — the tool-use
    // flow would strip tools, so don't swap.
    getHelperModelName.mockReturnValue('undeclared');

    const result = await resolve(configFor('opus', 'toolUse'));

    expect(result.model).toBe('opus');
    expect(getModelUnavailableReason).not.toHaveBeenCalled();
  });

  it('swaps a workflow agent without applying the tool-capability guard', async () => {
    // A workflow agent doesn't use the tool-use flow, so a non-function-calling
    // helper is fine.
    getHelperModelName.mockReturnValue('chatonly');
    getModelUnavailableReason.mockResolvedValue(undefined);

    const result = await resolve(configFor('opus', 'workflow'));

    expect(result.model).toBe('chatonly');
    expect(getModelUnavailableReason).toHaveBeenCalledWith(
      'chatonly',
      undefined,
      { agentCategory: 'workflow' },
    );
  });

  it('falls back to the selected model when the helper model is unavailable', async () => {
    getHelperModelName.mockReturnValue('deepseek');
    getModelUnavailableReason.mockResolvedValue('No API key configured.');

    const result = await resolve(configFor('opus'));

    expect(result.model).toBe('opus');
  });
});
