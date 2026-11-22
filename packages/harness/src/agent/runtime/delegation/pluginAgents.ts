/**
 * The agents installed plugins contribute: Claude Code subagent files
 * (`agents/<name>.md`, YAML frontmatter with `name`, `description` and
 * `tools`, the body its system prompt), named `<plugin>:<name>`: what the
 * `agent` tool starts by name. The harness defines no agent format of its
 * own; each file is read here, at the boundary, and nowhere else.
 */
// Node imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem, Predicate, Result, Schema } from 'effect';

// Local imports - common
import { AgentError } from '@common/errors/agentErrors';
import { readInstalledPluginLoad } from '@common/plugins/pluginTrust';
import { splitFrontmatterFence } from '@common/parsing/frontmatterFence';
import {
  CLAUDE_COUNTERPART_TOOLS,
  texraToolOfClaudeTool,
} from '@common/plugins/hookConfig';
import { safeParseYaml } from '@common/parsing/safeParseYaml';
import { withLogChannel } from '@logger/effectLog';
import { AppState } from '@platform/interfaces';
import type { SettingsStores } from '@shared/config/settings';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { readNormalizedFile } from '@utils/files/fsDurability';

/** An installed plugin's agent, as its file gives it. */
interface PluginAgent {
  /** `<plugin>:<name>`. */
  readonly name: string;
  readonly description?: string;
  readonly system: string;
  /** The tools it names; absent when it names none and takes the
   *  counterparts of Claude Code's own tools instead. */
  readonly tools?: readonly string[];
}

const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;

/** A subagent's frontmatter; `tools` is a comma-separated list or a list. */
const SubagentFrontmatterSchema = Schema.Struct({
  name: Schema.optional(Schema.Trim.check(Schema.isPattern(AGENT_NAME))),
  description: Schema.optional(Schema.String),
  tools: Schema.optional(
    Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  ),
});

/** Read the subagent file `file` of plugin `plugin`: the agent,
 *  and the tools it names that the harness has no counterpart for. */
const readPluginAgent = Effect.fn('pluginAgents.read')(function* (
  file: string,
  plugin: string,
) {
  const content = yield* readNormalizedFile(
    yield* FileSystem.FileSystem,
    file,
  ).pipe(
    Effect.mapError(
      (error) => new AgentError({ message: error.message, cause: error }),
    ),
  );
  const split = splitFrontmatterFence(content);
  if (split.kind !== 'ok')
    return yield* new AgentError({
      message: `${file} must start with YAML frontmatter (---).`,
    });
  const parsed = Result.flatMap(
    safeParseYaml(split.frontmatterText),
    Schema.decodeUnknownResult(SubagentFrontmatterSchema),
  );
  if (Result.isFailure(parsed))
    return yield* new AgentError({
      message: `${file}: ${toErrorMessage(parsed.failure)}`,
    });
  const systemPrompt = split.body.trim();
  if (!systemPrompt)
    return yield* new AgentError({ message: `${file} has no system prompt.` });
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
    return yield* new AgentError({
      message: `${file} names only tools this build does not have (${declared.join(', ')}).`,
    });
  const entry: PluginAgent = {
    name: `${plugin}:${parsed.success.name ?? path.basename(file, '.md')}`,
    description: parsed.success.description,
    system: systemPrompt,
    ...(declared === undefined || declared.length === 0
      ? {}
      : { tools: [...new Set(mapped.filter(Predicate.isNotUndefined))] }),
  };
  return {
    entry,
    dropped: (declared ?? []).filter((_, index) => mapped[index] === undefined),
  };
});

/**
 * A plugin agent (`agent`, named `<plugin>:<name>` as {@link readPluginAgent}
 * writes it) runs only while its plugin loads (enabled, and trusted as it
 * is): a launch asks the install record, and fails naming the plugin and
 * why it does not load: an enabled plugin the load holds back carries the
 * load's reason; any other is off or gone.
 */
const requirePluginLoads = Effect.fn('requirePluginLoads')(function* (
  agent: string,
  stores: Pick<SettingsStores, 'globalState'>,
) {
  const plugin = agent.slice(0, agent.indexOf(':'));
  const load = yield* readInstalledPluginLoad(stores);
  if (load.loadable.some(({ record }) => record.name === plugin)) return;
  const withheld = load.withheld.find((held) => held.plugin === plugin);
  return yield* new AgentError({
    message: `Agent ${agent} does not run: ${
      withheld?.reason ?? `plugin ${plugin} is not installed or not enabled.`
    }`,
  });
});

/**
 * The agents of the installed plugins that load now (enabled, and trusted
 * as they are), and the files that did not read: no entry, logged, and
 * returned so a launch that misses one names why. A tool
 * a file names that the harness has no counterpart for is dropped and
 * logged.
 */
export const scanPluginAgents = Effect.gen(function* () {
  const { loadable } = yield* readInstalledPluginLoad({
    globalState: yield* AppState,
  });
  const entries: PluginAgent[] = [];
  const issues: { readonly path: string; readonly message: string }[] = [];
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
      ).pipe(withLogChannel('pluginAgents'));
      issues.push({ path: file, message: read.failure.message });
      continue;
    }
    const { entry, dropped } = read.success;
    if (dropped.length > 0)
      yield* Effect.logWarning(
        `Agent ${entry.name} names tools this build does not have, which it is not offered: ${dropped.join(', ')}.`,
      ).pipe(withLogChannel('pluginAgents'));
    entries.push(entry);
  }
  return { entries, issues };
});

/**
 * The installed plugin's agent `name` (`<plugin>:<name>`) as a launch runs
 * it: its plugin loads now, and its system text and tools are read from its
 * file, with the scope the child's config records (`toolScope`). One that
 * names its tools gets exactly those. One that names none inherits, as a
 * Claude Code subagent does: the counterparts of the standard file, shell
 * and web tools, and the injected and installed plugins' tools at each of
 * its steps, wherever it runs.
 */
export const pluginAgent = Effect.fn('pluginAgent')(function* (
  name: string,
  stores: Pick<SettingsStores, 'globalState'>,
) {
  if (!name.includes(':'))
    return yield* new AgentError({
      message: `'${name}' is not an installed plugin's agent (those are named <plugin>:<name>). Write the child with \`system\` and \`tools\` instead.`,
    });
  yield* requirePluginLoads(name, stores);
  const { entries, issues } = yield* scanPluginAgents;
  const entry = entries.find((agent) => agent.name === name);
  if (entry === undefined) {
    const issue = issues.find(({ path: file }) =>
      file.endsWith(`${name.slice(name.indexOf(':') + 1)}.md`),
    );
    return yield* new AgentError({
      message: `Unknown agent '${name}'${issue ? ` (${issue.message})` : ''}. Available: ${entries.map((agent) => agent.name).join(', ') || 'none'}`,
    });
  }
  return {
    name: entry.name,
    system: entry.system,
    tools: entry.tools ?? CLAUDE_COUNTERPART_TOOLS,
    toolScope:
      entry.tools === undefined ? ('topLevel' as const) : ('declared' as const),
  };
});
