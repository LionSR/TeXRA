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
 * owns the closure, so leaving `Effect.scoped` closes the runtime's session
 * and, when the package composed the process, disposes the runtime the
 * owner runs on. A Promise embedder reaches the same closure through
 * `lifecycle.runShutdown()`, which `packages/agent/src/index.ts` wires.
 */
import { Context, Effect, Layer } from 'effect';

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
   * This call composed the process: it was the first to run here, so it
   * owns the disposal of the Effect runtime the session owner runs on.
   * False beside a host (or an earlier run) that composed its own.
   */
  readonly composed: boolean;
}

/**
 * Compose the process, or recognize the one already composed. Synchronous
 * and idempotent: a run beside a host that already ran its own composition
 * root (the same platform object) reuses all four installations, its
 * session included, and nothing here is installed twice.
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
  if (!active) {
    initPlatform(platform);
    initProcessWorkspaceRoots(platform.roots);
    // The runtime is installed before the agent runtime, as the CLI and
    // desktop roots do: registering the direct Lean language services
    // builds their layer graph on it, so a registration ahead of the
    // install throws before any agent work begins. The identity stays a
    // pending read: the owner's map builds synchronously over it, so an
    // open registers its root before the opener's first await and only the
    // entry's build waits.
    installProcessRuntime(platform.processes.selfIdentity());
    initNodeAgentRuntime(platform.lifecycle);
  }
  return { platform, roots: platform.roots, composed: !active };
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
          Effect.suspend(() => {
            try {
              return Effect.succeed(composeProcess(platform));
            } catch (error) {
              // The one refusal this composition states; anything else
              // thrown by an installation is a defect, not a condition.
              return error instanceof PlatformConflict
                ? Effect.fail(error)
                : Effect.die(error);
            }
          }),
        ),
      ),
    );
  }
}

/**
 * The sessions of the composed process, with the scope as their lifetime
 * (R6): leaving the scope closes the runtime's session, and disposes the
 * Effect runtime the owner runs on when this process was the package's to
 * compose.
 */
const sessionsLayer = Layer.effect(
  Sessions,
  Effect.gen(function* () {
    const runtime = yield* Runtime;
    const sessions = makeSessions(runtime);
    yield* Effect.addFinalizer(() =>
      sessions
        .close()
        .pipe(
          Effect.andThen(
            runtime.composed
              ? Effect.promise(() => disposeProcessRuntime())
              : Effect.void,
          ),
        ),
    );
    return sessions;
  }),
);
