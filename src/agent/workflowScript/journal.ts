import type { WorkflowAgentCallOptions } from './types';

/**
 * Stable identity for one agent() call: same prompt + options → same key,
 * regardless of object key insertion order. Used for resume: a prior
 * journal entry at the same call index with a matching key replays its
 * cached result instead of re-running the agent.
 */
export function journalKey(
  prompt: string,
  options: WorkflowAgentCallOptions,
): string {
  return hashString(stableStringify({ options, prompt }));
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort();
  const fields = keys.map(
    (key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`,
  );
  return `{${fields.join(',')}}`;
}

/** FNV-1a (32-bit), suffixed with length as a cheap collision hedge. */
function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, '0')}-${input.length.toString(36)}`;
}
