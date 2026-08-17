// Local imports
import {
  EXTERNAL_TOOL_DEFS,
  type ExternalToolDef,
} from '@tools/externalToolDefs';
import { runExternalToolChecks } from '@tools/toolAvailability';
import { isDefaultToolUnavailableOnHost } from '@tools/registry';
import { getDisabledToolIds, setToolEnabled } from '@utils/config/constants';

export interface CliToolStatusRecord {
  readonly id: string;
  readonly name: string;
  readonly category: string;
  readonly enabled: boolean | null;
  readonly detected: boolean | null;
  readonly status: string;
  readonly statusLabel?: string;
  readonly statusDetail?: string;
  readonly toggleable: boolean;
  readonly comingSoon: boolean;
  readonly installCommand?: string;
  readonly authCommand?: string;
  readonly note?: string;
}

type CliToolGuideKind = 'install' | 'auth';

export interface CliToolGuide {
  readonly text: string;
  readonly command?: string;
}

function getCliToolDefs(): ExternalToolDef[] {
  return EXTERNAL_TOOL_DEFS.filter(
    (def) =>
      !def.hideFromDashboard &&
      !def.hideFromCli &&
      !(
        def.tools.length > 0 &&
        def.tools.every((name) => isDefaultToolUnavailableOnHost(name, 'cli'))
      ),
  );
}

function detectedFromStatus(status: string): boolean | null {
  if (status === 'available') return true;
  if (status === 'not-found') return false;
  return null;
}

function noteForTool(
  def: ExternalToolDef,
  detected: boolean | null,
  statusLabel?: string,
): string {
  if (detected === false && def.installCommand) return def.installCommand;
  return (
    statusLabel ?? def.authNote ?? def.configNotes ?? def.installCommand ?? ''
  );
}

export async function readCliToolStatuses(): Promise<CliToolStatusRecord[]> {
  const checks = new Map((await runExternalToolChecks()).map((r) => [r.id, r]));
  const disabledIds = getDisabledToolIds();

  return getCliToolDefs().map((def) => {
    const check = checks.get(def.id);
    const comingSoon = def.comingSoon === true;
    const toggleable = def.toggleable === true;
    const status = check?.status ?? (comingSoon ? 'coming-soon' : 'unknown');
    const detected = check?.detected ?? detectedFromStatus(status);
    return {
      id: def.id,
      name: def.name,
      category: def.category,
      enabled: toggleable ? !disabledIds.has(def.id) : null,
      detected,
      status,
      statusLabel: check?.statusLabel,
      statusDetail: check?.statusDetail,
      toggleable,
      comingSoon,
      installCommand: def.installCommand,
      authCommand: def.authCommand,
      note: noteForTool(def, detected, check?.statusLabel),
    };
  });
}

export async function readCliToolStatus(
  id: string,
): Promise<CliToolStatusRecord | undefined> {
  return (await readCliToolStatuses()).find((record) => record.id === id);
}

export function findCliToolDef(id: string): ExternalToolDef | undefined {
  return getCliToolDefs().find((def) => def.id === id);
}

export function cliToolIds(): string[] {
  return getCliToolDefs().map((def) => def.id);
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

export async function setCliToolEnabled(
  id: string,
  enabled: boolean,
): Promise<boolean> {
  const def = findCliToolDef(id);
  if (!def?.toggleable) return false;
  await setToolEnabled(id, enabled);
  return true;
}

export function formatCliBoolean(value: boolean | null): string {
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

export function formatCliToolList(
  records: readonly CliToolStatusRecord[],
): string {
  if (records.length === 0) return 'No external tools found.';
  const header = 'ID\tNAME\tCATEGORY\tENABLED\tDETECTED\tNOTE';
  const rows = records.map((record) =>
    [
      record.id,
      record.name,
      record.category,
      formatCliBoolean(record.enabled),
      formatCliBoolean(record.detected),
      record.note ?? '',
    ].join('\t'),
  );
  return [header, ...rows].join('\n');
}

export function formatCliToolStatus(record: CliToolStatusRecord): string {
  const lines: string[] = [
    `id: ${record.id}`,
    `name: ${record.name}`,
    `category: ${record.category}`,
    `status: ${record.status}`,
    `enabled: ${formatCliBoolean(record.enabled)}`,
    `detected: ${formatCliBoolean(record.detected)}`,
  ];
  if (record.statusLabel) lines.push(`statusLabel: ${record.statusLabel}`);
  if (record.note) lines.push(`note: ${record.note}`);
  if (record.installCommand)
    lines.push(`installCommand: ${record.installCommand}`);
  if (record.authCommand) lines.push(`authCommand: ${record.authCommand}`);
  if (record.statusDetail) {
    lines.push('', record.statusDetail);
  }
  return lines.join('\n');
}
