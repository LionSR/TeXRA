/**
 * Proposal input registry for progress view.
 *
 * Stores typed proposal payloads by ID so they can be retrieved when the user
 * clicks the "Setup" link on a completed proposal log entry.
 *
 * Parsing the raw tool input into a typed proposal is domain logic and lives in
 * the schema layer (`parseDelegationToolInput`); this module is a thin registry
 * over `createContentStore`.
 */

import { parseDelegationToolInput, type AgentProposal } from '@shared/schemas';

import { createContentStore } from './contentStore';

const proposalInputStore = createContentStore<AgentProposal>({
  max: 500,
  prefix: 'proposal',
  serialize: (proposal) => JSON.stringify(proposal),
});

/**
 * Register proposal input and return a stable ID for lookup.
 */
export function registerProposalInput(
  input: unknown,
  toolName: string,
): string | null {
  const proposal = parseDelegationToolInput(input, toolName);
  if (!proposal) return null;
  return proposalInputStore.register(proposal);
}

/**
 * Retrieve proposal input by ID.
 */
export function getProposalInput(id: string): AgentProposal | undefined {
  return proposalInputStore.get(id);
}

/**
 * Clear all proposal input entries (called on stream delete / delete-all).
 */
export function clearProposalInputStore(): void {
  proposalInputStore.clear();
}
