/**
 * Agent teams - predefined collections of enabled agents
 * for different academic disciplines.
 *
 * Each team specifies which workflow and tool-use agents to enable.
 * Agent names are plain strings (not source-prefixed keys) so they
 * match across built-in and custom sources.
 */

import { z } from 'zod';

import type { TeXRAIconName } from '@shared/wa/iconNames';

import { AgentCategorySchema } from './agent';

const AGENT_MODE_PRESET_ICON_NAMES = [
  'bookmark',
  'rocket',
  'diagram-project',
  'cube',
  'hashtag',
  'screwdriver-wrench',
] as const satisfies readonly TeXRAIconName[];

type AgentModePresetIconName = (typeof AGENT_MODE_PRESET_ICON_NAMES)[number];

const AGENT_MODE_PRESET_ICON_NAME_SET = new Set<string>(
  AGENT_MODE_PRESET_ICON_NAMES,
);

const FALLBACK_AGENT_MODE_PRESET_ICON =
  'bookmark' satisfies AgentModePresetIconName;

/** Normalizes persisted icons, warning and using a safe display fallback. */
const AgentModePresetIconSchema = z.string().transform((rawIcon) => {
  const icon = rawIcon.trim();
  const normalized = icon.startsWith('codicon-') ? icon.slice(8) : icon;
  if (AGENT_MODE_PRESET_ICON_NAME_SET.has(normalized)) {
    return normalized as AgentModePresetIconName;
  }

  console.warn(
    `[agentPresets] Unknown agent team icon "${normalized}"; falling back to ` +
      `"${FALLBACK_AGENT_MODE_PRESET_ICON}" instead of dropping the team.`,
  );
  return FALLBACK_AGENT_MODE_PRESET_ICON;
});

/** Schema for a single agent team: members keyed by category. */
export const AgentModePresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  icon: AgentModePresetIconSchema,
  agents: z.record(AgentCategorySchema, z.array(z.string())),
  /** Members whose definitions may be supplied by TeXRA's remote catalog. */
  texraHostedAgents: z.array(z.string()).optional(),
});

export type AgentModePreset = z.infer<typeof AgentModePresetSchema>;

export function parseAgentModePresets(raw: unknown): AgentModePreset[] {
  const parsedRecords = z.array(z.unknown()).prefault([]).safeParse(raw);
  if (!parsedRecords.success) {
    console.warn(
      `[agentPresets] Custom agent teams are not an array; ignoring them for ` +
        `this read: ${parsedRecords.error.message}`,
    );
    return [];
  }

  return parsedRecords.data.flatMap((rawPreset, index) => {
    const result = AgentModePresetSchema.safeParse(rawPreset);
    if (result.success) return [result.data];

    console.warn(
      `[agentPresets] Ignoring malformed custom agent team at index ${index}: ` +
        result.error.message,
    );
    return [];
  });
}

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
  icon: 'rocket',
  agents: {
    workflow: ['correct', 'polish'],
    toolUse: [
      'assistant',
      'research',
      'review',
      'latexFixer',
      'setup',
      'orchestrator',
    ],
  },
  texraHostedAgents: ['orchestrator'],
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
    icon: 'diagram-project',
    agents: {
      workflow: [],
      toolUse: [
        'lean',
        'leanSearch',
        'leanSimplifier',
        'leanBlueprint',
        'latexFixer',
        'progressCheck',
        'leanOrchestrator',
      ],
    },
    texraHostedAgents: [
      'lean',
      'leanSearch',
      'leanSimplifier',
      'leanBlueprint',
      'progressCheck',
      'leanOrchestrator',
    ],
  },
  {
    id: 'physicist',
    name: 'Physicist',
    description:
      'For physics papers -- analytical derivations, numerical experiments, literature search, slides, and critical review.',
    icon: 'cube',
    agents: {
      workflow: [
        'correct',
        'polish',
        'generic',
        'devise',
        'apply',
        'criticize',
      ],
      toolUse: [
        'orchestrator',
        'research',
        'numerics',
        'review',
        'presenter',
        'simplifier',
        'latexFixer',
        'progressCheck',
        'search',
      ],
    },
    texraHostedAgents: [
      'generic',
      'devise',
      'apply',
      'criticize',
      'orchestrator',
      'presenter',
      'simplifier',
      'progressCheck',
      'search',
    ],
  },
  {
    id: 'mathematician',
    name: 'Mathematician',
    description:
      'For math research -- attacking open problems, proofs, Lean 4 formalization, and LaTeX correction.',
    icon: 'hashtag',
    agents: {
      workflow: [
        'correct',
        'polish',
        'generic',
        'devise',
        'apply',
        'criticize',
      ],
      toolUse: [
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
    texraHostedAgents: [
      'generic',
      'devise',
      'apply',
      'criticize',
      'lean',
      'simplifier',
      'progressCheck',
      'orchestrator',
    ],
  },
  {
    id: 'cs-ml',
    name: 'Computer Scientist',
    description:
      'For CS papers -- algorithm design, code-driven experiments and ablations, tests for reproducibility, literature search, and critical review.',
    icon: 'cube',
    agents: {
      workflow: ['criticize', 'generic', 'devise', 'apply', 'polish'],
      toolUse: [
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
    texraHostedAgents: [
      'criticize',
      'generic',
      'devise',
      'apply',
      'orchestrator',
      'search',
      'presenter',
      'simplifier',
      'progressCheck',
    ],
  },
  {
    id: 'software-engineer',
    name: 'Software Engineer',
    description:
      "For a project's code -- the engineer lead delegates implementation, review, debugging, and testing across a team of specialists.",
    icon: 'screwdriver-wrench',
    agents: {
      workflow: [],
      toolUse: [
        'engineer',
        'coder',
        'codeReviewer',
        'testEngineer',
        'codeSimplifier',
      ],
    },
    texraHostedAgents: [],
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
