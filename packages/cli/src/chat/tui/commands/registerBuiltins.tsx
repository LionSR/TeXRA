// Registers the slash commands the input palette surfaces.
//
// Idempotent at the call-site granularity: the module-scope `installed`
// flag short-circuits repeat invocations, so registrations that were
// individually unregistered won't reappear without a process restart.

import { ModelForm } from '../forms/ModelForm';
import { cliState } from '../state/cliState';
import { registerSlashCommand, type SlashFormProps } from './slashRegistry';

/** Adapter: wires the `/model` form's `(value)=>void` API into the generic
 *  `SlashFormProps<unknown>` shape the registry expects. */
function ModelFormAdapter(props: SlashFormProps): React.JSX.Element {
  const current = cliState.sessionMeta.get().model;
  return (
    <ModelForm
      currentModel={current}
      onSelect={(value) => {
        cliState.sessionMeta.set({
          ...cliState.sessionMeta.get(),
          model: value,
        });
        props.onDone(value);
      }}
      onCancel={() => props.onDone(undefined)}
    />
  );
}

let installed = false;

export function registerBuiltinSlashCommands(): void {
  if (installed) return;
  installed = true;

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
