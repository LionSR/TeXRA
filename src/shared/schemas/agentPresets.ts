/**
 * Agent teams - predefined collections of enabled agents
 * for different academic disciplines.
 *
 * Each team specifies which workflow and tool-use agents to enable.
 * Agent names are plain strings (not source-prefixed keys) so they
 * match across built-in and custom sources.
 */

import { z } from 'zod';

/** Schema for a single agent team. */
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
 * Built-in agent teams.
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
  {
    id: 'cs-ml',
    name: 'Computer Scientist (ML)',
    description:
      'For ML/CS papers -- algorithm design, experiments and ablations, literature search, critical review, and reproducibility.',
    icon: 'codicon-symbol-method',
    workflowAgents: ['criticize', 'generic', 'devise', 'apply', 'polish'],
    toolUseAgents: [
      'orchestrator',
      'numerics',
      'search',
      'review',
      'presenter',
      'simplifier',
      'latexFixer',
      'progressCheck',
    ],
  },
];
