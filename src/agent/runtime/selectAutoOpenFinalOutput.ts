import type { WorkflowFlowResult } from '@agent/runtime/AgentFlowResult';
import type { SettingsStores } from '@shared/config/settingsAccess';
import {
  finalWorkflowOutput,
  RUN_OUTCOME,
  type OutputFileSummary,
} from '@shared/schemas';
import { readSettingFrom } from '@utils/config/platformSettings';

/**
 * Decide whether a finished workflow should auto-open a final output, and which
 * one. Shared policy across hosts (VS Code extension, desktop) so a multi-round
 * run resolves the same file everywhere instead of each host picking its own:
 *
 * - Gated by `texra.agentOutputs.autoOpenFinal` (default true).
 * - Only a `completed` run qualifies — cancelled or failed runs may carry
 *   partial outputs the user did not ask to review.
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
  result: WorkflowFlowResult,
): OutputFileSummary | undefined {
  if (!readSettingFrom<boolean>(stores, 'texra.agentOutputs.autoOpenFinal')) {
    return undefined;
  }
  if (result.outcome !== RUN_OUTCOME.COMPLETED) return undefined;

  return finalWorkflowOutput(result.output.outputs);
}
