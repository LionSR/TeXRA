// Test-only agent-catalog fixtures shared by the extension and desktop
// agent-settings suites, so the preset "physicist" catalog both hosts pin
// their mode-preset behavior against can never drift between them.

import type { AgentEntry } from '@agent/index/agentEntry';
import type { AgentCategory, AgentSource } from '@shared/schemas';

export type AgentCatalog = Record<AgentCategory, AgentEntry[]>;

export function physicistCatalog(): AgentCatalog {
  const workflow = ['correct', 'polish'].map((name): AgentEntry => ({
    source: 'builtInWorkflow',
    name,
    path: `/agents/${name}.yaml`,
    category: 'workflow',
  }));
  const toolUse = [
    ['orchestrator', 'builtInToolUse'],
    ['research', 'custom'],
    ['numerics', 'builtInToolUse'],
    ['review', 'builtInToolUse'],
    ['presenter', 'builtInToolUse'],
    ['latexFixer', 'builtInToolUse'],
  ].map(([name, source]): AgentEntry => ({
    source: source as AgentSource,
    name,
    path: `/agents/${name}.yaml`,
    category: 'toolUse',
    ...(name === 'orchestrator' ? { tools: ['delegate_agent'] } : {}),
  }));
  return { workflow, toolUse };
}
