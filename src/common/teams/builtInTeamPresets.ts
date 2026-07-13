// Local imports
import {
  AGENT_MODE_PRESETS_BY_ID,
  STARTER_AGENT_MODE_PRESET,
  type AgentModePreset,
} from '@shared/schemas/agentPresets';

/** Resolve a built-in team id, including the hidden starter team. */
export function resolveBuiltInTeamPreset(
  teamId: string,
): AgentModePreset | undefined {
  if (teamId === STARTER_AGENT_MODE_PRESET.id) return STARTER_AGENT_MODE_PRESET;
  return AGENT_MODE_PRESETS_BY_ID.get(teamId);
}
