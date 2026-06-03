// First-run authentication onboarding for the interactive `texra` CLI.
//
// Replaces today's dead-end (a launcher full of "login required" models that
// errors out when the user picks chat) with a 2-choice picker, modeled on
// Claude Code / Gemini CLI / aider: the no-key included-relay login is the
// recommended default when both modes are viable, bring-your-own provider key is
// second, and skip is explicit. After credentials are set the caller re-reads
// availability in the SAME process (the relay/key paths invalidate the relevant
// caches), so the launcher/chat continues with real models — no restart.
//
// TTY-only: the gate returns immediately in headless / non-TTY / dumb-terminal
// runs, and both entry points already reject those before calling it, so
// `texra run` / `--print` / piped output stay byte-identical (headless parity).

import { render, Box, Text, useApp, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';
import { useEffect, useState } from 'react';

import { platform } from '@platform/platform';
import { DEFAULT_OAUTH_PROVIDER } from '@auth/config';
import { type OAuthProvider } from '@auth/sharedConfig';
import { toErrorMessage } from '@common/errors/errorMessage';
import { API_PROVIDERS, type ApiProvider } from '@model/apiProviders';
import { PROVIDER_DISPLAY_NAMES } from '@shared/constants/providers';

import { assertNever } from '../chat/tui/assertNever';
import { ApiKeyEntryForm } from '../chat/tui/forms/ApiKeyEntryForm';
import { clearTerminalVisibleScreen } from '../chat/tui/terminalCleanup';
import { KeyHints, type KeyHint } from '../chat/tui/ui/KeyHints';
import { Select, type SelectItem } from '../chat/tui/ui/Select';
import { formatCliAccountLabelForDisplay } from '../runtime/accountDisplay';
import { type CliApiMode } from '../runtime/apiAccessMode';
import { hasCliCredentialForApiMode } from '../runtime/credentialStatus';
import { writeTextStderr, writeTextStdout } from '../runtime/logSinks';
import { signInCliSupabase } from '../runtime/supabaseAuth';
import { interactiveTerminalFailure } from '../runtime/terminalRequirements';

import { saveProviderApiKey } from './applyOnboardingResult';
import {
  getOnboardingDeclined,
  setOnboardingDeclined,
} from './onboardingState';

export interface CliOnboardingResult {
  /** True when the user finished a sign-in or saved a key this run. */
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
  readonly apiMode?: CliApiMode;
}

const SKIP_SUMMARY =
  "Setup skipped — run `texra login` or `texra setup` when you're ready.";

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
    return { configured: false, declined: false };
  }
  if (getOnboardingDeclined(platform().globalState)) {
    return { configured: false, declined: false };
  }
  if (await hasCliCredentialForApiMode(context.apiMode).catch(() => false)) {
    return { configured: false, declined: false };
  }
  return runOnboardingFlow({ firstRun: true, apiMode: context.apiMode });
}

/**
 * `texra setup`: always show the picker for re-configuration, bypassing the
 * has-credentials / declined gate. Still TTY-only — the command rejects
 * headless before calling this.
 */
export async function runCliOnboarding(): Promise<CliOnboardingResult> {
  if (!process.stdout.isTTY) return { configured: false, declined: false };
  return runOnboardingFlow({ firstRun: false });
}

async function runOnboardingFlow(options: {
  readonly firstRun: boolean;
  readonly apiMode?: CliApiMode;
}): Promise<CliOnboardingResult> {
  const pickerSubtitle = onboardingPickerSubtitle(options);
  const pickerItems = onboardingPickerItems(onboardingSetupPaths(options));
  const resolution = await new Promise<OnboardingResolution>((resolve) => {
    let chosen: OnboardingResolution = { configured: false, declined: false };
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
        stdout: process.stdout,
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
  return { configured: resolution.configured, declined: resolution.declined };
}

type Screen =
  | 'picker'
  | 'relay-provider'
  | 'relay-progress'
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
        onRelay={() => {
          setError(undefined);
          setScreen('relay-provider');
        }}
        onKey={() => {
          setError(undefined);
          setScreen('key-provider');
        }}
        onSkip={skip}
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
        onCancel={() => setScreen('picker')}
      />
    );
  }

  if (screen === 'relay-progress') {
    return (
      <RelayProgressStep
        provider={relayProvider}
        noBrowser={noBrowser}
        onSuccess={(label) =>
          finish({
            configured: true,
            declined: false,
            summary: `Signed in as ${formatCliAccountLabelForDisplay(
              label,
            )}. Included relay access is active.`,
          })
        }
        onError={(message) => {
          setError(message);
          setScreen('relay-provider');
        }}
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
    return 'Choose how to power model calls — sign in, or add a provider API key:';
  }
  if (props.apiMode === 'included') {
    return 'Included relay access needs sign-in for this run:';
  }
  if (props.apiMode === 'personal') {
    return 'Personal API-key mode needs a provider key for this run:';
  }
  return 'Not signed in, and no provider API key is configured. Choose how to power model calls:';
}

type OnboardingChoice = 'relay' | 'key' | 'skip';
type OnboardingSetupPath = Exclude<OnboardingChoice, 'skip'>;
type OnboardingPickerItem = SelectItem<OnboardingChoice>;

const RELAY_PICKER_ITEM: OnboardingPickerItem = {
  value: 'relay',
  label: 'Sign in for included relay access (recommended)',
  description: 'opens your browser, no API key needed',
};

const KEY_PICKER_ITEM: OnboardingPickerItem = {
  value: 'key',
  label: 'Use my own provider API key',
  description: 'paste an Anthropic / OpenAI / Google key',
};

const SKIP_PICKER_ITEM: OnboardingPickerItem = {
  value: 'skip',
  label: 'Skip for now',
  description: 'set up later: texra login / texra setup',
};

function onboardingSetupPaths(props: {
  readonly firstRun: boolean;
  readonly apiMode?: CliApiMode;
}): readonly OnboardingSetupPath[] {
  if (!props.firstRun) return ['relay', 'key'];
  if (props.apiMode === 'included') return ['relay'];
  if (props.apiMode === 'personal') return ['key'];
  return ['relay', 'key'];
}

function onboardingPickerItems(
  setupPaths: readonly OnboardingSetupPath[],
): readonly OnboardingPickerItem[] {
  return [
    ...setupPaths.map((path) =>
      path === 'relay' ? RELAY_PICKER_ITEM : KEY_PICKER_ITEM,
    ),
    SKIP_PICKER_ITEM,
  ];
}

function PickerStep(props: {
  readonly subtitle: string;
  readonly items: readonly OnboardingPickerItem[];
  readonly onRelay: () => void;
  readonly onKey: () => void;
  readonly onSkip: () => void;
}): React.JSX.Element {
  return (
    <OnboardingFrame
      title="Welcome to TeXRA"
      subtitle={props.subtitle}
      hints={[
        { key: '↑/↓', action: 'navigate' },
        { key: `1-${props.items.length}/Enter`, action: 'select' },
        { key: 'Esc', action: 'skip' },
      ]}
    >
      <Select<OnboardingChoice>
        items={props.items}
        onSelect={(value) => {
          if (value === 'relay') props.onRelay();
          else if (value === 'key') props.onKey();
          else props.onSkip();
        }}
        onCancel={props.onSkip}
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
  readonly onCancel: () => void;
}): React.JSX.Element {
  // `n` toggles no-browser. The Select child ignores `n` (no row 22), so the
  // two active useInput handlers never collide on it.
  useInput((input, key) => {
    if (!key.ctrl && !key.meta && input.toLowerCase() === 'n') {
      props.onToggleNoBrowser();
    }
  });

  return (
    <OnboardingFrame
      title="Sign in · included relay"
      subtitle={
        props.noBrowser
          ? 'No-browser mode: we print the sign-in URL instead of opening it.'
          : 'Choose a provider to sign in with:'
      }
      error={props.error}
      hints={[
        { key: '↑/↓', action: 'navigate' },
        { key: '1-2/Enter', action: 'select' },
        { key: 'n', action: 'no-browser' },
        { key: 'Esc', action: 'back' },
      ]}
    >
      <Select<OAuthProvider>
        items={[
          { value: 'github', label: 'GitHub' },
          { value: 'google', label: 'Google' },
        ]}
        activeValue={props.activeProvider}
        onSelect={props.onSelect}
        onCancel={props.onCancel}
      />
    </OnboardingFrame>
  );
}

function RelayProgressStep(props: {
  readonly provider: OAuthProvider;
  readonly noBrowser: boolean;
  readonly onSuccess: (accountLabel: string) => void;
  readonly onError: (message: string) => void;
}): React.JSX.Element {
  const { provider, noBrowser, onSuccess, onError } = props;
  const [url, setUrl] = useState<string | undefined>(undefined);

  // Start the sign-in exactly once on mount. Empty deps is deliberate (not the
  // captured props): re-running would open a second browser + loopback server,
  // and a deps-triggered cleanup would flip `cancelled` and orphan the in-flight
  // login (eternal spinner). The captured callbacks only invoke stable state
  // setters / app.exit, so the mount-time closure stays correct. `cancelled`
  // guards against the real unmount (the user navigating away).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const session = await signInCliSupabase({
          provider,
          openBrowser: !noBrowser,
          manualBrowserHint: 'texra login --no-browser',
          onAuthUrl: (authUrl) => {
            if (!cancelled) setUrl(authUrl);
          },
        });
        if (!cancelled) onSuccess(session.account.label);
      } catch (loginError: unknown) {
        if (!cancelled) onError(toErrorMessage(loginError));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="cyan">
        Sign in · included relay
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          {noBrowser
            ? 'Open this URL on any device to sign in:'
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
      </Box>
      <Box marginTop={1}>
        <Spinner label="Waiting for you to finish in the browser… (Ctrl-C cancels)" />
      </Box>
    </Box>
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
