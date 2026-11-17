// `/models` form. Toggle which registry models appear in `/model` and the
// lead-model picker. Distinct from `/model`, which only chooses the active
// model among those already enabled and runnable.

import { joinFacts } from '@texra-ai/harness/schemas';
import { Text } from 'ink';

import {
  listCliEnabledModelCatalog,
  setCliModelEnabled,
  type CliEnabledModelRow,
} from '@cli/runtime/models/enabledModels';
import { AsyncListForm } from './_shared/ListForm';
import { enabledLabel } from '@ui/copy/format';
import { useChatProcess } from '../chatProcess';

interface EnabledModelsFormProps {
  readonly availableRows?: number;
  readonly onClose: () => void;
}

function formatEnabledModelDescription(model: CliEnabledModelRow): string {
  return joinFacts([
    enabledLabel(model.enabled),
    model.provider,
    model.deprecated && 'deprecated',
  ]);
}

export function EnabledModelsForm(
  props: EnabledModelsFormProps,
): React.JSX.Element {
  const { roots } = useChatProcess();
  return (
    <AsyncListForm<readonly CliEnabledModelRow[], string>
      title="/models"
      compactTitle="/models · Enable models that appear in pickers."
      loadingLabel="Loading models…"
      load={() => listCliEnabledModelCatalog(roots)}
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
        if (row) update(setCliModelEnabled(roots, id, !row.enabled));
      }}
      onCancel={props.onClose}
    />
  );
}
