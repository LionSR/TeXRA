// `/effort` form: chooses the reasoning effort for the active model on its
// current route, matching the desktop/VS Code composer's reasoning picker.

import { Text } from 'ink';
import { Effect } from 'effect';

import type { ReasoningEffort } from '@texra-ai/llm';
import { readModelOptions } from '@texra-ai/worldline/host';
import { getModelLabel, joinFacts } from '@texra-ai/worldline/schemas';
import {
  effectiveReasoningLevel,
  REASONING_LEVEL_LABELS,
} from '@texra/shared/model/modelPicker';
import type { SelectItem } from '@cli/tui/ui/Select';
import { CANCEL_HINT } from '@cli/tui/ui/KeyHints';

import { renderAsyncListFormTransient } from './_shared/FormFrame';
import { ListForm } from './_shared/ListForm';
import { useAsyncListForm } from './_shared/useAsyncListForm';
import { useChatProcess } from '../chatProcess';

interface LoadedEffortChoices {
  readonly modelLabel: string;
  readonly activeLevel: ReasoningEffort | undefined;
  readonly items: readonly SelectItem<ReasoningEffort>[];
}

interface EffortListFormProps {
  readonly currentModel: string;
  readonly availableRows: number;
  readonly selectable: boolean;
  readonly onSelect: (level: ReasoningEffort) => void;
  readonly onClose: () => void;
}

export function EffortListForm(props: EffortListFormProps): React.JSX.Element {
  const { roots } = useChatProcess();
  const fallbackLabel = getModelLabel(props.currentModel || '-');
  const { data, loading, error } = useAsyncListForm<LoadedEffortChoices>({
    load: () =>
      readModelOptions(roots, [props.currentModel]).pipe(
        Effect.map(([verdict]): LoadedEffortChoices => {
          if (verdict === undefined || !('config' in verdict)) {
            return {
              modelLabel: fallbackLabel,
              activeLevel: undefined,
              items: [],
            };
          }
          const modelLabel = verdict.config.label;
          const reasoning = verdict.reasoning;
          if (reasoning === undefined || reasoning.efforts.length <= 1) {
            return { modelLabel, activeLevel: undefined, items: [] };
          }
          const sent =
            'refused' in reasoning.sent ? undefined : reasoning.sent.effort;
          const defaultLevel =
            'refused' in reasoning.fallback
              ? undefined
              : reasoning.fallback.effort;
          const activeLevel = effectiveReasoningLevel(props.currentModel, {
            levels: reasoning.efforts,
            sent,
          });
          const items: SelectItem<ReasoningEffort>[] = reasoning.efforts.map(
            (level) => {
              const label = REASONING_LEVEL_LABELS[level];
              const description = joinFacts([
                level !== label.toLowerCase() && level,
                level === defaultLevel && 'default',
              ]);
              return {
                value: level,
                label,
                ...(description ? { description } : {}),
              };
            },
          );
          return { modelLabel, activeLevel, items };
        }),
      ),
    onClose: props.onClose,
    isEmpty: (loaded) => loaded.items.length === 0,
    closeEmptyOnEnter: true,
  });

  const transient = renderAsyncListFormTransient({
    loading,
    error,
    title: '/effort',
    loadingLabel: 'Loading reasoning levels…',
  });
  if (transient) return transient;
  if (data === undefined) {
    throw new Error('/effort list finished loading without data.');
  }

  return (
    <ListForm
      title="/effort"
      availableRows={props.availableRows}
      items={data.items}
      activeValue={data.activeLevel}
      compactVisibleItems={data.items.length}
      description={
        props.selectable
          ? `Choose the reasoning effort for ${data.modelLabel}.`
          : `Reasoning effort for ${data.modelLabel}. Finish the active response before changing it.`
      }
      compactDetail={<Text dimColor>{data.modelLabel}</Text>}
      selectMarginTop={1}
      emptyClosesOnEnter
      emptyMessage={`${data.modelLabel} does not offer selectable reasoning effort levels.`}
      action={props.selectable ? 'select' : 'close'}
      escape={CANCEL_HINT}
      onSelect={(level) => {
        if (!props.selectable) {
          props.onClose();
          return;
        }
        props.onSelect(level);
      }}
      onCancel={props.onClose}
    />
  );
}
