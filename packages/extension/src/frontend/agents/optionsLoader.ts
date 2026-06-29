import { computeAgentOptionsData } from '@agent/index';
import { getHelperModelName } from '@agent/runtime/helperModelName';
import { computeModelOptionsData } from '@model/computeModelOptions';
import { AgentCategory } from '@shared/schemas/agent';

type ModelOptionsData = Awaited<ReturnType<typeof computeModelOptionsData>>;

export interface MainViewModelOptionsByCategory {
  workflow: ModelOptionsData;
  toolUse: ModelOptionsData;
}

export interface OptionsPayload {
  agentOptions: Awaited<ReturnType<typeof computeAgentOptionsData>>;
  modelOptions: ModelOptionsData;
  modelOptionsByCategory: MainViewModelOptionsByCategory;
  defaultMergeModel: string;
}

export async function loadMainViewModelOptions(
  models?: readonly string[],
): Promise<MainViewModelOptionsByCategory> {
  const [workflow, toolUse] = await Promise.all([
    computeModelOptionsData(models, undefined, {
      agentCategory: AgentCategory.Workflow,
    }),
    computeModelOptionsData(models, undefined, {
      agentCategory: AgentCategory.ToolUse,
    }),
  ]);

  return { workflow, toolUse };
}

export async function loadOptions(): Promise<OptionsPayload> {
  const [modelOptionsByCategory, agentOptions] = await Promise.all([
    loadMainViewModelOptions(),
    computeAgentOptionsData(),
  ]);

  const defaultMergeModel = getHelperModelName();

  return {
    agentOptions,
    modelOptions: modelOptionsByCategory.workflow,
    modelOptionsByCategory,
    defaultMergeModel,
  };
}
