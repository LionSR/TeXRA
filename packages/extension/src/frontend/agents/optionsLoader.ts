import {
  computeRuntimeAgentOptionsData,
  refreshRuntimeAgentCatalog,
} from '@agent/runtime/agentResolution';
import { getRuntimeDefaultMergeModelName } from '@agent/runtime/executionRequests';
import { computeModelOptionsData } from '@model/computeModelOptions';

export interface OptionsPayload {
  agentOptions: Awaited<ReturnType<typeof computeRuntimeAgentOptionsData>>;
  modelOptions: Awaited<ReturnType<typeof computeModelOptionsData>>;
  defaultMergeModel: string;
}

export async function loadOptions(): Promise<OptionsPayload> {
  const [modelOptions, agentOptions] = await Promise.all([
    loadModelOptions(),
    loadAgentOptions(),
  ]);

  const defaultMergeModel = getRuntimeDefaultMergeModelName();

  return {
    agentOptions,
    modelOptions,
    defaultMergeModel,
  };
}

export async function loadModelOptions(): Promise<
  OptionsPayload['modelOptions']
> {
  return computeModelOptionsData();
}

export async function loadAgentOptions(): Promise<
  OptionsPayload['agentOptions']
> {
  return computeRuntimeAgentOptionsData();
}

export async function refreshAgentCatalog(): Promise<void> {
  await refreshRuntimeAgentCatalog();
}
