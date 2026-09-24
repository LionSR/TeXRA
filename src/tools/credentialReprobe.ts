/**
 * The one `credentialChanged` subscriber that keeps tool availability honest:
 * a committed write to a secret some plugin declares in
 * `ToolAvailabilityChecks.reprobeOnSecrets` re-probes every open workspace.
 * Each host's secret store already announces its writes on the `AppSignals`
 * bus, so which keys matter is the plugin's declaration and which workspaces
 * to re-probe is the session owner's roster, and no host names either.
 */

// Third-party imports
import { Cause, Effect, Queue } from 'effect';

// Local imports
import { listSessions } from '@agent/runtime/sessionGraph';
import { onAppSignal } from '@eventBus/AppSignals';
import { withLogChannel } from '@logger/effectLog';
import { TOOL_PLUGINS } from '@tools/plugins';
import { refreshToolAvailability } from '@tools/toolAvailability';
import type { ToolProbeInputs } from '@tools/toolProbes';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'toolAvailability';

/** Every secret key some plugin's availability answer reads. */
const REPROBE_SECRETS: ReadonlySet<string> = new Set(
  TOOL_PLUGINS.flatMap((plugin) => plugin.availability?.reprobeOnSecrets ?? []),
);

/**
 * The probe inputs of every session the process holds, one per workspace
 * root, because the availability cache is keyed by that root: the extension
 * and the CLI hold one session over their process roots, the desktop one per
 * open project plus the no-workspace one.
 */
const openWorkspaceInputs = Effect.map(listSessions(), (sessions) => {
  const inputs = new Map<string | undefined, ToolProbeInputs>();
  for (const { roots } of sessions) {
    if (inputs.has(roots.workspace)) continue;
    inputs.set(roots.workspace, {
      workspaceRoot: roots.workspace,
      config: roots.config,
    });
  }
  return [...inputs.values()];
});

/**
 * Re-probe on every declared credential change until interrupted. The bus
 * delivers to a synchronous listener, so the listener only enqueues the
 * change and this fiber owns the refreshes; each refresh is forked so a slow
 * probe does not hold back the next change, which the availability cache
 * coalesces into a follow-up probe anyway.
 */
export const reprobeOnCredentialChange = Effect.gen(function* () {
  if (REPROBE_SECRETS.size === 0) return;
  const changes = yield* Queue.unbounded<string>();
  yield* Effect.forkChild(
    onAppSignal('credentialChanged', ({ key }) => {
      if (REPROBE_SECRETS.has(key)) Queue.offerUnsafe(changes, key);
    }),
  );
  while (true) {
    const key = yield* Queue.take(changes);
    for (const inputs of yield* openWorkspaceInputs) {
      yield* Effect.forkChild(
        refreshToolAvailability(inputs).pipe(
          Effect.catchCause((cause) =>
            Effect.logError(
              `Tool availability refresh after a change to "${key}" failed: ${toErrorMessage(Cause.squash(cause))}`,
            ).pipe(withLogChannel(CHANNEL)),
          ),
        ),
      );
    }
  }
});
