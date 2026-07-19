/** Stateless YAML scanning for the agent registry. */

import { glob } from 'glob';
import pMap from 'p-map';

import { mergeInheritedAgentObject } from '@agent/core/definition/agentDefinitionInheritance';
import {
  AgentCategory,
  AgentDefinitionSchema,
  AgentWorkflowSettingSchema,
  type AgentDefinition,
} from '@agent/core/definition/AgentDataclass';
import { parseYamlWith } from '@common/parsing/safeParseYaml';
import * as logger from '@logger/logUtils';
import type { AgentSource } from '@shared/schemas/agent';
import { AbsoluteFS } from '@utils/files';
import { filterNotNull } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { LEGACY_AGENT_ALIASES } from './agentRegistryConstants';
import type { AgentEntry } from './agentEntry';

const CHANNEL = 'agentRegistry';
const INVALID_WORKFLOW_ROUNDS = Number.NaN;

interface ParsedAgentYaml {
  readonly name: string;
  readonly path: string;
  readonly definition: AgentDefinition;
}

/**
 * Extract tool names from raw YAML tool configs.
 * Tools can be plain strings ("web_search") or objects ({ name: "web_search", ... }).
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
      await pMap(files, (file) => readYamlDefinition(file), { concurrency: 8 })
    ).filter(filterNotNull);
    const unique = entriesWithUniqueNames(parsed);
    const definitions = new Map(
      unique.map((entry) => [entry.name, entry] as const),
    );
    const entries = unique
      .map((entry) => scanYaml(entry, source, definitions))
      .filter(filterNotNull);

    logger.debug(CHANNEL, `Scanned ${entries.length} agents from ${source}`);
    return entries;
  } catch (err) {
    logger.error(CHANNEL, `Failed to scan ${dir}: ${toErrorMessage(err)}`);
    return [];
  }
}

function entriesWithUniqueNames(
  entries: readonly ParsedAgentYaml[],
): ParsedAgentYaml[] {
  const byName = new Map<string, ParsedAgentYaml[]>();
  for (const entry of entries) {
    const matches = byName.get(entry.name);
    if (matches) {
      matches.push(entry);
    } else {
      byName.set(entry.name, [entry]);
    }
  }

  const unique: ParsedAgentYaml[] = [];
  for (const [name, matches] of byName) {
    const only = matches.at(0);
    if (matches.length === 1 && only) {
      unique.push(only);
      continue;
    }

    const paths = matches.map((entry) => entry.path).join(', ');
    logger.warn(
      CHANNEL,
      `Duplicate agent name "${name}" in ${paths}; skipping all duplicates.`,
    );
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
      logger.warn(
        CHANNEL,
        `Failed to scan ${yamlPath}: ${toErrorMessage(parsed.error)}`,
      );
      return null;
    }
    return {
      name: parsed.value.name,
      path: yamlPath,
      definition: parsed.value,
    };
  } catch (err) {
    logger.warn(CHANNEL, `Failed to scan ${yamlPath}: ${toErrorMessage(err)}`);
    return null;
  }
}

type InheritedBlockName = 'prompts' | 'settings';

interface InheritedDefinitionBlock {
  readonly value: Record<string, unknown>;
  readonly complete: boolean;
}

function parentDefinition(
  parentName: string,
  definitions: Map<string, ParsedAgentYaml>,
): ParsedAgentYaml | undefined {
  return (
    definitions.get(parentName) ??
    definitions.get(LEGACY_AGENT_ALIASES[parentName] ?? '')
  );
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

  const parent = parentDefinition(parentName, definitions);
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

function userRequestTemplateCount(rawPrompts: Record<string, unknown>): number {
  const userRequest = rawPrompts.userRequest;
  if (Array.isArray(userRequest)) return userRequest.length;
  return typeof userRequest === 'string' && userRequest ? 1 : 0;
}

function scanYaml(
  entry: ParsedAgentYaml,
  source: AgentSource,
  definitions: Map<string, ParsedAgentYaml>,
): AgentEntry | null {
  try {
    const validated = entry.definition;

    // Extract lightweight metadata
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

    // Determine category from source or explicit setting
    const rawCategory = rawSettings.agentCategory as string | undefined;
    const category =
      source === 'builtInToolUse' || rawCategory === AgentCategory.ToolUse
        ? AgentCategory.ToolUse
        : AgentCategory.Workflow;

    const internal = rawSettings.internal === true || undefined;
    let rounds: number | undefined;
    if (
      category === AgentCategory.Workflow &&
      settingsBlock.complete &&
      promptsBlock.complete
    ) {
      const parsedRounds = AgentWorkflowSettingSchema.shape.rounds
        .catch(INVALID_WORKFLOW_ROUNDS)
        .parse(rawSettings.rounds);
      if (!Number.isNaN(parsedRounds)) {
        rounds = Math.max(parsedRounds, userRequestTemplateCount(rawPrompts));
      }
    }

    return {
      name: entry.name,
      source,
      path: entry.path,
      category,
      description: validated.description,
      tools: tools?.length ? tools : undefined,
      defaultOutputFiles: defaultOutputFiles?.length
        ? defaultOutputFiles
        : undefined,
      rounds,
      internal,
    };
  } catch (err) {
    logger.warn(
      CHANNEL,
      `Failed to scan ${entry.path}: ${toErrorMessage(err)}`,
    );
    return null;
  }
}
