import { Effect } from 'effect';

import type { SettingsCatalog } from '@shared/state/stateSettings';

import { JsonConfigProvider, type ConfigStore } from './jsonConfigProvider';

/** Process-local {@link ConfigStore}, the in-memory twin of a `JsonStore`. */
function memoryConfigStore(): ConfigStore {
  const values = new Map<string, unknown>();
  return {
    get: values.get.bind(values),
    set: (key, value) =>
      Effect.sync(() => {
        // `JsonStore` treats `undefined` as a delete; match it so a cleared
        // key reads the same across backings.
        if (value === undefined) {
          values.delete(key);
        } else {
          values.set(key, value);
        }
      }),
  };
}

/**
 * In-memory {@link ConfigProvider} for process-local hosts (the default Node
 * platform, tests). Settings resolve exactly as they do for a file-backed
 * host — workspace shadows global, then the core-schema default, then the
 * caller's fallback — because it is the same provider over in-memory stores,
 * not a second implementation of the same rule.
 */
export class MemoryConfigProvider extends JsonConfigProvider {
  constructor(catalog: SettingsCatalog) {
    super({
      workspace: memoryConfigStore(),
      global: memoryConfigStore(),
      local: memoryConfigStore(),
      catalog,
    });
  }
}
