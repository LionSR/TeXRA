/**
 * The agents installed plugins contribute: Claude Code subagent files
 * (`agents/<name>.md`, YAML frontmatter with `name`, `description` and
 * `tools`, the body its system prompt), read as agents of source
 * `plugin` named `<plugin>:<name>`. The harness defines no agent format for
 * them; each file is read here, at the boundary, and nowhere else.
 */
// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Result, Schema } from 'effect';

// Local imports - common
import {
  readInstalledPluginLoad,
  type InstalledPluginLoad,
} from '@common/plugins/pluginTrust';
import { splitFrontmatterFence } from '@common/parsing/frontmatterFence';
import { texraToolOfClaudeTool } from '@common/plugins/hookConfig';
import { safeParseYaml } from '@common/parsing/safeParseYaml';
import { withLogChannel } from '@logger/effectLog';
import { AppState } from '@platform/interfaces';
import {
  PersonaSchema,
  AgentNameSchema,
  type AgentScanIssue,
} from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { readNormalizedFile } from '@utils/files/fsDurability';

// Local imports - this module's neighbours
import type { AgentEntry } from './agentEntry';

/** A subagent's frontmatter; `tools` is a comma-separated list or a list. */
const SubagentFrontmatterSchema = Schema.Struct({
  name: Schema.optional(AgentNameSchema),
  description: Schema.optional(Schema.String),
  tools: Schema.optional(
    Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  ),
});

/** Read the subagent file `file` of plugin `plugin`: its catalog entry,
 *  and the tools it names that the harness has no counterpart for. */
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
  const parsed = Result.flatMap(
    safeParseYaml(split.frontmatterText),
    Schema.decodeUnknownResult(SubagentFrontmatterSchema),
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
    tool.startsWith('mcp__') ? tool : texraToolOfClaudeTool(tool),
  );
  // Naming only tools the harness lacks must not read as naming none, which
  // would widen the agent to everything it inherits.
  if (
    declared !== undefined &&
    declared.length > 0 &&
    mapped.every((t) => t === undefined)
  )
    return yield* Effect.fail(
      new Error(
        `${file} names only tools this build does not have (${declared.join(', ')}).`,
      ),
    );
  // `undefined` when it names none and inherits them (`AgentRun`).
  const tools =
    declared === undefined || declared.length === 0
      ? undefined
      : [...new Set(mapped.filter((tool) => tool !== undefined))];
  const entry: AgentEntry = {
    name: `${plugin}:${parsed.success.name ?? path.basename(file, '.md')}`,
    source: 'plugin',
    path: file,
    description: parsed.success.description,
    tools: tools === undefined ? undefined : [...tools],
    // None named: `AgentRun` gives it what it inherits. The task arrives as
    // the user message, as a Claude Code subagent's does.
    persona: Schema.decodeUnknownSync(PersonaSchema)({
      prompt: systemPrompt,
      tools: tools ?? [],
    }),
    blocks: {},
  };
  return {
    entry,
    dropped: (declared ?? []).filter((_, index) => mapped[index] === undefined),
  };
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

/**
 * The catalog entries of the agents of the installed plugins that load now
 * (enabled, and trusted as they are), and the files that did not read: no
 * entry, logged, and returned so a launch that misses one names why. A tool
 * a file names that the harness has no counterpart for is dropped and
 * logged.
 */
export const scanPluginAgents = Effect.gen(function* () {
  const { loadable } = yield* readInstalledPluginLoad({
    globalState: yield* AppState,
  });
  const entries: AgentEntry[] = [];
  const issues: AgentScanIssue[] = [];
  // The files are read concurrently, then recorded in their listed order.
  const reads = yield* Effect.forEach(
    loadable.flatMap(({ record, plugin }) =>
      plugin.agents.map((relative) => ({
        file: path.join(record.path, relative),
        pluginName: record.name,
      })),
    ),
    ({ file, pluginName }) =>
      Effect.map(Effect.result(readPluginAgent(file, pluginName)), (read) => ({
        file,
        read,
      })),
    { concurrency: 8 },
  );
  for (const { file, read } of reads) {
    if (Result.isFailure(read)) {
      yield* Effect.logWarning(
        `Plugin agent ${file} is not loaded: ${read.failure.message}`,
      ).pipe(withLogChannel('agentRegistry'));
      issues.push({ path: file, message: read.failure.message });
      continue;
    }
    const { entry, dropped } = read.success;
    if (dropped.length > 0)
      yield* Effect.logWarning(
        `Agent ${entry.name} names tools this build does not have, which it is not offered: ${dropped.join(', ')}.`,
      ).pipe(withLogChannel('agentRegistry'));
    entries.push(entry);
  }
  return { entries, issues };
});
