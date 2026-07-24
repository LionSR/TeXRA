/**
 * The "prefer my ChatGPT subscription" switch.
 *
 * Off by default (experimental, opt-in). When on AND the user is signed in with
 * ChatGPT, Codex-eligible OpenAI models route through the subscription instead
 * of the user's API key.
 */
import type { ConfigTarget } from '@platform/interfaces';
import { tryPlatform } from '@platform/platform';
import { GlobalStateKey } from '@shared/state/stateKeys';
import {
  CODEX_PREFER_SUBSCRIPTION_KEY,
  CODEX_SUBSCRIPTION_TOOL_USE_ONLY_KEY,
} from './codexConstants';

export interface CodexSubscriptionPreferenceUpdate {
  readonly effective: boolean;
  readonly target: ConfigTarget;
}

/** Read a boolean preference, defaulting to off before platform init. */
function readCodexFlag(key: string): boolean {
  return tryPlatform()?.config.get<boolean>(key, false) ?? false;
}

function codexPreferenceUpdateTarget(key: string): ConfigTarget {
  const inspection = tryPlatform()?.config.inspect<boolean>(key);
  return inspection?.workspaceValue !== undefined ? 'workspace' : 'global';
}

/** Write a boolean preference at the scope that currently controls its value. */
async function writeCodexFlag(
  key: string,
  enabled: boolean,
): Promise<CodexSubscriptionPreferenceUpdate> {
  const host = tryPlatform();
  const target = codexPreferenceUpdateTarget(key);
  if (!host) return { effective: false, target };

  await host.config.update(key, enabled, target);
  return { effective: readCodexFlag(key), target };
}

/** Whether the user has switched on "prefer ChatGPT subscription". */
export function isPreferCodexSubscription(): boolean {
  return readCodexFlag(CODEX_PREFER_SUBSCRIPTION_KEY);
}

/**
 * Whether the ChatGPT subscription is restricted to tool-use agents (off by
 * default). When true, workflow agents skip the subscription and route through
 * the user's API key / relay — the Codex backend has no background mode and is
 * less stable for long workflow runs. Read per request by the Codex handler.
 */
export function isCodexSubscriptionToolUseOnly(): boolean {
  return readCodexFlag(CODEX_SUBSCRIPTION_TOOL_USE_ONLY_KEY);
}

/** Update the "subscription for tool-use only" switch at the controlling scope. */
export async function setCodexSubscriptionToolUseOnly(
  enabled: boolean,
): Promise<CodexSubscriptionPreferenceUpdate> {
  return writeCodexFlag(CODEX_SUBSCRIPTION_TOOL_USE_ONLY_KEY, enabled);
}

/** Update the preference at the scope that currently controls its value. */
export async function setPreferCodexSubscription(
  enabled: boolean,
): Promise<CodexSubscriptionPreferenceUpdate> {
  const update = await writeCodexFlag(CODEX_PREFER_SUBSCRIPTION_KEY, enabled);
  if (enabled && update.effective) {
    await tryPlatform()?.globalState.update(
      GlobalStateKey.USE_OPENROUTER,
      false,
    );
  }
  return update;
}
