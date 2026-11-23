import { execFile } from 'node:child_process';
import { platform } from 'node:os';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { joinFacts } from '@texra-ai/worldline/schemas';
import { useLayoutEffect, useState } from 'react';

import { isEscapeInput } from '@cli/tui/inputKeys';
import { writeTerminalSequence } from '@cli/tui/terminalCleanup';
import { osc } from '@cli/runtime/terminal/ansiEscapes';
import { CANCEL_HINT } from '@cli/tui/ui/KeyHints';
import { LoadingIndicator } from '@cli/tui/ui/LoadingIndicator';
import { COLOR_ERROR } from '@cli/tui/ui/colors';
import { wrappedRowCount } from '@cli/tui/ansiWrap';
import {
  FormFrame,
  formFrameChromeRows,
  formFrameContentWidth,
} from '../forms/_shared/FormFrame';
import { formProgress, type FormProgress } from '../state/cliState';
import { takeActiveForm } from '../state/formSlot';
import { useSignal } from '../state/useSignal';
import { appendLocalUserTranscript } from '../state/transcript';

import type { SlashCommand, SlashCommands } from './slashRegistry';

export function appendSlashCommandEcho(
  commands: SlashCommands,
  line: string,
): void {
  if (!commands.shouldRedact(line)) appendLocalUserTranscript(line.trim());
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
  writeTerminalSequence(osc(`52;c;${Buffer.from(text).toString('base64')}`));
  const child = execFile(
    CLIPBOARD_TOOL[platform()] ?? 'wl-copy',
    () => undefined,
  );
  // A missing tool must not crash the TUI; OSC 52 above is the fallback.
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(text);
}

/** Submit-side busy/finished surface for the active registered form. */
function FormBusyFrame(props: {
  readonly progress: FormProgress;
  readonly availableRows: number;
}): React.JSX.Element {
  const { progress } = props;
  const { columns } = useWindowSize();
  const finished = progress.status !== 'running';
  const [copied, setCopied] = useState(false);
  // Once archived, the message has been written to scrollback and is no
  // longer "live" for display/sizing purposes, even though the raw value is
  // kept on `progress.copyable` for archiveCopyable's own use.
  const liveCopyable = progress.copyable?.archived
    ? undefined
    : progress.copyable?.text;
  useInput((input, key) => {
    if (key.ctrl) return;
    if (input === 'c' && liveCopyable) {
      copyToClipboard(/https?:\/\/\S+/.exec(liveCopyable)?.[0] ?? liveCopyable);
      setCopied(true);
      return;
    }
    if (finished) {
      progress.dismiss();
      return;
    }
    if (isEscapeInput(input, key)) progress.cancel();
  });

  const title = joinFacts([
    progress.title,
    progress.status === 'succeeded' && 'complete',
    progress.status === 'failed' && 'error',
  ]);
  const innerWidth = formFrameContentWidth(columns);
  const hints = [
    ...(liveCopyable
      ? [{ key: 'c', action: copied ? 'copied' : 'copy link' }]
      : []),
    finished ? { key: 'any key', action: 'close' } : CANCEL_HINT,
  ];
  // Count rows the way Ink word-wraps them; character-wrap math undercounts
  // and can leave a copyable message on screen that does not fit.
  const wrappedRows = (text: string): number =>
    wrappedRowCount(text.replaceAll('\t', '    '), innerWidth);
  // The frame, plus the message and the copyable block.
  const requiredRows = (copyableMessage: string): number =>
    formFrameChromeRows(title, hints, innerWidth) +
    wrappedRows(progress.message ?? 'working…') +
    (copyableMessage === progress.message
      ? 0
      : 1 + wrappedRows(copyableMessage));
  const copyableDoesNotFit =
    liveCopyable !== undefined &&
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
      hints={hints}
    >
      {progress.status === 'running' && !spinnerFrozen ? (
        <LoadingIndicator label={displayMessage ?? 'working…'} />
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
          onPersist={onPersist ? persist : undefined}
          echoOnPersist={command.echo === 'ifPersists'}
          onDone={close}
        />
      </RegisteredFormSurface>
    ),
  });
  return true;
}
