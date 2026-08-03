// Interactive wizard for `texra init`. A small multi-step picker built on the
// shared Select primitive (same pattern as runOrchestrationTui): one question
// per screen, Esc cancels. Returns the collected answers, or `undefined` when
// the user backs out. Pure config logic lives in runtime/initConfig.

import { Box, Text, useApp } from 'ink';
import { useState } from 'react';

import { KeyHints } from '@cli/tui/ui/KeyHints';
import { Select, type SelectItem } from '@cli/tui/ui/Select';
import { renderCliPrompt } from '@cli/tui/renderCliPrompt';
import {
  TEXRA_APPROVAL_POLICY_OPTIONS,
  type TexraApprovalPolicy,
} from '@shared/approvalPolicy';
import {
  CLI_OUTPUT_FORMATS,
  type CliOutputFormat,
} from '../schemas/cliSettings';
import { pickDefaultToolUseAgent } from '../runtime/defaultAgents';
import type { InitAnswers } from '../runtime/initConfig';
import type { CliModelAccess } from '../runtime/modelAccess';

export interface InitWizardAgentOption {
  readonly name: string;
}

export interface InitWizardOptions {
  readonly agents: readonly InitWizardAgentOption[];
  readonly models: readonly CliModelAccess[];
  readonly colorEnabled?: boolean;
}

export interface InitWizardResult {
  readonly answers: InitAnswers;
  readonly gitignore: boolean;
}

const OUTPUT_DESCRIPTIONS: Record<CliOutputFormat, string> = {
  text: 'human-readable text (default)',
  json: 'a single JSON object',
  ndjson: 'newline-delimited JSON stream',
};

type Step = 'agent' | 'model' | 'approval' | 'output' | 'gitignore';

const STEPS: readonly Step[] = [
  'agent',
  'model',
  'approval',
  'output',
  'gitignore',
];

const STEP_TITLES: Record<Step, string> = {
  agent: 'default agent for texra chat',
  model: 'default model',
  approval: 'approval policy',
  output: 'default output format',
  gitignore: 'add .texra/ to .gitignore?',
};

interface Draft {
  agent?: string;
  model?: string;
  approvalPolicy?: TexraApprovalPolicy;
  outputFormat?: CliOutputFormat;
  gitignore?: boolean;
}

function StepFrame(props: {
  readonly stepNumber: number;
  readonly stepCount: number;
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color="cyan">
        texra init
      </Text>
      <Text dimColor>
        Step {props.stepNumber}/{props.stepCount} · {props.title}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {props.children}
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            { key: 'Enter', action: 'select' },
            { key: 'Esc', action: 'cancel' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}

function firstAvailableIndex(models: readonly CliModelAccess[]): number {
  const index = models.findIndex((model) => model.available);
  return index >= 0 ? index : 0;
}

export function initWizardModelSelectItems(
  models: readonly CliModelAccess[],
): ReadonlyArray<SelectItem<string>> {
  const hasAvailableModel = models.some((model) => model.available);
  return models.map((model) => ({
    value: model.model.value,
    label: model.model.label || model.model.value,
    description: model.available
      ? model.status
      : `${model.status} (unavailable now)`,
    disabled: hasAvailableModel && !model.available,
  }));
}

export function initWizardDefaultAgentIndex(
  agents: readonly InitWizardAgentOption[],
): number {
  const defaultAgent = pickDefaultToolUseAgent(agents);
  const index = agents.findIndex((agent) => agent.name === defaultAgent);
  return index >= 0 ? index : 0;
}

interface WizardAppProps {
  readonly options: InitWizardOptions;
  readonly onResolve: (result: InitWizardResult | undefined) => void;
}

function WizardApp(props: WizardAppProps): React.JSX.Element {
  const app = useApp();
  const stepCount = STEPS.length;
  const [index, setIndex] = useState(0);
  const [draft, setDraft] = useState<Draft>({});
  const step = STEPS[index];

  const cancel = (): void => {
    props.onResolve(undefined);
    app.exit();
  };

  const commit = (patch: Draft): void => {
    const merged = { ...draft, ...patch };
    setDraft(merged);
    if (index + 1 < stepCount) {
      setIndex(index + 1);
      return;
    }
    // Last step — every field is set by construction of `STEPS`. A gap means
    // the step list and the answer shape drifted apart, which is a bug in this
    // file: report it instead of resolving as "the user backed out", which
    // would drop the answers they just gave with no explanation.
    if (
      merged.agent === undefined ||
      merged.model === undefined ||
      merged.approvalPolicy === undefined ||
      merged.outputFormat === undefined
    ) {
      throw new Error(
        'texra init wizard reached its last step with an unanswered question: STEPS and InitAnswers are out of sync.',
      );
    }
    props.onResolve({
      answers: {
        agent: merged.agent,
        model: merged.model,
        approvalPolicy: merged.approvalPolicy,
        outputFormat: merged.outputFormat,
      },
      gitignore: merged.gitignore ?? false,
    });
    app.exit();
  };

  let picker: React.JSX.Element;
  switch (step) {
    case 'agent':
      picker = (
        <Select
          key={step}
          initialIndex={initWizardDefaultAgentIndex(props.options.agents)}
          items={props.options.agents.map((agent) => ({
            value: agent.name,
            label: agent.name,
          }))}
          onSelect={(agent) => commit({ agent })}
          onCancel={cancel}
        />
      );
      break;
    case 'model':
      picker = (
        <Select
          key={step}
          initialIndex={firstAvailableIndex(props.options.models)}
          items={initWizardModelSelectItems(props.options.models)}
          onSelect={(model) => commit({ model })}
          onCancel={cancel}
        />
      );
      break;
    case 'approval':
      picker = (
        <Select
          key={step}
          items={TEXRA_APPROVAL_POLICY_OPTIONS}
          onSelect={(approvalPolicy) => commit({ approvalPolicy })}
          onCancel={cancel}
        />
      );
      break;
    case 'output':
      picker = (
        <Select
          key={step}
          items={CLI_OUTPUT_FORMATS.map((format) => ({
            value: format,
            label: format,
            description: OUTPUT_DESCRIPTIONS[format],
          }))}
          onSelect={(outputFormat) => commit({ outputFormat })}
          onCancel={cancel}
        />
      );
      break;
    case 'gitignore':
      picker = (
        <Select
          key={step}
          items={[
            {
              value: true,
              label: 'Yes',
              description: 'keep local config out of git',
            },
            {
              value: false,
              label: 'No',
              description: 'leave .gitignore unchanged',
            },
          ]}
          onSelect={(gitignore) => commit({ gitignore })}
          onCancel={cancel}
        />
      );
      break;
  }

  return (
    <StepFrame
      stepNumber={index + 1}
      stepCount={stepCount}
      title={STEP_TITLES[step]}
    >
      {picker}
    </StepFrame>
  );
}

export async function runInitWizard(
  options: InitWizardOptions,
): Promise<InitWizardResult | undefined> {
  return renderCliPrompt<InitWizardResult | undefined>(
    (resolve) => <WizardApp options={options} onResolve={resolve} />,
    {
      stdout: process.stdout,
      stderr: process.stderr,
      colorEnabled: options.colorEnabled,
      clear: 'scrollback',
    },
  );
}
