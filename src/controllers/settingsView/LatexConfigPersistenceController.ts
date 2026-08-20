// Local imports - state keys
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  LatexConfigValuesSchema,
  type LatexConfigValues,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

// Local imports - shared constants
import {
  LATEX_FIELD_TO_KEY,
  LATEX_REPLACEMENT_FIELD_TO_CONFIG_KEY,
  type LatexConfigField,
} from '@shared/constants/latexConfig';

interface CoreConfigReader {
  get(key: string): unknown;
  isExplicitlySet(key: string): boolean;
}

/** Legacy frontend-keyed shape retained only for direct compatibility tests. */
interface LegacyLatexConfigValuesMessage {
  readonly command: typeof SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES;
  readonly values: LatexConfigValues;
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

  /** Legacy wrapper retained for direct consumers of this persistence helper. */
  buildConfigMessage(
    readStoredValue: (key: WorkspaceStateKey) => unknown,
    coreConfig?: CoreConfigReader,
  ): LegacyLatexConfigValuesMessage {
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_LATEX_CONFIG_VALUES,
      values: this.buildConfigValues(readStoredValue, coreConfig),
    };
  }
}
