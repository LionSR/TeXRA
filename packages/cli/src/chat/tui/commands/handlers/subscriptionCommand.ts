import {
  getCodexStatus,
  isPreferCodexSubscription,
  setPreferCodexSubscription,
} from '@auth/codex';
import { appendLocalAssistantTranscript } from '@cli/chat/tui/state/transcript';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';

const SUBSCRIPTION_ON = new Set(['on', 'enable', 'enabled', 'true', 'yes']);
const SUBSCRIPTION_OFF = new Set(['off', 'disable', 'disabled', 'false', 'no']);
const SUBSCRIPTION_USAGE = 'Usage: /subscription on | off';

/**
 * Toggle "prefer ChatGPT subscription" for Codex-eligible models. The
 * preference is orthogonal to the relay/personal api-mode (it only changes
 * where Codex models get their credentials), so it lives in its own command
 * rather than the `/api` binary.
 */
export async function applyCliSubscriptionToggle(input: string): Promise<void> {
  const normalized = input.trim().toLowerCase();
  const status = await getCodexStatus();
  const accountLine = status.signedIn
    ? `Signed in with ChatGPT as ${status.email ?? status.accountId ?? 'your account'}.`
    : 'Not signed in with ChatGPT — run `texra auth chatgpt login`.';

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

  let enabled: boolean;
  if (SUBSCRIPTION_ON.has(normalized)) enabled = true;
  else if (SUBSCRIPTION_OFF.has(normalized)) enabled = false;
  else {
    appendLocalAssistantTranscript(SUBSCRIPTION_USAGE);
    return;
  }

  const update = await setPreferCodexSubscription(enabled);
  invalidateModelOptionsCache();

  const lines = [
    update.effective === enabled
      ? `ChatGPT subscription ${enabled ? 'enabled' : 'disabled'} for Codex models.`
      : `ChatGPT subscription preference is still ${update.effective ? 'enabled' : 'disabled'} because a more specific setting overrides ${update.target} config.`,
  ];
  if (enabled && update.effective && !status.signedIn) {
    lines.push(
      'You are not signed in with ChatGPT yet — run `texra auth chatgpt login` to use it.',
    );
  } else if (enabled && update.effective) {
    lines.push(accountLine);
  }
  appendLocalAssistantTranscript(lines.join('\n'));
}
