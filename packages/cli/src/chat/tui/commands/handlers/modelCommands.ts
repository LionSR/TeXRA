import { Effect } from 'effect';

import { selectModel, type ReasoningEffort } from '@texra-ai/llm';
import type { ProcessServices } from '@texra-ai/worldline/host';
import { emitAppSignal } from '@texra-ai/worldline/plugins';
import { getModelLabel } from '@texra-ai/worldline/schemas';
import { CliUsageError } from '@cli/runtime/platform/cliContext';
import { setReasoningLevel } from '@texra/controllers/settingsView/modelSelection';
import { loadModelOptions } from '@texra/model/setupCredentialAccess';
import {
  modelChoiceWithEffort,
  REASONING_LEVEL_LABELS,
} from '@texra/shared/model/modelPicker';
import {
  rootRunId,
  sessionMeta,
  setTransientNotice,
  setCliSessionModelOverride,
} from '@cli/chat/tui/state/cliState';
import { currentView, runViewOf } from '@cli/chat/tui/state/sessionView';
import {
  appendLocalNotice,
  appendLocalRequestRefusal,
} from '@cli/chat/tui/state/transcript';
import { selectChatModel, type SlashCommandContext } from './slashContext';

/** The model currently in effect for this chat: the next launch's selection or the held root's model. */
export function currentChatModel(
  session: SlashCommandContext['session'],
): string {
  if (session.canStartRootRun()) return sessionMeta.get().model;
  const runId = rootRunId.get();
  const run = runViewOf(currentView(), runId);
  return run?.queuedModel ?? run?.model ?? sessionMeta.get().model;
}

/** Persist `level` for `modelName` and notify listeners (matching desktop). */
const saveReasoningLevel = Effect.fn('saveReasoningLevel')(function* (
  stores: SlashCommandContext['stores'],
  modelName: string,
  level: ReasoningEffort,
) {
  yield* setReasoningLevel(stores.globalState, { modelName, level });
  yield* emitAppSignal('modelAccessChanged', undefined);
});

/** Parse a typed effort token or display label (`xhigh`, `extra high`, `extra-high`). */
function parseCliReasoningEffort(input: string): ReasoningEffort | undefined {
  const normalized = input
    .trim()
    .toLowerCase()
    .replaceAll(/[\s_-]+/g, '');
  if (!normalized) return undefined;
  for (const [effort, label] of Object.entries(REASONING_LEVEL_LABELS) as [
    ReasoningEffort,
    string,
  ][]) {
    if (
      effort === normalized ||
      label.toLowerCase().replaceAll(/[\s_-]+/g, '') === normalized
    ) {
      return effort;
    }
  }
  return undefined;
}

export interface CliModelPick {
  readonly model: string;
  readonly effort?: ReasoningEffort;
}

interface ModelChangeMessages {
  readonly busy: string;
  readonly noActiveChat: string;
  readonly beforeStart: (model: string) => string;
  readonly queued: (model: string) => string;
  readonly switched: (model: string) => string;
}

const MODEL_SWITCH_MESSAGES: ModelChangeMessages = {
  busy: 'Finish the active response before switching models.',
  noActiveChat:
    'Model switching requires an active chat. Start a new one with `texra chat --model=<name>`.',
  beforeStart: (model) => `Model set to ${model}.`,
  queued: (model) =>
    `Model switch to ${model} queued; it applies when this conversation resumes.`,
  switched: (model) => `Model switched to ${model}. Future turns will use it.`,
};

/** One write path for switching the chat's model or effort, pre-run or live. */
const commitChatModelChange = Effect.fn('commitChatModelChange')(function* (
  nextModel: string,
  context: SlashCommandContext,
  options: {
    readonly messages: ModelChangeMessages;
    readonly afterAccepted?: () => Effect.Effect<void, Error, ProcessServices>;
  },
) {
  if (context.session.canStartRootRun()) {
    const selection = yield* selectChatModel(context.stores, {
      model: nextModel,
      reason: 'explicit-override',
    });
    if (options.afterAccepted) yield* options.afterAccepted();
    setCliSessionModelOverride(selection.model);
    appendLocalNotice(options.messages.beforeStart(selection.model));
    return;
  }

  if (!context.session.canSelectModel()) {
    setTransientNotice(options.messages.busy);
    return;
  }

  const runId = rootRunId.get();
  if (runId === undefined) {
    setTransientNotice(options.messages.noActiveChat);
    return;
  }

  const switched = yield* context.runSession
    .request({ kind: 'run.model', runId, model: nextModel })
    .pipe(
      Effect.match({
        onFailure: (error) => {
          appendLocalRequestRefusal(error, runId);
          return false;
        },
        onSuccess: () => true,
      }),
    );
  if (!switched) return;
  if (options.afterAccepted) yield* options.afterAccepted();
  // A run no session holds takes the switch at its next resume, which may
  // still refuse it; its `run.config` then names the model it runs on.
  if (runViewOf(currentView(), runId)?.holder !== 'here') {
    appendLocalNotice(options.messages.queued(nextModel));
    return;
  }
  setCliSessionModelOverride(nextModel);
  appendLocalNotice(options.messages.switched(nextModel));
});

export const applyCliModelSelection = Effect.fn('applyCliModelSelection')(
  function* (model: string, context: SlashCommandContext) {
    yield* commitChatModelChange(model.trim(), context, {
      messages: MODEL_SWITCH_MESSAGES,
    });
  },
);

/** Apply a selection from `/model`, persisting any inline effort adjustment. */
export const applyCliModelPick = Effect.fn('applyCliModelPick')(function* (
  pick: CliModelPick,
  context: SlashCommandContext,
) {
  const current = currentChatModel(context.session);
  const ref = selectModel(pick.model)?.config.ref ?? pick.model.trim();
  if (pick.effort === undefined) {
    yield* applyCliModelSelection(
      selectModel(current)?.config.ref === ref ? current : pick.model,
      context,
    );
    return;
  }
  const level = pick.effort;
  const nextModel = modelChoiceWithEffort(ref, level, current);
  yield* commitChatModelChange(nextModel, context, {
    messages: MODEL_SWITCH_MESSAGES,
    afterAccepted: () => saveReasoningLevel(context.stores, ref, level),
  });
});

/** `/effort <level>` and `/effort` picker selection: validate against the active
 *  model's route, persist the per-model default, and apply to the chat/run. */
export const applyCliEffortSelection = Effect.fn('applyCliEffortSelection')(
  function* (rawEffort: string, context: SlashCommandContext) {
    const current = currentChatModel(context.session);
    const [option] = yield* loadModelOptions(context.stores, [current]);
    const ref = selectModel(current)?.config.ref ?? current;
    const label = option?.label ?? getModelLabel(ref);
    const efforts = option?.efforts;
    if (efforts === undefined || efforts.levels.length <= 1) {
      return yield* new CliUsageError({
        message: `${label} does not offer selectable reasoning effort levels.`,
      });
    }
    const level = parseCliReasoningEffort(rawEffort);
    if (level === undefined || !efforts.levels.includes(level)) {
      return yield* new CliUsageError({
        message: `Unsupported reasoning effort "${rawEffort.trim()}" for ${label}. Supported levels: ${efforts.levels.join(', ')}.`,
      });
    }
    const levelLabel = REASONING_LEVEL_LABELS[level];
    const nextModel = modelChoiceWithEffort(ref, level, current);
    yield* commitChatModelChange(nextModel, context, {
      messages: {
        busy: 'Finish the active response before changing reasoning effort.',
        noActiveChat:
          'Changing reasoning effort requires an active chat. Start a new one with `texra chat --model=<name>@<effort>`.',
        beforeStart: () =>
          `Reasoning effort set to ${levelLabel} for ${label}.`,
        queued: () =>
          `Reasoning effort ${levelLabel} queued for ${label}; it applies when this conversation resumes.`,
        switched: () =>
          `Reasoning effort set to ${levelLabel} for ${label}. Future turns will use it.`,
      },
      afterAccepted: () => saveReasoningLevel(context.stores, ref, level),
    });
  },
);
