import { platform } from '@platform/platform';
import { seedRosterFromDefaultTeam } from '@controllers/onboarding/defaultTeamSeeding';
import { loadAgents } from '@agent/index';
import { toErrorMessage } from '@common/errors/errorMessage';

import { writeTextStderr } from './logSinks';

export async function seedCliRosterFromDefaultTeam(): Promise<boolean> {
  try {
    await loadAgents({ includeRemote: false });
    return await seedRosterFromDefaultTeam({
      globalState: platform().globalState,
      workspaceState: platform().workspaceState,
    });
  } catch (error: unknown) {
    writeTextStderr(
      `Note: couldn't seed the agent roster from your default team (${toErrorMessage(error)}). Pick agents in Settings or re-run the setup agent.`,
    );
    return false;
  }
}
