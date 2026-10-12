/**
 * `apply_team` — the setup agent's one-call team application.
 *
 * Applies a discipline team (an agent team) to the current workspace and
 * records it as the user-level default team, so fresh workspaces are seeded
 * with the same agent list (PRD: agent-native onboarding). The discipline-picker
 * UI is never built — the setup agent asks in conversation and calls this.
 *
 * The workspace agents write is the same `WorkspaceAgentsController.applyTeam` the
 * Settings "apply team" action calls, so the two can't drift. Members that
 * aren't in the registry yet are reported rather than silently dropped.
 */

import { Effect } from 'effect';
import { z } from 'zod';
import { defineTool, ToolContext } from '@texra-ai/harness';

import { createWorkspaceAgentsController } from '@agent/index/agentRegistry';
import { teamPresets } from '@common/teams/TeamPresets';
import { missingMemberNames } from '@common/teams/TeamPlan';
import { agentName, ToolError } from '@shared/schemas';
import { executed } from '@tools/core/result';

/**
 * The shared catalog's built-in teams (the setup starter included), so the
 * enum can't drift from the presets the agent list accepts.
 */
const TEAM_CHOICES = teamPresets(undefined);
const TEAM_IDS = TEAM_CHOICES.map((preset) => preset.id);

function describeTeams(): string {
  return TEAM_CHOICES.map(
    (preset) => `- \`${preset.id}\`: ${preset.name}: ${preset.description}`,
  ).join('\n');
}

const ApplyTeamInputSchema = z.strictObject({
  teamId: z
    .string()
    .refine((value) => TEAM_IDS.includes(value), {
      message: `Expected one of: ${TEAM_IDS.join(', ')}`,
    })
    .describe(`Team to apply. One of:\n${describeTeams()}`),
});

type ApplyTeamInput = z.infer<typeof ApplyTeamInputSchema>;

const applyTeam = Effect.fn('ApplyTeamTool.execute')(function* (
  input: ApplyTeamInput,
) {
  const call = yield* ToolContext;
  const workspaceAgents = createWorkspaceAgentsController(call.env.roots);

  const result = yield* workspaceAgents.applyTeam(input.teamId);

  if (result.status === 'unknown') {
    // The schema gates ids, so this only fires if the enum and the preset
    // list ever disagree — fail loudly rather than half-apply.
    return yield* Effect.fail(
      new ToolError(
        `Unknown team id "${input.teamId}". Valid ids: ${TEAM_IDS.join(', ')}.`,
      ),
    );
  }

  const { preset } = result;
  // The setup agent runs this mid-conversation: every process sharing the
  // store, a window over this task among them, repaints its agent lists
  // from the default team's change (`agentCatalogFollower`).
  yield* workspaceAgents.setDefaultTeam(preset.id);
  const active = result.resolution.agentKeys;
  // `agentKeys` holds only the agent keys that resolved in the registry. Names
  // that didn't resolve are not dropped: the agent list stores the team
  // reference and re-resolves `preset.agents` on every read, so a member
  // activates the moment it appears. Say so instead of letting it read as a
  // silent failure.
  const unresolvedNames = missingMemberNames(result.resolution);

  const lines = [
    `Applied the ${preset.name} team to this workspace.`,
    `Agents (${active.length}): ${
      active.map((key) => agentName(key)).join(', ') || '(none)'
    }`,
    `Saved "${preset.id}" as the default team: fresh workspaces start with this team.`,
  ];
  if (unresolvedNames.length > 0) {
    lines.push(
      `Not installed yet (kept in the team, activates when available): ${unresolvedNames.join(', ')}.`,
    );
  }

  return executed(
    lines.join('\n'),
    `Applied the ${preset.name} team: ${active.length} agents.`,
  );
});

export const ApplyTeamTool = defineTool({
  name: 'apply_team',
  description: `Apply an agent team (one per discipline) to this workspace and record it as the user's default team.

Sets which agents appear in this workspace's pickers, and saves the choice user-wide so future projects start with the same team. Use \`starter\` when the user skips the discipline question. The choice is reversible: Settings → Agents shows every agent and lets the user re-check anything.

Teams:
${describeTeams()}`,
  schema: ApplyTeamInputSchema,
  execute: applyTeam,
});
