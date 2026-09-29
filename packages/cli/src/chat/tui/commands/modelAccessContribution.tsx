// The `model-access` slash contribution: `/key`, and `/login`, whose one form
// signs in and out, sets subscription preferences, adds keys, and, while no
// model is connected, is the chat's "Connect a model" panel.

import { Effect } from 'effect';

import type { CliModelAccessSelection } from '@cli/runtime/modelAccessRoute';
import {
  type CliLogoutTarget,
  type LoginFormValue,
  parseChatLoginSlashArgs,
} from '@cli/runtime/loginOptions';
import type { ApiProvider } from '@model/apiProviders';
import type { ProcessRuntime, ProcessServices } from '@platform/processRuntime';
import type { PlatformSecrets } from '@platform/secrets';
import type { SettingsStores } from '@shared/config/settingsAccess';

import {
  AccountAccessForm,
  type AccountAccessFormValue,
} from '../forms/AccountAccessForm';
import { ProviderApiKeyForm } from '../forms/ProviderApiKeyForm';
import { modelConnectionNeeded } from '../modelConnection';
import { setTransientNotice } from '../state/cliState';
import { appendLocalAssistantTranscript } from '../state/transcript';
import {
  applyCliModelAccessSelection,
  applyCliProviderApiKey,
  showCliAccountStatus,
} from './handlers/modelAccessCommands';
import {
  loginFromChat,
  loginStartMessage,
  logoutFromChat,
} from './handlers/loginCommands';
import { openCliSlashCommandForm } from './slashForms';
import type {
  SlashCommandEffect,
  SlashCommandOutput,
} from './handlers/slashContext';
import type { formSelectionHandler } from './formSelection';
import type { SlashCommandContribution, SlashFormProps } from './slashRegistry';

/** Selection handler that reports progress while the form shows a busy frame. */
export type FormActionHandler<T> = (
  value: T,
  output: SlashCommandOutput,
) => SlashCommandEffect;
/** The key write as a program; the form that collects the key runs it. */
export type ApiKeySaveHandler = (
  provider: ApiProvider,
  key: string,
) => Effect.Effect<string | void, Error>;

/** `registerBuiltinSlashCommands`' picker binding, shared with this plugin. */
type BindSelection = <T>(
  props: SlashFormProps,
  action: (value: T, output: SlashCommandOutput) => SlashCommandEffect,
  overrides?: Partial<
    Pick<
      Parameters<typeof formSelectionHandler<T>>[0],
      'onDone' | 'completion' | 'busyTitle'
    >
  >,
) => (value: T) => void;

type AccountAction = Exclude<AccountAccessFormValue, { kind: 'key' }>;

export function modelAccessContribution(deps: {
  readonly secrets: PlatformSecrets;
  readonly stores: SettingsStores;
  readonly runtime: ProcessRuntime;
  readonly bindSelection: BindSelection;
  readonly onModelAccessSelect?: FormActionHandler<CliModelAccessSelection>;
  readonly onApiKeySave?: ApiKeySaveHandler;
  readonly onLoginSelect?: FormActionHandler<LoginFormValue>;
  readonly onLogoutSelect?: FormActionHandler<CliLogoutTarget>;
  /** After a sign-in, sign-out, preference, or key save settles: the chat
   *  re-checks whether a model can answer now. */
  readonly onAccountChanged?: () => Effect.Effect<void, never, ProcessServices>;
}): SlashCommandContribution {
  const { secrets, stores, runtime, bindSelection } = deps;
  const onModelAccessSelect: FormActionHandler<CliModelAccessSelection> =
    deps.onModelAccessSelect ??
    ((selection, output) =>
      applyCliModelAccessSelection(stores, selection, undefined, output));
  const onApiKeySave: ApiKeySaveHandler =
    deps.onApiKeySave ??
    ((provider, key) => applyCliProviderApiKey(secrets, stores, provider, key));
  const onLoginSelect: FormActionHandler<LoginFormValue> =
    deps.onLoginSelect ??
    ((value, output) =>
      loginFromChat(value, stores, runtime, undefined, output));
  const onLogoutSelect: FormActionHandler<CliLogoutTarget> =
    deps.onLogoutSelect ??
    ((value, output) => logoutFromChat(value, stores, secrets, output));
  const recheck = (): Effect.Effect<void, never, ProcessServices> =>
    deps.onAccountChanged?.() ?? Effect.void;

  function AccountAccessFormAdapter(props: SlashFormProps): React.JSX.Element {
    const bound = bindSelection<AccountAction>(
      props,
      (value, output) => {
        switch (value.kind) {
          case 'access':
            return onModelAccessSelect(value.selection, output);
          case 'login':
            return onLoginSelect(value.target, output);
          case 'logout':
            return onLogoutSelect(value.target, output);
          default:
            return value satisfies never;
        }
      },
      {
        onDone: (value) => {
          props.onDone(value);
          runtime.runFork(recheck());
        },
        completion: 'busy',
        busyTitle: (value) => {
          switch (value.kind) {
            case 'access':
              return 'Updating model access';
            case 'login': {
              const args = parseChatLoginSlashArgs(value.target);
              return args ? loginStartMessage(args) : 'Signing in';
            }
            case 'logout':
              return 'Signing out';
            default:
              return value satisfies never;
          }
        },
      },
    );
    return (
      <AccountAccessForm
        secrets={secrets}
        stores={stores}
        runtime={runtime}
        availableRows={props.availableRows}
        connecting={modelConnectionNeeded.get()}
        onSelect={(value) => {
          if (value.kind !== 'key') {
            bound(value);
            return;
          }
          // The key form takes the slot this form leaves; closing first keeps
          // `takeActiveForm` from requeueing this form behind it.
          props.onDone(undefined);
          openCliSlashCommandForm('key', '');
        }}
        onCancel={() => props.onDone(undefined)}
      />
    );
  }

  function ProviderApiKeyFormAdapter(props: SlashFormProps): React.JSX.Element {
    return (
      <ProviderApiKeyForm
        availableRows={props.availableRows}
        runtime={runtime}
        onSave={onApiKeySave}
        onDone={(provider, modelNotice) => {
          // The shared key controller posts the "key has been set" notice on
          // every host; only the coding-plan tip is this surface's to write.
          if (modelNotice) appendLocalAssistantTranscript(modelNotice);
          props.onDone(provider);
          runtime.runFork(recheck());
        }}
        onCancel={() => props.onDone(undefined)}
      />
    );
  }

  return {
    pluginId: 'model-access',
    commands: [
      {
        name: 'key',
        description: 'Add a provider API key with masked input',
        aliases: ['keys'],
        category: 'account',
        echo: 'never',
        // A remainder never reaches the form: it could be the key itself,
        // so it is refused and dropped rather than pre-filled.
        handler: (remainder) =>
          Effect.sync(() => {
            if (remainder) {
              setTransientNotice(
                'For safety, `/key` does not accept a key as an argument. Enter it in the masked form.',
              );
            }
            openCliSlashCommandForm('key', '');
          }),
        formComponent: ProviderApiKeyFormAdapter,
        redactInput: true,
      },
      {
        name: 'login',
        description: 'Sign in or out, and choose subscriptions or API keys',
        category: 'account',
        // One form owns sign-in, sign-out, and subscription preferences, so
        // the typed command is not an accurate transcript row; outcomes are
        // written by the form's handlers.
        echo: 'never',
        handler: (remainder, context) =>
          remainder.trim().toLowerCase() === 'status'
            ? showCliAccountStatus(stores, secrets)
            : loginFromChat(
                remainder,
                stores,
                runtime,
                context.cliContext,
              ).pipe(Effect.andThen(recheck)),
        formComponent: AccountAccessFormAdapter,
      },
    ],
  };
}
