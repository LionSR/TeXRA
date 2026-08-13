// `/models` form. Toggle which registry models appear in `/model` and the
// lead-model picker. Distinct from `/model`, which only chooses the active
// model among those already enabled and runnable.

import { Text } from 'ink';

import {
  listCliEnabledModelCatalog,
  setCliModelEnabled,
  type CliEnabledModelRow,
} from '@cli/runtime/enabledModels';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { setTransientNotice } from '../state/cliState';
import { AsyncListForm } from './_shared/ListForm';

export interface EnabledModelsFormProps {
  readonly availableRows?: number;
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
      load={async () => listCliEnabledModelCatalog()}
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
      onSelect={(id, { data: models, setData: setModels }) => {
        const row = models.find((candidate) => candidate.id === id);
        if (!row) return;
        void setCliModelEnabled(id, !row.enabled)
          .then(() => listCliEnabledModelCatalog())
          .then(setModels)
          .catch((error: unknown) => {
            // e.g. disabling the last remaining model — keep the catalog as-is.
            setTransientNotice(toErrorMessage(error));
          });
      }}
      onCancel={props.onClose}
    />
  );
}
