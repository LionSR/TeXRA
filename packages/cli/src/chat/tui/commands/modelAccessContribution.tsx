// The `model-access` slash contribution: `/key`, and `/login`, whose one form
// signs in and out, sets subscription preferences, adds keys, and, while no
// model is connected, is the chat's "Connect a model" panel.

import { Effect } from 'effect';

import { apiKeyOrigins } from '@texra-ai/llm';

import { Secrets } from '@texra-ai/harness/plugins';
import { parseChatLoginSlashArgs } from '@cli/runtime/models/loginOptions';

import {
  AccountAccessForm,
  type AccountAccessFormValue,
} from '../forms/AccountAccessForm';
import { ProviderApiKeyForm } from '../forms/ProviderApiKeyForm';
import { useAsyncResource } from '../forms/_shared/useAsyncListForm';
import { modelConnectionNeeded } from '../modelConnection';
import { setTransientNotice } from '../state/cliState';
import { appendLocalNotice } from '../state/transcript';
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
import { bindSelection, reportFormError } from './formSelection';
import { openRegisteredCliSlashForm } from './slashForms';
import {
  useSlashContext,
  type SlashCommand,
  type SlashCommandContribution,
  type SlashFormProps,
} from './slashRegistry';

type AccountAction = Exclude<AccountAccessFormValue, { kind: 'key' }>;

export function modelAccessContribution(): SlashCommandContribution & {
  readonly login: SlashCommand;
} {
  function AccountAccessFormAdapter(props: SlashFormProps): React.JSX.Element {
    const context = useSlashContext();
    const { stores, runtime } = context;
    const bound = bindSelection<AccountAction>(
      context,
      props,
      (value, _context, output) => {
        switch (value.kind) {
          case 'access':
            return applyCliModelAccessSelection(
              value.selection,
              context,
              output,
            );
          case 'login':
            return loginFromChat(value.target, context, output);
          case 'logout':
            return logoutFromChat(value.target, stores, output);
          default:
            return value satisfies never;
        }
      },
      {
        onDone: (value) => {
          props.onDone(value);
          runtime.runFork(context.onAccountChanged());
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
          openRegisteredCliSlashForm(key);
        }}
        onCancel={() => props.onDone(undefined)}
      />
    );
  }

  function ProviderApiKeyFormAdapter(props: SlashFormProps): React.JSX.Element {
    const context = useSlashContext();
    const { runtime } = context;
    // A failed status read is said in the transcript; the rows then read
    // "Status unavailable".
    const apiKeys = useAsyncResource({
      load: () => Effect.flatMap(Secrets, apiKeyOrigins),
      onError: (error) => reportFormError(error),
    });
    return (
      <ProviderApiKeyForm
        availableRows={props.availableRows}
        statusView={{
          statuses: apiKeys.data,
          loading: apiKeys.loading,
          error: apiKeys.error !== undefined,
        }}
        onSave={(provider, apiKey) =>
          applyCliProviderApiKey(context.stores, provider, apiKey)
        }
        onDone={(provider, modelNotice) => {
          // The shared key controller posts the "key has been set" notice on
          // every host; only the coding-plan tip is this surface's to write.
          if (modelNotice) appendLocalNotice(modelNotice);
          props.onDone(provider);
          runtime.runFork(context.onAccountChanged());
        }}
        onCancel={() => props.onDone(undefined)}
      />
    );
  }

  const key: SlashCommand = {
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
        openRegisteredCliSlashForm(key);
      }),
    formComponent: ProviderApiKeyFormAdapter,
    redactInput: true,
  };
  const login: SlashCommand = {
    name: 'login',
    description: 'Sign in or out, and choose subscriptions or API keys',
    category: 'account',
    // One form owns sign-in, sign-out, and subscription preferences, so
    // the typed command is not an accurate transcript row; outcomes are
    // written by the form's handlers.
    echo: 'never',
    handler: (remainder, context) =>
      remainder.trim().toLowerCase() === 'status'
        ? showCliAccountStatus(context.stores)
        : loginFromChat(remainder, context).pipe(
            Effect.andThen(context.onAccountChanged()),
          ),
    formComponent: AccountAccessFormAdapter,
  };
  return { pluginId: 'model-access', commands: [key, login], login };
}
