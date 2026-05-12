import * as vscode from 'vscode';

import type { WorkflowFlowResult } from '@agent/runtime/AgentFlowResult';
import * as logger from '@logger/logUtils';
import { getConfig } from '@utils/config';

const CHANNEL = 'FinalOutputOpener';
logger.initialize(CHANNEL);

/**
 * On successful workflow completion, preview the final revised output so
 * users don't feel the file "vanished" into run storage. A dismissible
 * status-bar hint reminds users that workflow mode is slow by design.
 *
 * Gated by `texra.agentOutputs.autoOpenFinal` (default: true).
 */
export async function openFinalOutputIfAvailable(
  result: WorkflowFlowResult,
): Promise<void> {
  if (!getConfig<boolean>('texra.agentOutputs.autoOpenFinal', true)) {
    return;
  }
  // END_GROUP_STATUS has only 'error' and 'stopped'; a completed workflow
  // ends as 'stopped' with outputs attached. 'error' means the flow crashed.
  if (result.status === 'error' || result.outputs.length === 0) {
    return;
  }

  const lastRound = Math.max(...result.outputs.map((o) => o.round));
  const primary = result.outputs.find((o) => o.round === lastRound);
  if (!primary) return;

  try {
    const uri = vscode.Uri.file(primary.absolutePath);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, {
      preview: true,
      preserveFocus: false,
    });
    vscode.window.setStatusBarMessage(
      'Workflow complete — revised file opened in preview. Use the progress toolbar to Accept or Pack.',
      8000,
    );
  } catch (error) {
    logger.debug(
      CHANNEL,
      `Unable to auto-open final output ${primary.absolutePath}: ${String(error)}`,
    );
  }
}
