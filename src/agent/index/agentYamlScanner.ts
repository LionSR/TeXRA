/** Stateless YAML scanning for the agent registry. */

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
import { AgentCategory } from '@shared/schemas';
import type { AgentSource } from '@shared/schemas/agent';
import { filterNotNull, groupBy } from '@utils/core';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { AgentEntry } from './agentEntry';

const log = createLog('agentRegistry');

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
): Promise<AgentEntry[]> {
  if (!dir) return [];

  try {
    const files = (
      await glob('**/*.yaml', {
        cwd: dir,
        absolute: true,
        nodir: true,
      })
    ).toSorted();
    const parsed = (
      await pMap(files, readYamlDefinition, { concurrency: 8 })
    ).filter(filterNotNull);
    const unique = entriesWithUniqueNames(parsed);
    const definitions = new Map(
      unique.map((entry) => [entry.name, entry] as const),
    );
    const entries = unique
      .map((entry) => scanYaml(entry, source, definitions))
      .filter(filterNotNull);

    log.debug(`Scanned ${entries.length} agents from ${source}`);
    return entries;
  } catch (err) {
    log.error(`Failed to scan ${dir}: ${toErrorMessage(err)}`);
    return [];
  }
}

function entriesWithUniqueNames(
  entries: readonly ParsedAgentYaml[],
): ParsedAgentYaml[] {
  const byName = groupBy(entries, (entry) => entry.name);

  const unique: ParsedAgentYaml[] = [];
  for (const [name, matches] of byName) {
    if (matches.length > 1) {
      const paths = matches.map((entry) => entry.path).join(', ');
      log.warn(
        `Duplicate agent name "${name}" in ${paths}; skipping all duplicates.`,
      );
      continue;
    }
    unique.push(matches[0]);
  }
  return unique;
}

async function readYamlDefinition(
  yamlPath: string,
): Promise<ParsedAgentYaml | null> {
  try {
    const content = await AbsoluteFS.read(yamlPath);
    const parsed = parseYamlWith(content, AgentDefinitionSchema);
    if (parsed.isErr()) {
      log.warn(`Failed to scan ${yamlPath}: ${toErrorMessage(parsed.error)}`);
      return null;
    }
    return {
      name: parsed.value.name,
      path: yamlPath,
      definition: parsed.value,
    };
  } catch (err) {
    log.warn(`Failed to scan ${yamlPath}: ${toErrorMessage(err)}`);
    return null;
  }
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
): AgentEntry | null {
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
      | string[]
      | undefined;

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
    };
  } catch (err) {
    log.warn(`Failed to scan ${entry.path}: ${toErrorMessage(err)}`);
    return null;
  }
}
