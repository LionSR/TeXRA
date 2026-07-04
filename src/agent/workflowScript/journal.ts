import { createHash } from 'node:crypto';

import stableStringify from 'fast-json-stable-stringify';

import type { WorkflowAgentCallOptions } from './types';

/**
 * Stable identity for one agent() call: same prompt + options → same key,
 * regardless of object key insertion order. Used for resume: a prior
 * journal entry at the same call index with a matching key replays its
 * cached result instead of re-running the agent. sha256 (truncated) so a
 * key collision — which would replay the wrong cached result — is not a
 * practical concern.
 */
export function journalKey(
  prompt: string,
  options: WorkflowAgentCallOptions,
): string {
  return createHash('sha256')
    .update(stableStringify({ options, prompt }))
    .digest('hex')
    .slice(0, 16);
}
