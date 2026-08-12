import * as vscode from 'vscode';

import type { WorkflowFlowResult } from '@agent/runtime/AgentFlowResult';
import { selectAutoOpenFinalOutput } from '@agent/runtime/selectAutoOpenFinalOutput';
import { createLog } from '@logger/logUtils';

const log = createLog('FinalOutputOpener');

/**
 * On successful workflow completion, preview the final revised output so
 * users don't feel the file "vanished" into run storage. A dismissible
 * status-bar hint reminds users that workflow mode is slow by design.
 *
 * The gate, outcome check, and which output counts as final live in
 * {@link selectAutoOpenFinalOutput} (shared with the desktop host); this only
 * supplies the VS Code open verb and status-bar hint.
 */
export async function openFinalOutputIfAvailable(
  result: WorkflowFlowResult,
): Promise<void> {
  const primary = selectAutoOpenFinalOutput(result);
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
    log.debug(
      `Unable to auto-open final output ${primary.absolutePath}: ${String(error)}`,
    );
  }
}
