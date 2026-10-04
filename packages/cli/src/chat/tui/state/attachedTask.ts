// A task the TeXRA service runs, attached from the chat (`/tasks`): its live
// view from the service's frames, and the three things the chat does to it —
// send a follow-up, answer a request, fetch an edit's preview. Nothing here
// writes the task's history: every action is a request the service lands.

import { Effect, type Scope, Stream } from 'effect';

import { describeWireRefusal, watchTask } from '@cli/runtime/taskAttach';
import type { ServiceConnection } from '@controllers/server/client';
import type {
  TaskSummary,
  ToolEditPreview,
} from '@controllers/server/protocol';
import type { RuntimeRequest } from '@shared/session/runtimeRequest';
import type { RunView, SessionView } from '@shared/session/sessionView';

/** One level of the attached task, as the view paints it. */
export interface AttachedTaskLevel {
  readonly run: RunView | undefined;
  /** The task's pending requests, its agents' included, in commit order. */
  readonly requests: SessionView['requests'];
  /** Why the attachment ended, once it has. */
  readonly ended: string | null;
}

/** What the attached view does to the task, each a request to the service. */
export interface AttachedTaskActions {
  readonly request: (request: RuntimeRequest) => Effect.Effect<void, Error>;
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
          Effect.asVoid,
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
    yield* Stream.runForEach(watchTask(client, task), (view) =>
      Effect.sync(() => {
        const tree = treeOf(view, task.runId);
        onLevel({
          run: view.runs.get(task.runId),
          requests: view.requests.filter((request) => tree.has(request.runId)),
          ended: null,
        });
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
