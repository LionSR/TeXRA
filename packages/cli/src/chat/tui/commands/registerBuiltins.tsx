// Registers the slash commands the input palette surfaces.

import { ModelForm } from '../forms/ModelForm';
import { cliState } from '../state/cliState';
import { registerSlashCommand, type SlashFormProps } from './slashRegistry';

type ModelSelectHandler = (value: string) => void | Promise<void>;

const defaultModelSelect: ModelSelectHandler = (value) => {
  cliState.sessionMeta.set({
    ...cliState.sessionMeta.get(),
    model: value,
  });
};

export function registerBuiltinSlashCommands(options?: {
  onModelSelect?: ModelSelectHandler;
}): void {
  const onModelSelect = options?.onModelSelect ?? defaultModelSelect;

  /** Adapter: wires the `/model` form's `(value)=>void` API into the generic
   *  `SlashFormProps<unknown>` shape the registry expects. */
  function ModelFormAdapter(props: SlashFormProps): React.JSX.Element {
    const current = cliState.sessionMeta.get().model;
    return (
      <ModelForm
        currentModel={current}
        onSelect={(value) => {
          void Promise.resolve(onModelSelect(value)).finally(() =>
            props.onDone(value),
          );
        }}
        onCancel={() => props.onDone(undefined)}
      />
    );
  }

  registerSlashCommand({
    name: 'help',
    description: 'Show available slash commands',
  });
  registerSlashCommand({
    name: 'clear',
    description: 'Clear the screen (scrollback preserved)',
  });
  registerSlashCommand({
    name: 'agent',
    description: 'Switch the active agent',
  });
  registerSlashCommand({
    name: 'model',
    description: 'Switch the active model',
    formComponent: ModelFormAdapter,
  });
  registerSlashCommand({
    name: 'api',
    description: 'Switch between included relay and personal API keys',
  });
  registerSlashCommand({
    name: 'auth',
    description: 'Show TeXRA login status',
  });
  registerSlashCommand({
    name: 'approval',
    description: 'Switch approval policy',
  });
  registerSlashCommand({
    name: 'yolo',
    description: 'Approve privileged actions automatically',
  });
  registerSlashCommand({
    name: 'status',
    description: 'Open the session status tabs',
  });
  registerSlashCommand({
    name: 'resume',
    description: 'Resume a previous session',
  });
  registerSlashCommand({
    name: 'exit',
    description: 'Exit the CLI session',
    aliases: ['quit'],
  });
}
