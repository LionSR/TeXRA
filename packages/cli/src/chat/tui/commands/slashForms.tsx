import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { useLayoutEffect, useState } from 'react';

import { isEscapeInput } from '@cli/tui/inputKeys';
import { writeTerminalSequence } from '@cli/tui/terminalCleanup';
import { borderedPanelChromeRows } from '@cli/tui/ui/BorderedPanel';
import { KeyHints } from '@cli/tui/ui/KeyHints';
import { LoadingIndicator } from '@cli/tui/ui/LoadingIndicator';
import { COLOR_ERROR } from '@cli/tui/ui/colors';
import { wrappedRowCount } from '@cli/tui/ansiWrap';
import { FormFrame, formFrameContentWidth } from '../forms/_shared/FormFrame';
import { formProgress, type FormProgress } from '../state/cliState';
import { takeActiveForm } from '../state/formSlot';
import { useSignal } from '../state/useSignal';
import { appendLocalUserTranscript } from '../state/transcript';

import {
  findSlashCommand,
  shouldRedactSlashInput,
  type SlashCommand,
} from './slashRegistry';

export function appendSlashCommandEcho(line: string): void {
  if (!shouldRedactSlashInput(line)) appendLocalUserTranscript(line.trim());
}

const CLIPBOARD_TOOL: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'pbcopy',
  win32: 'clip',
};

/**
 * Put text on the system clipboard. The framed panel hard-wraps a long URL
 * and adds its borders, so a mouse selection cannot copy it cleanly. OSC 52
 * reaches the local clipboard over SSH; the platform tool covers terminals
 * without OSC 52 (Terminal.app).
 */
function copyToClipboard(text: string): void {
  writeTerminalSequence(
    `\u001B]52;c;${Buffer.from(text).toString('base64')}\u0007`,
  );
  const child = execFile(
    CLIPBOARD_TOOL[platform()] ?? 'wl-copy',
    () => undefined,
  );
  // A missing tool must not crash the TUI; OSC 52 above is the fallback.
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(text);
}

/** Submit-side busy/settled surface for the active registered form. */
function FormBusyFrame(props: {
  readonly progress: FormProgress;
  readonly availableRows?: number;
}): React.JSX.Element {
  const { progress } = props;
  const { columns } = useWindowSize();
  const settled = progress.status !== 'running';
  const [copied, setCopied] = useState(false);
  // Once archived, the message has been written to scrollback and is no
  // longer "live" for display/sizing purposes, even though the raw value is
  // kept on `progress.copyableMessage` for archiveCopyable's own use.
  const liveCopyable = progress.copyableMessageArchived
    ? undefined
    : progress.copyableMessage;
  useInput((input, key) => {
    if (key.ctrl) return;
    if (input === 'c' && liveCopyable) {
      copyToClipboard(/https?:\/\/\S+/.exec(liveCopyable)?.[0] ?? liveCopyable);
      setCopied(true);
      return;
    }
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
  const innerWidth = formFrameContentWidth(columns);
  const hints = [
    ...(liveCopyable
      ? [{ key: 'c', action: copied ? 'copied' : 'copy link' }]
      : []),
    settled
      ? { key: 'any key', action: 'close' }
      : { key: 'Esc', action: 'cancel' },
  ];
  // Count rows the way Ink word-wraps them; character-wrap math undercounts
  // and can leave a copyable message on screen that does not fit.
  const wrappedRows = (text: string): number =>
    wrappedRowCount(text.replaceAll('\t', '    '), innerWidth);
  // The border and key hints, plus the title, message, and copyable block.
  const requiredRows = (copyableMessage: string): number =>
    borderedPanelChromeRows(hints, innerWidth) +
    wrappedRows(title) +
    wrappedRows(progress.message ?? 'working...') +
    (copyableMessage === progress.message
      ? 0
      : 1 + wrappedRows(copyableMessage));
  const copyableDoesNotFit =
    liveCopyable !== undefined &&
    props.availableRows !== undefined &&
    requiredRows(liveCopyable) > props.availableRows;
  useLayoutEffect(() => {
    if (copyableDoesNotFit) progress.archiveCopyable();
  }, [copyableDoesNotFit, progress]);
  const spinnerFrozen = liveCopyable !== undefined;
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
        liveCopyable &&
        liveCopyable !== progress.message && (
          <Box marginTop={1}>
            <Text>{liveCopyable}</Text>
          </Box>
        )}
      <Box marginTop={1}>
        <KeyHints hints={hints} confirmCancel={false} />
      </Box>
    </FormFrame>
  );
}

/**
 * The busy frame replaces the form while a submission runs. `formProgress` is
 * read through `useSignal` here, not in the slot's `render` callback: the
 * host memoizes that callback's output on the slot entry, so a plain `.get()`
 * there never re-renders when the progress changes and the sign-in URL never
 * reaches the screen.
 */
function RegisteredFormSurface(props: {
  readonly availableRows: number;
  readonly children: React.ReactNode;
}): React.ReactNode {
  const progress = useSignal(formProgress);
  return progress ? (
    <FormBusyFrame progress={progress} availableRows={props.availableRows} />
  ) : (
    props.children
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
  takeActiveForm({
    commandName: command.name,
    render: (close, availableRows) => (
      <RegisteredFormSurface availableRows={availableRows}>
        <Form
          availableRows={availableRows}
          remainder={remainder.trimStart()}
          onPersist={onPersist ? persist : undefined}
          echoOnPersist={command.echo === 'ifPersists'}
          onDone={close}
        />
      </RegisteredFormSurface>
    ),
  });
  return true;
}

export function openCliSlashCommandForm(
  commandName: string,
  remainder: string,
): boolean {
  const command = findSlashCommand(commandName);
  return command ? openRegisteredCliSlashForm(command, remainder) : false;
}
