// Local imports - agent options
import { computeAgentOptionsData } from '@agent/index';

// Local imports - model options
import { getHelperModelName } from '@agent/runtime/helperModel';
import { computeModelOptionsData } from '@model/computeModelOptions';

// Local imports - helper model

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

  const defaultMergeModel = getHelperModelName();

  return {
    agentOptions,
    modelOptions,
    defaultMergeModel,
  };
}
