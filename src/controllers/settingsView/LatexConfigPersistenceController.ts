// Local imports - state keys
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

// Local imports - shared constants
import {
  LATEX_FIELD_TO_KEY,
  LATEX_REPLACEMENT_FIELD_TO_CONFIG_KEY,
  type LatexConfigField,
} from '@shared/constants/latex';

// Local imports - shared schemas
import {
  LatexConfigValuesSchema,
  type LatexConfigValues,
  type UpdateLatexConfigValuesMessage,
} from '@shared/schemas/settingsViewMessages';

interface CoreConfigReader {
  get(key: string): unknown;
  isExplicitlySet(key: string): boolean;
}

/** Builds storage-backed LaTeX config snapshots without host side effects. */
export class LatexConfigPersistenceController {
  buildConfigValues(
    readStoredValue: (key: WorkspaceStateKey) => unknown,
    coreConfig?: CoreConfigReader,
  ): LatexConfigValues {
    const values: Partial<Record<keyof LatexConfigValues, unknown>> = {};

    for (const [field, key] of Object.entries(LATEX_FIELD_TO_KEY) as [
      LatexConfigField,
      WorkspaceStateKey,
    ][]) {
      const stored = readStoredValue(key);
      if (stored === undefined) continue;

      const parsed = LatexConfigValuesSchema.shape[field].safeParse(stored);
      if (parsed.success) values[field] = parsed.data;
    }

    if (coreConfig) {
      for (const [field, key] of Object.entries(
        LATEX_REPLACEMENT_FIELD_TO_CONFIG_KEY,
      ) as [keyof typeof LATEX_REPLACEMENT_FIELD_TO_CONFIG_KEY, string][]) {
        if (!coreConfig.isExplicitlySet(key)) continue;
        const parsed = LatexConfigValuesSchema.shape[field].safeParse(
          coreConfig.get(key),
        );
        if (parsed.success) values[field] = parsed.data;
      }
    }

    return values as LatexConfigValues;
  }

  /** Wraps the current config values into the outbound settings-view message shape. */
  buildConfigMessage(
    readStoredValue: (key: WorkspaceStateKey) => unknown,
    coreConfig?: CoreConfigReader,
  ): UpdateLatexConfigValuesMessage {
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES,
      values: this.buildConfigValues(readStoredValue, coreConfig),
    };
  }
}
