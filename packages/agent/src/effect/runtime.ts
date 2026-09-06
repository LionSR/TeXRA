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
 * {@link Runtime.layer} is the Effect embedder's entry: it composes the
 * process once per scope and provides both this service and `Sessions`,
 * with the scope as the lifetime of its hold. A Promise embedder's hold is
 * the one `packages/agent/src/index.ts` takes, released by
 * `lifecycle.runShutdown()`.
 */
import { Context, Effect, Layer } from 'effect';

import {
  closeSession as closeOwnedSession,
  listSessions as listOwnedSessions,
  sessionOwnerInstalled,
} from '@agent/runtime';
import {
  disposeProcessRuntime,
  installProcessRuntime,
} from '@controllers/session/sessionLayer';
import { initPlatform, tryPlatform, type Platform } from '@platform/platform';
import {
  initProcessWorkspaceRoots,
  type WorkspaceRoots,
} from '@platform/workspaceRoots';
import { initNodeAgentRuntime } from '@platform/defaults/nodeAgentRuntime';

import { PlatformConflict } from './errors.js';
import { makeSessions, Sessions } from './sessions.js';

/**
 * The process platform together with the workspace roots the package's runs
 * work in. `nodePlatform()` builds both; an embedder supplying its own
 * platform names its workspace roots beside it.
 */
export interface AgentPlatform extends Platform {
  readonly roots: WorkspaceRoots;
}

/** The composed process, as the package's services read it. */
export interface AgentRuntime {
  readonly platform: AgentPlatform;
  readonly roots: WorkspaceRoots;
}

/** One composition's hold on the composed process: what it reads, and the
 *  end of its claim on what it found or installed. */
export interface ProcessHold {
  readonly runtime: AgentRuntime;
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
 * would tear them out from under an overlapping scope, or from under the
 * Promise entry's runs, which is precisely what a borrowing composition has
 * no standing to do.
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
  if (!sessionOwnerInstalled()) {
    // The process-wide installations, once for the life of the process.
    if (!active) {
      initPlatform(platform);
      initProcessWorkspaceRoots(platform.roots);
    }
    // The runtime is installed before the agent runtime, as the CLI and
    // desktop roots do: registering the direct Lean language services
    // builds their layer graph on it, so a registration ahead of the
    // install throws before any agent work begins. The identity stays a
    // pending read: the owner's map builds synchronously over it, so an
    // open registers its root before the opener's first await and only the
    // entry's build waits.
    installProcessRuntime(platform.processes.selfIdentity());
    if (!active) {
      initNodeAgentRuntime(platform.lifecycle);
    }
    installedHere = true;
  }
  holds += 1;
  let held = true;
  return {
    runtime: { platform, roots: platform.roots },
    release: Effect.suspend(() => {
      if (!held) return Effect.void;
      held = false;
      holds -= 1;
      if (holds > 0 || !installedHere) return Effect.void;
      installedHere = false;
      return closeOwnedSessions().pipe(
        Effect.ensuring(Effect.promise(() => disposeProcessRuntime())),
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

/** The composed process. */
export class Runtime extends Context.Service<Runtime, AgentRuntime>()(
  '@texra-ai/agent/Runtime',
) {
  /** Compose the process once and provide both services, with this scope as
   *  the lifetime of the hold it takes. */
  static layer(
    platform: AgentPlatform,
  ): Layer.Layer<Runtime | Sessions, PlatformConflict> {
    return sessionsLayer.pipe(
      Layer.provideMerge(
        Layer.effect(
          Runtime,
          Effect.gen(function* () {
            const hold = yield* Effect.try({
              try: () => composeProcess(platform),
              catch: (thrown) => thrown,
            }).pipe(
              // The one refusal this composition states; anything else
              // thrown by an installation is a defect, not a condition.
              Effect.catch((thrown) =>
                thrown instanceof PlatformConflict
                  ? Effect.fail(thrown)
                  : Effect.die(thrown),
              ),
            );
            // Registered where the hold is taken, so no path leaves the
            // scope holding one.
            yield* Effect.addFinalizer(() => hold.release);
            return hold.runtime;
          }),
        ),
      ),
    );
  }
}

/** The sessions of the composed process. They outlive no hold on it: what
 *  ends them is the last {@link ProcessHold.release}. */
const sessionsLayer = Layer.effect(Sessions, Effect.map(Runtime, makeSessions));
