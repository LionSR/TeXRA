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
 * {@link Runtime.layer} is the Effect embedder's entry: it composes the
 * process once and provides both this service and `Sessions`. Its scope
 * owns what this composition installed, so leaving `Effect.scoped` closes
 * the runtime's session and disposes the runtime the owner runs on when
 * this composition was the one that installed them, and closes nothing
 * when it composed beside a host's (or an earlier run's) installation. A
 * Promise embedder reaches the same closure through
 * `lifecycle.runShutdown()`, which `packages/agent/src/index.ts` wires.
 */
import { Context, Effect, Layer } from 'effect';

import { sessionOwnerInstalled } from '@agent/runtime';
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
  /**
   * This call installed the process runtime and the session owner on it, so
   * it owns their disposal and the end of the session it opened. False
   * beside a host (or an earlier composition whose closure has not run)
   * that installed its own.
   */
  readonly composed: boolean;
}

/**
 * Compose the process, or recognize the one already composed. Synchronous
 * and idempotent: a run beside a host that already ran its own composition
 * root (the same platform object) reuses all four installations, its
 * session included, and nothing here is installed twice.
 *
 * What says a process is composed is the session owner, not the platform.
 * `initPlatform` has no inverse and holds for the life of the process,
 * while the owner and the runtime under it end with the composition that
 * installed them (`disposeProcessRuntime`). Reading the platform instead
 * would leave a process whose first closure has run permanently without an
 * owner; reading the owner composes again over the platform already
 * installed, which is what makes the Effect surface usable more than once
 * per process: there each scope owns the composition it made. The Promise
 * entry composes once, because the owner it hands a composition to is the
 * embedder's shutdown path, which runs once (`../index.ts`).
 *
 * Throws {@link PlatformConflict} when a second, different platform reaches
 * a process the package already composed.
 */
export function composeProcess(platform: AgentPlatform): AgentRuntime {
  const active = tryPlatform();
  if (active && active !== platform) {
    throw new PlatformConflict({
      message:
        'The agent package is already using another platform in this process.',
    });
  }
  const composed = !sessionOwnerInstalled();
  if (composed) {
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
  }
  return { platform, roots: platform.roots, composed };
}

/** The composed process. */
export class Runtime extends Context.Service<Runtime, AgentRuntime>()(
  '@texra-ai/agent/Runtime',
) {
  /** Compose the process once and provide both services. */
  static layer(
    platform: AgentPlatform,
  ): Layer.Layer<Runtime | Sessions, PlatformConflict> {
    return sessionsLayer.pipe(
      Layer.provideMerge(
        Layer.effect(
          Runtime,
          Effect.try({
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
          ),
        ),
      ),
    );
  }
}

/**
 * The sessions of the composed process, with the scope as the lifetime of
 * what this composition installed (R6): a composition that installed the
 * process runtime closes the runtime's session and disposes the runtime the
 * owner runs on when its scope leaves. A composition that found both
 * already installed closes nothing: the session belongs to the host (or the
 * earlier run) that opened it, and killing its live runs is not this scope's
 * to do; a root such a scope opened of its own ends through
 * `Sessions.close`.
 *
 * The disposal is the close's finalizer, not its continuation: the close
 * flushes the session's artifacts, and a flush that defects must not leave
 * the owner and the runtime under it installed with no later scope to end
 * them. The defect still leaves the scope, so the embedder sees the failed
 * close; what it cannot do is skip the disposal.
 */
const sessionsLayer = Layer.effect(
  Sessions,
  Effect.gen(function* () {
    const runtime = yield* Runtime;
    const sessions = makeSessions(runtime);
    if (runtime.composed) {
      yield* Effect.addFinalizer(() =>
        sessions
          .close()
          .pipe(Effect.ensuring(Effect.promise(() => disposeProcessRuntime()))),
      );
    }
    return sessions;
  }),
);
