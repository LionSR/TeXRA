/**
 * The agents installed plugins contribute: Claude Code subagent files
 * (`agents/<name>.md`, YAML frontmatter with `name`, `description` and
 * `tools`, the body its system prompt), read as agents of source
 * `plugin` named `<plugin>:<name>`. TeXRA defines no agent format for them;
 * each file is read here, at the boundary, and nowhere else.
 */
// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Result } from 'effect';
import { z } from 'zod';

// Local imports - common
import { PersonaSchema } from '@agent/core/definition/AgentDataclass';
import {
  readInstalledPluginLoad,
  type InstalledPluginLoad,
} from '@common/plugins/pluginTrust';
import { splitFrontmatterFence } from '@common/parsing/frontmatterFence';
import { parseYamlWith } from '@common/parsing/safeParseYaml';
import { withLogChannel } from '@logger/effectLog';
import { AppState } from '@platform/interfaces';
import { AgentNameSchema } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { readNormalizedFile } from '@utils/files/fsDurability';

// Local imports - this module's neighbours
import type { AgentEntry } from './agentEntry';

/** A subagent's frontmatter; `tools` is a comma-separated list or a list. */
const SubagentFrontmatterSchema = z.object({
  name: AgentNameSchema.optional(),
  description: z.string().optional(),
  tools: z.union([z.string(), z.array(z.string())]).optional(),
});

/** Claude Code's tool names, as the TeXRA tools that do the same. */
const CLAUDE_CODE_TOOLS: Readonly<Record<string, string>> = {
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'edit_file',
  MultiEdit: 'edit_file',
  Bash: 'bash',
  Glob: 'glob',
  Grep: 'grep',
  WebFetch: 'web_fetch',
  WebSearch: 'web_search',
};

/** What a top-level run of a plugin agent that names no tools inherits,
 *  beside the installed plugins' tools (a child inherits its parent's
 *  offered tools instead): the file, shell and web tools. */
export const PLUGIN_AGENT_DEFAULT_TOOLS = [
  'read_file',
  'write_file',
  'edit_file',
  'bash',
  'glob',
  'grep',
  'web_fetch',
  'web_search',
];

/** One plugin agent as its file defines it. */
interface PluginAgent {
  readonly name: string;
  readonly description?: string;
  /** The tools it names, as TeXRA's; `undefined` when it names none and
   *  inherits them (`AgentRun`). */
  readonly tools: readonly string[] | undefined;
  readonly systemPrompt: string;
  /** Tools the file names that TeXRA has no counterpart for. */
  readonly dropped: readonly string[];
}

/** Read the subagent file `file` of plugin `plugin`. */
const readPluginAgent = Effect.fn('pluginAgents.read')(function* (
  file: string,
  plugin: string,
) {
  const content = yield* readNormalizedFile(
    yield* FileSystem.FileSystem,
    file,
  ).pipe(Effect.mapError((error) => new Error(error.message)));
  const split = splitFrontmatterFence(content);
  if (split.kind !== 'ok')
    return yield* Effect.fail(
      new Error(`${file} must start with YAML frontmatter (---).`),
    );
  const parsed = parseYamlWith(
    split.frontmatterText,
    SubagentFrontmatterSchema,
  );
  if (Result.isFailure(parsed))
    return yield* Effect.fail(
      new Error(`${file}: ${toErrorMessage(parsed.failure)}`),
    );
  const systemPrompt = split.body.trim();
  if (!systemPrompt)
    return yield* Effect.fail(new Error(`${file} has no system prompt.`));
  const declared =
    parsed.success.tools === undefined
      ? undefined
      : [parsed.success.tools]
          .flat()
          .flatMap((entry) => entry.split(','))
          .map((entry) => entry.trim())
          .filter(Boolean);
  const mapped = (declared ?? []).map((tool) =>
    tool.startsWith('mcp__') ? tool : CLAUDE_CODE_TOOLS[tool],
  );
  // Naming only tools TeXRA lacks must not read as naming none, which
  // would widen the agent to everything it inherits.
  if (
    declared !== undefined &&
    declared.length > 0 &&
    mapped.every((t) => t === undefined)
  )
    return yield* Effect.fail(
      new Error(
        `${file} names only tools TeXRA does not have (${declared.join(', ')}).`,
      ),
    );
  return {
    name: `${plugin}:${parsed.success.name ?? path.basename(file, '.md')}`,
    description: parsed.success.description,
    tools:
      declared === undefined || declared.length === 0
        ? undefined
        : [...new Set(mapped.filter((tool) => tool !== undefined))],
    systemPrompt,
    dropped: (declared ?? []).filter((_, index) => mapped[index] === undefined),
  } satisfies PluginAgent;
});

/**
 * A plugin agent runs only while its plugin loads (enabled, and trusted as it
 * is). The catalog that listed it may predate a change another host made, so
 * the launch asks again and refuses, saying why, if it no longer does.
 */
export const requirePluginAgentLoads = (
  entry: AgentEntry,
  load: InstalledPluginLoad,
): Effect.Effect<void, Error> => {
  const plugin = entry.name.slice(0, entry.name.indexOf(':'));
  return load.loadable.some(({ record }) => record.name === plugin)
    ? Effect.void
    : Effect.fail(
        new Error(
          `Agent ${entry.name} does not run: ${
            load.withheld.find((reason) =>
              reason.startsWith(`Plugin ${plugin} `),
            ) ?? `plugin ${plugin} is not installed or not enabled.`
          }`,
        ),
      );
};

/** The catalog entry of a plugin agent read from `file`. */
function pluginAgentEntry(agent: PluginAgent, file: string): AgentEntry {
  return {
    name: agent.name,
    source: 'plugin',
    path: file,
    description: agent.description,
    tools: agent.tools === undefined ? undefined : [...agent.tools],
    // None named: `AgentRun` gives it what it inherits. The task arrives as
    // the user message, as a Claude Code subagent's does.
    persona: PersonaSchema.parse({
      prompt: agent.systemPrompt,
      tools: agent.tools ?? [],
    }),
    task: null,
  };
}

/**
 * The catalog entries of the agents of the installed plugins that load now
 * (enabled, and trusted as they are). A file that does not read is no entry,
 * and a tool a file names that TeXRA has no counterpart for is dropped; both
 * are logged.
 */
export const scanPluginAgents = Effect.gen(function* () {
  const { loadable } = yield* readInstalledPluginLoad({
    globalState: yield* AppState,
  });
  const entries: AgentEntry[] = [];
  for (const { record, plugin } of loadable) {
    for (const relative of plugin.agents) {
      const file = path.join(record.path, relative);
      const read = yield* Effect.result(readPluginAgent(file, record.name));
      if (Result.isFailure(read)) {
        yield* Effect.logWarning(
          `Plugin agent ${file} is not loaded: ${read.failure.message}`,
        ).pipe(withLogChannel('agentRegistry'));
        continue;
      }
      const agent = read.success;
      if (agent.dropped.length > 0)
        yield* Effect.logWarning(
          `Agent ${agent.name} names tools TeXRA does not have, which it is not offered: ${agent.dropped.join(', ')}.`,
        ).pipe(withLogChannel('agentRegistry'));
      entries.push(pluginAgentEntry(agent, file));
    }
  }
  return entries;
});
