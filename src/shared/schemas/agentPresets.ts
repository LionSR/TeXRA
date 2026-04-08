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
      'Best for Lean 4 formalization projects. Includes theorem search, tactic simplification, blueprint generation, and LaTeX polishing agents.',
    icon: 'codicon-symbol-structure',
    workflowAgents: ['correct', 'polish', 'draw'],
    toolUseAgents: [
      'lean',
      'leanSearch',
      'leanSimplifier',
      'leanBlueprint',
      'chat',
      'review',
      'leanOrchestrator',
    ],
  },
  {
    id: 'physicist',
    name: 'Physicist',
    description:
      'Best for physics manuscripts. Includes agents for symbolic derivations, literature search, presentation slides, and critical review.',
    icon: 'codicon-symbol-operator',
    workflowAgents: ['criticize', 'generic'],
    toolUseAgents: [
      'ask',
      'orchestrator',
      'research',
      'review',
      'search',
      'presenter',
    ],
  },
  {
    id: 'mathematician',
    name: 'Mathematician',
    description:
      'Best for math papers with optional Lean 4 formalization. Combines proof tools, research agents, and LaTeX correction for rigorous manuscripts.',
    icon: 'codicon-symbol-number',
    workflowAgents: ['correct', 'polish', 'draw'],
    toolUseAgents: [
      'lean',
      'leanSearch',
      'leanSimplifier',
      'leanBlueprint',
      'research',
      'review',
      'orchestrator',
    ],
  },
];
