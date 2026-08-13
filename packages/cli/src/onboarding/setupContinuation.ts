// State 1 continuation for the CLI (docs/prds/2026-06-11-agent-native-onboarding.md).
//
// The moment a credential lands on a true first run, the setup agent owns the
// session: the post-picker continuation enters chat with `setup` selected
// instead of the bare launcher / default agent. Pure decision logic so the
// Ink-free test kernel can cover it — callers read `firstRunDone` from
// platform global state and pass it in.

import { SETUP_AGENT_NAME } from '@shared/constants/agents';
import { ONBOARDING_SETUP_HANDOFF } from '@shared/copy/onboarding';

export interface FirstRunSetupContinuationInputs {
  /** The first-run picker just configured a credential in this process. */
  readonly onboardingConfigured: boolean;
  /** User-scoped flag: a run has completed or the setup agent handed off. */
  readonly firstRunDone: boolean;
  /** Agent the user pinned (--agent flag, resume, or env) — always wins. */
  readonly pinnedAgent?: string;
}

/**
 * Agent override for the post-picker continuation, or undefined when the
 * session should use its normal defaults. The setup agent takes the session
 * only on a true first run (a credential was just configured and no run has
 * completed yet) and never displaces an agent the user pinned themselves.
 */
export function firstRunSetupAgentOverride(
  inputs: FirstRunSetupContinuationInputs,
): string | undefined {
  if (!inputs.onboardingConfigured || inputs.firstRunDone) return undefined;
  if (inputs.pinnedAgent?.trim()) return undefined;
  return SETUP_AGENT_NAME;
}

/**
 * Local transcript notice shown when the setup agent takes over a first-run
 * session. Display-only (appended via `appendLocalAssistantTranscript`) — it
 * is never sent to the model, so the agent stays reactive instead of speaking
 * first on its own. Built from the shared State 1 handoff sentence (same
 * wording as the extension/desktop setup card) plus the CLI's own hint.
 */
export const SETUP_AGENT_HANDOFF_NOTICE = `${ONBOARDING_SETUP_HANDOFF} Tell it what you are working on — or switch to another agent anytime with /agent.`;
