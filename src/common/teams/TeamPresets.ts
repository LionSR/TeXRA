/** The team preset catalog every roster, launch and settings path reads. */
import {
  AGENT_MODE_PRESETS,
  parseAgentModePresets,
  STARTER_AGENT_MODE_PRESET,
  type AgentModePreset,
} from '@shared/schemas';

type TeamPresetSource = 'built-in' | 'custom';

export interface TeamPreset extends AgentModePreset {
  readonly source: TeamPresetSource;
  /** The setup starter: a roster a workspace can select, never a launch. */
  readonly setupOnly?: true;
}

/**
 * The one team preset catalog, in display order: the setup starter (tagged
 * `setupOnly`), the built-in teams, then the workspace's custom presets.
 * Built-in ids are reserved: a custom preset with the same id is dropped so
 * the built-in always wins.
 */
export function teamPresets(customRaw: unknown): TeamPreset[] {
  const builtIns: TeamPreset[] = [
    { ...STARTER_AGENT_MODE_PRESET, source: 'built-in', setupOnly: true },
    ...AGENT_MODE_PRESETS.map((preset) => ({
      ...preset,
      source: 'built-in' as const,
    })),
  ];
  const builtInIds = new Set(builtIns.map((preset) => preset.id));
  return [
    ...builtIns,
    ...parseAgentModePresets(customRaw)
      .filter((preset) => !builtInIds.has(preset.id))
      .map((preset) => ({ ...preset, source: 'custom' as const })),
  ];
}

/** The catalog's launchable teams: every preset but the setup starter. */
export function launchableTeamPresets(customRaw: unknown): TeamPreset[] {
  return teamPresets(customRaw).filter((preset) => !preset.setupOnly);
}

export function findTeamPreset(
  presets: readonly TeamPreset[],
  query: string,
): TeamPreset | undefined {
  const key = lookupKey(query);
  return presets.find(
    (preset) =>
      lookupKey(preset.id) === key ||
      lookupKey(preset.name) === key ||
      slugKey(preset.name) === key,
  );
}

function lookupKey(value: string): string {
  return value.trim().toLowerCase();
}

function slugKey(value: string): string {
  return lookupKey(value).replaceAll(/\s+/g, '-');
}
