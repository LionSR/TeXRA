/**
 * The `ALLOW_ORCHESTRATOR_KILL` permission gate for `/executions/{id}` kills.
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { withLogChannel } from '@logger/effectLog';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { GlobalStateKey } from '@shared/state/stateKeys';
import { inspectSettingFrom } from '@utils/config/platformSettings';

const CHANNEL = 'ExecutionsTool';

/**
 * Why the orchestrator may not kill a child run, or `undefined` when it may.
 *
 * The toggle's permissive default (`true`) answers only for an absent key. A
 * stored value that fails the row's schema — a hand-edited `'false'` or `1` —
 * denies the kill and says why, in the host log and in the tool result: it
 * may be the corruption of a deliberate denial, and a permission gate must not
 * re-permit on corrupt state (#11797). The stored value is left untouched; the
 * user resets it by setting the toggle again.
 */
export const orchestratorKillDenial = Effect.fn('orchestratorKillDenial')(
  function* (settings: SettingsStores) {
    const policy = yield* inspectSettingFrom<boolean>(
      settings,
      GlobalStateKey.ALLOW_ORCHESTRATOR_KILL,
    );
    if (policy.kind === 'invalid') {
      const denial =
        `Killing subagents is denied: the stored "Allow orchestrator cancellation" ` +
        `setting (${GlobalStateKey.ALLOW_ORCHESTRATOR_KILL}) is invalid ` +
        `(${policy.cause}). Set it again in Settings > Multi-Agent.`;
      yield* Effect.logWarning(denial).pipe(withLogChannel(CHANNEL));
      return denial;
    }
    return policy.value
      ? undefined
      : 'Killing subagents is disabled. Enable it in Settings > Multi-Agent.';
  },
);
