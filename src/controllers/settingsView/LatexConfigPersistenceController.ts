// Local imports - state keys
import { WorkspaceStateKey } from '@common/state/stateKeys';

// Local imports - shared constants
import {
  LATEX_FIELD_TO_KEY,
  type LatexConfigField,
} from '@shared/constants/latex';

// Local imports - shared schemas
import {
  LatexConfigValuesSchema,
  type LatexConfigValues,
} from '@shared/schemas/settingsViewMessages';

export type LatexConfigPersistenceEntry = {
  field: LatexConfigField;
  key: WorkspaceStateKey;
};

export type LatexConfigPersistenceUpdatePlan =
  | {
      ok: true;
      update: {
        key: WorkspaceStateKey;
        value: unknown;
      };
    }
  | {
      ok: false;
      error: unknown;
    };

/** Plans storage-backed LaTeX config reads and writes without host side effects. */
export class LatexConfigPersistenceController {
  getEntries(): LatexConfigPersistenceEntry[] {
    return Object.entries(LATEX_FIELD_TO_KEY).map(([field, key]) => ({
      field: field as LatexConfigField,
      key,
    }));
  }

  buildConfigValues(
    readStoredValue: (key: WorkspaceStateKey) => unknown,
  ): LatexConfigValues {
    const values: Partial<Record<LatexConfigField, unknown>> = {};

    for (const { field, key } of this.getEntries()) {
      const stored = readStoredValue(key);
      if (stored !== undefined) values[field] = stored;
    }

    return values as LatexConfigValues;
  }

  planUpdate(input: {
    field: LatexConfigField;
    value: unknown;
  }): LatexConfigPersistenceUpdatePlan {
    const fieldSchema = LatexConfigValuesSchema.shape[input.field];
    const parsed = fieldSchema.safeParse(input.value ?? undefined);

    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error,
      };
    }

    return {
      ok: true,
      update: {
        key: LATEX_FIELD_TO_KEY[input.field],
        value: parsed.data,
      },
    };
  }
}
