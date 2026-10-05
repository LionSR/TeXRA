// A task the TeXRA service runs, attached from the chat (`/tasks`): its live
// view from the service's frames, and the three things the chat does to it —
// send a follow-up, answer a request, fetch an edit's preview. Nothing here
// writes the task's history: every action is a request the service lands.

import { Effect, type Scope, Stream } from 'effect';

import {
  aggregateId,
  type Outcome,
  type RuntimeRequest,
} from '@texra-ai/harness';
import { describeWireRefusal, watchTask } from '@cli/runtime/taskAttach';
import {
  attentionOf,
  type RunView,
  type SessionView,
} from '@shared/session/sessionView';
import type {
  TaskSummary,
  ToolEditPreview,
} from '@texra/controllers/server/protocol';
import type { ServiceConnection } from '@texra/controllers/server/client';

/** One level of the attached task, as the view paints it. */
export interface AttachedTaskLevel {
  readonly run: RunView | undefined;
  /** The task's answerable requests, its agents' included, in commit order. */
  readonly requests: SessionView['requests'];
  /** Why the attachment ended, once it has. */
  readonly ended: string | null;
}

/** What the attached view does to the task, each a request to the service. */
export interface AttachedTaskActions {
  readonly request: (request: RuntimeRequest) => Effect.Effect<Outcome, Error>;
  readonly preview: (
    requestId: string,
  ) => Effect.Effect<ToolEditPreview | null, Error>;
}

/** The run ids of `root` and every run under it. */
function treeOf(view: SessionView, root: RunView['id']): Set<string> {
  const ids = new Set<string>();
  const visit = (id: RunView['id']): void => {
    if (ids.has(id)) return;
    ids.add(id);
    for (const child of view.runs.get(id)?.childIds ?? []) visit(child);
  };
  visit(root);
  return ids;
}

/**
 * Hold the service connection and follow `task`: `onReady` receives the
 * actions once connected, `onLevel` every change. Runs until interrupted;
 * a connection or watch that fails ends it with a final level saying why.
 */
export function followAttachedTask(
  connect: () => Effect.Effect<ServiceConnection, Error, Scope.Scope>,
  task: TaskSummary,
  onReady: (actions: AttachedTaskActions) => void,
  onLevel: (level: AttachedTaskLevel) => void,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const { client } = yield* connect();
    onReady({
      request: (request) =>
        client['task.request']({ workspace: task.workspace, request }).pipe(
          Effect.mapError((error) =>
            error._tag === 'RpcClientError'
              ? error
              : new Error(describeWireRefusal(error)),
          ),
        ),
      preview: (requestId) =>
        client['request.preview']({
          workspace: task.workspace,
          requestId,
        }).pipe(
          Effect.mapError((error) =>
            error._tag === 'RpcClientError' ? error : new Error(error.message),
          ),
        ),
    });
    const aggregate = aggregateId('run', task.runId);
    let seen = false;
    yield* Stream.runForEach(watchTask(client, task), (view) =>
      Effect.suspend(() => {
        const run = view.runs.get(task.runId);
        // Gone: held once and dropped since (deleted), or its history read
        // and no run in it.
        if (run === undefined && (seen || view.folded.has(aggregate)))
          return Effect.fail(
            new Error('The task is no longer in its project.'),
          );
        seen ||= run !== undefined;
        const tree = treeOf(view, task.runId);
        onLevel({
          run,
          // Only what the service can take an answer for now (the rule
          // every window reads): an interrupted run's request waits for a
          // resume, and is not offered here.
          requests: attentionOf(view).requests.filter((request) =>
            tree.has(request.runId),
          ),
          ended: null,
        });
        return Effect.void;
      }),
    );
  }).pipe(
    Effect.scoped,
    Effect.catch((error) =>
      Effect.sync(() =>
        onLevel({ run: undefined, requests: [], ended: error.message }),
      ),
    ),
  );
}
