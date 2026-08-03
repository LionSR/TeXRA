// Third-party imports
import { z } from 'zod';

// Local imports - shared schemas
import {
  MainViewPersistedStateSchema,
  type MainViewPersistedState,
} from '@shared/schemas';

/**
 * VS Code compatibility reader for main-view snapshots written with synthetic
 * `copilot:<baseModel>` picker ids before #9635. Introduced 2026-08-03;
 * retire after 2026-11-03 with the other Copilot identity readers.
 *
 * This stays extension-local because Electron never wrote that VS Code picker
 * format. The shared schema therefore describes only the current state shape.
 */
export const VscodeMainViewPersistedStateSchema: z.ZodType<MainViewPersistedState> =
  z.preprocess((input) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
      return input;
    }
    const model = 'model' in input ? input.model : undefined;
    if (typeof model !== 'string' || !model.startsWith('copilot:'))
      return input;
    return { ...input, model: model.slice('copilot:'.length) };
  }, MainViewPersistedStateSchema);
