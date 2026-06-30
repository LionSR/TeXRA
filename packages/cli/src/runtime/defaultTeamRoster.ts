import { platform } from '@platform/platform';
import { seedRosterFromDefaultTeam } from '@controllers/onboarding/defaultTeamSeeding';
import { toErrorMessage } from '@common/errors/errorMessage';
import { WorkspaceStateKey } from '@shared/state/stateKeys';

import { writeTextStderr } from './logSinks';

/**
 * Single CLI policy for roster seeding. Seeds this workspace's roster only from
 * an explicitly-recorded default team (the setup agent's `apply_team`);
 * otherwise it leaves every agent enabled (`fallbackTeamId: null`) so a fresh
 * terminal session exposes the full catalog — unlike the VS Code extension,
 * which falls back to the Physicist team.
 *
 * Best-effort and resilient: a broken state store or registry must not crash
 * chat startup / `texra init`, so failures are caught and surfaced on stderr.
 */
export async function seedCliRosterFromDefaultTeam(): Promise<boolean> {
  try {
    return await seedRosterFromDefaultTeam(
      {
        globalState: platform().globalState,
        workspaceState: platform().workspaceState,
      },
      { fallbackTeamId: null },
    );
  } catch (error: unknown) {
    writeTextStderr(
      `Note: couldn't seed the agent roster from your default team (${toErrorMessage(error)}). Pick agents in Settings or re-run the setup agent.`,
    );
    return false;
  }
}

export async function clearCliSeededRoster(): Promise<void> {
  const { workspaceState } = platform();
  await Promise.all([
    workspaceState.update(WorkspaceStateKey.ENABLED_AGENTS, undefined),
    workspaceState.update(WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS, undefined),
  ]);
}
