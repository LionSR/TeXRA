import { platform } from '@platform/platform';
import { WorkspaceStateKey } from '@common/state/stateKeys';
import {
  AGENT_MODE_PRESETS,
  AgentModePresetSchema,
  type AgentModePreset,
} from '@shared/schemas/agentPresets';

export type CliMultiAgentPresetSource = 'built-in' | 'custom';

export interface CliMultiAgentPreset extends AgentModePreset {
  readonly source: CliMultiAgentPresetSource;
}

export function parseCliCustomAgentPresets(raw: unknown): AgentModePreset[] {
  return AgentModePresetSchema.array().catch([]).parse(raw);
}

export function readCliMultiAgentPresets(): CliMultiAgentPreset[] {
  const customRaw = platform().workspaceState.get<unknown>(
    WorkspaceStateKey.CUSTOM_AGENT_PRESETS,
  );
  return cliMultiAgentPresets(customRaw);
}

export function cliMultiAgentPresets(
  customRaw: unknown,
): CliMultiAgentPreset[] {
  return [
    ...AGENT_MODE_PRESETS.map((preset) => withSource(preset, 'built-in')),
    ...parseCliCustomAgentPresets(customRaw).map((preset) =>
      withSource(preset, 'custom'),
    ),
  ];
}

export function findCliMultiAgentPreset(
  presets: readonly CliMultiAgentPreset[],
  query: string,
): CliMultiAgentPreset | undefined {
  const key = lookupKey(query);
  return presets.find(
    (preset) =>
      lookupKey(preset.id) === key ||
      lookupKey(preset.name) === key ||
      slugKey(preset.name) === key,
  );
}

export function formatCliMultiAgentPresetList(
  presets: readonly CliMultiAgentPreset[],
): string {
  if (presets.length === 0) return 'No multi-agent presets found.';

  return presets
    .map((preset) =>
      [
        preset.source,
        preset.id,
        preset.name,
        `workflow:${preset.workflowAgents.length}`,
        `tool-use:${preset.toolUseAgents.length}`,
      ].join('\t'),
    )
    .join('\n');
}

export function formatCliMultiAgentPresetDetails(
  preset: CliMultiAgentPreset,
): string {
  return [
    `${preset.name} (${preset.id})`,
    `Source: ${preset.source}`,
    `Description: ${preset.description}`,
    'Workflow agents:',
    formatAgentNames(preset.workflowAgents),
    'Tool-use agents:',
    formatAgentNames(preset.toolUseAgents),
  ].join('\n');
}

export function cliMultiAgentPresetNdjsonRecords(
  presets: readonly CliMultiAgentPreset[],
): unknown[] {
  const ts = new Date().toISOString();
  return presets.map((preset) => ({
    kind: 'multi-agent-preset',
    ts,
    preset,
  }));
}

function withSource(
  preset: AgentModePreset,
  source: CliMultiAgentPresetSource,
): CliMultiAgentPreset {
  return { ...preset, source };
}

function formatAgentNames(names: readonly string[]): string {
  if (names.length === 0) return '  (none)';
  return names.map((name) => `  ${name}`).join('\n');
}

function lookupKey(value: string): string {
  return value.trim().toLowerCase();
}

function slugKey(value: string): string {
  return lookupKey(value).replaceAll(/\s+/g, '-');
}
