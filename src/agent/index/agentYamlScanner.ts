/** Stateless YAML scanning for the agent registry. */

import * as path from 'node:path';
import { glob } from 'glob';
import * as yaml from 'yaml';

import {
  AgentCategory,
  AgentDefinitionSchema,
} from '@agent/core/definition/AgentDataclass';
import { toErrorMessage } from '@common/errors';
import * as logger from '@logger/logUtils';
import type { AgentSource } from '@shared/schemas/agent';
import { AbsoluteFS } from '@utils/files';
import { filterNotNull } from '@utils/core';
import type { AgentEntry } from './agentEntry';

const CHANNEL = 'agentRegistry';

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
    const files = await glob('**/*.yaml', {
      cwd: dir,
      absolute: true,
      nodir: true,
    });
    const entries = await Promise.all(
      files.map((f) => {
        const name = path.basename(f, '.yaml');
        return scanYaml(name, f, source);
      }),
    );

    const result = entries.filter(filterNotNull);
    logger.debug(CHANNEL, `Scanned ${result.length} agents from ${source}`);
    return result;
  } catch (err) {
    logger.error(CHANNEL, `Failed to scan ${dir}: ${toErrorMessage(err)}`);
    return [];
  }
}

async function scanYaml(
  name: string,
  yamlPath: string,
  source: AgentSource,
): Promise<AgentEntry | null> {
  try {
    const content = await AbsoluteFS.read(yamlPath);
    const parsed = yaml.parse(content);
    const validated = AgentDefinitionSchema.parse(parsed);

    // Extract lightweight metadata
    const rawSettings = (validated.settings ?? {}) as Record<string, unknown>;
    const defaultOutputFiles = rawSettings.defaultOutputFiles as
      | string[]
      | undefined;

    const tools = extractToolNames(rawSettings.tools as unknown[] | undefined);

    // Determine category from source or explicit setting
    const rawCategory = rawSettings.agentCategory as string | undefined;
    const category =
      source === 'builtInToolUse' || rawCategory === AgentCategory.ToolUse
        ? AgentCategory.ToolUse
        : AgentCategory.Workflow;

    const internal = rawSettings.internal === true || undefined;

    return {
      name,
      displayName: validated.displayName,
      source,
      path: yamlPath,
      category,
      description: validated.description,
      tools: tools?.length ? tools : undefined,
      defaultOutputFiles: defaultOutputFiles?.length
        ? defaultOutputFiles
        : undefined,
      internal,
    };
  } catch (err) {
    logger.warn(CHANNEL, `Failed to scan ${yamlPath}: ${toErrorMessage(err)}`);
    return null;
  }
}
