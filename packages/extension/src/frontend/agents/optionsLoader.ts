import { computeAgentOptionsData } from '@agent/index';
import { computeModelOptionsData } from '@model/computeModelOptions';
import { AgentCategory } from '@shared/schemas/agent';

import { loadMainViewTeamOptions } from './teamOptionsLoader';

export async function loadMainViewModelOptions(models?: readonly string[]) {
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

export async function loadOptions() {
  const [modelOptionsByCategory, agentOptions, teamOptions] = await Promise.all(
    [
      loadMainViewModelOptions(),
      computeAgentOptionsData(),
      loadMainViewTeamOptions(),
    ],
  );

  return {
    agentOptions,
    modelOptions: modelOptionsByCategory.workflow,
    modelOptionsByCategory,
    teamOptions,
  };
}
