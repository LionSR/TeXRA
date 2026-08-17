/** Stateless YAML scanning for the agent registry. */

import * as path from 'node:path';

import { glob } from 'glob';
import pMap from 'p-map';

import { mergeInheritedAgentObject } from '@agent/core/definition/agentDefinitionInheritance';
import {
  AgentDefinitionSchema,
  AgentWorkflowSettingSchema,
  type AgentDefinition,
} from '@agent/core/definition/AgentDataclass';
import { parseYamlWith } from '@common/parsing/safeParseYaml';
import { createLog } from '@logger/logUtils';
import type { AgentSource } from '@shared/schemas';
import { AgentCategory } from '@shared/schemas';
import { groupBy, isObject } from '@utils/core';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { AgentEntry } from './agentEntry';

const log = createLog('agentRegistry');

/** A YAML file the scanner found but could not turn into an agent. */
export interface AgentScanIssue {
  readonly path: string;
  readonly message: string;
}

interface AgentDirectoryScan {
  readonly entries: AgentEntry[];
  readonly issues: AgentScanIssue[];
}

interface ParsedAgentYaml {
  readonly name: string;
  readonly path: string;
  readonly definition: AgentDefinition;
}

/**
 * Extract tool names from declared tool configs. An entry is a registry name,
 * or — for definitions registered as values — a whole tool definition.
 */
export function extractToolNames(
  rawTools: unknown[] | undefined,
): string[] | undefined {
  return rawTools?.flatMap((t) => {
    if (typeof t === 'string') return t;
    const name = (t as Record<string, unknown>)?.name;
    return typeof name === 'string' ? name : [];
  });
}

export async function scanDirectory(
  dir: string,
  source: AgentSource,
): Promise<AgentDirectoryScan> {
  if (!dir) return { entries: [], issues: [] };

  try {
    const files = (
      await glob('**/*.yaml', {
        cwd: dir,
        absolute: true,
        nodir: true,
      })
    ).toSorted();
    const issues: AgentScanIssue[] = [];
    const parsed: ParsedAgentYaml[] = [];
    for (const result of await pMap(
      files,
      (yamlPath) => readYamlDefinition(yamlPath, dir),
      { concurrency: 8 },
    )) {
      if (result.ok) parsed.push(result.value);
      else issues.push(result.issue);
    }
    const unique = entriesWithUniqueNames(parsed, dir, issues);
    const definitions = new Map(
      unique.map((entry) => [entry.name, entry] as const),
    );
    const entries: AgentEntry[] = [];
    for (const entry of unique) {
      const scanned = scanYaml(entry, source, definitions);
      if (scanned.ok) {
        entries.push(scanned.entry);
        continue;
      }
      issues.push({
        path: relativeScanPath(dir, entry.path),
        message: scanned.message,
      });
    }

    log.debug(`Scanned ${entries.length} agents from ${source}`);
    return { entries, issues };
  } catch (err) {
    const message = toErrorMessage(err);
    log.error(`Failed to scan ${dir}: ${message}`);
    return { entries: [], issues: [{ path: dir, message }] };
  }
}

function entriesWithUniqueNames(
  entries: readonly ParsedAgentYaml[],
  dir: string,
  issues: AgentScanIssue[],
): ParsedAgentYaml[] {
  const byName = groupBy(entries, (entry) => entry.name);

  const unique: ParsedAgentYaml[] = [];
  for (const [name, matches] of byName) {
    if (matches.length > 1) {
      const paths = matches.map((entry) => entry.path).join(', ');
      log.warn(
        `Duplicate agent name "${name}" in ${paths}; skipping all duplicates.`,
      );
      for (const match of matches) {
        issues.push({
          path: relativeScanPath(dir, match.path),
          message: `Duplicate agent name "${name}".`,
        });
      }
      continue;
    }
    unique.push(matches[0]);
  }
  return unique;
}

async function readYamlDefinition(
  yamlPath: string,
  dir: string,
): Promise<
  { ok: true; value: ParsedAgentYaml } | { ok: false; issue: AgentScanIssue }
> {
  const displayPath = relativeScanPath(dir, yamlPath);
  try {
    const content = await AbsoluteFS.read(yamlPath);
    const parsed = parseYamlWith(content, AgentDefinitionSchema);
    if (parsed.isErr()) {
      const message = formatScanFailure(parsed.error);
      log.warn(`Failed to scan ${yamlPath}: ${message}`);
      return { ok: false, issue: { path: displayPath, message } };
    }
    return {
      ok: true,
      value: {
        name: parsed.value.name,
        path: yamlPath,
        definition: parsed.value,
      },
    };
  } catch (err) {
    const message = formatScanFailure(err);
    log.warn(`Failed to scan ${yamlPath}: ${message}`);
    return { ok: false, issue: { path: displayPath, message } };
  }
}

function relativeScanPath(dir: string, yamlPath: string): string {
  const relative = path.relative(dir, yamlPath);
  return relative || yamlPath;
}

function formatScanFailure(error: unknown): string {
  if (isObject(error) && Array.isArray(error.issues)) {
    const formatted = error.issues
      .map((issue) => formatSchemaIssue(issue))
      .filter((part) => part.length > 0);
    if (formatted.length > 0) return formatted.join('; ');
  }
  return toErrorMessage(error);
}

function formatSchemaIssue(issue: unknown): string {
  if (!isObject(issue)) return '';
  const where = Array.isArray(issue.path) ? issue.path.join('.') : '';
  const prefix = where ? `${where}: ` : '';
  if (issue.code === 'unrecognized_keys' && Array.isArray(issue.keys)) {
    return `${prefix}unrecognized keys ${issue.keys.filter((key) => typeof key === 'string').join(', ')}`;
  }
  return typeof issue.message === 'string' && issue.message
    ? `${prefix}${issue.message}`
    : '';
}

type InheritedBlockName = 'prompts' | 'settings';

interface InheritedDefinitionBlock {
  readonly value: Record<string, unknown>;
  readonly complete: boolean;
}

function inheritedDefinitionBlock(
  entry: ParsedAgentYaml,
  definitions: Map<string, ParsedAgentYaml>,
  block: InheritedBlockName,
  seen: ReadonlySet<string> = new Set([entry.name]),
): InheritedDefinitionBlock {
  // definition[block] is a validated raw YAML block; widen to
  // Record<string, unknown> for the lightweight metadata extraction below.
  const ownBlock: Record<string, unknown> = entry.definition[
    block
  ] as unknown as Record<string, unknown>;
  const parentName = entry.definition.inherits;
  if (!parentName) return { value: ownBlock, complete: true };

  const parent = definitions.get(parentName);
  if (!parent || seen.has(parent.name)) {
    return { value: ownBlock, complete: false };
  }

  const inherited = inheritedDefinitionBlock(
    parent,
    definitions,
    block,
    new Set([...seen, parent.name]),
  );
  return {
    value: mergeInheritedAgentObject(inherited.value, ownBlock),
    complete: inherited.complete,
  };
}

/**
 * Round floor for a workflow agent: one round per `userRequest` template.
 * Shared with `inlineAgents` so a definition supplied as a value derives the
 * same round count as the identical definition read from a YAML file.
 */
export function userRequestTemplateCount(userRequest: unknown): number {
  if (Array.isArray(userRequest)) return userRequest.length;
  return typeof userRequest === 'string' && userRequest ? 1 : 0;
}

function scanYaml(
  entry: ParsedAgentYaml,
  source: AgentSource,
  definitions: Map<string, ParsedAgentYaml>,
): { ok: true; entry: AgentEntry } | { ok: false; message: string } {
  try {
    const settingsBlock = inheritedDefinitionBlock(
      entry,
      definitions,
      'settings',
    );
    const promptsBlock = inheritedDefinitionBlock(
      entry,
      definitions,
      'prompts',
    );
    const rawSettings = settingsBlock.value;
    const rawPrompts = promptsBlock.value;
    const defaultOutputFiles = rawSettings.defaultOutputFiles as
      string[] | undefined;

    const tools = extractToolNames(rawSettings.tools as unknown[] | undefined);

    const rawCategory = rawSettings.agentCategory as string | undefined;
    const category =
      source === 'builtInToolUse' || rawCategory === AgentCategory.ToolUse
        ? AgentCategory.ToolUse
        : AgentCategory.Workflow;

    let rounds: number | undefined;
    if (
      category === AgentCategory.Workflow &&
      settingsBlock.complete &&
      promptsBlock.complete
    ) {
      const parsedRounds = AgentWorkflowSettingSchema.shape.rounds.safeParse(
        rawSettings.rounds,
      );
      if (parsedRounds.success) {
        rounds = Math.max(
          parsedRounds.data,
          userRequestTemplateCount(rawPrompts.userRequest),
        );
      } else {
        log.warn(
          `Ignoring malformed rounds in ${entry.path}: ${toErrorMessage(parsedRounds.error)}`,
        );
      }
    }

    return {
      ok: true,
      entry: {
        name: entry.name,
        source,
        path: entry.path,
        category,
        description: entry.definition.description,
        tools: tools?.length ? tools : undefined,
        defaultOutputFiles: defaultOutputFiles?.length
          ? defaultOutputFiles
          : undefined,
        rounds,
      },
    };
  } catch (err) {
    log.warn(`Failed to scan ${entry.path}: ${toErrorMessage(err)}`);
    return { ok: false, message: toErrorMessage(err) };
  }
}
