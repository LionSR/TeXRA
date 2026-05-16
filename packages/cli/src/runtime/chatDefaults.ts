import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { listExecutions } from '@agent/storage';
import { DEFAULT_AGENT_MODEL } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { isNonEmptyString } from '@utils/core/stringCore';
import { GlobalStorageFS } from '@utils/files/storageFS';

export const BUILTIN_DEFAULT_CHAT_AGENT = 'chat';
export const BUILTIN_DEFAULT_CHAT_MODEL = DEFAULT_AGENT_MODEL;

export interface ChatDefaults {
  readonly agent: string;
  readonly model: string;
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

function pickDefaults(parsed: unknown): PartialDefaults {
  if (typeof parsed !== 'object' || parsed === null) return {};
  const record = parsed as Record<string, unknown>;
  const out: { -readonly [K in keyof PartialDefaults]: PartialDefaults[K] } =
    {};
  if (isNonEmptyString(record.agent)) out.agent = record.agent.trim();
  if (isNonEmptyString(record.model)) out.model = record.model.trim();
  return out;
}

async function loadWorkspaceDefaults(cwd: string): Promise<PartialDefaults> {
  try {
    const raw = await readFile(
      path.join(cwd, WORKSPACE_CONFIG_DIR, CONFIG_FILE),
      'utf8',
    );
    return pickDefaults(JSON.parse(raw));
  } catch {
    return {};
  }
}

async function loadUserDefaults(): Promise<PartialDefaults> {
  try {
    return pickDefaults(await GlobalStorageFS.readJson(CONFIG_FILE));
  } catch {
    return {};
  }
}

async function loadHistoryDefaults(): Promise<PartialDefaults> {
  try {
    const entries = await listExecutions();
    const mostRecent = entries
      .filter(
        (entry) => entry.agentConfig?.agentCategory === AgentCategory.ToolUse,
      )
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
  readonly cwd: string;
  readonly agentOverride?: string;
  readonly modelOverride?: string;
}

/**
 * Four-tier lookup per `docs/prd/cli-tui-ink/10-architecture.md#entrypoint-default`:
 * workspace `.texra/config.json` → user `<global-storage>/config.json` →
 * last toolUse execution → built-in. Per-field independence: a workspace that
 * only sets `agent` still falls through to user/history for `model`.
 */
export async function resolveChatDefaults(
  init: ResolveChatDefaultsInit,
): Promise<ChatDefaults> {
  const overrideAgent = init.agentOverride?.trim();
  const overrideModel = init.modelOverride?.trim();

  if (overrideAgent && overrideModel) {
    return { agent: overrideAgent, model: overrideModel, source: 'mixed' };
  }

  // Tiers are independent I/O — fan out in parallel.
  const [workspace, user, history] = await Promise.all([
    loadWorkspaceDefaults(init.cwd),
    loadUserDefaults(),
    loadHistoryDefaults(),
  ]);
  const tiers: ReadonlyArray<readonly [ChatDefaultSource, PartialDefaults]> = [
    ['workspace', workspace],
    ['user', user],
    ['history', history],
  ];

  const pickedSources: {
    agent?: ChatDefaultSource;
    model?: ChatDefaultSource;
  } = {};
  let agent = overrideAgent;
  let model = overrideModel;

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
