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
  AgentCategory,
  AgentDefinitionSchema,
  AgentWorkflowSettingSchema,
  type AgentDefinition,
} from '@agent/core/definition/AgentDataclass';
import { extractToolNames } from './agentYamlScanner';
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
 * must find out at the call it made, not at launch.
 */
export function defineInlineAgents(
  definitions: readonly unknown[],
): AgentEntry[] {
  return definitions.map((definition) => {
    const inline = normalizeInlineAgent(definition);
    inlineAgents.set(inline.entry.name, inline);
    return inline.entry;
  });
}

/** Registry entries for every currently registered inline definition. */
export function inlineAgentEntries(): AgentEntry[] {
  return [...inlineAgents.values()].map((inline) => inline.entry);
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
  return inline.definition;
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

  const settings = parsed.settings;
  const category = settings.agentCategory ?? AgentCategory.Workflow;
  const tools = extractToolNames(settings.tools);
  const defaultOutputFiles = settings.defaultOutputFiles;

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
              userRequestCount(parsed),
            )
          : undefined,
      internal: settings.internal === true || undefined,
    },
    definition: parsed,
  };
}

/** Round floor for a workflow agent, mirroring `agentYamlScanner`'s rule. */
function userRequestCount(definition: AgentDefinition): number {
  const userRequest = definition.prompts.userRequest;
  if (Array.isArray(userRequest)) return userRequest.length;
  return userRequest ? 1 : 0;
}
