import { Effect } from 'effect';

import {
  rootRunId,
  setTransientNotice,
  setCliSessionModelOverride,
} from '@cli/chat/tui/state/cliState';
import { currentView, runViewOf } from '@cli/chat/tui/state/sessionView';
import {
  appendLocalNotice,
  appendLocalRequestRefusal,
} from '@cli/chat/tui/state/transcript';
import { selectChatModel, type SlashCommandContext } from './slashContext';

export const applyCliModelSelection = Effect.fn('applyCliModelSelection')(
  function* (model: string, context: SlashCommandContext) {
    const nextModel = model.trim();
    if (context.session.canStartRootRun()) {
      const selection = yield* selectChatModel(context.stores, {
        model: nextModel,
        reason: 'explicit-override',
      });
      setCliSessionModelOverride(selection.model);
      appendLocalNotice(`Root model set to ${selection.model}.`);
      return;
    }

    if (!context.session.canSelectModel()) {
      setTransientNotice('Finish the active response before switching models.');
      return;
    }

    const runId = rootRunId.get();
    if (runId === undefined) {
      setTransientNotice(
        'Model switching is only available for an active tool-use chat. Start a new chat with texra chat --model=<name> to choose a different root model.',
      );
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
    // A run no session holds takes the switch at its next resume, which may
    // still refuse it; its `run.config` then names the model it runs on.
    if (runViewOf(currentView(), runId)?.holder !== 'here') {
      appendLocalNotice(
        `Model switch to ${nextModel} queued; it applies when this conversation resumes.`,
      );
      return;
    }
    setCliSessionModelOverride(nextModel);
    appendLocalNotice(
      `Model switched to ${nextModel}. Future turns will use it.`,
    );
  },
);
