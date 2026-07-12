// First-run authentication onboarding for the interactive `texra` CLI.
//
// Replaces today's dead-end (a launcher full of "login required" models that
// errors out when the user picks chat) with a credential picker, modeled on
// Claude Code / Gemini CLI / aider: ChatGPT subscription, Researcher Access,
// and bring-your-own provider key are first-class credential paths, and skip is
// explicit. After credentials are set the caller re-reads availability in the
// SAME process (the relay/subscription/key paths invalidate the relevant
// caches), so the launcher/chat continues with real models — no restart.
//
// TTY-only: the gate returns immediately in headless / non-TTY / dumb-terminal
// runs, and both entry points already reject those before calling it, so
// `texra run` / `--print` / piped output stay byte-identical (headless parity).

import { render, Box, Text, useApp, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';
import { useState } from 'react';

import { platform } from '@platform/platform';
import {
  backfillFirstRunDone,
  getFirstRunDone,
  getOnboardingDeclined,
  setOnboardingDeclined,
} from '@controllers/onboarding/onboardingFunnel';
import { listExecutions } from '@agent/storage';
import { setPreferCodexSubscription, type CodexSession } from '@auth/codex';
import { DEFAULT_OAUTH_PROVIDER } from '@auth/config';
import { type OAuthProvider } from '@auth/sharedConfig';
import { type SupabaseSession } from '@auth/SupabaseSession';
import { useCancellableEffect } from '@cli/chat/tui/state/useCancellableEffect';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { API_PROVIDERS, type ApiProvider } from '@model/apiProviders';
import { PROVIDER_DISPLAY_NAMES } from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';

import {
  ONBOARDING_CARD_TITLE,
  ONBOARDING_CHOICE_API_KEY,
  ONBOARDING_CHOICE_CHATGPT,
  ONBOARDING_CHOICE_SIGN_IN,
  ONBOARDING_CHOICE_SKIP_LABEL,
} from '@shared/copy/onboarding';
import { assertNever } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { ApiKeyEntryForm } from '../chat/tui/forms/ApiKeyEntryForm';
import { tuiOutputStreamForColor } from '../chat/tui/render/noColorOutput';
import { clearTerminalVisibleScreen } from '../chat/tui/terminalCleanup';
import { KeyHints, type KeyHint } from '../chat/tui/ui/KeyHints';
import { Select, type SelectItem } from '../chat/tui/ui/Select';
import { type CliApiMode } from '../runtime/apiAccessMode';
import { chatGptAccountLabel, signInCliChatGpt } from '../runtime/chatgptLogin';
import { resolveCliStdoutColorEnabled } from '../runtime/cliContext';
import { hasCliCredentialForApiMode } from '../runtime/credentialStatus';
import { writeTextStderr, writeTextStdout } from '../runtime/logSinks';
import { CLI_OAUTH_PROVIDER_ITEMS } from '../runtime/oauthProviderDisplay';
import { isLikelyRemoteSession } from '../runtime/remoteSession';
import {
  CLI_MANUAL_AUTH_REMOTE_HINT,
  CLI_MANUAL_AUTH_URL_PROMPT,
  signInCliSupabase,
  signInCliSupabaseDeviceCode,
} from '../runtime/supabaseAuth';
import {
  CLI_DEVICE_AUTH_URL_PROMPT,
  type DeviceAuthorization,
} from '../runtime/supabaseAuthDeviceCode';
import { interactiveTerminalFailure } from '../runtime/terminalRequirements';

import { saveProviderApiKey } from './applyOnboardingResult';

export interface CliOnboardingResult {
  /**
   * True only when the picker configured a credential in this process —
   * the signal for the post-picker setup-agent continuation. A launch that
   * merely finds a pre-existing credential reports false (a stale skip is
   * handled by clearing the declined flag, never through this field).
   */
  readonly configured: boolean;
  /** True when the picker was shown and the user chose "Skip for now" this run.
   *  Lets `chat` exit cleanly (the skip summary already printed) instead of
   *  falling through to the no-models resolution error. */
  readonly declined: boolean;
}

/** Minimal slice of CliContext the gate needs (keeps it cheaply testable). */
export interface OnboardingGateContext {
  readonly mode: 'headless' | 'interactive';
  readonly stdoutIsTty?: boolean;
  readonly termIsDumb?: boolean;
  readonly stdoutColorEnabled?: boolean;
  readonly colorEnabled?: boolean;
  readonly apiMode?: CliApiMode;
}

const SKIP_SUMMARY =
  "Setup skipped — run `texra login` or `texra setup` when you're ready.";

// Fits the current 30-column onboarding action labels without truncation.
const ONBOARDING_SELECT_LABEL_MAX_COLS = 34;

/** Gate returned without showing the picker (or before any choice is made). */
const NO_ONBOARDING_RESULT: CliOnboardingResult = {
  configured: false,
  declined: false,
};

interface OnboardingResolution {
  readonly configured: boolean;
  readonly declined: boolean;
  readonly summary?: string;
}

/**
 * Gate for the two interactive entry points (orchestrate, chat). Renders the
 * first-run picker only when interactive, with no usable credentials, and not
 * previously declined. Otherwise returns immediately without rendering or
 * emitting anything.
 */
export async function maybeRunCliOnboarding(
  context: OnboardingGateContext,
): Promise<CliOnboardingResult> {
  // context.* carries the parsed intent (headless / non-TTY / dumb); the final
  // `process.stdout.isTTY` is the authoritative "Ink can actually mount here"
  // check at the call site (same guard runCliOnboarding uses for the
  // context-less `texra setup` path). Defense-in-depth before we render.
  if (interactiveTerminalFailure(context) || !process.stdout.isTTY) {
    return NO_ONBOARDING_RESULT;
  }
  const globalState = platform().globalState;
  const hasCredential = await hasCliCredentialForApiMode(context.apiMode).catch(
    () => false,
  );
  // Onboarding-funnel backfill (PRD: agent-native onboarding): a CLI user
  // with execution history never enters State 0/1. Credential presence alone
  // does not prove this is an upgrader: fresh installs can inherit env keys.
  // One-shot and best-effort: if a credential appears after a previous skip,
  // the stale skip is cleared below so a later sign-out re-enters State 0.
  const needsFirstRunBackfill =
    globalState.get<boolean | undefined>(
      GlobalStateKey.ONBOARDING_FIRST_RUN_DONE,
    ) === undefined;
  const hasRunHistory = needsFirstRunBackfill
    ? await listExecutions().then(
        (entries) => entries.length > 0,
        () => false,
      )
    : false;
  // LAST_KNOWN_VERSION is stamped by desktop/extension startup. The CLI's
  // API-mode preference is written during platform init, including first launch,
  // so it is not a reliable prior-install signal.
  const hasPriorInstall =
    needsFirstRunBackfill &&
    globalState.get<string | undefined>(GlobalStateKey.LAST_KNOWN_VERSION) !==
      undefined;
  await backfillFirstRunDone(globalState, {
    hasCredential,
    hasPriorInstall,
    hasRunHistory,
  }).catch(() => {});
  if (!hasCredential && getFirstRunDone(globalState)) {
    return NO_ONBOARDING_RESULT;
  }
  if (hasCredential) {
    // A credential clears a stale skip (the PRD's "configuring a credential
    // clears the flag"), but an already-credentialed launch is NOT a
    // post-picker continuation: `configured` stays false so the setup agent
    // only takes the session right after the picker actually configured a
    // credential in this process. Anything looser hijacks every launch into
    // setup until firstRunDone flips, with no exit path if the setup
    // conversation never completes a run.
    if (getOnboardingDeclined(globalState)) {
      await setOnboardingDeclined(globalState, false).catch(() => {});
    }
    return NO_ONBOARDING_RESULT;
  }
  if (getOnboardingDeclined(globalState)) {
    return NO_ONBOARDING_RESULT;
  }
  return runOnboardingFlow({
    firstRun: true,
    apiMode: context.apiMode,
    colorEnabled: resolveCliStdoutColorEnabled(context),
  });
}

/**
 * `texra setup`'s State 0 step: show the picker unconditionally — the command
 * only calls this after checking that no usable credential exists, and then
 * continues into the setup-agent chat once one is configured. Credentials-only
 * (re)configuration is `texra login`'s job. Still TTY-only — the command
 * rejects headless before calling this.
 */
export async function runCliOnboarding(
  colorEnabled = true,
): Promise<CliOnboardingResult> {
  if (!process.stdout.isTTY) return NO_ONBOARDING_RESULT;
  return runOnboardingFlow({ firstRun: false, colorEnabled });
}

async function runOnboardingFlow(options: {
  readonly firstRun: boolean;
  readonly apiMode?: CliApiMode;
  readonly colorEnabled?: boolean;
}): Promise<CliOnboardingResult> {
  const pickerSubtitle = onboardingPickerSubtitle(options);
  const pickerItems = onboardingPickerItems(onboardingSetupPaths(options));
  const resolution = await new Promise<OnboardingResolution>((resolve) => {
    let chosen: OnboardingResolution = NO_ONBOARDING_RESULT;
    const record = (next: OnboardingResolution): void => {
      chosen = next;
    };
    const instance = render(
      <OnboardingApp
        pickerSubtitle={pickerSubtitle}
        pickerItems={pickerItems}
        onResolve={record}
      />,
      {
        stdout: tuiOutputStreamForColor(
          process.stdout,
          options.colorEnabled ?? true,
        ),
        stderr: process.stderr,
        stdin: process.stdin,
      },
    );
    void instance.waitUntilExit().then(() => {
      // Wipe the picker out of the visible screen without erasing scrollback
      // (matches runOrchestrationTui); the summary below lands in scrollback.
      clearTerminalVisibleScreen();
      resolve(chosen);
    });
  });

  if (resolution.declined) {
    // Best-effort: persist the decline so we don't re-prompt next launch. If the
    // global-state write fails (read-only home, permissions), tell the user
    // rather than silently re-prompting later with no explanation.
    try {
      await setOnboardingDeclined(platform().globalState, true);
    } catch {
      writeTextStderr(
        "Note: couldn't save your choice, so you may be asked again next time.",
      );
    }
  } else if (resolution.configured) {
    // Clear any prior "skip" now that credentials exist — otherwise a user who
    // skipped, then configured via `texra setup` (which bypasses the gate), then
    // signed out would have the stale flag suppress onboarding and land back on
    // the dead-end. Best-effort: a failed clear only re-surfaces that rare edge.
    await setOnboardingDeclined(platform().globalState, false).catch(() => {});
  }
  if (resolution.summary) writeTextStdout(resolution.summary);
  // No "what next" hint after configuring: every caller continues in the same
  // process — orchestrate/chat into their session, `texra setup` into the
  // setup-agent chat.
  return { configured: resolution.configured, declined: resolution.declined };
}

type Screen =
  | 'picker'
  | 'relay-provider'
  | 'relay-progress'
  | 'relay-device-progress'
  | 'chatgpt-progress'
  | 'key-provider'
  | 'key-entry';

interface OnboardingAppProps {
  readonly pickerSubtitle: string;
  readonly pickerItems: readonly OnboardingPickerItem[];
  readonly onResolve: (resolution: OnboardingResolution) => void;
}

function OnboardingApp(props: OnboardingAppProps): React.JSX.Element {
  const app = useApp();
  const [screen, setScreen] = useState<Screen>('picker');
  const [relayProvider, setRelayProvider] = useState<OAuthProvider>(
    DEFAULT_OAUTH_PROVIDER,
  );
  const [noBrowser, setNoBrowser] = useState(false);
  const [keyProvider, setKeyProvider] = useState<ApiProvider>('anthropic');
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const finish = (resolution: OnboardingResolution): void => {
    props.onResolve(resolution);
    app.exit();
  };
  const skip = (): void =>
    finish({ configured: false, declined: true, summary: SKIP_SUMMARY });

  if (screen === 'picker') {
    return (
      <PickerStep
        subtitle={props.pickerSubtitle}
        items={props.pickerItems}
        error={error}
        onSelect={(choice) => {
          if (choice === 'skip') {
            skip();
            return;
          }
          setError(undefined);
          setScreen(PICKER_CHOICE_SCREENS[choice]);
        }}
      />
    );
  }

  if (screen === 'relay-provider') {
    return (
      <RelayProviderStep
        activeProvider={relayProvider}
        noBrowser={noBrowser}
        error={error}
        onToggleNoBrowser={() => setNoBrowser((v) => !v)}
        onSelect={(provider) => {
          setError(undefined);
          setRelayProvider(provider);
          setScreen('relay-progress');
        }}
        onDeviceCode={() => {
          setError(undefined);
          setScreen('relay-device-progress');
        }}
        onCancel={() => setScreen('picker')}
      />
    );
  }

  if (screen === 'relay-progress' || screen === 'relay-device-progress') {
    const onSuccess = (label: string): void =>
      finish({
        configured: true,
        declined: false,
        summary: `Signed in as ${label}. Included TeXRA access is active.`,
      });
    const onError = (message: string): void => {
      setError(message);
      setScreen('relay-provider');
    };
    return screen === 'relay-device-progress' ? (
      <RelayDeviceProgressStep onSuccess={onSuccess} onError={onError} />
    ) : (
      <RelayProgressStep
        provider={relayProvider}
        noBrowser={noBrowser}
        onSuccess={onSuccess}
        onError={onError}
      />
    );
  }

  if (screen === 'chatgpt-progress') {
    const onSuccess = (session: CodexSession): void => {
      const label = chatGptAccountLabel(session);
      finish({
        configured: true,
        declined: false,
        summary: `Signed in with ChatGPT as ${label}. ChatGPT subscription enabled for Codex models.`,
      });
    };
    const onError = (message: string): void => {
      setError(message);
      setScreen('picker');
    };
    return (
      <ChatGptProgressStep
        device={isLikelyRemoteSession()}
        onSuccess={onSuccess}
        onError={onError}
      />
    );
  }

  if (screen === 'key-provider') {
    return (
      <KeyProviderStep
        activeProvider={keyProvider}
        onSelect={(provider) => {
          setError(undefined);
          setKeyProvider(provider);
          setScreen('key-entry');
        }}
        onCancel={() => setScreen('picker')}
      />
    );
  }

  if (screen === 'key-entry') {
    return (
      <ApiKeyEntryForm
        provider={keyProvider}
        error={error}
        saving={saving}
        onCancel={() => {
          setError(undefined);
          setScreen('key-provider');
        }}
        onSubmit={(key) => {
          setSaving(true);
          void (async () => {
            try {
              const where = await saveProviderApiKey(keyProvider, key);
              finish({
                configured: true,
                declined: false,
                summary: `Saved your ${
                  PROVIDER_DISPLAY_NAMES[keyProvider] ?? keyProvider
                } API key. ${where}`,
              });
            } catch (saveError: unknown) {
              setSaving(false);
              setError(toErrorMessage(saveError));
            }
          })();
        }}
      />
    );
  }

  return assertNever(screen, 'Unhandled onboarding screen');
}

function OnboardingFrame(props: {
  readonly title: string;
  readonly subtitle?: string;
  readonly error?: string;
  readonly children: React.ReactNode;
  readonly hints: readonly KeyHint[];
}): React.JSX.Element {
  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="cyan">
        {props.title}
      </Text>
      {props.subtitle ? <Text dimColor>{props.subtitle}</Text> : null}
      {props.error ? <Text color="red">{props.error}</Text> : null}
      <Box marginTop={1} flexDirection="column">
        {props.children}
      </Box>
      <Box marginTop={1}>
        <KeyHints hints={props.hints} confirmCancel={false} />
      </Box>
    </Box>
  );
}

function onboardingPickerSubtitle(props: {
  readonly firstRun: boolean;
  readonly apiMode?: CliApiMode;
}): string {
  if (!props.firstRun) {
    return 'Choose how to power model calls — use ChatGPT, sign in, or add a provider API key:';
  }
  if (props.apiMode === 'included') {
    return 'Subscription or included access needs sign-in for this run:';
  }
  if (props.apiMode === 'personal') {
    return 'Personal mode needs ChatGPT sign-in or a provider key for this run:';
  }
  return 'Not signed in, and no provider API key is configured. Choose how to power model calls:';
}

type OnboardingChoice = 'relay' | 'chatgpt' | 'key' | 'skip';
type OnboardingSetupPath = Exclude<OnboardingChoice, 'skip'>;
type OnboardingPickerItem = SelectItem<OnboardingChoice>;

const SETUP_PATH_PICKER_ITEMS: Record<
  OnboardingSetupPath,
  OnboardingPickerItem
> = {
  relay: {
    value: 'relay',
    label: ONBOARDING_CHOICE_SIGN_IN.label,
    description: ONBOARDING_CHOICE_SIGN_IN.description,
  },
  chatgpt: {
    value: 'chatgpt',
    label: ONBOARDING_CHOICE_CHATGPT.label,
    description: ONBOARDING_CHOICE_CHATGPT.description,
  },
  key: {
    value: 'key',
    label: ONBOARDING_CHOICE_API_KEY.label,
    description: ONBOARDING_CHOICE_API_KEY.description,
  },
};

const SKIP_PICKER_ITEM: OnboardingPickerItem = {
  value: 'skip',
  label: ONBOARDING_CHOICE_SKIP_LABEL,
  description: 'set up later: texra setup (ChatGPT, Researcher, key)',
};

function onboardingSetupPaths(props: {
  readonly firstRun: boolean;
  readonly apiMode?: CliApiMode;
}): readonly OnboardingSetupPath[] {
  if (!props.firstRun) return ['chatgpt', 'relay', 'key'];
  if (props.apiMode === 'included') return ['chatgpt', 'relay'];
  if (props.apiMode === 'personal') return ['chatgpt', 'key'];
  return ['chatgpt', 'relay', 'key'];
}

function onboardingPickerItems(
  setupPaths: readonly OnboardingSetupPath[],
): readonly OnboardingPickerItem[] {
  return [
    ...setupPaths.map((path) => SETUP_PATH_PICKER_ITEMS[path]),
    SKIP_PICKER_ITEM,
  ];
}

/** Screen each non-skip picker choice opens (skip resolves the gate instead). */
const PICKER_CHOICE_SCREENS: Record<OnboardingSetupPath, Screen> = {
  relay: 'relay-provider',
  chatgpt: 'chatgpt-progress',
  key: 'key-provider',
};

function PickerStep(props: {
  readonly subtitle: string;
  readonly items: readonly OnboardingPickerItem[];
  readonly error?: string;
  readonly onSelect: (choice: OnboardingChoice) => void;
}): React.JSX.Element {
  return (
    <OnboardingFrame
      title={ONBOARDING_CARD_TITLE}
      subtitle={props.subtitle}
      error={props.error}
      hints={[
        { key: '↑/↓', action: 'navigate' },
        { key: `1-${props.items.length}/Enter`, action: 'select' },
        { key: 'Esc', action: 'skip' },
      ]}
    >
      <Select<OnboardingChoice>
        items={props.items}
        labelMaxCols={ONBOARDING_SELECT_LABEL_MAX_COLS}
        onSelect={props.onSelect}
        onCancel={() => props.onSelect('skip')}
      />
    </OnboardingFrame>
  );
}

function RelayProviderStep(props: {
  readonly activeProvider: OAuthProvider;
  readonly noBrowser: boolean;
  readonly error?: string;
  readonly onToggleNoBrowser: () => void;
  readonly onSelect: (provider: OAuthProvider) => void;
  readonly onDeviceCode: () => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  // `n` toggles no-browser and `d` starts device-code sign-in. The Select
  // child ignores both letters, so the two active useInput handlers never
  // collide on them.
  useInput((input, key) => {
    if (key.ctrl || key.meta) return;
    if (input.toLowerCase() === 'n') props.onToggleNoBrowser();
    if (input.toLowerCase() === 'd') props.onDeviceCode();
  });

  return (
    <OnboardingFrame
      title="Sign in · Researcher Access"
      subtitle={
        props.noBrowser
          ? 'No-browser mode: we print the sign-in URL instead of opening it.'
          : isLikelyRemoteSession()
            ? 'Remote session detected — press d for device-code sign-in (no callback port needed).'
            : 'Choose a provider to sign in with:'
      }
      error={props.error}
      hints={[
        { key: '↑/↓', action: 'navigate' },
        { key: `1-${CLI_OAUTH_PROVIDER_ITEMS.length}/Enter`, action: 'select' },
        { key: 'n', action: 'no-browser' },
        { key: 'd', action: 'device code' },
        { key: 'Esc', action: 'back' },
      ]}
    >
      <Select<OAuthProvider>
        items={CLI_OAUTH_PROVIDER_ITEMS}
        activeValue={props.activeProvider}
        onSelect={props.onSelect}
        onCancel={props.onCancel}
      />
    </OnboardingFrame>
  );
}

interface RelayProgressCallbacks {
  readonly onSuccess: (accountLabel: string) => void;
  readonly onError: (message: string) => void;
}

/**
 * Run a sign-in exactly once on mount. Empty deps is deliberate (not the
 * captured props): re-running would open a second browser + loopback server
 * (or request a second device code), and a deps-triggered cleanup would flip
 * `isCancelled()` and orphan the in-flight login (eternal spinner). The
 * captured callbacks only invoke stable state setters / app.exit, so the
 * mount-time closure stays correct. `isCancelled()` guards against the real
 * unmount (the user navigating away); progress callbacks receive it to drop
 * late updates.
 */
function useSignInOnMount(
  signIn: (isCancelled: () => boolean) => Promise<SupabaseSession>,
  callbacks: RelayProgressCallbacks,
): void {
  useCancellableEffect(async (isCancelled) => {
    try {
      const session = await signIn(isCancelled);
      if (!isCancelled()) callbacks.onSuccess(session.account.label);
    } catch (loginError: unknown) {
      if (!isCancelled()) callbacks.onError(toErrorMessage(loginError));
    }
  }, []);
}

function RelayProgressFrame(props: {
  readonly title?: string;
  readonly spinnerLabel: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="cyan">
        {props.title ?? 'Sign in · Researcher Access'}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {props.children}
      </Box>
      <Box marginTop={1}>
        <Spinner label={props.spinnerLabel} />
      </Box>
    </Box>
  );
}

function RelayProgressStep(
  props: RelayProgressCallbacks & {
    readonly provider: OAuthProvider;
    readonly noBrowser: boolean;
  },
): React.JSX.Element {
  const { provider, noBrowser } = props;
  const [url, setUrl] = useState<string | undefined>(undefined);

  useSignInOnMount(
    (isCancelled) =>
      signInCliSupabase({
        provider,
        openBrowser: !noBrowser,
        manualBrowserHint: 'texra login --no-browser',
        onAuthUrl: (authUrl) => {
          if (!isCancelled()) setUrl(authUrl);
        },
      }),
    props,
  );

  return (
    <RelayProgressFrame spinnerLabel="Waiting for you to finish in the browser… (Ctrl-C cancels)">
      <Text>
        {noBrowser
          ? CLI_MANUAL_AUTH_URL_PROMPT
          : `Opening your browser to sign in with ${provider}…`}
      </Text>
      {url ? (
        <Text color="cyan">{url}</Text>
      ) : (
        <Text dimColor>
          {noBrowser
            ? 'Preparing the sign-in URL…'
            : "If it doesn't open, the URL will appear here."}
        </Text>
      )}
      {noBrowser ? <Text dimColor>{CLI_MANUAL_AUTH_REMOTE_HINT}</Text> : null}
    </RelayProgressFrame>
  );
}

function RelayDeviceProgressStep(
  props: RelayProgressCallbacks,
): React.JSX.Element {
  const [deviceAuth, setDeviceAuth] = useState<DeviceAuthorization | undefined>(
    undefined,
  );

  useSignInOnMount(
    (isCancelled) =>
      signInCliSupabaseDeviceCode({
        onDeviceCode: (authorization) => {
          if (!isCancelled()) setDeviceAuth(authorization);
        },
      }),
    props,
  );

  return (
    <RelayProgressFrame spinnerLabel="Waiting for you to approve in the browser… (Ctrl-C cancels)">
      <Text>{CLI_DEVICE_AUTH_URL_PROMPT}</Text>
      {deviceAuth ? (
        <>
          <Text color="cyan">{deviceAuth.verification_uri}</Text>
          <Text>
            and enter this code:{' '}
            <Text bold color="cyan">
              {deviceAuth.user_code}
            </Text>
          </Text>
        </>
      ) : (
        <Text dimColor>Requesting a sign-in code…</Text>
      )}
    </RelayProgressFrame>
  );
}

interface ChatGptProgressCallbacks {
  readonly onSuccess: (session: CodexSession) => void;
  readonly onError: (message: string) => void;
}

function ChatGptProgressStep(
  props: ChatGptProgressCallbacks & {
    readonly device: boolean;
  },
): React.JSX.Element {
  const { device } = props;
  const [message, setMessage] = useState(
    device
      ? 'Requesting a ChatGPT device code...'
      : 'Preparing ChatGPT sign-in...',
  );

  useCancellableEffect(async (isCancelled) => {
    try {
      const session = await signInCliChatGpt(
        { device, noBrowser: false },
        {
          writeProgress: (next) => {
            if (!isCancelled()) setMessage(next);
          },
        },
      );
      const update = await setPreferCodexSubscription(true);
      if (!update.effective) {
        if (!isCancelled()) {
          props.onError(
            'Signed in with ChatGPT, but a more specific setting keeps the subscription disabled. Choose Researcher Access or a provider API key instead.',
          );
        }
        return;
      }
      invalidateModelOptionsCache();
      if (!isCancelled()) props.onSuccess(session);
    } catch (loginError: unknown) {
      if (!isCancelled()) props.onError(toErrorMessage(loginError));
    }
  }, []);

  return (
    <RelayProgressFrame
      title="Use ChatGPT subscription"
      spinnerLabel="Waiting for ChatGPT sign-in… (Ctrl-C cancels)"
    >
      {message.split('\n').map((line, index) => (
        <Text key={`${index}:${line}`}>{line}</Text>
      ))}
    </RelayProgressFrame>
  );
}

function KeyProviderStep(props: {
  readonly activeProvider: ApiProvider;
  readonly onSelect: (provider: ApiProvider) => void;
  readonly onCancel: () => void;
}): React.JSX.Element {
  return (
    <OnboardingFrame
      title="Use my own provider API key"
      subtitle="Choose your provider:"
      hints={[
        { key: '↑/↓', action: 'navigate' },
        { key: '1-9/a-z/Enter', action: 'select' },
        { key: 'Esc', action: 'back' },
      ]}
    >
      <Select<ApiProvider>
        items={API_PROVIDERS.map((provider) => ({
          value: provider,
          label: PROVIDER_DISPLAY_NAMES[provider] ?? provider,
        }))}
        activeValue={props.activeProvider}
        onSelect={props.onSelect}
        onCancel={props.onCancel}
      />
    </OnboardingFrame>
  );
}
