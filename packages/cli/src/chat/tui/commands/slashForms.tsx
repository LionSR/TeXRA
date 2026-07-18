import { Box, Text, useInput, useWindowSize } from 'ink';
import { useLayoutEffect } from 'react';

import { isEscapeInput } from '../input/inputKeys';
import { FormFrame, formFrameWidth } from '../forms/_shared/FormFrame';
import { textDisplayWidth } from '../render/terminalText';
import { activeForm, formProgress, type FormProgress } from '../state/cliState';
import { appendLocalUserTranscript } from '../state/transcript';
import { COLOR_ERROR } from '../ui/colors';
import { KeyHints } from '../ui/KeyHints';
import { LoadingIndicator } from '../ui/LoadingIndicator';

import {
  findSlashCommand,
  shouldRedactSlashInput,
  type SlashCommand,
} from './slashRegistry';

export function appendSlashCommandEcho(line: string): void {
  if (!shouldRedactSlashInput(line)) appendLocalUserTranscript(line.trim());
}

/** Submit-side busy/settled surface for the active registered form. */
function FormBusyFrame(props: {
  readonly progress: FormProgress;
  readonly availableRows?: number;
}): React.JSX.Element {
  const { progress } = props;
  const { columns } = useWindowSize();
  const settled = progress.status !== 'running';
  useInput((input, key) => {
    if (key.ctrl) return;
    if (settled) {
      progress.dismiss();
      return;
    }
    if (isEscapeInput(input, key)) progress.cancel();
  });

  let titleSuffix = '';
  if (progress.status === 'succeeded') titleSuffix = ' · complete';
  if (progress.status === 'failed') titleSuffix = ' · error';
  const title = `${progress.title}${titleSuffix}`;
  const innerWidth = Math.max(1, formFrameWidth(columns) - 4);
  const wrappedRows = (text: string): number =>
    text.split('\n').reduce((rows, line) => {
      const width = textDisplayWidth(line.replaceAll('\t', '    '));
      return rows + Math.max(1, Math.ceil(width / innerWidth));
    }, 0);
  const copyableDoesNotFit =
    progress.copyableMessage !== undefined &&
    props.availableRows !== undefined &&
    2 +
      wrappedRows(title) +
      wrappedRows(progress.message ?? 'working...') +
      (progress.copyableMessage === progress.message
        ? 0
        : 1 + wrappedRows(progress.copyableMessage)) +
      1 +
      wrappedRows(settled ? 'any key close' : 'Esc cancel') >
      props.availableRows;
  useLayoutEffect(() => {
    if (copyableDoesNotFit) progress.archiveCopyable?.();
  }, [copyableDoesNotFit, progress]);
  const spinnerFrozen = progress.copyableMessage !== undefined;
  const displayMessage = copyableDoesNotFit
    ? 'Authentication instructions are being written to scrollback.'
    : progress.message;
  return (
    <FormFrame
      color={progress.status === 'failed' ? COLOR_ERROR : undefined}
      title={title}
      showCloseHint={false}
    >
      {progress.status === 'running' && !spinnerFrozen ? (
        <LoadingIndicator label={displayMessage ?? 'working...'} />
      ) : (
        displayMessage && <Text>{displayMessage}</Text>
      )}
      {!copyableDoesNotFit &&
        progress.copyableMessage &&
        progress.copyableMessage !== progress.message && (
          <Box marginTop={1}>
            <Text>{progress.copyableMessage}</Text>
          </Box>
        )}
      <Box marginTop={1}>
        <KeyHints
          hints={[
            settled
              ? { key: 'any key', action: 'close' }
              : { key: 'Esc', action: 'cancel' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </FormFrame>
  );
}

export function openRegisteredCliSlashForm(
  command: SlashCommand,
  remainder: string,
  onPersist?: () => void,
): boolean {
  const Form = command.formComponent;
  if (!Form) return false;
  let persisted = false;
  const persist = (): void => {
    if (persisted) return;
    persisted = true;
    onPersist?.();
  };
  formProgress.set(undefined);
  activeForm.set({
    commandName: command.name,
    escapeAction: command.formEscapeAction,
    render: (close, availableRows) => {
      const progress = formProgress.get();
      if (progress) {
        return (
          <FormBusyFrame progress={progress} availableRows={availableRows} />
        );
      }
      return (
        <Form
          availableRows={availableRows}
          remainder={remainder.trimStart()}
          onPersist={onPersist ? persist : undefined}
          echoOnPersist={command.echo === 'ifPersists'}
          onDone={close}
        />
      );
    },
  });
  return true;
}

export function openCliSlashCommandForm(
  commandName: string,
  remainder: string,
  onPersist?: () => void,
): boolean {
  const command = findSlashCommand(commandName);
  return command
    ? openRegisteredCliSlashForm(command, remainder, onPersist)
    : false;
}
