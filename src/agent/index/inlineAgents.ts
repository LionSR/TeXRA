/**
 * Inline agent definitions: agent definitions supplied to the runtime as
 * values instead of YAML files on disk.
 *
 * This is the local twin of the remote catalog. `remoteAgentMeta.ts` fabricates
 * an {@link AgentEntry} with an empty `path` from a Supabase row and
 * `agentLoad.ts` skips the filesystem read for `source: 'remote'`; the same two
 * moves here take a caller-supplied definition object instead of a network
 * fetch.
 *
 * The split matches the one the file path already uses: this module validates a
 * definition and derives its registry metadata, exactly as `agentYamlScanner`
 * does for a YAML file, while `agentLoad` resolves tools and applies
 * `AgentSettingSchema`/`AgentPromptSchema` for both. That keeps tool resolution
 * on a single code path, and keeps `@tools/registry` — which the registry
 * deliberately reaches only through a lazy import (see `loadRemoteAgents`) — out
 * of the eagerly loaded registry graph.
 */

import {
  AgentDefinitionSchema,
  AgentPromptSchema,
  AgentRootSettingInputSchema,
  AgentWorkflowSettingSchema,
  type AgentDefinition,
} from '@agent/core/definition/AgentDataclass';
import { AgentCategory } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { extractToolNames, userRequestTemplateCount } from './agentYamlScanner';
import type { AgentEntry } from './agentEntry';

interface InlineAgent {
  readonly entry: AgentEntry;
  readonly definition: AgentDefinition;
}

/**
 * Registered inline definitions, keyed by agent name — every entry here is an
 * inline one, so the registry's `source:name` qualification would add nothing.
 *
 * Module-level because the agent registry it feeds is itself process-global and
 * resolution is a synchronous read; hanging definitions off a per-run options
 * bag would fork the lookup. Registrations outlive `refresh()` — the registry
 * rebuilds its cache from scratch on every load, so `doLoad` re-merges these
 * entries rather than letting a catalog refresh silently drop them.
 */
const inlineAgents = new Map<string, InlineAgent>();

/**
 * Validate agent definitions supplied as values and derive their registry
 * entries, replacing any previous registration of the same name. Returns the
 * entries so the caller can publish them into the live cache.
 *
 * Throws on an invalid definition: an embedder handing over a malformed agent
 * must find out at the call it made, not at launch. The entire batch is
 * validated before any entry is stored, so a failed registration never leaves
 * partial state behind.
 */
export function defineInlineAgents(
  definitions: readonly unknown[],
): AgentEntry[] {
  // Validate every definition first — the module-level map must never contain
  // orphaned entries from a partially-failed batch.
  const validated = definitions.map((definition) =>
    normalizeInlineAgent(definition),
  );
  for (const inline of validated) {
    inlineAgents.set(inline.entry.name, inline);
  }
  return validated.map((inline) => clonePlainContainers(inline.entry));
}

/**
 * Registry entries for every currently registered inline definition.
 *
 * Each is a fresh copy: a published entry is reachable through `getAgent`, and
 * a consumer that mutates its `tools`/`defaultOutputFiles` array must not
 * corrupt the stored definition those arrays came from.
 */
export function inlineAgentEntries(): AgentEntry[] {
  return [...inlineAgents.values()].map((inline) =>
    clonePlainContainers(inline.entry),
  );
}

/**
 * Remove every registered inline definition so a host or test lifecycle can
 * start from a clean slate.
 */
export function clearInlineAgentDefinitions(): void {
  inlineAgents.clear();
}

/**
 * The validated definition behind a registered inline agent — what the
 * `agentLoad` source-switch arm parses instead of reading a YAML file.
 */
export function inlineAgentDefinition(name: string): AgentDefinition {
  const inline = inlineAgents.get(name);
  if (!inline) {
    throw new Error(
      `Inline agent "${name}" is not registered. Call registerInlineAgents before launching it.`,
    );
  }
  return clonePlainContainers(inline.definition);
}

/**
 * Copy every mutable data container while preserving runtime value objects
 * such as Zod schemas carried by object-form tool definitions.
 */
function clonePlainContainers<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => clonePlainContainers(item)) as T;
  }
  if (
    typeof value !== 'object' ||
    value === null ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      clonePlainContainers(item),
    ]),
  ) as T;
}

function normalizeInlineAgent(definition: unknown): InlineAgent {
  const parsed = AgentDefinitionSchema.parse(definition);

  if (parsed.inherits) {
    // The YAML loader resolves `inherits` against a source's directory scan;
    // an inline definition has no directory, so honouring it would silently
    // resolve against a different source's files. Reject instead.
    throw new Error(
      `Inline agent "${parsed.name}" declares "inherits: ${parsed.inherits}"; inline definitions must be self-contained.`,
    );
  }

  const settings = AgentRootSettingInputSchema.parse({
    ...parsed.settings,
    agentCategory: parsed.settings.agentCategory ?? AgentCategory.Workflow,
  });
  const category = settings.agentCategory;
  const tools = extractToolNames(settings.tools);
  const defaultOutputFiles = settings.defaultOutputFiles;

  // Validate prompts against their finalized schema at registration time
  // so an embedder discovers invalid prompts immediately.
  try {
    AgentPromptSchema.parse(parsed.prompts);
  } catch (error) {
    throw new Error(`Inline agent "${parsed.name}": ${toErrorMessage(error)}`, {
      cause: error,
    });
  }

  return {
    entry: {
      name: parsed.name,
      source: 'inline',
      path: '',
      category,
      description: parsed.description,
      tools: tools?.length ? tools : undefined,
      defaultOutputFiles: defaultOutputFiles?.length
        ? defaultOutputFiles
        : undefined,
      rounds:
        category === AgentCategory.Workflow
          ? Math.max(
              // Materializes the schema's own default when unset.
              AgentWorkflowSettingSchema.shape.rounds.parse(settings.rounds),
              userRequestTemplateCount(parsed.prompts.userRequest),
            )
          : undefined,
    },
    definition: clonePlainContainers({ ...parsed, settings }),
  };
}
