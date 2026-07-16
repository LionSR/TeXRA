import { createHash } from 'node:crypto';

const WORKFLOW_SCRIPT_CHECKPOINT_KEY_PREFIX = 'workflow-script-';

/** Build the execution-KV key owned by one workflow invocation. */
export function workflowScriptCheckpointKvKey(checkpointId: string): string {
  // JSON.stringify preserves lone UTF-16 surrogates as escapes, unlike direct
  // UTF-8 encoding, which would conflate them with the replacement character.
  const digest = createHash('sha256')
    .update(JSON.stringify(checkpointId))
    .digest('hex');
  return `${WORKFLOW_SCRIPT_CHECKPOINT_KEY_PREFIX}${digest}`;
}

/** True when an execution-KV key is a workflow-script checkpoint. */
export function isWorkflowScriptCheckpointKvKey(key: string): boolean {
  return key.startsWith(WORKFLOW_SCRIPT_CHECKPOINT_KEY_PREFIX);
}
