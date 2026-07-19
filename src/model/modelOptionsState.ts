import type { StateStore } from '@platform/interfaces';
import { GlobalStateKey } from '@shared/state/stateKeys';

import { DEFAULT_MODELS } from './modelOptionsBasic';

/** Read the enabled model list from host state at the composition boundary. */
export function getVisibleModels(state: Pick<StateStore, 'get'>): string[] {
  return state.get<string[]>(GlobalStateKey.ENABLED_MODELS, DEFAULT_MODELS);
}
