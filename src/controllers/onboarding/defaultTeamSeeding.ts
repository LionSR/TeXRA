/**
 * Default-team seeding of fresh workspaces (PRD: agent-native onboarding,
 * "Dropdown hygiene" item 1).
 *
 * The setup agent's `apply_team` tool records a user-level default team id.
 * When a workspace has never configured its agent roster, host activation
 * seeds both roster keys from that team so the user's discipline choice
 * follows them into every new project. If no user-level default has been
 * recorded yet, fresh workspaces start from the built-in Physicist team so
 * startup menus do not expose the full agent catalog by default.
 */

import { createRegistryTeamRosterState } from '@agent/teams/registryTeamRosterState';
import { applyTeamRoster } from '@common/teams/TeamRoster';
import { resolveBuiltInTeamPreset } from '@common/teams/builtInTeamPresets';
import { getDefaultTeamId } from '@shared/state/onboardingState';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

import type { StateStore } from '@platform/interfaces';

const DEFAULT_STARTUP_TEAM_ID = 'physicist';

/**
 * Seed this workspace's agent roster from the user-level default team.
 * No-op unless BOTH roster keys are unset (never configured) AND a team
 * resolves to a known preset. Returns whether seeding happened.
 *
 * `options.fallbackTeamId` is the team applied when no user-level default has
 * been recorded. It defaults to the built-in Physicist team (the VS Code
 * extension keeps this so its startup menus stay scoped to a discipline). Pass
 * `null` to skip the fallback so a never-configured workspace keeps every agent
 * enabled — the CLI does this so a fresh terminal session exposes the full
 * catalog and only an explicitly-applied team scopes the roster.
 */
export async function seedRosterFromDefaultTeam(
  stores: {
    globalState: StateStore;
    workspaceState: StateStore;
  },
  options: { readonly fallbackTeamId?: string | null } = {},
): Promise<boolean> {
  const { globalState, workspaceState } = stores;
  if (
    workspaceState.get(WorkspaceStateKey.ENABLED_AGENTS) !== undefined ||
    workspaceState.get(WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS) !== undefined
  ) {
    return false;
  }
  // Prefer the user's recorded default team; fall back to the host's startup
  // team when no default is recorded or the recorded id no longer resolves.
  const { fallbackTeamId = DEFAULT_STARTUP_TEAM_ID } = options;
  const defaultTeamId = getDefaultTeamId(globalState);
  const preset =
    (defaultTeamId ? resolveBuiltInTeamPreset(defaultTeamId) : undefined) ??
    (fallbackTeamId ? resolveBuiltInTeamPreset(fallbackTeamId) : undefined);
  if (!preset) return false;
  await applyTeamRoster(createRegistryTeamRosterState(workspaceState), preset);
  return true;
}
