import { getCodexStatus, isPreferCodexSubscription } from '@auth/codex';
import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import { setCliCodexSubscription } from '@cli/chat/tui/state/codexSubscription';

const SUBSCRIPTION_ON = new Set(['on', 'enable', 'enabled', 'true', 'yes']);
const SUBSCRIPTION_OFF = new Set(['off', 'disable', 'disabled', 'false', 'no']);
const SUBSCRIPTION_USAGE = 'Usage: /subscription on | off';

function parseSubscriptionToggle(normalized: string): boolean | undefined {
  if (SUBSCRIPTION_ON.has(normalized)) return true;
  if (SUBSCRIPTION_OFF.has(normalized)) return false;
  return undefined;
}

/**
 * Toggle "prefer ChatGPT subscription" for Codex-eligible models. The
 * preference is orthogonal to the relay/personal API fallback. `/api` is the
 * primary route chooser; this command remains the direct on/off compatibility
 * control for scripts and established interactive use.
 */
export async function applyCliSubscriptionToggle(input: string): Promise<void> {
  const normalized = input.trim().toLowerCase();
  const status = await getCodexStatus();
  const accountLine = status.signedIn
    ? `Signed in with ChatGPT as ${status.email ?? status.accountId ?? 'your account'}.`
    : 'Not signed in with ChatGPT - run `/login chatgpt`.';

  if (!normalized || normalized === 'status') {
    appendLocalAssistantTranscript(
      [
        `ChatGPT subscription: ${isPreferCodexSubscription() ? 'on' : 'off'}.`,
        accountLine,
        SUBSCRIPTION_USAGE,
      ].join('\n'),
    );
    return;
  }

  const enabled = parseSubscriptionToggle(normalized);
  if (enabled === undefined) {
    appendLocalAssistantTranscript(SUBSCRIPTION_USAGE);
    return;
  }

  const update = await setCliCodexSubscription(enabled);

  const lines = [
    update.effective === enabled
      ? `ChatGPT subscription ${enabled ? 'enabled' : 'disabled'} for Codex models.`
      : `ChatGPT subscription preference is still ${update.effective ? 'enabled' : 'disabled'} because a more specific setting overrides ${update.target} config.`,
  ];
  if (enabled && update.effective && !status.signedIn) {
    lines.push(
      'You are not signed in with ChatGPT yet - run `/login chatgpt` to use it.',
    );
  } else if (enabled && update.effective) {
    lines.push(accountLine);
  }
  appendLocalAssistantTranscript(lines.join('\n'));
}
