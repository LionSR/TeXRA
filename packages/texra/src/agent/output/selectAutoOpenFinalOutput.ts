import { Effect } from 'effect';
import { Settings } from '@texra-ai/harness/host';
import { RUN_OUTCOME } from '@texra-ai/harness/schemas';
import {
  documentsResultOf,
  finalWorkflowOutput,
} from '@texra/shared/plugins/documentOutputs';
import { DOCUMENT_TASK_BLOCK } from '@texra/shared/plugins/documents';
import type { RunEndResult, AgentConfig } from '@texra-ai/harness/schemas';
import type { SettingsStores } from '@texra-ai/harness/host';

/**
 * Decide whether a finished run should auto-open a final output, and which
 * one. The app's policy across hosts (VS Code extension, desktop) so a multi-round
 * run resolves the same file everywhere instead of each host picking its own.
 * Hosts ask once the launch has returned, so this presentation never runs
 * inside the run whose outcome it shows:
 *
 * - Only a `completed` document task (its recipe runs the documents block)
 *   qualifies — failed or cancelled runs may hold partial outputs.
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
export const selectAutoOpenFinalOutput = Effect.fn('selectAutoOpenFinalOutput')(
  function* (
    stores: SettingsStores,
    config: AgentConfig,
    result: RunEndResult,
  ) {
    const documents = documentsResultOf(result.output.structured);
    if (
      config.script?.kind !== 'recipe' ||
      config.script.block !== DOCUMENT_TASK_BLOCK.key ||
      documents === undefined ||
      result.outcome !== RUN_OUTCOME.COMPLETED
    )
      return undefined;
    if (
      !(yield* Settings.get<boolean>(
        stores,
        'texra.agentOutputs.autoOpenFinal',
      ))
    ) {
      return undefined;
    }

    return finalWorkflowOutput(documents.outputs);
  },
);
