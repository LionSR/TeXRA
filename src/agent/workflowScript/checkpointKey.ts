// Third-party imports
import stableStringify from 'fast-json-stable-stringify';

// Local imports
import { truncatedHexId } from '@utils/core/idHash';

const WORKFLOW_SCRIPT_CHECKPOINT_KEY_PREFIX = 'workflow-script-';

/**
 * Named checkpoint identity: `meta.name` plus the default agent under one
 * parent execution owns one durable journal. A retry after a timeout or
 * interruption resumes that journal even when the model rewrites the script
 * (models rarely reproduce source byte-for-byte); safety lives in the journal
 * itself, whose entries replay only on a matching call index and prompt/
 * options hash — a changed call re-executes, an unchanged one is free.
 * A script that must re-execute everything from scratch needs a new
 * meta.name.
 */
export function deriveWorkflowScriptCheckpointId(identity: {
  readonly name: string;
  readonly defaultAgent: string;
  readonly parentExecutionId: string;
}): string {
  return truncatedHexId(
    stableStringify({
      defaultAgent: identity.defaultAgent,
      name: identity.name,
      parentExecutionId: identity.parentExecutionId,
    }),
    32,
  );
}

/** Build the execution-KV key owned by one workflow invocation. */
export function workflowScriptCheckpointKvKey(checkpointId: string): string {
  // JSON.stringify preserves lone UTF-16 surrogates as escapes, unlike direct
  // UTF-8 encoding, which would conflate them with the replacement character.
  const digest = truncatedHexId(JSON.stringify(checkpointId), 64);
  return `${WORKFLOW_SCRIPT_CHECKPOINT_KEY_PREFIX}${digest}`;
}

/** True when an execution-KV key is a workflow-script checkpoint. */
export function isWorkflowScriptCheckpointKvKey(key: string): boolean {
  return key.startsWith(WORKFLOW_SCRIPT_CHECKPOINT_KEY_PREFIX);
}
