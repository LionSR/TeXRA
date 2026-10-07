import { Effect } from 'effect';
import type { RunEndResult } from '@agent/runtime/RunEndResult';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { finalWorkflowOutput, RUN_OUTCOME } from '@shared/schemas';
import { readSettingFrom } from '@utils/config/platformSettings';

/**
 * Decide whether a finished run should auto-open a final output, and which
 * one. Shared policy across hosts (VS Code extension, desktop) so a multi-round
 * run resolves the same file everywhere instead of each host picking its own.
 * Hosts ask once the launch has returned, so this presentation never runs
 * inside the run whose outcome it shows:
 *
 * - Only a `completed` workflow qualifies — cancelled or failed runs may
 *   carry partial outputs the user did not ask to review.
 * - Gated by `texra.agentOutputs.autoOpenFinal` (default true).
 * - Which file counts as final is {@link finalWorkflowOutput}'s call, shared
 *   with the CLI's `--output` copy and text result.
 *
 * Returns `undefined` when nothing should open; the host supplies only its own
 * open verb (the extension's text-document preview, the desktop's `openPath`).
 *
 * `stores` are the setting slots of the session the run belongs to, held as
 * data: the gate answers for that project, not for whichever roots the
 * calling context carries.
 */
export function selectAutoOpenFinalOutput(
  stores: SettingsStores,
  result: RunEndResult,
) {
  return Effect.gen(function* () {
    const { documents } = result.output;
    if (documents === undefined || result.outcome !== RUN_OUTCOME.COMPLETED) {
      return undefined;
    }
    if (
      !(yield* readSettingFrom<boolean>(
        stores,
        'texra.agentOutputs.autoOpenFinal',
      ))
    ) {
      return undefined;
    }

    return finalWorkflowOutput(documents.outputs);
  });
}
