// Local imports - agent options
import { computeAgentOptionsData } from '@agent/index';

// Local imports - model options
import { computeModelOptionsData } from '@model/computeModelOptions';

// Local imports - config
import { getConfig } from '@utils/config';

export interface OptionsPayload {
  agentOptions: Awaited<ReturnType<typeof computeAgentOptionsData>>;
  modelOptions: Awaited<ReturnType<typeof computeModelOptionsData>>;
  defaultMergeModel: string;
}

export async function loadOptions(): Promise<OptionsPayload> {
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
}
