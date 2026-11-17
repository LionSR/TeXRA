// The script popup: the calls a run's `script` call issued, painted from the
// shared script-stage model (`scriptStages` in `@texra-ai/harness/transcript`), the one the
// progress view paints. A foreground surface like the Ctrl-T reader:
// row-budgeted, and Esc restores the conversation untouched. Its title is
// the card's summary line; each section lists its calls in issue order. Enter
// opens a call's child run (or the run asking under it); `s` stops a running
// call's agent, which the script sees as `Skipped`.

// Third-party imports
import { joinFacts } from '@texra-ai/harness/schemas';
import { Box, Text, useInput, useWindowSize } from 'ink';

// Local imports - TUI primitives
import {
  scriptStages,
  type ScriptCallView,
} from '@texra-ai/harness/transcript';
import { isCtrlInput, isEscapeInput } from '@cli/tui/inputKeys';
import { ReaderPanel, readerLayout } from '@cli/tui/ui/BorderedPanel';
import {
  CLOSE_HINT,
  KeyHints,
  LEFT_RIGHT_KEYS,
  UP_DOWN_KEYS,
  type KeyHint,
} from '@cli/tui/ui/KeyHints';
import { Select, type SelectItem } from '@cli/tui/ui/Select';
import { HOLLOW_DOT, REUSED, STATUS_DIAMOND } from '@cli/tui/ui/glyphs';
import { TONE_PAINT } from '@cli/tui/ui/tonePaint';
import { fillRows, safeTerminalText } from '@cli/runtime/terminal/terminalText';
import {
  SCRIPT_CALL_STATUS_LABEL,
  SCRIPT_CALL_STATUS_LOOK,
  scriptCallSummary,
  scriptStageSummary,
} from '@ui/copy/scriptStage';

// Local imports - shared schemas and model
import { TALK_TO_AGENT } from '@ui/copy/nestedRuns';

// Local imports - TUI state
import { type ScriptPopupView } from '../state/cliState';
import { killableRunId, runViewOf, sessionView } from '../state/sessionView';
import { useSignal } from '../state/useSignal';
import { RowSegment } from './SubagentList';
import type { RuntimeCommand, RunId } from '@texra-ai/harness/schemas';

/** Rows the popup paints besides its list: the focused call's facts. */
const POPUP_EXTRA_ROWS = 1;

/** The terminal markers of the statuses whose look carries a glyph of its
 *  own (`SCRIPT_CALL_STATUS_LOOK`): a queued call has not started and a
 *  reused one ran nothing this time, so neither shows its tone's marker. */
const OWN_MARKER: Partial<Record<ScriptCallView['status'], string>> = {
  queued: HOLLOW_DOT,
  reused: REUSED,
};

/** One list entry: a section heading, or a call. */
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
  const last = scriptCallSummary(call);
  const paint = TONE_PAINT[SCRIPT_CALL_STATUS_LOOK[call.status].tone];
  return (
    <Box flexDirection="row" height={1} minWidth={0} overflowY="hidden">
      <Box flexShrink={0}>
        <Text
          aria-hidden
          color={waiting ? TONE_PAINT.warning.color : paint.color}
        >
          {fillRows(` ${OWN_MARKER[call.status] ?? paint.marker}`, 3)}
        </Text>
      </Box>
      <RowSegment flexShrink={0}>
        {joinFacts([
          safeTerminalText(call.label),
          SCRIPT_CALL_STATUS_LABEL[call.status],
        ])}
      </RowSegment>
      {last ? (
        <RowSegment
          color={
            call.detail?.kind === 'error' ? TONE_PAINT.danger.color : undefined
          }
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
  readonly onRequest: (request: RuntimeCommand) => void;
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
  const stages = run === undefined ? [] : scriptStages(run, session);
  // The newest script unless the user moved to another.
  const stageIndex = Math.max(
    0,
    view.stageId === undefined
      ? stages.length - 1
      : stages.findIndex((stage) => stage.id === view.stageId),
  );
  const stage = stages[stageIndex];

  const entries: Entry[] = (stage?.sections ?? []).flatMap((section) => [
    ...(section.title === null
      ? []
      : [
          {
            kind: 'heading' as const,
            key: `section:${section.title}`,
            text: `${STATUS_DIAMOND} ${section.title}`,
          },
        ]),
    ...section.calls.map((call) => ({
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
    ...(stages.length > 1 ? [{ key: LEFT_RIGHT_KEYS, action: 'script' }] : []),
    { key: UP_DOWN_KEYS, action: 'select' },
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
    CLOSE_HINT,
  ];
  const title = joinFacts([
    'Script',
    stages.length > 1 && `${stageIndex + 1}/${stages.length}`,
    (stage && scriptStageSummary(stage)) || `${stage?.calls.length ?? 0} calls`,
  ]);
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
            {safeTerminalText(joinFacts(call?.facts ?? []))}
          </Text>
        </Box>
      </Box>
    </ReaderPanel>
  );
}
