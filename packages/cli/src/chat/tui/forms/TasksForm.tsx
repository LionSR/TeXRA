// `/tasks`: the TeXRA service's tasks across every project, and one of them
// attached live — its transcript as the service streams it, a composer that
// sends it a follow-up, and its pending requests answered in place. Esc
// detaches; the task keeps running in the service.

import { Box, Text, useInput, useWindowSize } from 'ink';
import { Effect } from 'effect';
import { useEffect, useRef, useState } from 'react';

import { presentFollowUpResult } from '@texra-ai/harness/host';
import {
  acceptsFollowUp,
  offeredGrant,
  type RunId,
  toErrorMessage,
  joinFacts,
} from '@texra-ai/harness/schemas';
import { isEscapeInput } from '@cli/tui/inputKeys';
import { COLOR_ERROR, COLOR_WARNING } from '@cli/tui/ui/colors';
import { POINTER } from '@cli/tui/ui/glyphs';
import {
  approvalDecisionDelivery,
  type SurfaceDecision,
} from '@texra/shared/session/surfaceDecision';
import {
  readToolEditPreview,
  type ToolEditPreviewRead,
} from '@texra/controllers/approval/ToolEditApprovalController';
import type { TaskSummary } from '@texra/controllers/server/protocol';
import { runStatus, runStatusLabel } from '@ui/copy/runStatus';

import { TextInput } from '../input/TextInput';
import { ApprovalModal } from '../modals/ApprovalModal';
import {
  followAttachedTask,
  type AttachedTaskActions,
  type AttachedTaskLevel,
  type ConnectService,
} from '../state/attachedTask';
import { transcriptToLines } from '../state/transcriptLines';
import { useChatProcess } from '../chatProcess';
import { useMountScope } from '../state/useMountScope';
import { FormFrame, formFrameContentWidth } from './_shared/FormFrame';
import { AsyncListForm } from './_shared/ListForm';
import type { TuiRequest } from '../state/approvalQueue';

interface TasksFormProps {
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
        connect={props.connect}
        availableRows={props.availableRows}
        onClose={props.onClose}
      />
    );
  return (
    <AsyncListForm<readonly TaskSummary[], RunId>
      title="/tasks"
      loadingLabel="Reaching the TeXRA service…"
      load={() =>
        Effect.scoped(
          Effect.flatMap(props.connect(), ({ client }) =>
            client['tasks.list']({ all: false }),
          ),
        )
      }
      items={(tasks) =>
        tasks.map((entry) => ({
          value: entry.runId,
          label: `${entry.live ? '* ' : ''}${entry.label}`,
          description: joinFacts([
            runStatusLabel(entry.statusKey),
            entry.workspace,
          ]),
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
  readonly connect: ConnectService;
  readonly availableRows?: number;
  readonly onClose: () => void;
}

function AttachedTask(props: AttachedTaskProps): React.JSX.Element {
  const { task } = props;
  const { chat } = useChatProcess();
  const mount = useMountScope();
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
    ReadonlyMap<string, ToolEditPreviewRead>
  >(new Map());
  const actions = useRef<AttachedTaskActions>(undefined);

  useEffect(() => {
    const fiber = mount.fork(
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
    return () => fiber.interruptUnsafe();
  }, [mount, props.connect, task]);

  /** Run one action on the service, saying so when it fails. The notice
   *  is about the latest attempt: a new one clears it, and an older attempt
   *  that finishes later says nothing. An action belongs to the chat, not
   *  this view: a decision or a stop already sent lands even when the view
   *  closes first. */
  const attempt = useRef(0);
  const act = (
    program: (
      a: AttachedTaskActions,
      say: (notice: string) => void,
    ) => Effect.Effect<void, Error>,
    onFailed?: () => void,
  ) => {
    const current = ++attempt.current;
    const say = (notice: string) => {
      if (attempt.current === current) setNotice(notice);
    };
    setNotice(undefined);
    const ready = actions.current;
    if (!ready) {
      say('Still connecting to the TeXRA service.');
      return;
    }
    chat.fork(
      program(ready, say).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            onFailed?.();
            say(toErrorMessage(error));
          }),
        ),
      ),
    );
  };

  const pending = level.requests.find(
    (request) => !decided.has(request.requestId),
  );
  // Previews of decided requests go: each holds two whole documents.
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
    act((ready) =>
      readToolEditPreview(ready, pending.runId, requestId).pipe(
        Effect.map((read) =>
          setPreviews((held) => new Map(held).set(requestId, read)),
        ),
      ),
    );
  });

  const presentable = ((): TuiRequest | undefined => {
    if (!pending) return undefined;
    const { payload } = pending;
    switch (payload.kind) {
      case 'toolEdit': {
        const tui = previews.get(pending.requestId);
        return tui === undefined ? undefined : { ...payload, tui };
      }
      case 'retry':
        // Switching onto the user's own key is the host's that runs the
        // task; this view offers retry and stop only.
        return {
          ...payload,
          data: { ...payload.data, credentialSwitch: null },
        };
      default:
        return payload;
    }
  })();

  const decide = (decision: SurfaceDecision): void => {
    if (!pending) return;
    const delivery = approvalDecisionDelivery(pending, decision);
    if ('host' in delivery) {
      setNotice(
        'That choice needs the window running the task; approve or reject here instead.',
      );
      return;
    }
    const { requestId } = pending;
    setDecided((held) => new Set(held).add(requestId));
    act(
      (ready) => ready.request(delivery.runtime),
      // Refused: the request is still open, so it comes back.
      () =>
        setDecided((held) => {
          const next = new Set(held);
          next.delete(requestId);
          return next;
        }),
    );
  };

  const answering = presentable !== undefined;
  // The composer shows only for a run that takes a follow-up (the rule
  // every host reads).
  const composing =
    !answering &&
    !level.ended &&
    level.run !== undefined &&
    acceptsFollowUp(level.run);
  // The composer takes Esc while it shows; without one, Esc still
  // detaches.
  useInput((input, key) => {
    if (!composing && !answering && isEscapeInput(input, key)) props.onClose();
  });

  const lines = level.run
    ? transcriptToLines(
        level.run.transcript.rows,
        formFrameContentWidth(columns),
      )
    : [];
  const budget = Math.max(
    3,
    (props.availableRows ?? 24) - ATTACHED_CHROME_ROWS - (presentable ? 10 : 0),
  );
  const runWord = level.run && runStatus(level.run).word;
  const status = level.ended
    ? `detached: ${level.ended}`
    : (runWord ?? 'connecting…');

  return (
    <Box flexDirection="column">
      <FormFrame
        color={level.ended ? COLOR_ERROR : undefined}
        title={joinFacts([task.label, status])}
        // While a request is on screen its card owns Esc (reject or skip);
        // detaching waits until it is answered.
        hints={[
          ...(composing ? [{ key: 'Enter', action: 'send a follow-up' }] : []),
          ...(answering
            ? []
            : [{ key: 'Esc', action: 'detach (the task keeps running)' }]),
        ]}
      >
        {lines.slice(-budget).map((line, index) => (
          <Text key={index}>{line}</Text>
        ))}
        {composing && (
          <Box marginTop={1}>
            <Text>{`${POINTER} `}</Text>
            <TextInput
              value={draft}
              placeholder="Message this task"
              onChange={setDraft}
              onEscape={props.onClose}
              onSubmit={(text) => {
                const message = text.trim();
                if (!message) return;
                setDraft('');
                act(
                  (ready, say) =>
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
                          const shown = presentFollowUpResult(outcome);
                          if (shown.severity !== 'none') say(shown.message);
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
      </FormFrame>
      {presentable && pending && (
        <ApprovalModal
          // A fresh modal per request: a question's answers or a card's
          // feedback never carry into the next one.
          key={pending.requestId}
          payload={presentable}
          grant={offeredGrant(pending)}
          availableRows={10}
          onDecide={decide}
        />
      )}
    </Box>
  );
}
