/**
 * The `host.request` body both GUI hosts answer through (PRD
 * one-fold-three-renderers, 8.3): one switch, one case order, one wire
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
import { Effect } from 'effect';

import type { ToolEditApprovalController } from '@controllers/approval/ToolEditApprovalController';
import type { ProgressWorkflowFileActionsController } from '@controllers/progressView/ProgressWorkflowFileActionsController';
import type { HostDraftRequests } from '@controllers/session/hostDraftRequests';
import {
  launchPatchOf,
  type HostRunActions,
  type WorkflowDiffRequest,
  type WorkflowFileOperationRequest,
} from '@controllers/session/hostRunActions';
import type { HostSnapshotSource } from '@controllers/session/hostSnapshotSource';
import type { ProcessServices } from '@platform/processRuntime';
import type { StorageFs, WorkspaceFs } from '@platform/rootedFs';
import type { RunId } from '@shared/schemas';
import type { HostRequest } from '@shared/session/hostRequest';
import {
  Rejected,
  type HostRequestFailure,
} from '@shared/session/requestErrors';
import type {
  HostOutcome,
  SurfaceActionMessage,
} from '@shared/session/sessionFrames';

/** The kinds {@link handleSharedHostRequest} answers. */
const SHARED_HOST_REQUEST_KINDS = [
  'agentConfigBanner',
  'apiKeyBanner',
  'clean',
  'dismissBanner',
  'exportTranscript',
  'fileAction',
  'gettingStarted',
  'latexdiff',
  'latexdiffs',
  'onboarding',
  'openDashboard',
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
  'restoreIntoLauncher',
  'restoreProposalConfig',
  'resume',
  'runCompileFixer',
  'runNew',
  'savePastedImage',
  'setActiveView',
  'signIn',
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

/** The launcher form of a settled run's setup, as `launchPatchOf` takes it. */
type LaunchConfig = Parameters<typeof launchPatchOf>[0];

type OpenSettingsRequest = Extract<HostRequest, { kind: 'openSettings' }>;
type AgentConfigBannerRequest = Extract<
  HostRequest,
  { kind: 'agentConfigBanner' }
>;
type GettingStartedRequest = Extract<HostRequest, { kind: 'gettingStarted' }>;
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
  /** A host-initiated change to the surface (PRD 8.5). */
  surfaceAction(action: SurfaceActionMessage['action']): void;
  /** Bring the launcher into view behind a restore. The desktop's window is
   *  the launcher, so the two surface actions above are the whole move
   *  there; only the extension has a sidebar to raise. */
  readonly showLauncher: HostVerb<void>;
  runWorkflowDiff(request: WorkflowDiffRequest): HostVerb<void>;
  runWorkflowFileOperation(
    operation: 'pack' | 'clean',
    request: WorkflowFileOperationRequest,
  ): HostVerb<void>;
  /** latexdiff-vc over the base file against a commit, and the pack and
   *  clean housekeeping of what it produced. */
  latexdiffAgainstCommit(
    action: LatexdiffCommitAction,
    baseFile: string,
    commit: string,
  ): HostVerb<void>;
  mergeFiles(baseFile: string, editedFile: string): HostVerb<void>;
  latexdiffFiles(baseFile: string, editedFile: string): HostVerb<void>;
  readonly openDashboard: HostVerb<void>;
  openSettings(
    section: OpenSettingsRequest['section'],
    sessionType: OpenSettingsRequest['sessionType'],
  ): HostVerb<void>;
  /** Ask for a provider API key: a prompt on one host, the Models tab on the
   *  other. The caller re-reads the secret store after this returns. */
  setApiKey(provider: string | undefined): HostVerb<void>;
  openApiKeyGuide(provider: string | undefined): HostVerb<void>;
  /** The agent settings, for the sub-tab a session type names or for none. */
  openAgentSettings(
    sessionType: AgentConfigBannerRequest['sessionType'] | undefined,
  ): HostVerb<void>;
  readonly openCustomAgentDirectory: HostVerb<void>;
  readonly openAgentDocs: HostVerb<void>;
  readonly recheckDependencies: HostVerb<void>;
  openInstallGuide(tool: string): HostVerb<void>;
  readonly signIn: HostVerb<void>;
  gettingStarted(action: GettingStartedRequest['action']): HostVerb<void>;
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
  /** Which state the port shows, for the view-title menus that differ
   *  between the New-task state and a conversation. */
  setActiveView(view: 'main' | 'progress', port: string): void;
}

/** The ports a host binds before these arms have anything left to decide. */
export interface SharedHostRequestPorts {
  readonly runActions: HostRunActions;
  readonly workflowFileActions: ProgressWorkflowFileActionsController;
  readonly snapshot: HostSnapshotSource;
  /** This session's take on the one process recorder, as
   *  {@link HostDraftRequests.attach} bound it. */
  readonly draftRequests: ReturnType<HostDraftRequests['attach']>;
  readonly toolEditApprovals: ToolEditApprovalController;
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

  /** A run's saved setup into the launcher, and the launcher into view. */
  const restoreIntoLauncher = (config: LaunchConfig) =>
    Effect.gen(function* () {
      host.surfaceAction({ kind: 'launch', patch: launchPatchOf(config) });
      host.surfaceAction({ kind: 'selectNew' });
      yield* host.showLauncher;
    });

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
          yield* host.mergeFiles(baseFile, editedFile);
          return;
        case 'latexdiff':
          yield* host.latexdiffFiles(baseFile, editedFile);
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
      case 'exportTranscript':
        yield* host.exportTranscript(request.runId);
        return done;
      case 'restoreIntoLauncher':
        yield* restoreIntoLauncher(
          yield* ports.runActions.restoreState(request.runId),
        );
        return done;
      case 'restoreProposalConfig':
        yield* restoreIntoLauncher(
          yield* ports.runActions.restoreProposal(request.proposal),
        );
        return done;
      case 'latexdiff': {
        const diff = yield* ports.runActions.workflowDiffRequest(request.runId);
        if (diff) yield* host.runWorkflowDiff(diff);
        return done;
      }
      case 'pack':
      case 'clean': {
        const operation = yield* ports.runActions.workflowFileOperationRequest(
          request.runId,
        );
        if (operation) {
          yield* host.runWorkflowFileOperation(request.kind, operation);
        }
        return done;
      }
      case 'latexdiffs':
        yield* latexdiffs(request);
        return done;
      case 'openDashboard':
        yield* host.openDashboard;
        return done;
      case 'openSettings':
        yield* host.openSettings(request.section, request.sessionType);
        return done;
      case 'apiKeyBanner':
        yield* request.action === 'set'
          ? host.setApiKey(request.provider ?? undefined)
          : host.openApiKeyGuide(request.provider ?? undefined);
        return done;
      case 'agentConfigBanner':
        switch (request.action) {
          case 'edit':
            yield* host.openAgentSettings(request.sessionType);
            return done;
          case 'dir':
            // Without a custom directory there is nothing to reveal, so the
            // banner's link is the agent settings instead.
            yield* request.customDirSet === true
              ? host.openCustomAgentDirectory
              : host.openAgentSettings(undefined);
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
      case 'signIn':
        yield* host.signIn;
        return done;
      case 'gettingStarted':
        yield* host.gettingStarted(request.action);
        return done;
      case 'onboarding':
        switch (request.action) {
          case 'signInChatGpt':
            yield* host.onboarding.signInChatGpt;
            return done;
          case 'setApiKey':
            yield* host.setApiKey(undefined);
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
      case 'setActiveView':
        host.setActiveView(request.view, port);
        return done;
    }
  });
}
