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
  type GetModelSwitchDisabledReason,
} from '@cli/runtime/models/modelAccess';
import { AsyncListForm } from './_shared/ListForm';
import { CHAT_KEY_RECOVERY } from '../commands/handlers/slashContext';
import { useChatProcess } from '../chatProcess';

interface ModelListFormProps {
  readonly currentModel: string;
  readonly availableRows?: number;
  readonly selectable: boolean;
  readonly getModelSwitchDisabledReason?: GetModelSwitchDisabledReason;
  readonly onSelect?: (value: string) => void;
  readonly onClose: () => void;
}

export function ModelListForm(props: ModelListFormProps): React.JSX.Element {
  const { roots } = useChatProcess();
  return (
    <AsyncListForm<readonly CliModelPickerItem[], string>
      title="/model"
      loadingLabel="Loading models…"
      load={() =>
        Effect.flatMap(getCliModelAccessList({ stores: roots }), (models) =>
          modelSelectItemsForCli(models, props.getModelSwitchDisabledReason),
        )
      }
      items={(items) => items}
      selectable={props.selectable}
      availableRows={props.availableRows}
      activeValue={props.currentModel}
      description={
        <Text dimColor>
          {props.selectable
            ? 'Choose the model for future turns.'
            : 'Available models. Finish the active response before switching models.'}
        </Text>
      }
      compactDetail={<Text dimColor>Available models</Text>}
      emptyClosesOnEnter
      emptyMessage={formatCliNoRunnableModelsMessage(CHAT_KEY_RECOVERY)}
      action={props.selectable ? 'select' : 'close'}
      onSelect={(value) => props.onSelect?.(value)}
      onCancel={props.onClose}
    />
  );
}
