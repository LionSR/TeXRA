import { AGENT_CATEGORY, type AgentProposalPermission } from '@shared/schemas';

export function agentProposalCategoryLabel(
  agentCategory: AgentProposalPermission['agentCategory'],
): string {
  return agentCategory === AGENT_CATEGORY.WORKFLOW
    ? 'workflow agent'
    : 'tool-use agent';
}
