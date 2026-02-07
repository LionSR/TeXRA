/**
 * Proposal input registry for progress view.
 *
 * Stores proposal tool inputs by ID so they can be retrieved when the user
 * clicks the "Setup" link on a completed proposal log entry.
 *
 * Uses content-based hashing (like copyContentStore) so re-rendering the
 * same message produces the same ID — no memory leak on stream switches.
 */

import { hashString } from './hashUtils';

interface StoredProposal {
  input: Record<string, unknown>;
  toolName: string;
}

const proposalInputStore = new Map<string, StoredProposal>();

function buildId(input: Record<string, unknown>, toolName: string): string {
  const serialized = JSON.stringify({ t: toolName, i: input });
  return `proposal:${serialized.length}:${hashString(serialized)}`;
}

/**
 * Register proposal input and return a stable ID for lookup.
 */
export function registerProposalInput(
  input: Record<string, unknown>,
  toolName: string,
): string {
  const id = buildId(input, toolName);
  if (!proposalInputStore.has(id)) {
    proposalInputStore.set(id, { input, toolName });
  }
  return id;
}

/**
 * Retrieve proposal input by ID.
 */
export function getProposalInput(id: string): StoredProposal | undefined {
  return proposalInputStore.get(id);
}
