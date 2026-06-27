import { computeRuntimeAgentOptionsData } from '@agent/runtime/agentResolution';
import { getHelperModelName } from '@agent/runtime/helperModelName';
import { computeModelOptionsData } from '@model/computeModelOptions';

export interface OptionsPayload {
  agentOptions: Awaited<ReturnType<typeof computeRuntimeAgentOptionsData>>;
  modelOptions: Awaited<ReturnType<typeof computeModelOptionsData>>;
  defaultMergeModel: string;
}

export async function loadOptions(): Promise<OptionsPayload> {
  const [modelOptions, agentOptions] = await Promise.all([
    computeModelOptionsData(),
    computeRuntimeAgentOptionsData(),
  ]);

  const defaultMergeModel = getHelperModelName();

  return {
    agentOptions,
    modelOptions,
    defaultMergeModel,
  };
}
