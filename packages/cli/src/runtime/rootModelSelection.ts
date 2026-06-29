import type { AgentCategory } from '@shared/schemas/agent';

import { setCliHelperModel } from './initPlatform';
import {
  resolveCliRunnableModel,
  type CliModelSelectionSource,
  type CliRunnableModelResolution,
} from './modelAccess';
import type { CliApiMode } from './apiAccessMode';

export async function selectCliRootModel({
  apiMode,
  model,
  modelSource,
  noAvailableModelsMessage,
  agentCategory,
}: {
  readonly apiMode?: CliApiMode;
  readonly model: string;
  readonly modelSource: CliModelSelectionSource;
  readonly noAvailableModelsMessage?: string;
  readonly agentCategory?: AgentCategory;
}): Promise<CliRunnableModelResolution> {
  const selection = await resolveCliRunnableModel(model, {
    fallbackSource: modelSource,
    apiMode,
    agentCategory,
    ...(noAvailableModelsMessage == null ? {} : { noAvailableModelsMessage }),
  });
  await setCliHelperModel(selection.model);
  return selection;
}
