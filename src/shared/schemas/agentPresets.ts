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
      'For Lean 4 projects -- theorem search, tactic simplification, and blueprints.',
    icon: 'codicon-symbol-structure',
    workflowAgents: [],
    toolUseAgents: [
      'lean',
      'leanSearch',
      'leanSimplifier',
      'leanBlueprint',
      'latexFixer',
      'progressCheck',
      'leanOrchestrator',
    ],
  },
  {
    id: 'physicist',
    name: 'Physicist',
    description:
      'For physics papers -- analytical derivations, numerical experiments, literature search, slides, and critical review.',
    icon: 'codicon-symbol-operator',
    workflowAgents: ['criticize', 'generic', 'devise', 'apply'],
    toolUseAgents: [
      'orchestrator',
      'research',
      'numerics',
      'review',
      'search',
      'presenter',
      'simplifier',
      'latexFixer',
      'progressCheck',
    ],
  },
  {
    id: 'mathematician',
    name: 'Mathematician',
    description:
      'For math papers -- proofs, Lean 4 formalization, research, and LaTeX correction.',
    icon: 'codicon-symbol-number',
    workflowAgents: ['correct', 'polish', 'generic', 'devise', 'apply'],
    toolUseAgents: [
      'lean',
      'research',
      'review',
      'simplifier',
      'latexFixer',
      'progressCheck',
      'orchestrator',
    ],
  },
];
