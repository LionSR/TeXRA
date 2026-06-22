/**
 * `apply_team` — the setup agent's one-call team application.
 *
 * Applies a discipline roster (an agent team) to the current workspace and
 * records it as the user-level default team, so fresh workspaces are seeded
 * with the same roster (PRD: agent-native onboarding). The discipline-picker
 * UI is never built — the setup agent asks in conversation and calls this.
 *
 * The roster write goes through the same shared application path as the
 * Settings "apply team" action (`applyPresetRoster`), so the two can't
 * drift. Relay-served leads (orchestrators) that aren't in the registry yet
 * (signed out) are reported as "after sign-in" rather than silently dropped.
 */

import { z } from 'zod';

import {
  registryPresetRosterState,
  resolveTeamPreset,
} from '@controllers/onboarding/defaultTeamSeeding';
import { setDefaultTeamId } from '@controllers/onboarding/onboardingFunnel';
import { applyPresetRoster } from '@controllers/settingsView/SettingsAgentCatalogController';
import { platform } from '@platform/platform';
import { REMOTE_ORCHESTRATOR_AGENT_NAMES } from '@agent/index/agentRegistryConstants';
import { agentName } from '@shared/schemas/agent';
import {
  AGENT_MODE_PRESETS,
  STARTER_AGENT_MODE_PRESET,
} from '@shared/schemas/agentPresets';
import { ToolError, type ToolResult } from '@shared/schemas/toolResult';

import { defineTool } from '../core/define';

/**
 * Built from the actual preset list (plus the hidden starter team) so the
 * enum can't drift from `AGENT_MODE_PRESETS`.
 */
const TEAM_CHOICES = [...AGENT_MODE_PRESETS, STARTER_AGENT_MODE_PRESET];
const TEAM_IDS = TEAM_CHOICES.map((preset) => preset.id);

function isTeamId(value: string): boolean {
  return TEAM_IDS.includes(value);
}

function describeTeams(): string {
  return TEAM_CHOICES.map(
    (preset) => `- \`${preset.id}\` — ${preset.name}: ${preset.description}`,
  ).join('\n');
}

const ApplyTeamInputSchema = z.strictObject({
  teamId: z
    .string()
    .refine(isTeamId, {
      message: `Expected one of: ${TEAM_IDS.join(', ')}`,
    })
    .describe(`Team to apply. One of:\n${describeTeams()}`),
});

type ApplyTeamInput = z.infer<typeof ApplyTeamInputSchema>;

export class ApplyTeamTool extends defineTool({
  name: 'apply_team',
  description: `Apply an agent team (a discipline roster) to this workspace and record it as the user's default team.

Sets which workflow agents and assistants appear in this workspace's pickers, and saves the choice user-wide so future projects start with the same roster. Use \`starter\` when the user skips the discipline question. The choice is reversible — Settings → Agents shows every agent and lets the user re-check anything.

Teams:
${describeTeams()}`,
  schema: ApplyTeamInputSchema,
}) {
  protected async execute(input: ApplyTeamInput): Promise<ToolResult> {
    const preset = resolveTeamPreset(input.teamId);
    if (!preset) {
      // The schema gates ids, so this only fires if the enum and the preset
      // list ever disagree — fail loudly rather than half-apply.
      throw new ToolError(
        `Unknown team id "${input.teamId}". Valid ids: ${TEAM_IDS.join(', ')}.`,
      );
    }

    const { workflowKeys, toolUseKeys, unresolvedNames } =
      await applyPresetRoster(
        registryPresetRosterState(platform().workspaceState),
        preset,
      );
    await setDefaultTeamId(platform().globalState, preset.id);

    // Names that didn't resolve in the registry right now stay in the roster
    // (visibility matches by name, so they activate the moment they appear).
    // Relay-served leads are absent until sign-in — say so instead of letting
    // it read as a silent failure; check registry resolution, never auth.
    const unresolved = new Set(unresolvedNames);
    const activeWorkflow = workflowKeys.filter((key) => !unresolved.has(key));
    const activeToolUse = toolUseKeys.filter((key) => !unresolved.has(key));
    const remoteLeadNames = new Set<string>(REMOTE_ORCHESTRATOR_AGENT_NAMES);
    const pendingRemoteLeads = unresolvedNames.filter((name) =>
      remoteLeadNames.has(name),
    );
    const pendingOther = unresolvedNames.filter(
      (name) => !remoteLeadNames.has(name),
    );

    const signInNote =
      pendingRemoteLeads.length > 0
        ? `The ${pendingRemoteLeads.join(' and ')} lead is relay-served — it joins the roster automatically after sign-in.`
        : undefined;

    const lines = [
      `Applied the ${preset.name} roster to this workspace.`,
      `Workflow agents (${activeWorkflow.length}): ${
        activeWorkflow.map((key) => agentName(key)).join(', ') || '(none)'
      }`,
      `Assistants (${activeToolUse.length}): ${
        activeToolUse.map((key) => agentName(key)).join(', ') || '(none)'
      }`,
      `Saved "${preset.id}" as the default team — fresh workspaces start with this roster.`,
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

    return { summary, output: lines.join('\n') };
  }
}
