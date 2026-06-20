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
}: {
  readonly apiMode?: CliApiMode;
  readonly model: string;
  readonly modelSource: CliModelSelectionSource;
  readonly noAvailableModelsMessage?: string;
}): Promise<CliRunnableModelResolution> {
  const selection = await resolveCliRunnableModel(model, {
    fallbackSource: modelSource,
    apiMode,
    ...(noAvailableModelsMessage == null ? {} : { noAvailableModelsMessage }),
  });
  await setCliHelperModel(selection.model);
  return selection;
}
