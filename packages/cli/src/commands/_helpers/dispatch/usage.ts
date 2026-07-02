import { renderUsage } from 'citty';
import stripAnsi from 'strip-ansi';

import { writeRawStderr, writeRawStdout } from '@cli/runtime/logSinks';
import { readCliAmbientState } from '@cli/runtime/cliContext';

import { resolveCommandMeta, type AnyCommand } from './commandTree';
import { knownGlobalFlagTokenCount } from './argTokens';

export interface UsageSection {
  readonly title: string;
  readonly rows: readonly (readonly [label: string, description: string])[];
}

interface UsageRenderContext {
  readonly parentPath?: readonly string[];
  readonly rootCommand?: AnyCommand;
}

const usageSections = new WeakMap<AnyCommand, readonly UsageSection[]>();

let usageColorOverride: boolean | undefined;

export function hasUsageNoColorFlag(rawArgs: readonly string[]): boolean {
  for (let index = 0; index < rawArgs.length;) {
    const arg = rawArgs[index];
    if (arg === undefined || arg === '--') return false;
    if (arg === '--no-color') return true;

    const tokenCount = knownGlobalFlagTokenCount(rawArgs, index);
    index += tokenCount ?? 1;
  }
  return false;
}

export function setUsageColorOverrideFromRawArgs(
  rawArgs: readonly string[],
): void {
  usageColorOverride = hasUsageNoColorFlag(rawArgs) ? false : undefined;
}

export function withUsageSections<T extends AnyCommand>(
  command: T,
  sections: readonly UsageSection[],
): T {
  usageSections.set(command, sections);
  return command;
}

function formatUsageSection(section: UsageSection): string {
  if (section.rows.length === 0) return section.title;
  const labelWidth = Math.max(...section.rows.map(([label]) => label.length));
  return [
    section.title,
    '',
    ...section.rows.map(
      ([label, description]) => `  ${label.padEnd(labelWidth)}  ${description}`,
    ),
  ].join('\n');
}

function usageColorEnabled(stream: 'stdout' | 'stderr'): boolean | undefined {
  if (usageColorOverride !== undefined) return usageColorOverride;
  const ambient = readCliAmbientState();
  return stream === 'stdout'
    ? ambient.stdoutColorEnabled
    : ambient.stderrColorEnabled;
}

async function usageParentWithFullPath(
  parent: AnyCommand | undefined,
  context: UsageRenderContext | undefined,
): Promise<AnyCommand | undefined> {
  if (!parent || !context?.parentPath || context.parentPath.length <= 1) {
    return parent;
  }

  const [parentMeta, rootMeta] = await Promise.all([
    resolveCommandMeta(parent),
    context.rootCommand ? resolveCommandMeta(context.rootCommand) : undefined,
  ]);
  return {
    ...parent,
    meta: {
      ...parentMeta,
      name: context.parentPath.join(' '),
      version: parentMeta.version ?? rootMeta?.version,
    },
  };
}

async function renderUsageWithSections(
  cmd: AnyCommand,
  parent?: AnyCommand,
  context?: UsageRenderContext,
  stream: 'stdout' | 'stderr' = 'stdout',
): Promise<string> {
  const usage = await renderUsage(
    cmd,
    await usageParentWithFullPath(parent, context),
  );
  const sections = usageSections.get(cmd);
  const usageWithSections = sections?.length
    ? `${usage}\n${sections.map(formatUsageSection).join('\n\n')}`
    : usage;
  return usageColorEnabled(stream) === false
    ? stripAnsi(usageWithSections)
    : usageWithSections;
}

/**
 * Render usage text to STDERR (the diagnostic stream) instead of citty's
 * `showUsage`, which prints to STDOUT via `consola.log`. Usage shown because of
 * a usage error must not pollute STDOUT — otherwise `--output-format json|ndjson`
 * stops being machine-parseable (`texra run ... --output-format json | jq`).
 *
 * `renderUsage` is citty's string-returning primitive (it does not write
 * anywhere), so we own the destination. Explicit `--help` keeps using
 * `showUsage` (STDOUT) per Unix convention.
 */
export async function showUsageStderr(
  cmd: AnyCommand,
  parent?: AnyCommand,
  context?: UsageRenderContext,
): Promise<void> {
  writeRawStderr(
    `${await renderUsageWithSections(cmd, parent, context, 'stderr')}\n`,
  );
}

export async function showUsage(
  cmd: AnyCommand,
  parent?: AnyCommand,
  context?: UsageRenderContext,
): Promise<void> {
  writeRawStdout(`${await renderUsageWithSections(cmd, parent, context)}\n\n`);
}
