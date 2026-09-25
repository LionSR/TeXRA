/**
 * `apply_team` — the setup agent's one-call team application.
 *
 * Applies a discipline roster (an agent team) to the current workspace and
 * records it as the user-level default team, so fresh workspaces are seeded
 * with the same roster (PRD: agent-native onboarding). The discipline-picker
 * UI is never built — the setup agent asks in conversation and calls this.
 *
 * The roster write goes through the same shared application path
 * (`applyTeamRosterWithPreflight`) as the Settings "apply team" action, so the
 * two can't drift. Account-served members (remote workflow agents) that aren't in the
 * registry yet (signed out) are reported as "after sign-in" rather than
 * silently dropped.
 */

import { Effect } from 'effect';
import { z } from 'zod';
import { ToolCall } from '@agent/runtime/ToolCall';

import {
  createWorkspaceAgentRosterController,
  loadAgents,
  refresh,
} from '@agent/index/agentRegistry';
import { TeamCatalogPortFailed } from '@common/teams/TeamAvailabilityPreflight';
import { findTeamPreset, teamPresets } from '@common/teams/TeamPresets';
import {
  resolveTeamRoster,
  type TeamRosterCatalog,
} from '@common/teams/TeamRoster';
import { applyTeamRosterWithPreflight } from '@common/teams/TeamRosterApplication';
import { emitAppSignal } from '@eventBus/AppSignals';
import { agentName, ToolError } from '@shared/schemas';
import { executed } from '@tools/core/result';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { defineTool } from '../core/define';
import { getSetupAuthStatus, SetupPlatform } from './platform';

/**
 * The shared catalog's built-in teams (the setup starter included), so the
 * enum can't drift from the presets the roster accepts.
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
  unavailableAction: z
    .enum(['sign-in', 'continue', 'cancel'])
    .nullish()
    .describe(
      'Explicit response when TeXRA-hosted members are unavailable. Omit on the first call; after asking the user, pass sign-in, continue, or cancel.',
    ),
});

type ApplyTeamInput = z.infer<typeof ApplyTeamInputSchema>;

const applyTeam = Effect.fn('ApplyTeamTool.execute')(function* (
  input: ApplyTeamInput,
) {
  const call = yield* ToolCall;
  const roster = createWorkspaceAgentRosterController(call.roots);
  const { signIn } = yield* SetupPlatform;
  const authStatus = yield* getSetupAuthStatus();

  // Applying the roster and recording it as the default team both go
  // through this tool's adapter — the Settings "apply team" action commits
  // only the roster, since it has no notion of a fresh-workspace default.
  const catalog: TeamRosterCatalog = {
    resolvePreset: (presetId) =>
      Effect.gen(function* () {
        const preset = findTeamPreset(yield* roster.allPresets(), presetId);
        if (!preset) return { ok: false, reason: 'unknownPreset' } as const;
        return {
          ok: true,
          preset,
          resolution: resolveTeamRoster(roster, preset),
        };
      }),
    commitPreset: (preset) =>
      Effect.gen(function* () {
        yield* roster.setTeam(preset.id);
        yield* roster.setDefaultTeam(preset.id);
        // The setup agent runs this mid-conversation, so an open settings
        // view is showing a roster this call just replaced.
        emitAppSignal('agentRosterChanged', undefined);
      }).pipe(
        // The roster writes are the port's own failure: the preflight reads
        // this channel, and the two stores' tags would not name the port.
        Effect.mapError(
          (cause) =>
            new TeamCatalogPortFailed({
              member: 'commitPreset',
              message: `The applied team could not be stored: ${toErrorMessage(cause)}`,
              cause,
            }),
        ),
      ),
  };

  const result = yield* applyTeamRosterWithPreflight(input.teamId, {
    catalog,
    loadLocalCatalog: () => loadAgents({ includeRemote: false }),
    canAccessRemoteCatalog: () => Effect.succeed(authStatus.authenticated),
    providedChoice: input.unavailableAction ?? undefined,
    choose: () => Effect.succeed(undefined),
    signIn,
    forceRefreshRemoteCatalog: () => refresh({ includeRemote: true }),
  });

  if (result.status === 'unknown') {
    // The schema gates ids, so this only fires if the enum and the preset
    // list ever disagree — fail loudly rather than half-apply.
    return yield* Effect.fail(
      new ToolError(
        `Unknown team id "${input.teamId}". Valid ids: ${TEAM_IDS.join(', ')}.`,
      ),
    );
  }

  if (result.status === 'choice-required') {
    const names = result.unavailableNames.join(', ');
    return executed(
      `The ${result.preset.name} team has unavailable TeXRA-hosted members: ${names}. Ask the user to choose one action: Sign in to TeXRA, Continue with available members, or Cancel. Then call apply_team again with unavailableAction set to "sign-in", "continue", or "cancel". No roster or default-team state was written.`,
      `Team not applied; TeXRA-hosted members are unavailable: ${names}.`,
    );
  }

  if (result.status === 'cancelled') {
    return executed(
      'Cancelled. No roster or default-team state was written.',
      `Cancelled ${result.preset.name} team application.`,
    );
  }
  if (result.status === 'unavailable') {
    return yield* Effect.fail(
      new ToolError(
        `The ${result.preset.name} team is still unavailable after refreshing the TeXRA agent catalog: ${result.unavailableNames.join(', ')}.`,
      ),
    );
  }

  const { preset } = result;
  const { keys, unresolvedNames } = result.resolution;
  const texraHostedNames = new Set(preset.texraHostedAgents);

  // `keys` holds only the agent keys that resolved in the registry. Names
  // that didn't resolve are not dropped: the roster stores the team
  // reference and re-resolves `preset.agents` on every read, so a member
  // activates the moment it appears. `unresolvedNames` is preflight
  // evidence, not stored state. Account-served members are absent until
  // sign-in — say so instead of letting it read as a silent failure; check
  // registry resolution, never auth.
  const activeWorkflow = keys.workflow;
  const activeToolUse = keys.toolUse;
  const pendingRemoteMembers = unresolvedNames.filter((name) =>
    texraHostedNames.has(name),
  );
  const pendingOther = unresolvedNames.filter(
    (name) => !texraHostedNames.has(name),
  );

  const signInNote =
    pendingRemoteMembers.length > 0
      ? `TeXRA-hosted members join the roster automatically after sign-in: ${pendingRemoteMembers.join(', ')}.`
      : undefined;

  const lines = [
    `Applied the ${preset.name} roster to this workspace.`,
    `Workflow agents (${activeWorkflow.length}): ${
      activeWorkflow.map((key) => agentName(key)).join(', ') || '(none)'
    }`,
    `Assistants (${activeToolUse.length}): ${
      activeToolUse.map((key) => agentName(key)).join(', ') || '(none)'
    }`,
    `Saved "${preset.id}" as the default team: fresh workspaces start with this roster.`,
  ];
  if (signInNote) lines.push(signInNote);
  if (pendingOther.length > 0) {
    lines.push(
      `Not installed yet (kept in the roster, activates when available): ${pendingOther.join(', ')}.`,
    );
  }

  const summary = [
    `Applied the ${preset.name} roster: ${activeWorkflow.length} workflows, ${activeToolUse.length} assistants.`,
    ...(signInNote ? [signInNote] : []),
  ].join(' ');

  return executed(lines.join('\n'), summary);
});

export const ApplyTeamTool = defineTool({
  name: 'apply_team',
  description: `Apply an agent team (a discipline roster) to this workspace and record it as the user's default team.

Sets which workflow agents and assistants appear in this workspace's pickers, and saves the choice user-wide so future projects start with the same roster. Use \`starter\` when the user skips the discipline question. The choice is reversible: Settings → Agents shows every agent and lets the user re-check anything.

Teams:
${describeTeams()}`,
  schema: ApplyTeamInputSchema,
  execute: applyTeam,
});
