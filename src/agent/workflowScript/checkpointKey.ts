// Node imports
import { createHash } from 'node:crypto';

// Third-party imports
import stableStringify from 'fast-json-stable-stringify';

const WORKFLOW_SCRIPT_CHECKPOINT_KEY_PREFIX = 'workflow-script-';

/**
 * Content-derived checkpoint identity: the same script, args, and default
 * agent under the same parent execution resume the same durable journal, so
 * an LLM retry after a timeout or interruption (which mints a new tool-call
 * id) replays completed work instead of orphaning it. Same-content
 * semantics: a script that must re-execute from scratch needs different
 * content (e.g. a nonce field in args).
 *
 * Omitted args and explicit null args hash differently (stableStringify
 * drops undefined properties), matching the persistence layer, which
 * stores them as distinct values and fails loudly on a mismatch.
 */
export function deriveWorkflowScriptCheckpointId(identity: {
  readonly script: string;
  readonly args: unknown;
  readonly defaultAgent: string;
  readonly parentExecutionId: string;
}): string {
  return createHash('sha256')
    .update(
      stableStringify({
        args: identity.args,
        defaultAgent: identity.defaultAgent,
        parentExecutionId: identity.parentExecutionId,
        script: identity.script,
      }),
    )
    .digest('hex')
    .slice(0, 32);
}

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
