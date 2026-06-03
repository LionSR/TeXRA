// `/model` form. It loads the same registry used by `texra models list`, then
// shows only the entries that can run in the active API mode. Before the first
// message it can choose the root model; after that it is read-only because an
// active conversation owns a concrete model handler.

import { Box, Text, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';

import {
  getCliModelAccessList,
  runnableCliModelAccessEntries,
  type CliModelAccess,
} from '@cli/runtime/modelAccess';
import { formatCliApiMode, type CliApiMode } from '@cli/runtime/apiAccessMode';
import type { ModelAvailabilityKind } from '@shared/schemas';
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

const RELAY_STATUS_BY_AVAILABILITY = {
  'included-access': 'relay: included',
  'not-included': 'relay: not included',
  'included-login-required': 'relay: login required',
  'relay-quota-exhausted': 'relay: quota exhausted',
  'provider-key': 'relay: unavailable; api key set',
  'openrouter-key': 'relay: unavailable; openrouter key set',
  'missing-key': 'relay: unavailable; missing api key',
} satisfies Record<ModelAvailabilityKind, string>;

const EMPTY_MODEL_LIST_MESSAGES = {
  includedLoginRequired:
    'Included relay models require sign-in. Run /login or switch with /api personal.',
  included:
    'No included relay models are runnable. Switch with /api personal or try again later.',
  personal:
    'No personal API-key models are runnable. Configure a provider key or switch with /api included.',
} satisfies Record<CliApiMode | 'includedLoginRequired', string>;

export type NoRunnableModelAccessReason = CliApiMode | 'includedLoginRequired';

export function noRunnableModelAccessReason(
  models: readonly CliModelAccess[],
  apiMode: CliApiMode,
): NoRunnableModelAccessReason {
  if (
    apiMode === 'included' &&
    models.some(
      (model) => model.model.availability === 'included-login-required',
    )
  ) {
    return 'includedLoginRequired';
  }
  return apiMode;
}

export function formatModelStatusForCliMode(
  model: CliModelAccess,
  apiMode: CliApiMode,
): string {
  if (apiMode === 'personal') return `api: ${model.status}`;

  const availability = model.model.availability;
  if (availability == null) return `relay: ${model.status}`;
  return RELAY_STATUS_BY_AVAILABILITY[availability];
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
  return runnableCliModelAccessEntries(models, apiMode).map((m) => ({
    value: m.model.value,
    label: m.model.label || m.model.value,
    description: formatModelStatusForCliMode(m, apiMode),
  }));
}

export function emptyModelListMessageForCliMode(
  models: readonly CliModelAccess[],
  apiMode: CliApiMode,
): string {
  return EMPTY_MODEL_LIST_MESSAGES[
    noRunnableModelAccessReason(models, apiMode)
  ];
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
  const items = modelSelectItemsForCliMode(models, props.apiMode);
  const selectable = props.selectable === true;
  const selectWindow = modelSelectWindow({
    availableRows: props.availableRows,
    itemCount: items.length,
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
      <Text dimColor>
        {selectable
          ? 'Choose the root model for the first message.'
          : 'Available models. Start a new chat with texra chat --model=<name> to choose the root model.'}
      </Text>
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
