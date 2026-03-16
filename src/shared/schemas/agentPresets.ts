/**
 * Agent mode presets - predefined collections of enabled agents
 * for different academic disciplines.
 *
 * Each preset specifies which workflow and tool-use agents to enable.
 * Agent names are plain strings (not source-prefixed keys) so they
 * match across built-in and custom sources.
 */

import { z } from 'zod';

/** Schema for a single agent mode preset. */
export const AgentModePresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  icon: z.string(),
  workflowAgents: z.array(z.string()),
  toolUseAgents: z.array(z.string()),
});

export type AgentModePreset = z.infer<typeof AgentModePresetSchema>;

/**
 * Built-in agent mode presets.
 *
 * Agent names listed here are matched by name (not source:name key)
 * so custom agents that override a built-in are included automatically.
 */
export const AGENT_MODE_PRESETS: AgentModePreset[] = [
  {
    id: 'lean-project',
    name: 'Lean Project',
    description:
      'Formal proof development with Lean 4, theorem search, tactic simplification, and LaTeX document support.',
    icon: 'codicon-symbol-structure',
    workflowAgents: ['correct', 'polish', 'draw'],
    toolUseAgents: [
      'lean',
      'leanSearch',
      'leanSimplifier',
      'leanBlueprint',
      'chat',
      'review',
      'latexFixer',
      'leanOrchestrator',
    ],
  },
  {
    id: 'physicist',
    name: 'Physicist',
    description:
      'Symbolic derivations, mathematical verification, literature discussion, and rigorous manuscript review.',
    icon: 'codicon-symbol-operator',
    workflowAgents: ['criticize', 'generic'],
    toolUseAgents: [
      'chat',
      'ask',
      'orchestrator',
      'research',
      'review',
      'latexFixer',
      'search',
      'presenter',
    ],
  },
  {
    id: 'mathematician',
    name: 'Mathematician',
    description:
      'Formal proofs with Lean 4, symbolic computation, derivation verification, and theorem exploration.',
    icon: 'codicon-symbol-number',
    workflowAgents: ['correct', 'polish', 'draw'],
    toolUseAgents: [
      'lean',
      'leanSearch',
      'leanSimplifier',
      'leanBlueprint',
      'research',
      'review',
      'latexFixer',
      'chat',
      'orchestrator',
    ],
  },
];
