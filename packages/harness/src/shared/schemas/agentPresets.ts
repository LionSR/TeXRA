/**
 * Agent teams - predefined collections of enabled agents
 * for different academic disciplines.
 *
 * Each team lists the agents it enables, tasks included.
 * Agent names are plain strings (not source-prefixed keys) so they
 * match across built-in and custom sources.
 */

import { Effect, Result, Schema } from 'effect';

const AGENT_MODE_PRESET_ICON_NAMES = [
  'bookmark',
  'rocket',
  'diagram-project',
  'cube',
  'hashtag',
  'screwdriver-wrench',
] as const;

/** Schema for a single agent team: its members, by name. */
export const AgentModePresetSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: Schema.String,
  icon: Schema.Literals(AGENT_MODE_PRESET_ICON_NAMES),
  agents: Schema.Array(Schema.String),
});

export type AgentModePreset = typeof AgentModePresetSchema.Type;

export function parseAgentModePresets(raw: unknown): AgentModePreset[] {
  const parsedRecords = Schema.decodeUnknownResult(
    Schema.Array(Schema.Unknown).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
    ),
  )(raw);
  if (!Result.isSuccess(parsedRecords)) {
    console.warn(
      `[agentPresets] Custom agent teams are not an array; ignoring them for ` +
        `this read: ${parsedRecords.failure.message}`,
    );
    return [];
  }

  return parsedRecords.success.flatMap((rawPreset, index) => {
    const result = Schema.decodeUnknownResult(AgentModePresetSchema)(rawPreset);
    if (Result.isSuccess(result)) return [result.success];

    const named = Schema.decodeUnknownResult(
      Schema.Struct({ name: Schema.String }),
    )(rawPreset);
    const name = Result.isSuccess(named) ? named.success.name : undefined;
    console.warn(
      `[agentPresets] Ignoring malformed custom agent team ` +
        `${name == null ? `at index ${index}` : `"${name}" (index ${index})`}: ` +
        result.failure.message,
    );
    return [];
  });
}

/**
 * Generic default team applied when the user skips the setup agent's
 * discipline question. Deliberately NOT part
 * of {@link AGENT_MODE_PRESETS}: it is not a discipline and must not appear
 * as a team card in the settings UI — only `apply_team` and default-team
 * seeding resolve it.
 */
export const STARTER_AGENT_MODE_PRESET: AgentModePreset = {
  id: 'starter',
  name: 'Starter',
  description: 'Balanced default team for a first project.',
  icon: 'rocket',
  agents: [
    'assistant',
    'research',
    'review',
    'latexFixer',
    'setup',
    'orchestrator',
    'correct',
    'polish',
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
    icon: 'diagram-project',
    agents: [
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
    icon: 'cube',
    agents: [
      'orchestrator',
      'research',
      'numerics',
      'review',
      'presenter',
      'simplifier',
      'latexFixer',
      'progressCheck',
      'search',
      'correct',
      'polish',
      'generic',
      'devise',
      'apply',
      'criticize',
    ],
  },
  {
    id: 'mathematician',
    name: 'Mathematician',
    description:
      'For math research -- attacking open problems, proofs, Lean 4 formalization, and LaTeX correction.',
    icon: 'hashtag',
    agents: [
      'prover',
      'lean',
      'research',
      'numerics',
      'review',
      'simplifier',
      'latexFixer',
      'progressCheck',
      'orchestrator',
      'correct',
      'polish',
      'generic',
      'devise',
      'apply',
      'criticize',
    ],
  },
  {
    id: 'cs-ml',
    name: 'Computer Scientist',
    description:
      'For CS papers -- algorithm design, code-driven experiments and ablations, tests for reproducibility, literature search, and critical review.',
    icon: 'cube',
    agents: [
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
      'criticize',
      'generic',
      'devise',
      'apply',
      'polish',
    ],
  },
  {
    id: 'software-engineer',
    name: 'Software Engineer',
    description:
      "For a project's code -- the engineer lead delegates implementation, review, debugging, and testing across a team of specialists.",
    icon: 'screwdriver-wrench',
    agents: [
      'engineer',
      'coder',
      'codeReviewer',
      'testEngineer',
      'codeSimplifier',
    ],
  },
];
