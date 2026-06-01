// `/model` form. It loads the same registry used by `texra models list`, then
// shows only the entries that can run in the active API mode. Before the first
// message it can choose the root model; after that it is read-only because an
// active conversation owns a concrete model handler.

import { Box, Text, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';

import {
  getCliModelAccessList,
  type CliModelAccess,
} from '@cli/runtime/modelAccess';
import { formatCliApiMode, type CliApiMode } from '@cli/runtime/apiAccessMode';
import { Select, type SelectItem } from '../ui/Select';
import { KeyHints } from '../ui/KeyHints';
import { CompactFormKeyHints, FormFrame } from './_shared/FormFrame';
import {
  computeSelectWindowSize,
  isCompactFormRows,
  type SelectWindowSize,
} from './_shared/selectWindow';
import { useAsyncListForm } from './_shared/useAsyncListForm';
import { isPlainReturnInput } from '../input/inputKeys';

export interface ModelListFormProps {
  readonly currentModel: string;
  readonly apiMode: CliApiMode;
  readonly availableRows?: number;
  readonly selectable?: boolean;
  readonly onSelect?: (value: string) => void;
  readonly onClose: () => void;
}

export function formatModelStatusForCliMode(
  model: CliModelAccess,
  apiMode: CliApiMode,
): string {
  if (apiMode === 'personal') return `api: ${model.status}`;

  switch (model.model.availability) {
    case 'included-access':
      return 'relay: included';
    case 'not-included':
      return 'relay: not included';
    case 'included-login-required':
      return 'relay: login required';
    case 'relay-quota-exhausted':
      return 'relay: quota exhausted';
    case 'provider-key':
      return 'relay: unavailable; api key set';
    case 'openrouter-key':
      return 'relay: unavailable; openrouter key set';
    case 'missing-key':
      return 'relay: unavailable; missing api key';
    default:
      return `relay: ${model.status}`;
  }
}

export function modelSelectWindow(args: {
  readonly availableRows: number | undefined;
  readonly itemCount: number;
}): SelectWindowSize {
  // Border, title, description, and key hints are the irreducible chrome.
  return computeSelectWindowSize({ ...args, chromeRows: 5 });
}

export function modelSelectItemsForCliMode(
  models: readonly CliModelAccess[],
  apiMode: CliApiMode,
): ReadonlyArray<SelectItem<string>> {
  return models
    .filter((m) => m.available)
    .map((m) => ({
      value: m.model.value,
      label: m.model.label || m.model.value,
      description: formatModelStatusForCliMode(m, apiMode),
    }));
}

export function hasRunnableModelSelectItems(
  models: readonly CliModelAccess[],
): boolean {
  return models.some((m) => m.available);
}

function EmptyModelListState(props: { readonly onClose: () => void }) {
  useInput((input, key) => {
    if (isPlainReturnInput(input, key)) props.onClose();
  });

  return <Text>No models are available in this API mode.</Text>;
}

export function ModelListForm(props: ModelListFormProps): React.JSX.Element {
  const { data, loading, error } = useAsyncListForm<readonly CliModelAccess[]>({
    load: () => getCliModelAccessList({ apiMode: props.apiMode }),
    onClose: props.onClose,
    isEmpty: (models) => !hasRunnableModelSelectItems(models),
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
  const items = modelSelectItemsForCliMode(models, props.apiMode);
  const selectable = props.selectable === true;
  const selectWindow = modelSelectWindow({
    availableRows: props.availableRows,
    itemCount: items.length,
  });

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
          onSelect={(value) => {
            if (selectable) {
              props.onSelect?.(value);
              return;
            }
            props.onClose();
          }}
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
      <Text dimColor>
        {selectable
          ? 'Choose the root model for the first message.'
          : 'Available models. Start a new chat with texra chat --model=<name> to choose the root model.'}
      </Text>
      {items.length === 0 ? (
        <EmptyModelListState onClose={props.onClose} />
      ) : (
        <Box flexDirection="column">
          <Select
            items={items}
            activeValue={props.currentModel}
            maxVisibleItems={selectWindow.maxVisibleItems}
            showOverflow={selectWindow.showOverflow}
            onSelect={(value) => {
              if (selectable) {
                props.onSelect?.(value);
                return;
              }
              props.onClose();
            }}
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
