// Local imports - agent options
import { computeAgentOptionsData } from '@agent/index';

// Local imports - model options
import { computeModelOptionsData } from '@model/computeModelOptions';

// Local imports - state
import { GlobalStateKey, globalSM } from '@common/state';
import { DEFAULT_HELPER_MODEL } from '@shared/constants/providers';

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

  const defaultMergeModel = globalSM.get<string>(
    GlobalStateKey.HELPER_MODEL,
    DEFAULT_HELPER_MODEL,
  );

  return {
    agentOptions,
    modelOptions,
    defaultMergeModel,
  };
}
