// `/model` form. It loads the same registry used by `texra models list`, then
// shows only the entries that can run in the active API mode. Before the first
// message it chooses the root model; once a tool-use chat is waiting, it can
// switch the live conversation to a compatible model for future turns.

import { Box, Text, useInput } from 'ink';

import {
  emptyModelListMessageForCliMode,
  getCliModelAccessList,
  modelSelectItemsForCliMode,
  type CliModelAccess,
  type CliNoRunnableModelsMessageOptions,
  type GetModelSwitchDisabledReason,
} from '@cli/runtime/modelAccess';
import type { CliApiMode } from '@cli/runtime/apiAccessMode';
import { formatCliModelAccessRoute } from '@cli/runtime/modelAccessRoute';
import type { AgentCategory } from '@shared/schemas/agent';
import { Select } from '../ui/Select';
import { KeyHints } from '../ui/KeyHints';
import {
  CompactFormKeyHints,
  FormFrame,
  renderAsyncListFormTransient,
} from './_shared/FormFrame';
import {
  computeSelectWindowSize,
  isCompactFormRows,
  type SelectWindowSize,
} from './_shared/selectWindow';
import { useAsyncListForm } from './_shared/useAsyncListForm';
import { usePendingListFormSelection } from './_shared/ListForm';
import { isPlainReturnInput } from '../input/inputKeys';

const TUI_MODEL_EMPTY_RECOVERY = {
  includedModeAction: 'switch with /api included',
  loginAction: 'run /login',
  personalModeAction: 'switch with /api personal',
  configureKeyAction: 'configure a provider API key',
} satisfies CliNoRunnableModelsMessageOptions;

export interface ModelListFormProps {
  readonly currentModel: string;
  readonly apiMode: CliApiMode;
  readonly agentCategory?: AgentCategory;
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

function EmptyModelListState(props: {
  readonly models: readonly CliModelAccess[];
  readonly apiMode: CliApiMode;
  readonly onClose: () => void;
}): React.JSX.Element {
  useInput((input, key) => {
    if (isPlainReturnInput(input, key)) props.onClose();
  });

  return (
    <Text>
      {emptyModelListMessageForCliMode(
        props.models,
        props.apiMode,
        TUI_MODEL_EMPTY_RECOVERY,
      )}
    </Text>
  );
}

export function ModelListForm(props: ModelListFormProps): React.JSX.Element {
  const { data, loading, error, pendingInput, clearPendingInput } =
    useAsyncListForm<readonly CliModelAccess[]>({
      load: () =>
        getCliModelAccessList({
          apiMode: props.apiMode,
          agentCategory: props.agentCategory,
        }),
      onClose: props.onClose,
      isEmpty: (models) => !models.some((model) => model.available),
    });
  const models = data ?? [];
  const items = modelSelectItemsForCliMode(
    models,
    props.apiMode,
    props.getModelSwitchDisabledReason,
  );
  const selectWindow = modelSelectWindow({
    availableRows: props.availableRows,
    itemCount: items.length,
  });
  const description = modelListDescription({
    itemCount: items.length,
    selectable: props.selectable,
  });

  function handleSelect(value: string): void {
    if (props.selectable) {
      props.onSelect?.(value);
      return;
    }
    props.onClose();
  }

  usePendingListFormSelection({
    loading,
    error,
    pendingInput,
    clearPendingInput,
    items,
    enabled: props.selectable,
    onSelect: handleSelect,
  });

  const transient = renderAsyncListFormTransient({
    loading,
    error,
    title: '/model',
    loadingLabel: 'Loading model registry...',
  });
  if (transient) return transient;

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
          onSelect={handleSelect}
          onCancel={props.onClose}
        />
        <CompactFormKeyHints
          primary={
            props.selectable
              ? { key: '1-9/a-z/Enter', action: 'select' }
              : { key: 'Enter', action: 'close' }
          }
        />
      </FormFrame>
    );
  }

  function footerHints(): React.JSX.Element {
    if (props.selectable && items.length > 0) {
      return (
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            { key: '1-9/a-z', action: 'select' },
          ]}
        />
      );
    }
    if (items.length > 0) {
      return (
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            { key: 'Enter', action: 'close' },
            { key: 'Esc', action: 'close' },
          ]}
          confirmCancel={false}
        />
      );
    }
    return (
      <KeyHints
        hints={[
          { key: 'Enter', action: 'close' },
          { key: 'Esc', action: 'close' },
        ]}
        confirmCancel={false}
      />
    );
  }

  return (
    <FormFrame
      title={`/model · ${formatCliModelAccessRoute(props.apiMode)}`}
      showCloseHint={false}
    >
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
      <Box marginTop={1}>{footerHints()}</Box>
    </FormFrame>
  );
}
