// Paste-aware text input wrapping `ink-text-input`.
//
// Ctrl-J inserts a newline. Bracketed paste detection returns in Phase 5;
// the raw-stdin listener was removed because it drained bytes before Ink.

import { useInput } from 'ink';
import TextInput from 'ink-text-input';

export interface BaseTextInputProps {
  readonly value: string;
  readonly placeholder?: string;
  readonly focus?: boolean;
  readonly onSubmit: (value: string) => void;
  readonly onChange: (value: string) => void;
}

export function BaseTextInput(props: BaseTextInputProps): React.JSX.Element {
  useInput(
    (input, key) => {
      if (key.ctrl && input === 'j') {
        // Ctrl-J → literal newline (kills the legacy `/multi` ceremony).
        props.onChange(`${props.value}\n`);
      }
    },
    { isActive: props.focus !== false },
  );

  return (
    <TextInput
      value={props.value}
      placeholder={props.placeholder}
      focus={props.focus ?? true}
      showCursor
      onChange={props.onChange}
      onSubmit={props.onSubmit}
    />
  );
}
