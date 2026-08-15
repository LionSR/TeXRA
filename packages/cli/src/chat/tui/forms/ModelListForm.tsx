// `/model` form. It loads the same registry used by `texra models list`, then
// shows only the entries that can run in the active API mode. Before the first
// message it chooses the root model; once a tool-use chat is waiting, it can
// switch the live conversation to a compatible model for future turns.

import { Box, Text } from 'ink';

import {
  emptyModelListMessageForCliMode,
  getCliModelAccessList,
  modelSelectItemsForCliMode,
  type CliModelAccess,
  type GetModelSwitchDisabledReason,
} from '@cli/runtime/modelAccess';
import { formatCliModelAccessRoute } from '@cli/runtime/modelAccessRoute';
import { Select } from '@cli/tui/ui/Select';
import {
  computeSelectWindowSize,
  isCompactFormRows,
  type SelectWindowSize,
} from '@cli/tui/selectWindow';
import type { ApiAccessMode } from '@shared/schemas';
import {
  CompactPickerKeyHints,
  FormFrame,
  PickerKeyHints,
} from './_shared/FormFrame';
import { useAsyncPickerForm } from './_shared/ListForm';
import { CHAT_API_MODE_MODEL_RECOVERY } from '../commands/handlers/slashContext';

export interface ModelListFormProps {
  readonly currentModel: string;
  readonly apiMode: ApiAccessMode;
  readonly availableRows?: number;
  readonly selectable: boolean;
  readonly getModelSwitchDisabledReason?: GetModelSwitchDisabledReason;
  readonly onSelect?: (value: string) => void;
  readonly onClose: () => void;
}

export function modelSelectWindow(args: {
  readonly availableRows: number | undefined;
  readonly itemCount: number;
}): SelectWindowSize {
  // Border, title, description, footer spacer, and key hints are the chrome.
  return computeSelectWindowSize({ ...args, chromeRows: 6 });
}

export function modelListDescription({
  itemCount,
  selectable,
}: {
  readonly itemCount: number;
  readonly selectable: boolean;
}): string {
  if (itemCount === 0) return 'No model choices in this API mode.';
  return selectable
    ? 'Choose the model for future turns.'
    : 'Available models. Finish the active response before switching models.';
}

export function ModelListForm(props: ModelListFormProps): React.JSX.Element {
  const picker = useAsyncPickerForm<readonly CliModelAccess[], string>({
    title: '/model',
    loadingLabel: 'Loading models...',
    load: () =>
      getCliModelAccessList({
        apiMode: props.apiMode,
      }),
    isEmpty: (models) => !models.some((model) => model.available),
    closeEmptyOnEnter: true,
    items: (models) =>
      modelSelectItemsForCliMode(
        models,
        props.apiMode,
        props.getModelSwitchDisabledReason,
      ),
    selectable: props.selectable,
    onSelect: (value) => props.onSelect?.(value),
    onClose: props.onClose,
  });
  const models = picker.data ?? [];
  const items = picker.items;
  const selectWindow = modelSelectWindow({
    availableRows: props.availableRows,
    itemCount: items.length,
  });
  const description = modelListDescription({
    itemCount: items.length,
    selectable: props.selectable,
  });

  if (picker.transient) return picker.transient;

  if (isCompactFormRows(props.availableRows) && items.length > 0) {
    return (
      <FormFrame
        title={`/model · ${formatCliModelAccessRoute(props.apiMode)}`}
        showCloseHint={false}
      >
        <Text dimColor>Available models</Text>
        <Select
          items={items}
          activeValue={props.currentModel}
          maxVisibleItems={1}
          showOverflow={false}
          onSelect={picker.select}
          onCancel={props.onClose}
        />
        <CompactPickerKeyHints selectable={props.selectable} />
      </FormFrame>
    );
  }

  return (
    <FormFrame
      title={`/model · ${formatCliModelAccessRoute(props.apiMode)}`}
      showCloseHint={false}
    >
      <Text dimColor>{description}</Text>
      {items.length === 0 ? (
        <Text>
          {emptyModelListMessageForCliMode(
            models,
            props.apiMode,
            CHAT_API_MODE_MODEL_RECOVERY,
          )}
        </Text>
      ) : (
        <Box flexDirection="column">
          <Select
            items={items}
            activeValue={props.currentModel}
            maxVisibleItems={selectWindow.maxVisibleItems}
            showOverflow={selectWindow.showOverflow}
            onSelect={picker.select}
            onCancel={props.onClose}
          />
        </Box>
      )}
      <Box marginTop={1}>
        <PickerKeyHints
          selectable={props.selectable}
          hasItems={items.length > 0}
        />
      </Box>
    </FormFrame>
  );
}
