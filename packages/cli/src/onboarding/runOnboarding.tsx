// First-run authentication onboarding for the interactive `texra` CLI.
//
// A credential picker with three first-class paths (ChatGPT subscription,
// Researcher Access, bring-your-own provider key) plus an explicit skip. After
// credentials are set the caller re-reads availability in the SAME process
// (the included/ChatGPT/personal paths invalidate the relevant caches), so the
// launcher/chat continues with real models, with no restart.
//
// TTY-only: the gate returns immediately in headless / non-TTY / dumb-terminal
// runs, and both entry points already reject those before calling it, so
// `texra run` / `--print` / piped output stay byte-identical (headless parity).

import { Box, Text, useApp, useInput } from 'ink';
import { useState } from 'react';

import { listExecutions } from '@agent/storage';
import type { SupabaseSession } from '@auth/SupabaseSession';
import { DEFAULT_OAUTH_PROVIDER, type OAuthProvider } from '@auth/config';
import type { CodexSession } from '@auth/codex';
import { codexAccountLabel } from '@auth/codex/codexSessionTypes';
import { BorderedPanel } from '@cli/tui/ui/BorderedPanel';
import { LoadingIndicator } from '@cli/tui/ui/LoadingIndicator';
import { useCancellableEffect } from '@cli/tui/useCancellableEffect';
import { renderCliPrompt } from '@cli/tui/renderCliPrompt';
import { KeyHints, type KeyHint } from '@cli/tui/ui/KeyHints';
import { Select, type SelectItem } from '@cli/tui/ui/Select';
import { COLOR_ERROR, COLOR_HINT } from '@cli/tui/ui/colors';
import { CROSS } from '@cli/tui/ui/glyphs';
import { planOnboardingFunnelTransition } from '@controllers/onboarding/onboardingFunnel';
import { warn as logWarning } from '@logger/logUtils';
import { API_PROVIDERS, type ApiProvider } from '@model/apiProviders';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import { setPreferCodexSubscription } from '@model/codex/codexPreference';
import { platform } from '@platform/platform';
import type { ApiAccessMode } from '@shared/schemas';
import {
  backfillFirstRunDone,
  readOnboardingFlags,
  setOnboardingDeclined,
} from '@shared/state/onboardingState';
import { providerDisplayName } from '@shared/constants/providers';
import { GlobalStateKey } from '@shared/state/stateKeys';

import {
  ONBOARDING_CARD_TITLE,
  ONBOARDING_CHOICE_API_KEY,
  ONBOARDING_CHOICE_CHATGPT,
  ONBOARDING_CHOICE_SIGN_IN,
  ONBOARDING_CHOICE_SKIP_LABEL,
} from '@shared/copy/onboarding';
import { INCLUDED_ACCESS, OWN_API_KEYS } from '@shared/copy/modelAccess';
import { assertNever } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { ApiKeyEntryForm } from '../chat/tui/forms/ApiKeyEntryForm';
import { setCliApiMode } from '../runtime/apiAccessMode';
import { signInCliChatGpt } from '../runtime/chatgptLogin';
import { hasCliCredentialForApiMode } from '../runtime/credentialStatus';
import { cliApiFallbackSelection } from '../runtime/modelAccessRoute';
import { updateCliModelAccess } from '../runtime/modelAccessSelection';
import { saveProviderApiKey } from '../runtime/providerApiKey';
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

import { formatSavedKeySummary } from './onboardingState';

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
interface OnboardingGateContext {
  readonly mode: 'headless' | 'interactive';
  readonly stdoutIsTty?: boolean;
  readonly termIsDumb?: boolean;
  readonly stdoutColorEnabled?: boolean;
  readonly apiMode?: ApiAccessMode;
}

const LOG_CHANNEL = 'CLI Onboarding';

/**
 * The gate degrades to "not configured yet" when a state read or write fails,
 * which at worst re-prompts. Say why in the log so a read-only home directory
 * or an unreadable history store is diagnosable rather than looking like the
 * gate's normal behavior.
 */
function warnOnboardingFailure(action: string, error: unknown): void {
  logWarning(LOG_CHANNEL, `${action} failed: ${toErrorMessage(error)}`);
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

interface OnboardingResolution extends CliOnboardingResult {
  /** Line printed to stdout once the picker settles, when there is one. */
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
  const hasCredential = await hasCliCredentialForApiMode(context.apiMode);
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
        (error: unknown) => {
          warnOnboardingFailure('Run-history check', error);
          return false;
        },
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
  }).catch((error: unknown) =>
    warnOnboardingFailure('First-run backfill write', error),
  );
  // Route through the same funnel-transition planner the extension/desktop
  // hosts use, rather than a hand-copied precedence ladder. `selectSetupAgent`
  // is discarded: the CLI has no launcher agent list to steer. Clearing a
  // stale skip must stay decoupled from the 3-way state — an
  // already-credentialed launch clears a stale skip (the PRD's "configuring a
  // credential clears the flag") even when firstRunDone is also true, which
  // `transition.clearDeclined` captures directly.
  const transition = planOnboardingFunnelTransition(undefined, {
    hasCredential,
    ...readOnboardingFlags(globalState),
  });
  if (transition.clearDeclined) {
    await setOnboardingDeclined(globalState, false).catch((error: unknown) =>
      warnOnboardingFailure('Clearing the stale skip flag', error),
    );
  }
  // `configured` stays false for both 'done' and 'setup': an
  // already-credentialed or already-completed launch is not a post-picker
  // continuation, so the setup agent only takes the session right after the
  // picker actually configures a credential in this process.
  if (transition.state !== 'needs-credential') {
    return NO_ONBOARDING_RESULT;
  }
  return runOnboardingFlow({
    firstRun: true,
    apiMode: context.apiMode,
    colorEnabled: context.stdoutColorEnabled,
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
  readonly apiMode?: ApiAccessMode;
  readonly colorEnabled?: boolean;
}): Promise<CliOnboardingResult> {
  const picker = onboardingPicker(options);
  // `interactive`: both callers reject non-TTY output before reaching this
  // flow. Keep that product boundary authoritative when a real PTY also has CI
  // set; Ink otherwise disables interactive rendering from its CI heuristic.
  // The visible-screen clear keeps scrollback intact so the summary below
  // lands there.
  const chosen = await renderCliPrompt<OnboardingResolution>(
    (resolve) => (
      <OnboardingApp
        pickerSubtitle={picker.subtitle}
        pickerItems={picker.items}
        onResolve={resolve}
      />
    ),
    {
      stdout: process.stdout,
      stderr: process.stderr,
      colorEnabled: options.colorEnabled,
      interactive: true,
    },
  );
  const resolution: OnboardingResolution = chosen ?? NO_ONBOARDING_RESULT;

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
    await setOnboardingDeclined(platform().globalState, false).catch(
      (error: unknown) =>
        warnOnboardingFailure('Clearing the stale skip flag', error),
    );
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
        summary: `Signed in as ${label}. ${INCLUDED_ACCESS.label} is active.`,
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
      const label = codexAccountLabel(session);
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
              await saveProviderApiKey(keyProvider, key);
              const selection = await updateCliModelAccess(
                undefined,
                cliApiFallbackSelection('personal'),
              );
              finish({
                configured: true,
                declined: false,
                summary: formatSavedKeySummary(keyProvider, selection),
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
    <BorderedPanel
      color={COLOR_HINT}
      title={props.title}
      footer={<KeyHints hints={props.hints} confirmCancel={false} />}
    >
      {props.subtitle ? <Text dimColor>{props.subtitle}</Text> : null}
      {props.error ? (
        <Text color={COLOR_ERROR}>{`${CROSS} ${props.error}`}</Text>
      ) : null}
      <Box marginTop={1} flexDirection="column">
        {props.children}
      </Box>
    </BorderedPanel>
  );
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
  description: 'Set up later with `texra setup`',
};

interface OnboardingPicker {
  readonly subtitle: string;
  readonly items: readonly OnboardingPickerItem[];
}

/** Picker copy and the credential paths offered, for one entry point. */
function onboardingPicker(props: {
  readonly firstRun: boolean;
  readonly apiMode?: ApiAccessMode;
}): OnboardingPicker {
  const picker = (
    subtitle: string,
    setupPaths: readonly OnboardingSetupPath[],
  ): OnboardingPicker => ({
    subtitle,
    items: [
      ...setupPaths.map((path) => SETUP_PATH_PICKER_ITEMS[path]),
      SKIP_PICKER_ITEM,
    ],
  });

  if (!props.firstRun) {
    return picker('Choose how to power model calls:', [
      'chatgpt',
      'relay',
      'key',
    ]);
  }
  if (props.apiMode === 'included') {
    return picker(
      `Sign in to use a subscription or ${INCLUDED_ACCESS.inline} for this run:`,
      ['chatgpt', 'relay'],
    );
  }
  if (props.apiMode === 'personal') {
    return picker(
      `To use ${OWN_API_KEYS.inline} for this run, sign in to ChatGPT or add a provider key:`,
      ['chatgpt', 'key'],
    );
  }
  return picker(
    'Not signed in, and no provider API key is configured. Choose how to power model calls:',
    ['chatgpt', 'relay', 'key'],
  );
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

  let subtitle: string;
  if (props.noBrowser) {
    subtitle =
      'No-browser mode: we print the sign-in URL instead of opening it.';
  } else if (isLikelyRemoteSession()) {
    subtitle =
      'Remote session detected — press d for device-code sign-in (no callback port needed).';
  } else {
    subtitle = 'Choose a provider to sign in with:';
  }

  return (
    <OnboardingFrame
      title="Sign in · Researcher Access"
      subtitle={subtitle}
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
      // Picking Researcher Access in the funnel is the mode choice itself, so
      // record it here. Signing in does not touch the preference on its own:
      // a credential says who you are, not which route you want.
      await setCliApiMode('included');
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
    <BorderedPanel
      color={COLOR_HINT}
      title={props.title ?? 'Sign in · Researcher Access'}
      footer={<LoadingIndicator label={props.spinnerLabel} />}
    >
      <Box marginTop={1} flexDirection="column">
        {props.children}
      </Box>
    </BorderedPanel>
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
        <Text color={COLOR_HINT}>{url}</Text>
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
          <Text color={COLOR_HINT}>{deviceAuth.verification_uri}</Text>
          <Text>
            and enter this code:{' '}
            <Text bold color={COLOR_HINT}>
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
      title={ONBOARDING_CHOICE_CHATGPT.label}
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
      title={ONBOARDING_CHOICE_API_KEY.label}
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
          label: providerDisplayName(provider),
        }))}
        activeValue={props.activeProvider}
        onSelect={props.onSelect}
        onCancel={props.onCancel}
      />
    </OnboardingFrame>
  );
}
