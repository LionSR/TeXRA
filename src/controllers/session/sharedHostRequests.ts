/**
 * The `host.request` arms no GUI host answers its own way (PRD
 * one-fold-three-renderers, 8.3): each is a verb on a port both hosts already
 * build, so once those are bound nothing host-specific is left in the arm, and
 * the extension and the desktop had been answering these thirteen kinds with
 * the same body twice. A host keeps its own `case` labels, so its switch stays
 * exhaustive over `HostRequest` and the compiler still names a kind it forgot;
 * arms the hosts perform differently stay with the host that performs them.
 */
import { Effect } from 'effect';

import type { ToolEditApprovalController } from '@controllers/approval/ToolEditApprovalController';
import type { ProgressWorkflowFileActionsController } from '@controllers/progressView/ProgressWorkflowFileActionsController';
import type { HostDraftRequests } from '@controllers/session/hostDraftRequests';
import type { HostRunActions } from '@controllers/session/hostRunActions';
import type { HostSnapshotSource } from '@controllers/session/hostSnapshotSource';
import type { ProcessServices } from '@platform/processRuntime';
import type { StorageFs } from '@platform/rootedFs';
import type { HostRequest } from '@shared/session/hostRequest';
import type { HostRequestFailure } from '@shared/session/requestErrors';
import type { HostOutcome } from '@shared/session/sessionFrames';

/** The requests {@link handleSharedHostRequest} answers. */
type SharedHostRequest = Extract<
  HostRequest,
  {
    kind:
      | 'dismissBanner'
      | 'fileAction'
      | 'openRunStorage'
      | 'polish'
      | 'record'
      | 'refreshCommits'
      | 'refreshFiles'
      | 'resume'
      | 'runCompileFixer'
      | 'runNew'
      | 'savePastedImage'
      | 'toolEdit'
      | 'useOwnApiKey';
  }
>;

/** The ports a host binds before these arms have anything left to decide. */
export interface SharedHostRequestPorts {
  readonly runActions: HostRunActions;
  readonly workflowFileActions: ProgressWorkflowFileActionsController;
  readonly snapshot: HostSnapshotSource;
  /** This session's take on the one process recorder, as
   *  {@link HostDraftRequests.attach} bound it. */
  readonly draftRequests: ReturnType<HostDraftRequests['attach']>;
  readonly toolEditApprovals: ToolEditApprovalController;
}

const done: HostOutcome = Object.freeze({ kind: 'done' } as const);

/**
 * One program per request, as a host's own arms are: it runs on the fiber the
 * host's dispatch already owns and settles nothing, so its failure reaches
 * that host's fold as the value the port carried.
 */
export function handleSharedHostRequest(
  ports: SharedHostRequestPorts,
  request: SharedHostRequest,
  port: string,
): Effect.Effect<HostOutcome, HostRequestFailure, ProcessServices | StorageFs> {
  return Effect.gen(function* () {
    switch (request.kind) {
      case 'openRunStorage':
        yield* ports.workflowFileActions.openRunStorage(request.runId);
        return done;
      case 'resume':
        yield* ports.runActions.resume(request.runId);
        return done;
      case 'runNew':
        yield* ports.runActions.runNew(request.runId);
        return done;
      case 'runCompileFixer':
        yield* ports.runActions.runCompileFixer(request.runId);
        return done;
      case 'useOwnApiKey':
        yield* ports.runActions.useOwnApiKey(request);
        return done;
      case 'record':
      case 'polish':
      case 'savePastedImage':
        return yield* ports.draftRequests.handle(request, port);
      case 'refreshCommits':
        yield* ports.snapshot.refreshCommits;
        return done;
      case 'refreshFiles':
        yield* ports.snapshot.refreshFiles;
        return done;
      case 'dismissBanner':
        yield* ports.snapshot.dismissBanner(request.banner);
        return done;
      case 'toolEdit':
        yield* ports.toolEditApprovals.handleAction({
          requestId: request.requestId,
          action: request.action,
          ...(request.feedback == null ? {} : { feedback: request.feedback }),
        });
        return done;
      case 'fileAction': {
        const config = yield* ports.runActions.readConfig(request.runId);
        yield* ports.workflowFileActions.handle(request, config);
        return done;
      }
    }
  });
}
