// Interactive wizard for `texra init`. A small multi-step picker built on the
// shared Select primitive (same pattern as runOrchestrationTui): one question
// per screen, Esc cancels. Returns the collected answers, or `undefined` when
// the user backs out. Pure config logic lives in runtime/initConfig.

import { render, Box, Text, useApp } from 'ink';
import { useState } from 'react';

import { KeyHints } from '../chat/tui/ui/KeyHints';
import { Select } from '../chat/tui/ui/Select';
import { clearTerminalScrollback } from '../chat/tui/terminalCleanup';
import {
  CLI_OUTPUT_FORMATS,
  type CliApprovalPolicy,
  type CliOutputFormat,
} from '../schemas/cliSettings';
import type { InitAnswers } from '../runtime/initConfig';

export interface InitWizardAgentOption {
  readonly name: string;
  readonly description?: string;
}

export interface InitWizardModelOption {
  readonly value: string;
  readonly label: string;
  readonly available: boolean;
  readonly status: string;
}

export interface InitWizardOptions {
  readonly agents: readonly InitWizardAgentOption[];
  readonly models: readonly InitWizardModelOption[];
}

export interface InitWizardResult {
  readonly answers: InitAnswers;
  readonly gitignore: boolean;
}

const APPROVAL_DESCRIPTIONS: Record<CliApprovalPolicy, string> = {
  never: 'deny every privileged action (no prompt)',
  ask: 'confirm before privileged actions (recommended)',
  yolo: 'auto-approve every action',
};

// `ask` first so the wizard highlights the recommended, runtime-default policy
// instead of the deny-all `never`.
const APPROVAL_POLICY_ORDER: readonly CliApprovalPolicy[] = [
  'ask',
  'never',
  'yolo',
];

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

interface Draft {
  agent?: string;
  model?: string;
  approvalPolicy?: CliApprovalPolicy;
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

function firstAvailableIndex(models: readonly InitWizardModelOption[]): number {
  const index = models.findIndex((model) => model.available);
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
    // Last step — every field is set by construction of `steps`.
    if (
      merged.agent === undefined ||
      merged.model === undefined ||
      merged.approvalPolicy === undefined ||
      merged.outputFormat === undefined
    ) {
      cancel();
      return;
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

  const stepNumber = index + 1;

  if (step === 'agent') {
    return (
      <StepFrame
        stepNumber={stepNumber}
        stepCount={stepCount}
        title="default agent for texra chat"
      >
        <Select
          key={step}
          items={props.options.agents.map((agent) => ({
            value: agent.name,
            label: agent.name,
            description: agent.description,
          }))}
          onSelect={(agent) => commit({ agent })}
          onCancel={cancel}
        />
      </StepFrame>
    );
  }

  if (step === 'model') {
    return (
      <StepFrame
        stepNumber={stepNumber}
        stepCount={stepCount}
        title="default model"
      >
        <Select
          key={step}
          initialIndex={firstAvailableIndex(props.options.models)}
          items={props.options.models.map((model) => ({
            value: model.value,
            label: model.label,
            description: model.available
              ? model.status
              : `${model.status} (unavailable now)`,
          }))}
          onSelect={(model) => commit({ model })}
          onCancel={cancel}
        />
      </StepFrame>
    );
  }

  if (step === 'approval') {
    return (
      <StepFrame
        stepNumber={stepNumber}
        stepCount={stepCount}
        title="approval policy"
      >
        <Select
          key={step}
          items={APPROVAL_POLICY_ORDER.map((policy) => ({
            value: policy,
            label: policy,
            description: APPROVAL_DESCRIPTIONS[policy],
          }))}
          onSelect={(approvalPolicy) => commit({ approvalPolicy })}
          onCancel={cancel}
        />
      </StepFrame>
    );
  }

  if (step === 'output') {
    return (
      <StepFrame
        stepNumber={stepNumber}
        stepCount={stepCount}
        title="default output format"
      >
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
      </StepFrame>
    );
  }

  return (
    <StepFrame
      stepNumber={stepNumber}
      stepCount={stepCount}
      title="add .texra/ to .gitignore?"
    >
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
    </StepFrame>
  );
}

export async function runInitWizard(
  options: InitWizardOptions,
): Promise<InitWizardResult | undefined> {
  return new Promise((resolve) => {
    let chosen: InitWizardResult | undefined;
    const record = (result: InitWizardResult | undefined): void => {
      chosen = result;
    };

    const instance = render(
      <WizardApp options={options} onResolve={record} />,
      {
        stdout: process.stdout,
        stderr: process.stderr,
        stdin: process.stdin,
      },
    );

    void instance.waitUntilExit().then(() => {
      clearTerminalScrollback();
      resolve(chosen);
    });
  });
}
