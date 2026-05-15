import { useCallback, useState } from 'react';
import { Box, Text, useStdout } from 'ink';

import { BaseTextInput } from '../input/BaseTextInput';

export interface InputBarProps {
  /** Forwarded to BaseTextInput; called only on real (non-paste) Enter. */
  readonly onSubmit: (value: string) => void;
  /** Disable the input while an approval modal is owning the screen. */
  readonly disabled?: boolean;
  /** Prompt prefix (e.g. `>`). */
  readonly prompt?: string;
}

export function InputBar(props: InputBarProps): React.JSX.Element {
  const { stdout } = useStdout();
  const [value, setValue] = useState('');

  const handleSubmit = useCallback(
    (submitted: string) => {
      const trimmed = submitted.trim();
      if (trimmed.length === 0) return;
      setValue('');
      props.onSubmit(trimmed);
    },
    [props],
  );

  return (
    <Box borderStyle="round" paddingX={1}>
      <Text>{props.prompt ?? '>'} </Text>
      <BaseTextInput
        value={value}
        focus={!props.disabled}
        onChange={setValue}
        onSubmit={handleSubmit}
        width={Math.max(20, (stdout?.columns ?? 80) - 4)}
      />
    </Box>
  );
}
