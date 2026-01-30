// Local imports - agent + model options
import { computeAgentOptionsData } from '@agent/index';
import { computeModelOptionsData } from '@model/computeModelOptions';
import { getConfig } from '@utils/config';

type AgentOptionsData = Awaited<ReturnType<typeof computeAgentOptionsData>>;
type ModelOptionsData = Awaited<ReturnType<typeof computeModelOptionsData>>;

export interface OptionsLoadResult {
  agentOptionsData: AgentOptionsData;
  modelOptionsData: ModelOptionsData;
  defaultMergeModel: string;
}

export async function loadOptions(): Promise<OptionsLoadResult> {
  const [agentOptionsData, modelOptionsData] = await Promise.all([
    computeAgentOptionsData(),
    computeModelOptionsData(),
  ]);

  const defaultMergeModel = getConfig<string>(
    'texra.merge.defaultModel',
    'gemini3f',
  );

  return { agentOptionsData, modelOptionsData, defaultMergeModel };
}
