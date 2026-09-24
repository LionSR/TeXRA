// `/model` form. It loads the same registry used by `texra models list`, then
// shows only the runnable entries. Before the first
// message it chooses the root model; once a tool-use chat is waiting, it can
// switch the live conversation to a compatible model for future turns.

import { Text } from 'ink';
import { Effect } from 'effect';

import {
  formatCliNoRunnableModelsMessage,
  getCliModelAccessList,
  modelSelectItemsForCli,
  type CliModelPickerItem,
  type CliModelStores,
  type GetModelSwitchDisabledReason,
} from '@cli/runtime/modelAccess';
import { ListForm, useAsyncPickerForm } from './_shared/ListForm';
import { CHAT_API_MODE_MODEL_RECOVERY } from '../commands/handlers/slashContext';

interface ModelListFormProps {
  readonly currentModel: string;
  /**
   * The secret store and global state the availability computation reads,
   * with the runtime its read runs on. Ink components run no Effect
   * themselves, so both arrive as one prop from the surface that opened the
   * form.
   */
  readonly stores: CliModelStores;
  readonly availableRows?: number;
  readonly selectable: boolean;
  readonly getModelSwitchDisabledReason?: GetModelSwitchDisabledReason;
  readonly onSelect?: (value: string) => void;
  readonly onClose: () => void;
}

export function modelListDescription({
  itemCount,
  selectable,
}: {
  readonly itemCount: number;
  readonly selectable: boolean;
}): string {
  if (itemCount === 0) return 'No model choices available.';
  return selectable
    ? 'Choose the model for future turns.'
    : 'Available models. Finish the active response before switching models.';
}

export function ModelListForm(props: ModelListFormProps): React.JSX.Element {
  const picker = useAsyncPickerForm<readonly CliModelPickerItem[], string>({
    title: '/model',
    loadingLabel: 'Loading models...',
    load: () =>
      Effect.flatMap(
        getCliModelAccessList({ stores: props.stores }),
        (models) =>
          modelSelectItemsForCli(models, props.getModelSwitchDisabledReason),
      ),
    runtime: props.stores.runtime,
    isEmpty: (items) => items.length === 0,
    closeEmptyOnEnter: true,
    items: (items) => items,
    selectable: props.selectable,
    onSelect: (value) => props.onSelect?.(value),
    onClose: props.onClose,
  });
  if (picker.transient) return picker.transient;

  return (
    <ListForm
      title="/model"
      availableRows={props.availableRows}
      items={picker.items}
      activeValue={props.currentModel}
      description={
        <Text dimColor>
          {modelListDescription({
            itemCount: picker.items.length,
            selectable: props.selectable,
          })}
        </Text>
      }
      compactDetail={<Text dimColor>Available models</Text>}
      emptyMessage={formatCliNoRunnableModelsMessage(
        CHAT_API_MODE_MODEL_RECOVERY,
      )}
      action={props.selectable ? 'select' : 'close'}
      onSelect={picker.select}
      onCancel={props.onClose}
    />
  );
}
