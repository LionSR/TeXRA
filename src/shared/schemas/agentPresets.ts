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
 * Generic default team applied when the user skips the setup agent's
 * discipline question (PRD: agent-native onboarding). Deliberately NOT part
 * of {@link AGENT_MODE_PRESETS}: it is not a discipline and must not appear
 * as a team card in the settings UI — only `apply_team` and default-team
 * seeding resolve it.
 *
 * `orchestrator` is relay-served and only resolves after sign-in; listing it
 * here is harmless because roster application intersects preset names with
 * the live registry.
 */
export const STARTER_AGENT_MODE_PRESET: AgentModePreset = {
  id: 'starter',
  name: 'Starter',
  description: 'Balanced default roster for a first project.',
  icon: 'codicon-rocket',
  workflowAgents: ['correct', 'polish'],
  toolUseAgents: [
    'assistant',
    'research',
    'review',
    'latexFixer',
    'setup',
    'orchestrator',
  ],
};

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
      'For math research -- attacking open problems, proofs, Lean 4 formalization, and LaTeX correction.',
    icon: 'codicon-symbol-number',
    workflowAgents: ['correct', 'polish', 'generic', 'devise', 'apply'],
    toolUseAgents: [
      'prover',
      'lean',
      'research',
      'numerics',
      'review',
      'simplifier',
      'latexFixer',
      'progressCheck',
      'orchestrator',
    ],
  },
  {
    id: 'cs-ml',
    name: 'Computer Scientist',
    description:
      'For CS papers -- algorithm design, code-driven experiments and ablations, tests for reproducibility, literature search, and critical review.',
    icon: 'codicon-symbol-method',
    workflowAgents: ['criticize', 'generic', 'devise', 'apply', 'polish'],
    toolUseAgents: [
      'orchestrator',
      'research',
      'numerics',
      'coder',
      'testEngineer',
      'search',
      'review',
      'presenter',
      'simplifier',
      'latexFixer',
      'progressCheck',
    ],
  },
  {
    id: 'software-engineer',
    name: 'Software Engineer',
    description:
      "For a project's code -- the engineer lead delegates implementation, review, debugging, and testing across a team of specialists.",
    icon: 'codicon-tools',
    workflowAgents: [],
    toolUseAgents: [
      'engineer',
      'coder',
      'codeReviewer',
      'testEngineer',
      'codeSimplifier',
      'progressCheck',
    ],
  },
];

/**
 * Built-in presets indexed by id. {@link AGENT_MODE_PRESETS} stays the ordered
 * source of truth (the settings UI renders team cards in declaration order);
 * this map is the native lookup structure for id resolution, so callers don't
 * linear-scan the array on every resolve.
 */
export const AGENT_MODE_PRESETS_BY_ID: ReadonlyMap<string, AgentModePreset> =
  new Map(AGENT_MODE_PRESETS.map((preset) => [preset.id, preset]));
