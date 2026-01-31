// Local imports - agent options
import { computeAgentOptionsData, refresh } from '@agent/index';

// Local imports - model options
import { computeModelOptionsData } from '@model/computeModelOptions';

// Local imports - config
import { getConfig } from '@utils/config';

export interface OptionsPayload {
  agentOptions: Awaited<ReturnType<typeof computeAgentOptionsData>>;
  modelOptions: Awaited<ReturnType<typeof computeModelOptionsData>>;
  defaultMergeModel: string;
}

export interface LoadOptionsParams {
  refreshAgents?: boolean;
  onError?: (error: unknown) => void;
}

export async function loadOptions(
  params: LoadOptionsParams = {},
): Promise<OptionsPayload | null> {
  const { refreshAgents = true, onError } = params;

  try {
    if (refreshAgents) {
      await refresh();
    }
    const [modelOptions, agentOptions] = await Promise.all([
      computeModelOptionsData(),
      computeAgentOptionsData(),
    ]);

    const defaultMergeModel = getConfig<string>(
      'texra.merge.defaultModel',
      'gemini3f',
    );

    return {
      agentOptions,
      modelOptions,
      defaultMergeModel,
    };
  } catch (error) {
    onError?.(error);
    return null;
  }
}
