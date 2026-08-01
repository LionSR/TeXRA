// Local imports - state keys
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

// Local imports - shared constants
import {
  LATEX_FIELD_TO_KEY,
  type LatexConfigField,
} from '@shared/constants/latex';

// Local imports - shared schemas
import {
  LatexConfigValuesSchema,
  type LatexConfigValues,
  type UpdateLatexConfigValuesMessage,
} from '@shared/schemas/settingsViewMessages';

/** Builds storage-backed LaTeX config snapshots without host side effects. */
export class LatexConfigPersistenceController {
  buildConfigValues(
    readStoredValue: (key: WorkspaceStateKey) => unknown,
  ): LatexConfigValues {
    const values: Partial<Record<LatexConfigField, unknown>> = {};

    for (const [field, key] of Object.entries(LATEX_FIELD_TO_KEY) as [
      LatexConfigField,
      WorkspaceStateKey,
    ][]) {
      const stored = readStoredValue(key);
      if (stored === undefined) continue;

      const parsed = LatexConfigValuesSchema.shape[field].safeParse(stored);
      if (parsed.success) values[field] = parsed.data;
    }

    return values as LatexConfigValues;
  }

  /** Wraps the current config values into the outbound settings-view message shape. */
  buildConfigMessage(
    readStoredValue: (key: WorkspaceStateKey) => unknown,
  ): UpdateLatexConfigValuesMessage {
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES,
      values: this.buildConfigValues(readStoredValue),
    };
  }
}
