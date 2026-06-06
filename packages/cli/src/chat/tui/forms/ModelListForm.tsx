// `/model` form. It loads the same registry used by `texra models list`, then
// shows only the entries that can run in the active API mode. Before the first
// message it chooses the root model; once a tool-use chat is waiting, it can
// switch the live conversation to a compatible model for future turns.

import { Box, Text, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';

import {
  getCliModelAccessList,
  type CliModelAccess,
} from '@cli/runtime/modelAccess';
import { formatCliApiMode, type CliApiMode } from '@cli/runtime/apiAccessMode';
import { Select } from '../ui/Select';
import { KeyHints } from '../ui/KeyHints';
import { CompactFormKeyHints, FormFrame } from './_shared/FormFrame';
import {
  computeSelectWindowSize,
  isCompactFormRows,
  type SelectWindowSize,
} from './_shared/selectWindow';
import { useAsyncListForm } from './_shared/useAsyncListForm';
import { isPlainReturnInput } from '../input/inputKeys';
import {
  emptyModelListMessageForCliMode,
  modelSelectItemsForCliMode,
} from '../modelAccessDisplay';

export interface ModelListFormProps {
  readonly currentModel: string;
  readonly apiMode: CliApiMode;
  readonly availableRows?: number;
  readonly selectable?: boolean;
  readonly getModelSwitchDisabledReason?: (model: string) => string | undefined;
  readonly onSelect?: (value: string) => void;
  readonly onClose: () => void;
}

export function modelSelectWindow(args: {
  readonly availableRows: number | undefined;
  readonly itemCount: number;
}): SelectWindowSize {
  // Border, title, description, and key hints are the irreducible chrome.
  return computeSelectWindowSize({ ...args, chromeRows: 5 });
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

function EmptyModelListState(props: {
  readonly models: readonly CliModelAccess[];
  readonly apiMode: CliApiMode;
  readonly onClose: () => void;
}) {
  useInput((input, key) => {
    if (isPlainReturnInput(input, key)) props.onClose();
  });

  return (
    <Text>{emptyModelListMessageForCliMode(props.models, props.apiMode)}</Text>
  );
}

export function ModelListForm(props: ModelListFormProps): React.JSX.Element {
  const { data, loading, error } = useAsyncListForm<readonly CliModelAccess[]>({
    load: () => getCliModelAccessList({ apiMode: props.apiMode }),
    onClose: props.onClose,
    isEmpty: (models) => !models.some((model) => model.available),
  });

  if (loading) {
    return (
      <FormFrame color="cyan" title="/model">
        <Spinner label="Loading model registry..." />
      </FormFrame>
    );
  }
  if (error) {
    return (
      <FormFrame color="red" title="/model - error">
        <Text>{error}</Text>
      </FormFrame>
    );
  }

  const models = data ?? [];
  const items = modelSelectItemsForCliMode(
    models,
    props.apiMode,
    props.getModelSwitchDisabledReason,
  );
  const selectable = props.selectable === true;
  const selectWindow = modelSelectWindow({
    availableRows: props.availableRows,
    itemCount: items.length,
  });
  const description = modelListDescription({
    itemCount: items.length,
    selectable,
  });

  function handleSelect(value: string): void {
    if (selectable) {
      props.onSelect?.(value);
      return;
    }
    props.onClose();
  }

  if (isCompactFormRows(props.availableRows) && items.length > 0) {
    return (
      <FormFrame
        color="cyan"
        title={`/model · ${formatCliApiMode(props.apiMode)}`}
        showCloseHint={false}
      >
        <Text dimColor>Available models</Text>
        <Select
          items={items}
          activeValue={props.currentModel}
          maxVisibleItems={1}
          showOverflow={false}
          onSelect={handleSelect}
          onCancel={props.onClose}
        />
        <CompactFormKeyHints
          primary={
            selectable
              ? { key: '1-9/a-z/Enter', action: 'select' }
              : { key: 'Enter', action: 'close' }
          }
        />
      </FormFrame>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="cyan">
        {`/model · ${formatCliApiMode(props.apiMode)}`}
      </Text>
      <Text dimColor>{description}</Text>
      {items.length === 0 ? (
        <EmptyModelListState
          models={models}
          apiMode={props.apiMode}
          onClose={props.onClose}
        />
      ) : (
        <Box flexDirection="column">
          <Select
            items={items}
            activeValue={props.currentModel}
            maxVisibleItems={selectWindow.maxVisibleItems}
            showOverflow={selectWindow.showOverflow}
            onSelect={handleSelect}
            onCancel={props.onClose}
          />
        </Box>
      )}
      <Box>
        {selectable && items.length > 0 ? (
          <KeyHints
            hints={[
              { key: '↑/↓', action: 'navigate' },
              { key: '1-9/a-z', action: 'select' },
            ]}
          />
        ) : items.length > 0 ? (
          <KeyHints
            hints={[
              { key: '↑/↓', action: 'navigate' },
              { key: 'Enter', action: 'close' },
              { key: 'Esc', action: 'close' },
            ]}
            confirmCancel={false}
          />
        ) : (
          <KeyHints
            hints={[
              { key: 'Enter', action: 'close' },
              { key: 'Esc', action: 'close' },
            ]}
            confirmCancel={false}
          />
        )}
      </Box>
    </Box>
  );
}
