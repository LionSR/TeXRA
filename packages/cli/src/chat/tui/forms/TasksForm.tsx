// `/tasks`: the TeXRA service's tasks across every project, and one of them
// attached live — its transcript as the service streams it, a composer that
// sends it a follow-up, and its pending requests answered in place. Esc
// detaches; the task keeps running in the service.

import { Box, Text, useInput, useWindowSize } from 'ink';
import { Effect, Fiber, type Scope } from 'effect';
import { useEffect, useRef, useState } from 'react';

import { isEscapeInput } from '@cli/tui/inputKeys';
import {
  BORDERED_PANEL_CHROME_COLUMNS,
  BorderedPanel,
} from '@cli/tui/ui/BorderedPanel';
import { COLOR_ERROR, COLOR_HINT, COLOR_WARNING } from '@cli/tui/ui/colors';
import { POINTER } from '@cli/tui/ui/glyphs';
import { KeyHints } from '@cli/tui/ui/KeyHints';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { RunId, ToolEditPermission } from '@shared/schemas';
import {
  approvalDecisionArms,
  type SurfaceDecision,
} from '@shared/session/approvalDecision';
import { acceptsFollowUp } from '@shared/session/sessionView';
import type { ServiceConnection } from '@texra/controllers/server/client';
import type {
  TaskSummary,
  ToolEditPreview,
} from '@texra/controllers/server/protocol';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { BaseTextInput } from '../input/BaseTextInput';
import { ApprovalModal } from '../modals/ApprovalModal';
import { ConfirmCard } from '../modals/ConfirmCard';
import {
  followAttachedTask,
  type AttachedTaskActions,
  type AttachedTaskLevel,
} from '../state/attachedTask';
import { transcriptToLines } from '../state/transcriptLines';
import { AsyncListForm } from './_shared/ListForm';
import type { ApprovalPayload } from '../state/approvalQueue';

/** Opens (and, when none runs, starts) the service connection. */
type ConnectService = () => Effect.Effect<
  ServiceConnection,
  Error,
  Scope.Scope
>;

interface TasksFormProps {
  readonly runtime: ProcessRuntime;
  readonly connect: ConnectService;
  readonly availableRows?: number;
  readonly onClose: () => void;
}

/** Rows the attached view spends outside the transcript: the panel's
 *  border and title, the composer, and the key hints. */
const ATTACHED_CHROME_ROWS = 6;

export function TasksForm(props: TasksFormProps): React.JSX.Element {
  const [task, setTask] = useState<TaskSummary>();
  if (task)
    return (
      <AttachedTask
        task={task}
        runtime={props.runtime}
        connect={props.connect}
        availableRows={props.availableRows}
        onClose={props.onClose}
      />
    );
  return (
    <AsyncListForm<readonly TaskSummary[], RunId>
      title="/tasks"
      loadingLabel="Reaching the TeXRA service..."
      load={() =>
        Effect.scoped(
          Effect.flatMap(props.connect(), ({ client }) =>
            client['tasks.list']({ all: false }),
          ),
        )
      }
      runtime={props.runtime}
      items={(tasks) =>
        tasks.map((entry) => ({
          value: entry.runId,
          label: `${entry.live ? '* ' : ''}${entry.label}`,
          description: `${entry.statusLabel} · ${entry.workspace}`,
        }))
      }
      availableRows={props.availableRows}
      description={
        <Text dimColor>
          Every project&apos;s tasks; * runs in the service. Choose one to
          attach.
        </Text>
      }
      emptyMessage="The service has no tasks yet."
      selectMarginTop={1}
      action="attach"
      onSelect={(runId, { data }) =>
        setTask(data.find((entry) => entry.runId === runId))
      }
      onCancel={props.onClose}
    />
  );
}

interface AttachedTaskProps {
  readonly task: TaskSummary;
  readonly runtime: ProcessRuntime;
  readonly connect: ConnectService;
  readonly availableRows?: number;
  readonly onClose: () => void;
}

/** A pending request this view can present, with what it presents. */
type Presentable =
  | { readonly kind: 'modal'; readonly payload: ApprovalPayload }
  | { readonly kind: 'edit'; readonly data: ToolEditPermission };

function AttachedTask(props: AttachedTaskProps): React.JSX.Element {
  const { task, runtime } = props;
  const { columns } = useWindowSize();
  const [level, setLevel] = useState<AttachedTaskLevel>({
    run: undefined,
    requests: [],
    ended: null,
  });
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string>();
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
  const [previews, setPreviews] = useState<
    ReadonlyMap<string, ToolEditPreview | null>
  >(new Map());
  const actions = useRef<AttachedTaskActions>(undefined);

  useEffect(() => {
    const fiber = runtime.runFork(
      followAttachedTask(
        props.connect,
        task,
        (ready) => {
          actions.current = ready;
        },
        (next) =>
          setLevel((previous) =>
            next.ended === null
              ? next
              : { ...previous, requests: [], ended: next.ended },
          ),
      ),
    );
    return () => {
      runtime.runFork(Fiber.interrupt(fiber));
    };
  }, [runtime, props.connect, task]);

  /** Run one action on the service, saying so when it fails. */
  const act = (
    program: (a: AttachedTaskActions) => Effect.Effect<void, Error>,
    onFailed?: () => void,
  ) => {
    const ready = actions.current;
    if (!ready) {
      setNotice('Still connecting to the TeXRA service.');
      return;
    }
    runtime.runFork(
      program(ready).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            onFailed?.();
            setNotice(toErrorMessage(error));
          }),
        ),
      ),
    );
  };

  // An external inquiry is answered from its thread and never parks its
  // run, so it is named apart and never stands in front of a request
  // this view can answer.
  const pending = level.requests.find(
    (request) =>
      request.payload.kind !== 'externalInquiry' &&
      !decided.has(request.requestId),
  );
  const inquiries = level.requests.filter(
    (request) => request.payload.kind === 'externalInquiry',
  ).length;
  // Previews of settled requests go: each holds two whole documents.
  useEffect(() => {
    const open = new Set(level.requests.map((request) => request.requestId));
    setPreviews((held) =>
      [...held.keys()].every((id) => open.has(id))
        ? held
        : new Map([...held].filter(([id]) => open.has(id))),
    );
  }, [level.requests]);
  // An edit's preview is the service's to hand over: fetch it once.
  const asked = useRef(new Set<string>());
  useEffect(() => {
    if (pending?.payload.kind !== 'toolEdit') return;
    if (asked.current.has(pending.requestId)) return;
    const { requestId } = pending;
    asked.current.add(requestId);
    act(
      (ready) =>
        ready
          .preview(requestId)
          .pipe(
            Effect.map((preview) =>
              setPreviews((held) => new Map(held).set(requestId, preview)),
            ),
          ),
      // No preview to be had: the card shows the edit from its path.
      () => setPreviews((held) => new Map(held).set(requestId, null)),
    );
  });

  const presentable = ((): Presentable | undefined => {
    if (!pending) return undefined;
    const { payload } = pending;
    switch (payload.kind) {
      case 'externalInquiry':
        return undefined;
      case 'toolEdit': {
        const preview = previews.get(pending.requestId);
        if (preview === undefined) return undefined;
        return preview === null
          ? { kind: 'edit', data: payload.data }
          : { kind: 'modal', payload: { ...payload, tui: preview } };
      }
      case 'retry':
        // Switching onto the user's own key is the host's that runs the
        // task; this view offers retry and stop only.
        return {
          kind: 'modal',
          payload: {
            ...payload,
            data: { ...payload.data, credentialSwitch: null },
          },
        };
      default:
        return { kind: 'modal', payload };
    }
  })();

  const decide = (decision: SurfaceDecision): void => {
    if (!pending) return;
    const arms = approvalDecisionArms(pending.payload, decision);
    if (arms.some((arm) => 'host' in arm)) {
      setNotice(
        'That choice needs the window running the task; approve or reject here instead.',
      );
      return;
    }
    const { requestId } = pending;
    setDecided((held) => new Set(held).add(requestId));
    act(
      (ready) =>
        Effect.forEach(
          arms,
          (arm) =>
            'runtime' in arm ? ready.request(arm.runtime) : Effect.void,
          { discard: true },
        ),
      // Refused: the request is still open, so it comes back.
      () =>
        setDecided((held) => {
          const next = new Set(held);
          next.delete(requestId);
          return next;
        }),
    );
  };

  const answering =
    presentable?.kind === 'modal' || presentable?.kind === 'edit';
  // The composer shows only for a run that takes a follow-up (the rule
  // every host reads); a terminal-backed run takes none from here.
  const composing =
    !answering &&
    !level.ended &&
    level.run !== undefined &&
    acceptsFollowUp(level.run, { terminalBacked: false });
  // The composer takes Esc while it shows; without one, Esc still
  // detaches.
  useInput((input, key) => {
    if (!composing && !answering && isEscapeInput(input, key)) props.onClose();
  });

  const width = Math.max(20, (columns ?? 80) - BORDERED_PANEL_CHROME_COLUMNS);
  const lines = level.run
    ? transcriptToLines(level.run.transcript.rows, width)
    : [];
  const budget = Math.max(
    3,
    (props.availableRows ?? 24) - ATTACHED_CHROME_ROWS - (presentable ? 10 : 0),
  );
  const status = level.ended
    ? `detached: ${level.ended}`
    : (level.run?.statusLabel ?? 'connecting…');

  return (
    <Box flexDirection="column">
      <BorderedPanel
        color={level.ended ? COLOR_ERROR : COLOR_HINT}
        title={`${task.label} · ${status}`}
        footer={
          <KeyHints
            // While a request is on screen its card owns Esc (reject or
            // skip); detaching waits until it is answered.
            hints={[
              ...(composing
                ? [{ key: 'Enter', action: 'send a follow-up' }]
                : []),
              ...(answering
                ? []
                : [{ key: 'Esc', action: 'detach (the task keeps running)' }]),
            ]}
            confirmCancel={false}
          />
        }
      >
        {lines.slice(-budget).map((line, index) => (
          <Text key={index}>{line}</Text>
        ))}
        {composing && (
          <Box marginTop={1}>
            <Text>{`${POINTER} `}</Text>
            <BaseTextInput
              value={draft}
              placeholder="Message this task"
              onChange={setDraft}
              onEscape={props.onClose}
              onSubmit={(text) => {
                const message = text.trim();
                if (!message) return;
                setDraft('');
                act(
                  (ready) =>
                    ready
                      .request({
                        kind: 'followUp.send',
                        runId: task.runId,
                        text: message,
                      })
                      .pipe(
                        Effect.map((outcome) => {
                          // Queued but not taken: the run did not wake, and
                          // waits for a resume before it reads the message.
                          if (
                            outcome.kind === 'followUp' &&
                            outcome.wake === 'failed'
                          )
                            setNotice(
                              'The message is queued, but the task did not wake to read it.',
                            );
                        }),
                      ),
                  // Not sent: the draft comes back to send again.
                  () => setDraft((held) => held || message),
                );
              }}
            />
          </Box>
        )}
        {notice && <Text color={COLOR_WARNING}>{notice}</Text>}
      </BorderedPanel>
      {presentable?.kind === 'modal' && (
        <ApprovalModal
          // A fresh modal per request: a question's answers or a card's
          // feedback never carry into the next one.
          key={pending?.requestId}
          payload={presentable.payload}
          availableRows={10}
          onDecide={decide}
        />
      )}
      {presentable?.kind === 'edit' && (
        <ConfirmCard
          key={pending?.requestId}
          color={COLOR_WARNING}
          title="Apply edit?"
          rejectionMode="feedback"
          onDecide={decide}
        >
          <Text>{`${presentable.data.relativePath} (+${presentable.data.addedLines} −${presentable.data.removedLines}); the service holds no preview.`}</Text>
        </ConfirmCard>
      )}
      {inquiries > 0 && (
        <Text dimColor>
          {`${inquiries === 1 ? 'An external inquiry waits' : `${inquiries} external inquiries wait`}; answer from its thread.`}
        </Text>
      )}
    </Box>
  );
}
