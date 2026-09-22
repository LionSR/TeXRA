/**
 * The process `@texra-ai/agent` composes, as an Effect service.
 *
 * {@link composeProcess} is the package's composition root: the platform,
 * the process workspace roots, the node agent runtime, and the one Effect
 * runtime that holds the session owner. It is synchronous and idempotent by
 * design — everything from the platform check to the owner's registration
 * of a root happens before the first yield of a run, so a close issued the
 * moment a launch returns settles that launch too.
 *
 * That composition is one installation, however many callers reach it, so
 * it is held rather than owned: every {@link composeProcess} returns a
 * {@link ProcessHold} on it, and the last hold to be released is what closes
 * the owner's sessions and disposes the runtime under them.
 *
 * `Sessions.layer` is the embedder's entry: it composes the process once
 * per scope and provides `Sessions` over it, with the scope as the lifetime
 * of its hold. The root entry (`packages/agent/src/index.ts`) re-exports
 * these services as the package's surface.
 */
import { Effect, Layer, type Context } from 'effect';

import {
  closeSession as closeOwnedSession,
  installedProcessRuntime,
  listSessions as listOwnedSessions,
} from '@agent/runtime';
import { unavailableSupabaseAuth } from '@auth/SupabaseAuth';
import { SignInFailed } from '@common/errors/signInFailed';
import {
  disposeProcessRuntime,
  installProcessRuntime,
} from '@controllers/session/sessionLayer';
import { globalDatabaseLayer } from '@controllers/session/Database';
import { setDebugModeConfig } from '@logger/logUtils';
import { AppState, AgentDirectories } from '@platform/interfaces';
import { initPlatform, tryPlatform, type Platform } from '@platform/platform';
import type { AgentResumePort } from '@platform/interfaces';
import type { LanguageModelPort } from '@platform/languageModel';
import type { PlatformSecrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { nodeProcesses } from '@platform/defaults/nodeProcesses';
import { UsageLog } from '@shared/usageLog';
import { directLeanLanguageServices } from '@tools/lean/direct/directLspAdapter';
import {
  SetupCommandFailed,
  type SetupPlatformShape,
} from '@tools/setup/platform';

import { PlatformConflict } from './errors.js';
import { makeSessions } from './sessionPrograms.js';
import type { Sessions } from './sessions.js';

/**
 * The process platform together with the workspace roots the package's runs
 * work in. `nodePlatform()` builds both; an embedder supplying its own
 * platform names its workspace roots beside it.
 */
export interface AgentPlatform extends Platform {
  readonly roots: WorkspaceRoots;
  /** The secret store this process's `Secrets` service reads from. */
  readonly secrets: PlatformSecrets;
  /** The port this process's `AgentResume` service forwards to. */
  readonly agentResume: AgentResumePort;
  /** The bridge its `LanguageModel` service serves; an embedder with no
   *  editor passes `UNAVAILABLE_LANGUAGE_MODEL_PORT`, as `nodePlatform()`. */
  readonly languageModel: LanguageModelPort;
}

/** The composed process, as the package's services read it. */
export interface AgentRuntime {
  readonly platform: AgentPlatform;
  readonly roots: WorkspaceRoots;
}

/**
 * What the package answers a setup tool with: nothing, loudly. It is
 * embedded in someone else's process, so it is none of the three product
 * hosts `ToolHost` names and it has no sign-in flow of its own to start.
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
export interface ProcessHold {
  readonly runtime: AgentRuntime;
  readonly sessions: Context.Service.Shape<typeof Sessions>;
  /**
   * End this hold (R6). The last hold to end closes every session the owner
   * holds and then disposes the runtime they ran on; every earlier one ends
   * nothing, because something else is still working on it. A hold on a
   * host's own installation ends nothing either: the session belongs to the
   * host that opened it, and killing its live runs is not this package's to
   * do.
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
 * Whether the installation those holds share is this package's. What says a
 * process is composed is the session owner, not the platform: `initPlatform`
 * has no inverse and holds for the life of the process, while the owner and
 * the runtime under it end with the holds on them. A composition that found
 * a host's own installation disposes nothing, however its holds end.
 */
let installedHere = false;

/**
 * Compose the process, or take a hold on the one already composed.
 * Synchronous and idempotent: a run beside a host that already ran its own
 * composition root (the same platform object) reuses all four
 * installations, its session included, and nothing here is installed twice.
 *
 * Every call takes a hold, and every hold is ended by exactly one
 * {@link releaseProcess}. That is what makes the Effect surface usable more
 * than once per process and safe to use twice at once: each scope holds the
 * composition it found, and the last one out ends it.
 *
 * Throws {@link PlatformConflict} when a second, different platform reaches
 * a process the package already composed.
 */
export function composeProcess(platform: AgentPlatform): ProcessHold {
  const active = tryPlatform();
  if (active && active !== platform) {
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
    lifecycle: platform.lifecycle,
    setup: PACKAGE_SETUP,
  };
  // The owner carries the runtime it runs on, so a composition beside a host
  // that already installed one borrows exactly that runtime; an absent owner
  // is what says this composition must install its own.
  let processRuntime = installedProcessRuntime();
  if (!processRuntime) {
    // The process-wide installations, once for the life of the process.
    if (!active) {
      initPlatform(platform);
      // The logger's process-wide debug-mode read, over this embedder's
      // configuration.
      setDebugModeConfig(platform.roots.config);
    }
    // The identity stays a pending read -- the package's composition root is
    // synchronous, so it hands the program over rather than a value, and the
    // runtime it installs reads it once for the process. The direct Lean
    // language services are a layer of this runtime, as on the CLI and
    // desktop roots.
    processRuntime = installProcessRuntime({
      processStart: nodeProcesses.selfIdentity(),
      globalStorage: platform.roots.globalStorage,
      ...processServices,
      lean: directLeanLanguageServices(),
      // An embedder reports no usage: the package has no version or editor of
      // its own to stamp entries with, and no account plane to send them on.
      usageLog: UsageLog.disabled,
      // The embedder's global root is a root like any host's: one handle for
      // the life of the runtime this composition installs.
      globalDatabase: globalDatabaseLayer(platform.roots.globalStorage),
    });
    installedHere = true;
  }
  const heldRuntime = processRuntime;
  const runtime: AgentRuntime = { platform, roots: platform.roots };
  const sessions = makeSessions(
    runtime,
    Layer.effectContext(processRuntime.contextEffect),
  );
  holds += 1;
  let held = true;
  return {
    runtime,
    sessions,
    release: Effect.suspend(() => {
      if (!held) return Effect.void;
      held = false;
      holds -= 1;
      if (holds > 0 || !installedHere) return Effect.void;
      installedHere = false;
      return closeOwnedSessions().pipe(
        // The runtime is this composition's own local, not a read of what is
        // installed now.
        Effect.ensuring(disposeProcessRuntime(heldRuntime)),
      );
    }),
  };
}

/** Every session the owner still holds, closed one at a time: a root some
 *  composition opened of its own settles its runs and flushes its artifacts
 *  exactly as the runtime's own root does, rather than going down with the
 *  runtime unwritten. */
function closeOwnedSessions(): Effect.Effect<void> {
  return Effect.flatMap(listOwnedSessions(), (open) =>
    Effect.forEach(
      open,
      (session) => closeOwnedSession(session.roots.storage),
      { discard: true },
    ),
  );
}
