// `/models` form. Toggle which registry models appear in `/model` and the
// lead-model picker. Distinct from `/model`, which only chooses the active
// model among those already enabled and runnable.

import { Text } from 'ink';

import {
  listCliEnabledModelCatalog,
  setCliModelEnabled,
  type CliEnabledModelRow,
} from '@cli/runtime/enabledModels';
import type { StateStore } from '@platform/interfaces';
import type { ProcessRuntime } from '@platform/processRuntime';

import { AsyncListForm } from './_shared/ListForm';

interface EnabledModelsFormProps {
  readonly availableRows?: number;
  /**
   * The global state the enabled-model list reads and each toggle writes, with
   * the runtime that settles that write: Ink components own no runtime, so both
   * arrive as props from the surface that opened the form.
   */
  readonly state: StateStore;
  readonly runtime: ProcessRuntime;
  readonly onClose: () => void;
}

function formatEnabledModelDescription(model: CliEnabledModelRow): string {
  const parts = [
    model.enabled ? 'enabled' : 'disabled',
    model.provider,
    model.deprecated ? 'deprecated' : undefined,
  ].filter((part): part is string => part != null);
  return parts.join(' · ');
}

export function EnabledModelsForm(
  props: EnabledModelsFormProps,
): React.JSX.Element {
  return (
    <AsyncListForm<readonly CliEnabledModelRow[], string>
      title="/models"
      compactTitle="/models · Enable models that appear in pickers."
      loadingLabel="Loading models..."
      load={() => listCliEnabledModelCatalog(props.state)}
      runtime={props.runtime}
      items={(models) =>
        models.map((model) => ({
          value: model.id,
          label: model.label,
          description: formatEnabledModelDescription(model),
        }))
      }
      availableRows={props.availableRows}
      description={
        <Text dimColor>
          Enable models for `/model` and lead-model pickers. Does not change API
          keys or access mode.
        </Text>
      }
      action="toggle"
      showTransientCloseHint={false}
      onSelect={(id, { data: models, update }) => {
        const row = models.find((candidate) => candidate.id === id);
        // A refused write (e.g. disabling the last remaining model) keeps the
        // catalog as-is.
        if (row) update(setCliModelEnabled(props.state, id, !row.enabled));
      }}
      onCancel={props.onClose}
    />
  );
}
