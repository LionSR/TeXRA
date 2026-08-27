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
import {
  WORKFLOW_SCRIPT_PROPOSAL_COPY,
  workflowScriptPlanSummary,
} from '@shared/copy/workflowScriptProposal';

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
      wrappedRows(
        `${workflow.name} · ${workflowScriptPlanSummary(workflow)}`,
        width,
      ) +
      wrappedRows(
        WORKFLOW_SCRIPT_PROPOSAL_COPY.defaults(payload.agent, payload.model),
        width,
      ) +
      wrappedRows(WORKFLOW_SCRIPT_PROPOSAL_COPY.costWarning, width) +
      wrappedRows(
        workflow.tasks.length > 0
          ? WORKFLOW_SCRIPT_PROPOSAL_COPY.declaredItemsNote
          : WORKFLOW_SCRIPT_PROPOSAL_COPY.dynamicCallsNote,
        width,
      ) +
      (fileGroups.length > 0
        ? 1 +
          fileGroups.reduce(
            (rows, group) =>
              rows +
              wrappedRows(fileGroupText(group.label, group.files), width),
            0,
          )
        : 0) +
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
              {workflowScriptPlanSummary(workflowScript)}
            </Text>
            <Text>
              {WORKFLOW_SCRIPT_PROPOSAL_COPY.defaults(
                props.payload.agent,
                props.payload.model,
              )}
            </Text>
            <Text color="yellow">
              {WORKFLOW_SCRIPT_PROPOSAL_COPY.costWarning}
            </Text>
            <Text dimColor>
              {workflowScript.tasks.length > 0
                ? WORKFLOW_SCRIPT_PROPOSAL_COPY.declaredItemsNote
                : WORKFLOW_SCRIPT_PROPOSAL_COPY.dynamicCallsNote}
            </Text>
            {fileGroups.length > 0 ? (
              <Box flexDirection="column">
                <Text dimColor>
                  {WORKFLOW_SCRIPT_PROPOSAL_COPY.filesHeading}:
                </Text>
                {fileGroups.map((group) => (
                  <FileGroup
                    key={group.label}
                    label={group.label}
                    files={group.files}
                  />
                ))}
              </Box>
            ) : null}
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
