// Standard library imports
import { readFile } from 'node:fs/promises';
import path from 'node:path';

// Local imports - agent / shared
import { listExecutions } from '@agent/storage';

// Local imports - platform
import { platform } from '@platform/platform';

/**
 * Built-in fallback defaults — used when no workspace, user, or history
 * configuration provides an explicit choice. The PRD calls out `chat` and
 * `claude-opus-4-7` as the v1 fallbacks for the TUI entrypoint.
 */
export const BUILTIN_DEFAULT_CHAT_AGENT = 'chat';
export const BUILTIN_DEFAULT_CHAT_MODEL = 'claude-opus-4-7';

export interface ChatDefaults {
  readonly agent: string;
  readonly model: string;
  /** Where the agent/model values originated, for logging or `/status`. */
  readonly source: ChatDefaultSource;
}

export type ChatDefaultSource =
  | 'workspace'
  | 'user'
  | 'history'
  | 'builtin'
  | 'mixed';

interface PartialDefaults {
  readonly agent?: string;
  readonly model?: string;
}

const CONFIG_FILE = 'config.json';
const WORKSPACE_CONFIG_DIR = '.texra';

async function readJsonConfig(filePath: string): Promise<PartialDefaults> {
  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: { -readonly [K in keyof PartialDefaults]: PartialDefaults[K] } =
      {};
    const record = parsed as Record<string, unknown>;
    if (typeof record.agent === 'string' && record.agent.trim().length > 0) {
      out.agent = record.agent.trim();
    }
    if (typeof record.model === 'string' && record.model.trim().length > 0) {
      out.model = record.model.trim();
    }
    return out;
  } catch {
    // Missing or malformed config — caller falls through to next source.
    return {};
  }
}

async function loadWorkspaceDefaults(cwd: string): Promise<PartialDefaults> {
  return readJsonConfig(path.join(cwd, WORKSPACE_CONFIG_DIR, CONFIG_FILE));
}

async function loadUserDefaults(): Promise<PartialDefaults> {
  const storage = platform().storage;
  return readJsonConfig(path.join(storage.getGlobalStoragePath(), CONFIG_FILE));
}

async function loadHistoryDefaults(): Promise<PartialDefaults> {
  try {
    const entries = await listExecutions();
    const mostRecent = entries
      .filter((entry) => entry.agentConfig?.agentCategory === 'toolUse')
      .sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
      )[0];
    if (!mostRecent?.agentConfig) return {};
    return {
      agent: mostRecent.agentConfig.agent,
      model: mostRecent.agentConfig.model,
    };
  } catch {
    return {};
  }
}

function deriveSource(picked: {
  agent?: ChatDefaultSource;
  model?: ChatDefaultSource;
}): ChatDefaultSource {
  const sources = [picked.agent ?? 'builtin', picked.model ?? 'builtin'];
  return sources[0] === sources[1] ? sources[0] : 'mixed';
}

export interface ResolveChatDefaultsInit {
  /** CLI working directory used to locate `.texra/config.json`. */
  readonly cwd: string;
  /** Explicit `--agent` override; bypasses all lookup tiers when present. */
  readonly agentOverride?: string;
  /** Explicit `--model` override; bypasses all lookup tiers when present. */
  readonly modelOverride?: string;
}

/**
 * Resolve the chat agent and model using the four-tier lookup defined in
 * `docs/prd/cli-tui-ink/10-architecture.md#entrypoint-default`:
 *
 *   1. workspace `.texra/config.json`
 *   2. user `<global-storage>/config.json`
 *   3. last toolUse execution recorded in this workspace's history
 *   4. built-in (`chat`, `claude-opus-4-7`)
 *
 * Per-field independence: a workspace that only sets `agent` still falls
 * through to user/history for `model`.
 */
export async function resolveChatDefaults(
  init: ResolveChatDefaultsInit,
): Promise<ChatDefaults> {
  const overrideAgent = init.agentOverride?.trim();
  const overrideModel = init.modelOverride?.trim();

  if (overrideAgent && overrideModel) {
    return {
      agent: overrideAgent,
      model: overrideModel,
      source: 'mixed',
    };
  }

  const tiers: ReadonlyArray<readonly [ChatDefaultSource, PartialDefaults]> = [
    ['workspace', await loadWorkspaceDefaults(init.cwd)],
    ['user', await loadUserDefaults()],
    ['history', await loadHistoryDefaults()],
  ];

  const pickedSources: {
    agent?: ChatDefaultSource;
    model?: ChatDefaultSource;
  } = {};
  let agent: string | undefined = overrideAgent;
  let model: string | undefined = overrideModel;

  for (const [source, defaults] of tiers) {
    if (!agent && defaults.agent) {
      agent = defaults.agent;
      pickedSources.agent = source;
    }
    if (!model && defaults.model) {
      model = defaults.model;
      pickedSources.model = source;
    }
    if (agent && model) break;
  }

  return {
    agent: agent ?? BUILTIN_DEFAULT_CHAT_AGENT,
    model: model ?? BUILTIN_DEFAULT_CHAT_MODEL,
    source: deriveSource(pickedSources),
  };
}
