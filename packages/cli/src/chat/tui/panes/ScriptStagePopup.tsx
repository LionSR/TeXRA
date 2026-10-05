// The script popup: the calls a run's `script` call issued, painted from the
// shared script-stage model (`scriptStages` in `@ui/transcript`), the one the
// progress view paints. A foreground surface like the Ctrl-T reader:
// row-budgeted, and Esc restores the conversation untouched. Its title is
// the card's summary line; each phase lists its calls in issue order. Enter
// opens a call's child run (or the run asking under it); `s` stops a running
// call's agent, which the script sees as `Skipped`.

// Third-party imports
import { Box, Text, useInput, useWindowSize } from 'ink';

// Local imports - TUI primitives
import { isCtrlInput, isEscapeInput } from '@cli/tui/inputKeys';
import { ReaderPanel, readerLayout } from '@cli/tui/ui/BorderedPanel';
import { KeyHints, type KeyHint } from '@cli/tui/ui/KeyHints';
import { Select, type SelectItem } from '@cli/tui/ui/Select';
import {
  COLOR_BORDER,
  COLOR_ERROR,
  COLOR_HINT,
  COLOR_SUCCESS,
  COLOR_WARNING,
} from '@cli/tui/ui/colors';
import { fillRows, safeTerminalText } from '@cli/runtime/terminalText';

// Local imports - shared schemas and model
import {
  SCRIPT_CALL_STATUS_LABEL,
  scriptStages,
  TALK_TO_AGENT,
  type ScriptCallView,
} from '@shared/transcript';

// Local imports - TUI state
import { type ScriptPopupView } from '../state/cliState';
import {
  CLI_FOLLOW_UP_HOST,
  killableRunId,
  runViewOf,
  sessionView,
} from '../state/sessionView';
import { useSignal } from '../state/useSignal';
import { RowSegment } from './SubagentList';
import type { RuntimeRequest } from '@texra-ai/harness';
import type { RunId } from '@texra-ai/harness/schemas';

/** Rows the popup paints besides its list: the focused call's facts. */
const POPUP_EXTRA_ROWS = 1;

const STATUS_GLYPH = {
  queued: '○',
  running: '◐',
  interrupted: '◌',
  finished: '✓',
  reused: '↺',
  skipped: '⊘',
  cancelled: '⊘',
  failed: '✗',
  'not run': '·',
} as const satisfies Record<ScriptCallView['status'], string>;

const STATUS_COLOR = {
  queued: undefined,
  running: COLOR_HINT,
  interrupted: COLOR_WARNING,
  finished: COLOR_SUCCESS,
  reused: COLOR_SUCCESS,
  skipped: COLOR_BORDER,
  cancelled: COLOR_BORDER,
  failed: COLOR_ERROR,
  'not run': COLOR_BORDER,
} as const satisfies Record<ScriptCallView['status'], string | undefined>;

/** One list entry: a phase heading, or a call. */
type Entry =
  | { readonly kind: 'heading'; readonly key: string; readonly text: string }
  | {
      readonly kind: 'call';
      readonly key: string;
      readonly call: ScriptCallView;
    };

function CallRow({
  call,
}: {
  readonly call: ScriptCallView;
}): React.JSX.Element {
  const waiting = call.needsYou;
  const last = call.summary;
  return (
    <Box flexDirection="row" height={1} minWidth={0} overflowY="hidden">
      <Box flexShrink={0}>
        <Text
          aria-hidden
          color={waiting ? COLOR_WARNING : STATUS_COLOR[call.status]}
        >
          {fillRows(` ${STATUS_GLYPH[call.status]}`, 3)}
        </Text>
      </Box>
      <RowSegment flexShrink={0}>
        {`${safeTerminalText(call.label)} · ${SCRIPT_CALL_STATUS_LABEL[call.status]}`}
      </RowSegment>
      {last ? (
        <RowSegment
          color={call.detail?.kind === 'error' ? COLOR_ERROR : undefined}
          dimColor={call.detail?.kind !== 'error'}
          flexShrink={1}
        >{`  ${safeTerminalText(last)}`}</RowSegment>
      ) : null}
    </Box>
  );
}

interface ScriptStagePopupProps {
  readonly availableRows: number;
  /** The run whose transcript holds the script stages. */
  readonly runId: RunId;
  readonly view: ScriptPopupView;
  readonly onClose: () => void;
  readonly onFocusRun: (runId: RunId) => void;
  /** Stop a call's agent (`run.stop` of the call's child). */
  readonly onRequest: (request: RuntimeRequest) => void;
  readonly onOpenTranscript: (runId: RunId) => void;
  readonly onViewChange: (patch: Partial<ScriptPopupView>) => void;
}

export function ScriptStagePopup({
  availableRows,
  onClose,
  onFocusRun,
  onOpenTranscript,
  onRequest,
  onViewChange,
  runId,
  view,
}: ScriptStagePopupProps): React.JSX.Element | null {
  const { columns } = useWindowSize();
  const session = useSignal(sessionView());
  const run = runViewOf(session, runId);
  const stages =
    run === undefined ? [] : scriptStages(run, session, CLI_FOLLOW_UP_HOST);
  // The newest script unless the user moved to another.
  const stageIndex = Math.max(
    0,
    view.stageId === undefined
      ? stages.length - 1
      : stages.findIndex((stage) => stage.id === view.stageId),
  );
  const stage = stages[stageIndex];

  const entries: Entry[] = (stage?.phases ?? []).flatMap((phase) => [
    ...(phase.title === null
      ? []
      : [
          {
            kind: 'heading' as const,
            key: `phase:${phase.title}`,
            text: `◆ ${phase.title}`,
          },
        ]),
    ...phase.calls.map((call) => ({
      kind: 'call' as const,
      key: call.id,
      call,
    })),
  ]);
  const byKey = new Map(entries.map((entry) => [entry.key, entry] as const));
  const remembered =
    view.selectedId === undefined ? undefined : byKey.get(view.selectedId);
  const selectedKey =
    remembered?.kind === 'call'
      ? remembered.key
      : entries.find((entry) => entry.kind === 'call')?.key;
  const selected =
    selectedKey === undefined ? undefined : byKey.get(selectedKey);
  const call = selected?.kind === 'call' ? selected.call : undefined;
  const child = runViewOf(session, call?.childRunId);
  const stoppable =
    call?.status === 'running' && killableRunId(child) !== undefined;
  const target = call?.askingRunId ?? child?.id;

  // Enter focuses the run: the one asking, else an agent's own stream,
  // where the input talks to it.
  let enterAction = 'open';
  if (call?.askingRunId !== undefined) enterAction = 'review';
  else if (call?.talkable === true) enterAction = TALK_TO_AGENT.toLowerCase();
  const hints: KeyHint[] = [
    ...(stages.length > 1 ? [{ key: '←/→', action: 'script' }] : []),
    { key: '↑/↓', action: 'select' },
    ...(target !== undefined
      ? [
          {
            key: 'Enter',
            action: enterAction,
          },
        ]
      : []),
    ...(stoppable ? [{ key: 's', action: 'stop agent' }] : []),
    { key: 'Ctrl-T', action: 'transcript' },
    { key: 'Esc', action: 'close' },
  ];
  const title = [
    'Script',
    stages.length > 1 ? `${stageIndex + 1}/${stages.length}` : undefined,
    stage === undefined || stage.summary === ''
      ? `${stage?.calls.length ?? 0} calls`
      : stage.summary,
  ]
    .filter((part) => part !== undefined)
    .join(' · ');
  const layout = readerLayout({
    availableRows,
    extraRows: POPUP_EXTRA_ROWS,
    frameWidth: Math.max(1, columns),
    hints,
    title,
  });
  const width = layout.contentWidth;

  useInput((input, key) => {
    if (isCtrlInput(input, key, 't')) {
      onOpenTranscript(runId);
      return;
    }
    if (key.ctrl || key.meta) return;
    if (entries.length === 0 && isEscapeInput(input, key)) {
      onClose();
      return;
    }
    if ((key.leftArrow || key.rightArrow) && stages.length > 1) {
      const next = Math.min(
        stages.length - 1,
        Math.max(0, stageIndex + (key.rightArrow ? 1 : -1)),
      );
      onViewChange({ stageId: stages[next]?.id, selectedId: undefined });
      return;
    }
    if (input === 's' && stoppable && child !== undefined) {
      onRequest({ kind: 'run.stop', runId: child.id, reason: 'user' });
    }
  });

  const items: SelectItem<string>[] = entries.map((entry) => ({
    label: entry.key,
    value: entry.key,
    disabled: entry.kind === 'heading',
  }));
  const renderItem = (item: SelectItem<string>): React.JSX.Element | null => {
    const entry = byKey.get(item.value);
    if (entry === undefined) return null;
    if (entry.kind === 'heading') {
      return (
        <Box height={1} overflowY="hidden">
          <Text bold dimColor wrap="truncate-end">
            {safeTerminalText(entry.text)}
          </Text>
        </Box>
      );
    }
    return <CallRow call={entry.call} />;
  };
  const activate = (selectedValue: string): void => {
    const entry = byKey.get(selectedValue);
    if (entry?.kind !== 'call') return;
    const open = entry.call.askingRunId ?? entry.call.childRunId;
    if (open !== undefined && session.runs.has(open)) onFocusRun(open);
  };

  return (
    <ReaderPanel
      footer={<KeyHints hints={hints} confirmCancel={false} wrap />}
      layout={layout}
      title={title}
    >
      <Box flexDirection="column" width={width}>
        {entries.length === 0 ? (
          <Text dimColor>No calls yet</Text>
        ) : (
          <Select
            hotkeys={false}
            highlightedValue={selectedKey ?? null}
            items={items}
            maxVisibleItems={Math.max(1, layout.bodyRows)}
            onCancel={onClose}
            onHighlightChange={(selectedId) => onViewChange({ selectedId })}
            onSelect={activate}
            renderItem={renderItem}
            showOverflow
            wrap={false}
          />
        )}
        <Box height={1} overflowY="hidden">
          <Text dimColor wrap="truncate-end">
            {safeTerminalText(call?.facts.join(' · ') ?? '')}
          </Text>
        </Box>
      </Box>
    </ReaderPanel>
  );
}
