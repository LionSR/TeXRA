// `/model` form. It loads the same registry used by `texra models list`, then
// shows only the runnable entries. Before the first message it chooses the
// root model; once a tool-use chat is waiting, it can switch the live
// conversation to a compatible model for future turns. `←/→` adjusts the
// highlighted model's reasoning effort inline.

import { signal } from '@lit-labs/signals';
import { Box, Text, useInput } from 'ink';
import { Effect } from 'effect';
import { useState } from 'react';

import { selectModel, type ReasoningEffort } from '@texra-ai/llm';
import { loadModelOptions } from '@texra/model/setupCredentialAccess';
import {
  effectiveReasoningLevel,
  REASONING_LEVEL_LABELS,
} from '@texra/shared/model/modelPicker';
import type { ModelOptionData } from '@texra/shared/pickerOptions';
import { COLOR_BORDER, COLOR_HINT } from '@cli/tui/ui/colors';
import { LEFT_RIGHT_KEYS } from '@cli/tui/ui/KeyHints';
import {
  formatCliNoRunnableModelsMessage,
  modelSelectItemsForCli,
  type CliModelPickerItem,
  type GetModelSwitchDisabledReason,
} from '@cli/runtime/models/modelAccess';
import type { CliModelPick } from '../commands/handlers/modelCommands';
import { CHAT_KEY_RECOVERY } from '../commands/handlers/slashContext';
import { useSignal } from '../state/useSignal';
import { useChatProcess } from '../chatProcess';
import { renderAsyncListFormTransient } from './_shared/FormFrame';
import { ListForm } from './_shared/ListForm';
import { useAsyncListForm } from './_shared/useAsyncListForm';

interface LoadedModelList {
  readonly models: readonly ModelOptionData[];
  readonly items: readonly CliModelPickerItem[];
}

interface ModelListFormProps {
  readonly currentModel: string;
  readonly availableRows: number;
  readonly selectable: boolean;
  readonly getModelSwitchDisabledReason: GetModelSwitchDisabledReason;
  readonly onSelect: (pick: CliModelPick) => void;
  readonly onClose: () => void;
}

function rawHorizontalArrowDirection(input: string): -1 | 1 | undefined {
  if (input === '\u001B[D' || input === '\u001BOD') return -1;
  if (input === '\u001B[C' || input === '\u001BOC') return 1;
  return undefined;
}

/** Resolve the effective level for `row`, preferring a draft pick, else the
 *  same rule the desktop/VS Code picker applies. */
function effectiveEffortForRow(
  row: ModelOptionData,
  currentModel: string,
  activeModelRef: string,
  draftEfforts: Readonly<Record<string, ReasoningEffort>>,
): ReasoningEffort | undefined {
  const levels = row.efforts?.levels;
  if (levels === undefined || levels.length <= 1) return undefined;
  const draft = draftEfforts[row.value];
  if (draft !== undefined && levels.includes(draft)) return draft;
  return row.value === activeModelRef
    ? effectiveReasoningLevel(currentModel, row.efforts)
    : row.efforts?.sent;
}

/** Inline horizontal reasoning-level strip below the model list, matching the
 *  desktop/VS Code `<model-picker>` footer. */
function ReasoningEffortStrip(props: {
  readonly levels: readonly ReasoningEffort[];
  readonly activeLevel: ReasoningEffort | undefined;
  readonly canAdjust: boolean;
  readonly compact?: boolean;
  readonly onStep: (direction: -1 | 1) => void;
}): React.JSX.Element {
  useInput(
    (input, key) => {
      if (key.ctrl || key.meta) return;
      const rawDir = rawHorizontalArrowDirection(input);
      if (key.leftArrow || rawDir === -1) {
        props.onStep(-1);
      } else if (key.rightArrow || rawDir === 1) {
        props.onStep(1);
      }
    },
    { isActive: props.canAdjust },
  );

  const line = (
    <Text wrap="truncate-end">
      <Text dimColor>Reasoning level: </Text>
      {props.levels.map((level, index) => {
        const selected = level === props.activeLevel;
        const label = REASONING_LEVEL_LABELS[level];
        return (
          <Text key={level}>
            {index > 0 ? '  ' : ''}
            {selected ? (
              <Text bold color={COLOR_HINT}>
                [{label}]
              </Text>
            ) : (
              <Text dimColor>{label}</Text>
            )}
          </Text>
        );
      })}
    </Text>
  );
  if (props.compact) return line;
  return (
    <Box
      marginTop={1}
      borderStyle="single"
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderColor={COLOR_BORDER}
    >
      {line}
    </Box>
  );
}

export function ModelListForm(props: ModelListFormProps): React.JSX.Element {
  const { roots } = useChatProcess();
  const activeModelRef =
    selectModel(props.currentModel)?.config.ref ?? props.currentModel;
  const [highlightedModel, setHighlightedModel] = useState<string | undefined>(
    undefined,
  );
  // Enter can arrive in the same input burst as an arrow, before React
  // paints the change. The key handlers and the strip read the same drafts.
  const [drafts] = useState(() =>
    signal<Readonly<Record<string, ReasoningEffort>>>({}),
  );
  const draftEfforts = useSignal(drafts);

  const { data, loading, error } = useAsyncListForm<LoadedModelList>({
    load: () =>
      Effect.flatMap(loadModelOptions(roots), (models) =>
        Effect.map(
          modelSelectItemsForCli(models, props.getModelSwitchDisabledReason),
          (items): LoadedModelList => ({ models, items }),
        ),
      ),
    onClose: props.onClose,
    isEmpty: (loaded) => loaded.items.length === 0,
    closeEmptyOnEnter: true,
  });

  const transient = renderAsyncListFormTransient({
    loading,
    error,
    title: '/model',
    loadingLabel: 'Loading models…',
  });
  if (transient) return transient;
  if (data === undefined) {
    throw new Error('/model list finished loading without data.');
  }

  // Match Select's initial highlight: active model when present & enabled,
  // otherwise the first enabled item.
  const initialFocus =
    data.items.find((item) => item.value === activeModelRef && !item.disabled)
      ?.value ??
    data.items.find((item) => !item.disabled)?.value ??
    data.items[0]?.value;
  const focusedModelId =
    highlightedModel !== undefined &&
    data.items.some((item) => item.value === highlightedModel)
      ? highlightedModel
      : initialFocus;

  const focusedItem = data.items.find((item) => item.value === focusedModelId);
  const focusedRow = data.models.find((row) => row.value === focusedModelId);
  const focusedLevels =
    focusedRow?.efforts !== undefined && focusedRow.efforts.levels.length > 1
      ? focusedRow.efforts.levels
      : undefined;
  const focusedEffort =
    focusedRow === undefined
      ? undefined
      : effectiveEffortForRow(
          focusedRow,
          props.currentModel,
          activeModelRef,
          draftEfforts,
        );
  const canAdjustFocused =
    props.selectable &&
    focusedLevels !== undefined &&
    focusedItem !== undefined &&
    !focusedItem.disabled;

  const stepFocusedEffort = (direction: -1 | 1): void => {
    if (!focusedRow || !focusedLevels) return;
    const previous = drafts.get();
    const level = previous[focusedRow.value] ?? focusedEffort;
    const currentIndex = level === undefined ? 0 : focusedLevels.indexOf(level);
    const startIndex = currentIndex >= 0 ? currentIndex : 0;
    const nextIndex = Math.max(
      0,
      Math.min(focusedLevels.length - 1, startIndex + direction),
    );
    const nextLevel = focusedLevels[nextIndex];
    if (nextLevel === undefined || nextLevel === level) return;
    drafts.set({ ...previous, [focusedRow.value]: nextLevel });
  };

  // Reflect any drafted effort in the row's description so the list and the
  // strip never disagree.
  const items = data.items.map((item) => {
    const draft = draftEfforts[item.value];
    if (draft === undefined) return item;
    const label = REASONING_LEVEL_LABELS[draft];
    const updated = item.description.replace(
      /reasoning setting: [^·]+$/,
      `reasoning setting: ${label}`,
    );
    return updated === item.description
      ? item
      : { ...item, description: updated };
  });

  return (
    <ListForm
      title="/model"
      availableRows={props.availableRows}
      items={items}
      activeValue={activeModelRef}
      highlightedValue={focusedModelId}
      onHighlightChange={setHighlightedModel}
      description={
        props.selectable
          ? 'Choose the model for future turns.'
          : 'Available models. Finish the active response before switching models.'
      }
      footer={
        focusedLevels === undefined ? null : (
          <ReasoningEffortStrip
            levels={focusedLevels}
            activeLevel={focusedEffort}
            canAdjust={canAdjustFocused}
            onStep={stepFocusedEffort}
          />
        )
      }
      compactDetail={
        focusedLevels === undefined || focusedEffort === undefined ? (
          <Text dimColor>Available models</Text>
        ) : (
          <ReasoningEffortStrip
            levels={focusedLevels}
            activeLevel={focusedEffort}
            canAdjust={canAdjustFocused}
            compact
            onStep={stepFocusedEffort}
          />
        )
      }
      extraHints={
        canAdjustFocused
          ? [{ key: LEFT_RIGHT_KEYS, action: 'reasoning level' }]
          : undefined
      }
      emptyClosesOnEnter
      emptyMessage={formatCliNoRunnableModelsMessage(CHAT_KEY_RECOVERY)}
      action={props.selectable ? 'select' : 'close'}
      onSelect={(value) => {
        if (!props.selectable) {
          props.onClose();
          return;
        }
        props.onSelect({ model: value, effort: drafts.get()[value] });
      }}
      onCancel={props.onClose}
    />
  );
}
