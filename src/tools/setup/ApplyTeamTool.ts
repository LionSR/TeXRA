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
 * two can't drift. Relay-served leads (orchestrators) that aren't in the
 * registry yet (signed out) are reported as "after sign-in" rather than
 * silently dropped.
 */

import { z } from 'zod';

import {
  createWorkspaceAgentRosterController,
  getAgentsByCategory,
  loadAgents,
  refresh,
} from '@agent/index/agentRegistry';
import {
  resolveTeamRoster,
  teamHostedNamesForPreflight,
  type TeamRosterCatalog,
} from '@common/teams/TeamRoster';
import { applyTeamRosterWithPreflight } from '@common/teams/TeamRosterApplication';
import { ToolError, type ToolResult } from '@shared/schemas';
import { agentName } from '@shared/schemas/agent';
import {
  AGENT_MODE_PRESETS,
  AGENT_MODE_PRESETS_BY_ID,
  STARTER_AGENT_MODE_PRESET,
} from '@shared/schemas/agentPresets';

import { executed } from '@tools/core/result';
import { defineTool } from '../core/define';
import { getSetupAuthStatus, getSetupPlatform } from './platform';

/**
 * Built from the actual preset list (plus the hidden starter team) so the
 * enum can't drift from `AGENT_MODE_PRESETS`.
 */
const TEAM_CHOICES = [...AGENT_MODE_PRESETS, STARTER_AGENT_MODE_PRESET];
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

export class ApplyTeamTool extends defineTool({
  name: 'apply_team',
  description: `Apply an agent team (a discipline roster) to this workspace and record it as the user's default team.

Sets which workflow agents and assistants appear in this workspace's pickers, and saves the choice user-wide so future projects start with the same roster. Use \`starter\` when the user skips the discipline question. The choice is reversible: Settings → Agents shows every agent and lets the user re-check anything.

Teams:
${describeTeams()}`,
  schema: ApplyTeamInputSchema,
}) {
  protected async execute(input: ApplyTeamInput): Promise<ToolResult> {
    const state = { getAgents: getAgentsByCategory };
    const roster = createWorkspaceAgentRosterController();
    const { signIn } = getSetupPlatform();
    const authenticated = await getSetupAuthStatus();

    // Applying the roster and recording it as the default team both go
    // through this tool's adapter — the Settings "apply team" action commits
    // only the roster, since it has no notion of a fresh-workspace default.
    const catalog: TeamRosterCatalog = {
      resolvePreset: (presetId) => {
        const preset =
          presetId === STARTER_AGENT_MODE_PRESET.id
            ? STARTER_AGENT_MODE_PRESET
            : AGENT_MODE_PRESETS_BY_ID.get(presetId);
        if (!preset) return { ok: false, reason: 'unknownPreset' };
        return {
          ok: true,
          preset,
          resolution: resolveTeamRoster(state, preset),
        };
      },
      // `resolution` is unused: roster.setTeam persists a live {kind:'team'}
      // reference and re-resolves against the catalog on read, rather than
      // committing the frozen per-agent-key snapshot the preflight computed.
      commitPresetResolution: async (preset) => {
        await roster.setTeam(preset.id);
        await roster.setDefaultTeam(preset.id);
      },
    };

    const result = await applyTeamRosterWithPreflight(input.teamId, {
      catalog,
      loadLocalCatalog: () => loadAgents({ includeRemote: false }),
      canAccessRemoteCatalog: async () =>
        authenticated.remoteAgentCatalogAvailable,
      providedChoice: input.unavailableAction ?? undefined,
      choose: async () => undefined,
      signIn,
      forceRefreshRemoteCatalog: () => refresh({ includeRemote: true }),
    });

    if (result.status === 'unknown') {
      // The schema gates ids, so this only fires if the enum and the preset
      // list ever disagree — fail loudly rather than half-apply.
      throw new ToolError(
        `Unknown team id "${input.teamId}". Valid ids: ${TEAM_IDS.join(', ')}.`,
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
      throw new ToolError(
        `The ${result.preset.name} team is still unavailable after refreshing the TeXRA agent catalog: ${result.unavailableNames.join(', ')}.`,
      );
    }

    const { preset } = result;
    const { keys, unresolvedNames } = result.resolution;
    const texraHostedNames = teamHostedNamesForPreflight(
      preset,
      unresolvedNames,
    );

    // `keys` holds only the agent keys that resolved in the registry; names
    // that didn't resolve right now stay in the roster as name slots (from
    // `unresolvedNames`), where visibility matches by name and they activate
    // the moment they appear. Relay-served leads are absent until sign-in —
    // say so instead of letting it read as a silent failure; check registry
    // resolution, never auth.
    const activeWorkflow = keys.workflow;
    const activeToolUse = keys.toolUse;
    const pendingRemoteLeads = unresolvedNames.filter((name) =>
      texraHostedNames.has(name),
    );
    const pendingOther = unresolvedNames.filter(
      (name) => !texraHostedNames.has(name),
    );

    const signInNote =
      pendingRemoteLeads.length > 0
        ? `The ${pendingRemoteLeads.join(' and ')} lead is TeXRA-hosted. It joins the roster automatically after sign-in.`
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
  }
}
