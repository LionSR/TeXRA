import { Effect } from 'effect';

// Local imports
import {
  buildToolDashboardItems,
  isToolPluginVisible,
} from '@controllers/settingsView/ToolDashboardData';
import type { StateStore } from '@platform/interfaces';
import type { ToolDashboardItem } from '@shared/settingsView/settingsViewMessages';
import { findToolPlugin, type ToolPlugin } from '@tools/plugins';
import type { ToolProbeInputs } from '@tools/toolProbes';
import { setToolEnabled } from '@utils/config/constants';

type CliToolGuideKind = 'install' | 'auth';

export interface CliToolGuide {
  readonly text: string;
  readonly command?: string;
}

/**
 * The external integrations `texra tools` manages: the shared dashboard
 * projection for the CLI host, minus the built-in groups that need no setup.
 *
 * The calling surface runs this on the process runtime its composition root
 * installed, so the disabled-tool read inside the builder (`AppState`) and the
 * toggle that follows it hit the same store. `probeInputs` is the `--cwd`
 * project the same init opened and its configuration, carried as data for the
 * probes that need them.
 */
export function readCliToolStatuses(probeInputs: ToolProbeInputs) {
  return Effect.map(buildToolDashboardItems('cli', probeInputs), (items) =>
    items.filter((item) => item.requiresSetup),
  );
}

export function readCliToolStatus(probeInputs: ToolProbeInputs, id: string) {
  return Effect.map(readCliToolStatuses(probeInputs), (items) =>
    items.find((item) => item.id === id),
  );
}

/** A probed plugin the CLI's dashboard lists; built-in plugins need no setup. */
function findCliToolDef(id: string): ToolPlugin | undefined {
  const def = findToolPlugin(id);
  return def?.availability && isToolPluginVisible(def, 'cli') ? def : undefined;
}

export function readCliToolGuide(
  id: string,
  kind: CliToolGuideKind,
): CliToolGuide | undefined {
  const def = findCliToolDef(id);
  if (!def) return undefined;

  if (kind === 'install') {
    const lines = [def.installGuide ?? def.configNotes ?? 'No install guide.'];
    if (def.installCommand) {
      lines.push('', `Command: ${def.installCommand}`);
    }
    if (def.installUrl) {
      lines.push(`URL: ${def.installUrl}`);
    }
    return { text: lines.join('\n'), command: def.installCommand };
  }

  const lines = [def.authNote ?? def.configNotes ?? 'No auth guide.'];
  if (def.authCommand) {
    lines.push('', `Command: ${def.authCommand}`);
  }
  return { text: lines.join('\n'), command: def.authCommand };
}

export function setCliToolEnabled(
  state: StateStore,
  id: string,
  enabled: boolean,
) {
  const def = findCliToolDef(id);
  if (!def?.toggleable) return Effect.succeed(false);
  return Effect.as(setToolEnabled(id, enabled, state), true);
}

/**
 * The raw dependency probe outcome behind a dashboard status: `null` only when
 * the probe itself failed, which is the one case the status carries no yes/no
 * answer about the dependency.
 */
export function cliToolDetected(item: ToolDashboardItem): boolean | null {
  return item.status === 'unknown' ? null : item.status === 'available';
}

/** The toggle state, or `null` for a group that cannot be toggled. */
export function cliToolEnabled(item: ToolDashboardItem): boolean | null {
  return item.toggleable === true ? (item.enabled ?? null) : null;
}

function cliToolCommand(
  item: ToolDashboardItem,
  kind: 'command' | 'auth',
): string | undefined {
  for (const action of item.installActions) {
    if (action.kind === kind) return action.command;
  }
  return undefined;
}

function cliToolNote(item: ToolDashboardItem): string {
  const installCommand = cliToolCommand(item, 'command');
  if (cliToolDetected(item) === false && installCommand) return installCommand;
  return (
    item.statusLabel ??
    item.authNote ??
    item.configNotes ??
    installCommand ??
    ''
  );
}

function formatCliBoolean(value: boolean | null): string {
  if (value == null) return '-';
  return value ? 'yes' : 'no';
}

export function formatCliToolNotFoundMessage(id: string): string {
  return `Tool integration not found: ${id}`;
}

export function formatCliToolNotToggleableMessage(id: string): string {
  return `Tool integration is not toggleable: ${id}`;
}

export function formatCliToolMissingInstallCommandMessage(id: string): string {
  return `No install command is registered for ${id}.`;
}

export function formatCliToolList(items: readonly ToolDashboardItem[]): string {
  if (items.length === 0) return 'No external tools found.';
  const header = 'ID\tNAME\tCATEGORY\tENABLED\tDETECTED\tNOTE';
  const rows = items.map((item) =>
    [
      item.id,
      item.name,
      item.category,
      formatCliBoolean(cliToolEnabled(item)),
      formatCliBoolean(cliToolDetected(item)),
      cliToolNote(item),
    ].join('\t'),
  );
  return [header, ...rows].join('\n');
}

export function formatCliToolStatus(item: ToolDashboardItem): string {
  const installCommand = cliToolCommand(item, 'command');
  const authCommand = cliToolCommand(item, 'auth');
  const note = cliToolNote(item);
  const lines: string[] = [
    `id: ${item.id}`,
    `name: ${item.name}`,
    `category: ${item.category}`,
    `status: ${item.status}`,
    `enabled: ${formatCliBoolean(cliToolEnabled(item))}`,
    `detected: ${formatCliBoolean(cliToolDetected(item))}`,
  ];
  if (item.statusLabel) lines.push(`statusLabel: ${item.statusLabel}`);
  if (note) lines.push(`note: ${note}`);
  if (installCommand) lines.push(`installCommand: ${installCommand}`);
  if (authCommand) lines.push(`authCommand: ${authCommand}`);
  if (item.statusDetail) {
    lines.push('', item.statusDetail);
  }
  return lines.join('\n');
}
