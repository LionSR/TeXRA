import { useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';

import { COLOR_ACCENT } from '@cli/tui/ui/colors';
import {
  clampModalWidth,
  CONFIRM_CARD_HORIZONTAL_DECORATION,
} from '@cli/tui/ui/theme';
import { wrapAnsiToWidth } from '@cli/tui/ansiWrap';
import {
  AgentCategory,
  agentProposalCategoryLabel,
  getProposalFileGroups,
  type AgentProposalPermission,
} from '@shared/schemas';
import { DELEGATION_APPROVAL_COPY } from '@shared/copy/delegationApproval';

import { ConfirmCard } from './ConfirmCard';
import {
  ScrollableModalText,
  scrollableModalTextRowsBudget,
} from './ScrollableModalText';
import type { ApprovalDecision } from '../state/approvalQueue';

export interface AgentProposalProps {
  readonly availableRows?: number;
  readonly payload: AgentProposalPermission;
  readonly onDecide: (decision: ApprovalDecision) => void;
}

const FILE_LIMIT = 5;
const AGENT_PROPOSAL_HIDDEN_NOUN = 'prompt rows';

function wrappedRows(text: string, width: number): number {
  return wrapAnsiToWidth(text, clampModalWidth(width)).split('\n').length;
}

function fileGroupText(label: string, files: readonly string[]): string {
  const visible = files.slice(0, FILE_LIMIT);
  const hidden = files.length - visible.length;
  return `${label}: ${visible.join(', ')}${hidden > 0 ? `, +${hidden} more` : ''}`;
}

export function agentProposalMetadataRows({
  fileGroups,
  payload,
  width,
}: {
  readonly fileGroups: ReturnType<typeof getProposalFileGroups>;
  readonly payload: AgentProposalPermission;
  readonly width: number;
}): number {
  if (
    payload.agentCategory === AgentCategory.Workflow &&
    payload.workflowScript
  ) {
    const workflow = payload.workflowScript;
    return (
      3 +
      wrappedRows(
        `${workflow.name} · ${workflow.tasks.length} tasks · ${workflow.phases.length} phases`,
        width,
      ) +
      wrappedRows(`Script: ${workflow.scriptPath}`, width)
    );
  }
  return (
    1 +
    wrappedRows(
      `Model: ${payload.model} · Category: ${agentProposalCategoryLabel(payload.agentCategory)}`,
      width,
    ) +
    (payload.workingDirectory
      ? wrappedRows(`Directory: ${payload.workingDirectory}`, width)
      : 0) +
    (fileGroups.length > 0
      ? 1 +
        fileGroups.reduce(
          (rows, group) =>
            rows + wrappedRows(fileGroupText(group.label, group.files), width),
          0,
        )
      : 0) +
    wrappedRows(DELEGATION_APPROVAL_COPY.cliExplanation, width)
  );
}

function FileGroup(props: {
  readonly label: string;
  readonly files: readonly string[];
}): React.JSX.Element {
  const text = fileGroupText(props.label, props.files);
  const prefix = `${props.label}: `;
  return (
    <Text>
      <Text bold>{prefix}</Text>
      {text.slice(prefix.length)}
    </Text>
  );
}

export function AgentProposal(props: AgentProposalProps): React.JSX.Element {
  const { columns } = useWindowSize();
  const [feedbackMode, setFeedbackMode] = useState(false);
  const fileGroups = getProposalFileGroups(props.payload);
  const workflowScript =
    props.payload.agentCategory === AgentCategory.Workflow
      ? props.payload.workflowScript
      : undefined;
  const title = workflowScript
    ? `Approve multi-agent workflow ${workflowScript.name}?`
    : `Spawn ${props.payload.agent}?`;
  const instructionWidth = clampModalWidth(
    columns - CONFIRM_CARD_HORIZONTAL_DECORATION,
  );
  const metadataRows = agentProposalMetadataRows({
    fileGroups,
    payload: props.payload,
    width: instructionWidth,
  });
  const maxInstructionRows = scrollableModalTextRowsBudget({
    availableRows: props.availableRows,
    columns,
    extraFixedRows: metadataRows,
    title,
  });

  return (
    <ConfirmCard
      borderStyle="double"
      color={COLOR_ACCENT}
      title={title}
      rejectionMode="feedback"
      alwaysAllow={{
        kind: 'superYolo',
        label: DELEGATION_APPROVAL_COPY.cliAction,
      }}
      onFeedbackModeChange={setFeedbackMode}
      onDecide={props.onDecide}
    >
      <Box marginTop={1} flexDirection="column">
        {workflowScript ? (
          <>
            <Text>
              <Text bold>{workflowScript.name}</Text>
              {' · '}
              {workflowScript.tasks.length} tasks ·{' '}
              {workflowScript.phases.length} phases
            </Text>
            <Text>
              <Text bold>Default: </Text>
              {props.payload.agent} ({props.payload.model})
            </Text>
            <Text color="yellow">
              May run tasks concurrently and incur high model cost.
            </Text>
            <Text dimColor>Script: {workflowScript.scriptPath}</Text>
          </>
        ) : (
          <>
            <Text>
              <Text bold>Model: </Text>
              {props.payload.model}
              {' · '}
              <Text bold>Category: </Text>
              {agentProposalCategoryLabel(props.payload.agentCategory)}
            </Text>
            {props.payload.workingDirectory ? (
              <Text>
                <Text bold>Directory: </Text>
                {props.payload.workingDirectory}
              </Text>
            ) : null}
            {fileGroups.length > 0 ? (
              <Box marginTop={1} flexDirection="column">
                {fileGroups.map((group) => (
                  <FileGroup
                    key={group.label}
                    label={group.label}
                    files={group.files}
                  />
                ))}
              </Box>
            ) : null}
            <Text dimColor>{DELEGATION_APPROVAL_COPY.cliExplanation}</Text>
          </>
        )}
      </Box>
      <ScrollableModalText
        hiddenNoun={AGENT_PROPOSAL_HIDDEN_NOUN}
        maxRows={maxInstructionRows}
        scrollActive={!feedbackMode}
        scrollHint="scroll prompt"
        text={props.payload.instruction}
        width={instructionWidth}
      />
    </ConfirmCard>
  );
}
