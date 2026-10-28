/**
 * The `host.request` body both GUI hosts answer through: one switch, one case order, one wire
 * contract, over a binding table each host fills with the verbs it actually
 * performs. The extension and the desktop had been answering thirty-two
 * kinds with the same body twice -- the same refusal wording, the same
 * read-then-act order, the same three- and six-way sub-switches -- so the
 * body lives here once and the difference is the table.
 *
 * A host routes every kind {@link isSharedHostRequest} admits here and keeps
 * a `case` only for an arm it performs its own way (its file pickers, its
 * editor's current file, its tab pop-out, its launch path). The guard narrows
 * the host's switch to exactly those kinds, so it stays exhaustive and the
 * compiler still names a kind it forgot.
 */
import * as path from 'node:path';
import { formatResultCount } from '@texra-ai/harness/transcript';

import { Effect } from 'effect';

import { Rejected, type HostRequestFailure } from '@texra-ai/harness';
import { getIncludedExtensions } from '@texra/common/files/fileTypeUtils';
import type { HostRequest } from '@texra/shared/session/hostRequest';
import type { SettingsTarget } from '@texra/shared/settingsView/settingsTarget';
import type {
  HostOutcome,
  SurfaceActionMessage,
} from '@texra/shared/session/sessionFrames';
import type { ToolEditApprovalController } from '@texra/controllers/approval/ToolEditApprovalController';
import { attachDroppedFiles } from '@texra/controllers/mainView/MainViewDroppedFilesController';
import type { ProgressWorkflowFileActionsController } from '@texra/controllers/progressView/ProgressWorkflowFileActionsController';
import {
  launchApprovalOptions,
  launchFormOf,
  prepareSurfaceLaunch,
} from '@texra/controllers/mainView/backend/MainViewRunLaunchController';
import { hostFailure } from '@texra/controllers/session/hostCallFailure';
import type { HostDraftRequests } from '@texra/controllers/session/hostDraftRequests';
import {
  type HostRunActions,
  type WorkflowDiffRequest,
  type WorkflowFileOperationResult,
} from '@texra/controllers/session/hostRunActions';
import type { HostSnapshotSource } from '@texra/controllers/session/hostSnapshotSource';
import type { WorkspaceRoots } from '@texra-ai/harness';
import type {
  ProcessServices,
  StorageFs,
  WorkspaceFs,
} from '@texra-ai/harness/host';
import type { RunId } from '@texra-ai/harness/schemas';

/** The kinds {@link handleSharedHostRequest} answers. */
const SHARED_HOST_REQUEST_KINDS = [
  'agentConfigBanner',
  'apiKeyBanner',
  'attachDroppedFiles',
  'clean',
  'dismissBanner',
  'exportTranscript',
  'fileAction',
  'fork',
  'launch',
  'latexdiff',
  'latexdiffs',
  'onboarding',
  'openFile',
  'openInstallGuide',
  'openLabel',
  'openRunStorage',
  'openSettings',
  'pack',
  'polish',
  'recheckDependencies',
  'record',
  'refreshCommits',
  'refreshFiles',
  'resume',
  'runCompileFixer',
  'runAgain',
  'savePastedImage',
  'toolEdit',
  'useOwnApiKey',
] as const satisfies readonly HostRequest['kind'][];

type SharedHostRequest = Extract<
  HostRequest,
  { kind: (typeof SHARED_HOST_REQUEST_KINDS)[number] }
>;

const sharedHostRequestKinds: ReadonlySet<HostRequest['kind']> = new Set(
  SHARED_HOST_REQUEST_KINDS,
);

/** Whether the shared body answers `request`. A host routes these to
 *  {@link handleSharedHostRequest} and switches over what the guard leaves. */
export function isSharedHostRequest(
  request: HostRequest,
): request is SharedHostRequest {
  return sharedHostRequestKinds.has(request.kind);
}

/** A verb a host binds: it runs on the fiber the host's dispatch owns, and
 *  its failure is the value the arm answers with. */
type HostVerb<A> = Effect.Effect<
  A,
  HostRequestFailure,
  ProcessServices | StorageFs | WorkspaceFs
>;

type LaunchRequest = Extract<HostRequest, { kind: 'launch' }>;
type LatexdiffsRequest = Extract<HostRequest, { kind: 'latexdiffs' }>;

/** The latexdiff verbs taken against a commit rather than an edited file. */
type LatexdiffCommitAction = Extract<
  LatexdiffsRequest['action'],
  'latexdiffvc' | 'packLatexdiffvc' | 'cleanLatexdiffvc'
>;

/**
 * The verbs behind the shared arms. Every member is a capability the host
 * performs; nothing here decides anything, which is the point: the decision
 * -- the order, the guard, the refusal wording -- is in the one body below.
 */
export interface SharedHostRequestBindings {
  /** Open a file of this session's workspace, at a line when one is named. */
  openPath(file: string, line: number | undefined): HostVerb<void>;
  /** Reveal the first file defining `label`; `false` when none does. */
  openLabel(label: string): HostVerb<boolean>;
  exportTranscript(runId: RunId): HostVerb<void>;
  showInfo(message: string): HostVerb<void>;
  /** A host-initiated change to the surface. */
  surfaceAction(action: SurfaceActionMessage['action']): void;
  /** Admit a launch this host cannot run as asked, with the refusal that
   *  says why; the extension names only open workspace folders as a working
   *  directory. */
  admitLaunch(form: LaunchRequest['launch']): HostVerb<void>;
  runWorkflowDiff(request: WorkflowDiffRequest): HostVerb<void>;
  /** Tell the user what a pack or clean did. */
  presentWorkflowFileOperation(
    operation: 'pack' | 'clean',
    done: WorkflowFileOperationResult,
  ): HostVerb<void>;
  /** latexdiff-vc over the base file against a commit, and the pack and
   *  clean housekeeping of what it produced. */
  latexdiffAgainstCommit(
    action: LatexdiffCommitAction,
    baseFile: string,
    commit: string,
  ): HostVerb<void>;
  /** Settings at a target, or where it was last left without one. */
  openSettings(target: SettingsTarget | undefined): HostVerb<void>;
  /** Ask for a provider API key: a prompt on one host, the Models tab on the
   *  other. The caller re-reads the secret store after this returns. */
  readonly setApiKey: HostVerb<void>;
  readonly openApiKeyGuide: HostVerb<void>;
  readonly openCustomAgentDirectory: HostVerb<void>;
  readonly openAgentDocs: HostVerb<void>;
  readonly recheckDependencies: HostVerb<void>;
  openInstallGuide(tool: string): HostVerb<void>;
  /** The onboarding card's five verbs; its sixth, "set an API key", is
   *  {@link SharedHostRequestBindings.setApiKey}, the same verb the banner
   *  takes. */
  readonly onboarding: {
    readonly signInChatGpt: HostVerb<void>;
    readonly skip: HostVerb<void>;
    readonly runSetup: HostVerb<void>;
    readonly skipSetup: HostVerb<void>;
    readonly openGettingStarted: HostVerb<void>;
  };
}

/** The ports a host binds before these arms have anything left to decide. */
export interface SharedHostRequestPorts {
  readonly runActions: HostRunActions;
  readonly workflowFileActions: ProgressWorkflowFileActionsController;
  readonly snapshot: HostSnapshotSource;
  /** This session's take on the one process recorder, as
   *  {@link HostDraftRequests.attach} bound it. */
  readonly draftRequests: Effect.Success<
    ReturnType<HostDraftRequests['attach']>
  >;
  readonly toolEditApprovals: ToolEditApprovalController;
  readonly roots: WorkspaceRoots;
  readonly host: SharedHostRequestBindings;
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
): Effect.Effect<
  HostOutcome,
  HostRequestFailure,
  ProcessServices | StorageFs | WorkspaceFs
> {
  const { host } = ports;

  /** The Tools sheet's verbs over the launcher's base and edited files. */
  const latexdiffs = (sheet: LatexdiffsRequest) =>
    Effect.gen(function* () {
      const { action } = sheet;
      const baseFile = sheet.baseFile ?? '';
      const editedFile = sheet.editedFile ?? '';
      if (
        action === 'latexdiffvc' ||
        action === 'packLatexdiffvc' ||
        action === 'cleanLatexdiffvc'
      ) {
        yield* host.latexdiffAgainstCommit(
          action,
          baseFile,
          sheet.commit ?? 'HEAD',
        );
        return;
      }
      if (!baseFile || !editedFile) {
        return yield* Effect.fail(
          new Rejected({
            reason: 'Choose a base file and an edited file first.',
          }),
        );
      }
      switch (action) {
        case 'compare':
          yield* ports.workflowFileActions.compareOriginal(
            editedFile,
            baseFile,
          );
          return;
        case 'accept':
          yield* ports.workflowFileActions.acceptFile(editedFile, baseFile);
          return;
        case 'merge':
          yield* ports.workflowFileActions.mergeFile(editedFile, baseFile);
          return;
        case 'latexdiff':
          yield* ports.workflowFileActions.latexdiffFile(editedFile, baseFile);
          return;
      }
    });

  return Effect.gen(function* () {
    switch (request.kind) {
      case 'openFile':
        yield* host.openPath(request.path, request.line ?? undefined);
        return done;
      case 'openLabel': {
        // The "not found" message belongs to the request, not to either
        // host's search: both word it the same way.
        const opened = yield* host.openLabel(request.label);
        if (!opened) {
          return yield* Effect.fail(
            new Rejected({
              reason: `No file defines the label ${request.label}.`,
            }),
          );
        }
        return done;
      }
      case 'openRunStorage':
        yield* ports.workflowFileActions.openRunStorage(request.runId);
        return done;
      case 'attachDroppedFiles': {
        const attached = yield* attachDroppedFiles(
          ports.roots.workspace,
          request.paths,
          getIncludedExtensions(request.category),
        );
        if (attached.attachedCount > 0 && attached.rejectedCount > 0) {
          yield* Effect.forkDetach(
            host
              .showInfo(
                `Attached ${formatResultCount(attached.attachedCount, 'dropped file')}; skipped ${formatResultCount(attached.rejectedCount, 'unsupported, folder, or out-of-workspace item')}.`,
              )
              .pipe(
                Effect.catch((cause) =>
                  Effect.logWarning('Dropped-file notice failed', cause),
                ),
              ),
          );
        }
        return { kind: 'files', paths: attached.paths };
      }
      case 'launch':
        yield* host.admitLaunch(request.launch);
        yield* prepareSurfaceLaunch(request, ports.roots).pipe(
          Effect.flatMap((prepared) =>
            ports.runActions
              .runValidated(prepared, launchApprovalOptions(request))
              .pipe(
                Effect.mapError((cause) => hostFailure('runValidated', cause)),
              ),
          ),
        );
        return done;
      case 'resume':
        yield* ports.runActions.resume(request.runId);
        return done;
      case 'runAgain': {
        // The form opens on the run's setup; the person changes it and
        // starts it, so nothing launches here.
        const form = yield* launchFormOf(
          yield* ports.runActions.runAgain(request.runId),
        );
        host.surfaceAction({ kind: 'selectNew' });
        host.surfaceAction({ kind: 'launch', patch: form });
        return done;
      }
      case 'fork': {
        const forked = yield* ports.runActions.fork(
          request.runId,
          request.at ?? null,
        );
        const { draft } = request;
        if (draft != null) {
          // The composer keeps an image while its text holds the image's
          // `[name]` chip, the stored file's name. A send from the CLI
          // names it `[Image #N]` instead, so a missing chip is added.
          const images = (request.mediaFiles ?? []).map((file) => ({
            fileName: path.basename(file),
            path: file,
          }));
          const chips = images
            .map(({ fileName }) => `[${fileName}]`)
            .filter((chip) => !draft.includes(chip));
          host.surfaceAction({
            kind: 'draft',
            runId: forked,
            text: [draft, ...chips].join(' '),
            images,
          });
        }
        host.surfaceAction({ kind: 'select', runId: forked });
        return done;
      }
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
        yield* ports.toolEditApprovals.handleAction(request);
        return done;
      case 'fileAction': {
        const config = yield* ports.runActions.readConfig(request.runId);
        yield* ports.workflowFileActions.handle(request, config);
        return done;
      }
      case 'exportTranscript':
        yield* host.exportTranscript(request.runId);
        return done;
      case 'latexdiff': {
        const diff = yield* ports.runActions.workflowDiffRequest(request.runId);
        if (diff) yield* host.runWorkflowDiff(diff);
        return done;
      }
      case 'pack':
      case 'clean': {
        const files = yield* ports.runActions.workflowFileOperation(
          request.runId,
          request.kind,
        );
        if (files)
          yield* host.presentWorkflowFileOperation(request.kind, files);
        return done;
      }
      case 'latexdiffs':
        yield* latexdiffs(request);
        return done;
      case 'openSettings':
        yield* host.openSettings(request.target ?? undefined);
        return done;
      case 'apiKeyBanner':
        yield* request.action === 'set' ? host.setApiKey : host.openApiKeyGuide;
        return done;
      case 'agentConfigBanner':
        switch (request.action) {
          case 'edit':
            yield* host.openSettings('agents/library');
            return done;
          case 'dir':
            // Without a custom directory there is nothing to reveal, so the
            // banner's link is the agent settings instead.
            yield* request.customDirSet === true
              ? host.openCustomAgentDirectory
              : host.openSettings('agents/library');
            return done;
          case 'docs':
            yield* host.openAgentDocs;
            return done;
        }
        return done;
      case 'recheckDependencies':
        yield* host.recheckDependencies;
        return done;
      case 'openInstallGuide':
        yield* host.openInstallGuide(request.tool);
        return done;
      case 'onboarding':
        switch (request.action) {
          case 'signInChatGpt':
            yield* host.onboarding.signInChatGpt;
            return done;
          case 'setApiKey':
            yield* host.setApiKey;
            return done;
          case 'skip':
            yield* host.onboarding.skip;
            return done;
          case 'runSetup':
            yield* host.onboarding.runSetup;
            return done;
          case 'skipSetup':
            yield* host.onboarding.skipSetup;
            return done;
          case 'openGettingStarted':
            yield* host.onboarding.openGettingStarted;
            return done;
        }
        return done;
    }
  });
}
