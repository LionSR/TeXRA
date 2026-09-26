/**
 * The process `@texra-ai/agent` composes, as an Effect service.
 *
 * {@link acquireProcess} is the package's composition root: the process
 * workspace roots, the node agent runtime, and the one Effect runtime that
 * holds the session owner. Acquisition waits for any previous composition's
 * retirement before joining or building that installation.
 *
 * That composition is one installation, however many callers reach it, so
 * it is held rather than owned: every {@link acquireProcess} takes a
 * {@link ProcessHold} on it, and the last hold to be released is what closes
 * the owner's sessions and disposes the runtime under them.
 *
 * `Sessions.layer` is the embedder's entry: it composes the process once
 * per scope and provides `Sessions` over it, with the scope as the lifetime
 * of its hold. The root entry (`packages/agent/src/index.ts`) re-exports
 * these services as the package's surface.
 */
import { Effect, Layer, Semaphore, type Context, type Scope } from 'effect';

import { closeAllSessions, installedProcessRuntime } from '@agent/runtime';
import { unavailableSupabaseAuth } from '@auth/SupabaseAuth';
import { SignInFailed } from '@common/errors/signInFailed';
import {
  disposeProcessRuntime,
  installProcessRuntime,
} from '@controllers/session/sessionLayer';
import { globalDatabaseLayer } from '@controllers/session/Database';
import {
  AppState,
  AgentDirectories,
  type AgentDirectoriesPort,
  type AgentResumePort,
  type ToolMissingHandler,
} from '@platform/interfaces';
import type { LanguageModelPort } from '@platform/languageModel';
import type { PlatformSecrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { nodeProcesses } from '@platform/defaults/nodeProcesses';
import { UsageLog } from '@shared/usageLog';
import {
  SetupCommandFailed,
  type SetupPlatformShape,
} from '@tools/setup/platform';

import { PlatformConflict } from './errors.js';
import { makeSessions } from './sessionPrograms.js';
import type { Sessions } from './sessions.js';

/**
 * The process services the package composes, together with the workspace
 * roots the package's runs work in. `nodePlatform()` builds all of them; an
 * embedder supplying its own names its workspace roots beside them.
 */
export interface AgentPlatform {
  /** The agent directories this process's `AgentDirectories` service serves. */
  readonly agentDirectories: AgentDirectoriesPort;
  /** Surfaces a tool-missing error to the embedder, served as
   *  `ToolMissingReporter`; absent, a missing-tool probe answers without
   *  surfacing. */
  readonly toolMissingHandler?: ToolMissingHandler;
  readonly roots: WorkspaceRoots;
  /** The secret store this process's `Secrets` service reads from. */
  readonly secrets: PlatformSecrets;
  /** The port this process's `AgentResume` service forwards to. */
  readonly agentResume: AgentResumePort;
  /** The bridge its `LanguageModel` service serves; an embedder with no
   *  editor passes `UNAVAILABLE_LANGUAGE_MODEL_PORT`, as `nodePlatform()`. */
  readonly languageModel: LanguageModelPort;
}

/**
 * What the package answers a setup tool with: nothing, loudly. It is
 * embedded in someone else's process, so it is none of the three product
 * hosts `SettingHost` names and it has no sign-in flow of its own to start.
 * Claiming to be the CLI would make `collectCoreSetupStatus` and the probe
 * tools branch on a surface that is not there, and answering `signIn` with
 * `false` would report a sign-in that can never happen as one that merely
 * did not complete. Each member says so instead, the way the test kernel's
 * fake does — on read for the members a caller only ever calls, and as the
 * port's own typed failure for the sign-in and command surfaces.
 * The same loud answer this package gave before it provided `SetupPlatform`
 * at all.
 */
const NO_SETUP_PLATFORM =
  'The agent package has no setup platform: run the setup agent from the texra CLI, the desktop app, or the VS Code extension.';

const PACKAGE_SETUP: SetupPlatformShape = {
  get host(): never {
    throw new Error(NO_SETUP_PLATFORM);
  },
  signIn: () => Effect.fail(new SignInFailed({ message: NO_SETUP_PLATFORM })),
  // The one member read before it is called: `unset_api_key` asks for the
  // command surface to refresh the host's status views after a credential
  // it already removed. A throwing getter would make that read a defect
  // mid-tool, so the absence is the port's own typed failure instead, which
  // the caller settles per command.
  commands: {
    invoke: (commandId) =>
      Effect.fail(
        new SetupCommandFailed({
          reason: 'command-unavailable',
          message: NO_SETUP_PLATFORM,
          commandId,
        }),
      ),
  },
  // Optional on the shape: an embedder has no editor, so probes that read
  // `extensions?.isInstalled` see the same absence a headless host reports.
  extensions: undefined,
  get terminal(): never {
    throw new Error(NO_SETUP_PLATFORM);
  },
};

/** One composition's hold on the composed process: what it reads, and the
 *  end of its claim on what it found or installed. */
interface ProcessHold {
  readonly sessions: Context.Service.Shape<typeof Sessions>;
  /**
   * End this hold (R6). The last hold to end closes every session the owner
   * holds and then disposes the runtime they ran on; every earlier one ends
   * nothing, because something else is still working on it.
   *
   * The disposal is the close's finalizer, not its continuation: the close
   * flushes each session's artifacts, and a flush that defects must not
   * leave the owner and the runtime under it installed with no hold left to
   * end them. The defect still propagates, so the embedder sees the failed
   * close; what it cannot do is skip the disposal.
   *
   * Ending a hold twice ends it once. A hold is one composition's and the
   * count is the process's, so a second release must not spend another
   * composition's claim.
   */
  readonly release: Effect.Effect<void>;
}

/**
 * How many live holds there are on the process this package composed. The
 * session owner and the runtime under it are one installation shared by
 * every composition that found it already there, so they end when the last
 * hold ends and not before: a scope that disposed them at its own exit
 * would tear them out from under an overlapping scope still working on
 * them, which is precisely what a borrowing composition has no standing to
 * do.
 */
let holds = 0;

/**
 * The platform the installation those holds share was composed with, while
 * this package holds one; cleared with the last hold. It is what says the
 * installed process runtime is this package's to join: one that is installed
 * while this is unset was installed by a host for its own roots, and one
 * composed with a different platform serves another embedder's services.
 */
let composedWith: AgentPlatform | undefined;

/** A new hold must wait for the last hold's full session and runtime teardown. */
const processChanges = Semaphore.makeUnsafe(1);

/** Acquire and register one hold atomically; its scope owns the release. */
export const acquireProcess = (
  platform: AgentPlatform,
): Effect.Effect<
  Context.Service.Shape<typeof Sessions>,
  PlatformConflict,
  Scope.Scope
> =>
  Effect.acquireRelease(
    processChanges.withPermit(
      Effect.try({
        try: () => composeProcess(platform),
        catch: (thrown) => thrown,
      }).pipe(
        Effect.catch((thrown) =>
          thrown instanceof PlatformConflict
            ? Effect.fail(thrown)
            : Effect.die(thrown),
        ),
      ),
    ),
    (hold) => processChanges.withPermit(hold.release),
  ).pipe(Effect.map((hold) => hold.sessions));

/**
 * Compose the process, or take a hold on the one this package already
 * composed with the same platform. Synchronous and idempotent: nothing here
 * is installed twice.
 *
 * Every call takes a hold, ended by its scope's finalizer. This makes the
 * Effect surface usable more than once per process and safe to use twice
 * at once: each scope holds the
 * composition it found, and the last one out ends it.
 *
 * Throws {@link PlatformConflict} when a second, different platform reaches
 * a process the package already composed, or when a process runtime the
 * package did not install is already there: borrowing a runtime a host built
 * for its own roots would silently serve the host's services to this one.
 */
function composeProcess(platform: AgentPlatform): ProcessHold {
  // The owner carries the runtime it runs on; an absent owner is what says
  // this composition must install its own.
  let processRuntime = installedProcessRuntime();
  if (composedWith ? composedWith !== platform : processRuntime !== undefined) {
    throw new PlatformConflict({
      message:
        'The agent package is already using another platform in this process.',
    });
  }
  const processServices = {
    secrets: platform.secrets,
    appState: AppState.layer(platform.roots.globalState),
    // The package has no TeXRA account plane of its own: every probe answers
    // signed-out, as the uninitialized facade did for an embedder.
    auth: unavailableSupabaseAuth(),
    languageModel: platform.languageModel,
    agentResume: platform.agentResume,
    agentDirectories: AgentDirectories.layer(platform.agentDirectories),
    toolMissingReporter: platform.toolMissingHandler,
    setup: PACKAGE_SETUP,
  };
  if (!processRuntime) {
    // The identity stays a pending read -- the package's composition root is
    // synchronous, so it hands the program over rather than a value, and the
    // runtime it installs reads it once for the process. The direct Lean
    // language services are a layer of this runtime, as on the CLI and
    // desktop roots.
    processRuntime = installProcessRuntime({
      processStart: nodeProcesses.selfIdentity(),
      globalStorage: platform.roots.globalStorage,
      ...processServices,
      // An embedder reports no usage: the package has no version or editor of
      // its own to stamp entries with, and no account plane to send them on.
      usageLog: UsageLog.disabled,
      // The embedder's global root is a root like any host's: one handle for
      // the life of the runtime this composition installs.
      globalDatabase: globalDatabaseLayer(platform.roots.globalStorage),
      // An embedder's console has no live level filter of its own, so the
      // package speaks at the informational level rather than flooding it.
      minimumLogLevel: 'Info',
    });
    composedWith = platform;
  }
  const heldRuntime = processRuntime;
  const sessions = makeSessions(
    platform.roots,
    Layer.effectContext(processRuntime.contextEffect),
  );
  holds += 1;
  let held = true;
  return {
    sessions,
    release: Effect.suspend(() => {
      if (!held) return Effect.void;
      held = false;
      holds -= 1;
      if (holds > 0) return Effect.void;
      composedWith = undefined;
      return Effect.asVoid(closeAllSessions()).pipe(
        // The runtime is this composition's own local, not a read of what is
        // installed now.
        Effect.ensuring(disposeProcessRuntime(heldRuntime)),
      );
    }),
  };
}
