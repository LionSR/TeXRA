import { getRuntimeModelLabel } from '@model/runtimeModelRegistry';
import type { WorkflowCallProgress } from '@shared/schemas';
import { formatWorkflowCallLine } from '@shared/copy/workflowCall';

/** Format workflow-call progress for CLI surfaces without changing its model ID. */
export function formatCliWorkflowCallLine(call: WorkflowCallProgress): string {
  const displayCall =
    'model' in call && call.model !== undefined
      ? { ...call, model: getRuntimeModelLabel(call.model) }
      : call;
  return formatWorkflowCallLine(displayCall);
}
