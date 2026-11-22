// Interactive wizard for `texra init`. A small multi-step picker built on the
// shared Select primitive (same pattern as runOrchestrationTui): one question
// per screen, Esc cancels. Returns the collected answers, or `undefined` when
// the user backs out. Pure config logic lives in runtime/initConfig.

import { Effect } from 'effect';
import { Box, Text, useApp } from 'ink';
import { useState } from 'react';

import { Select, type SelectItem } from '@cli/tui/ui/Select';
import { COLOR_HINT } from '@cli/tui/ui/colors';
import { renderCliPrompt } from '@cli/tui/renderCliPrompt';
import {
  CLI_OUTPUT_FORMATS,
  type CliOutputFormat,
} from '@texra/shared/cliOutputFormat';
import type { InitAnswers } from '../runtime/platform/initConfig';
import { isModelOptionAvailable } from '@texra-ai/worldline/schemas';
import type { ModelOptionData } from '@texra/shared/pickerOptions';
import { cliModelStatus } from '../runtime/models/modelAccess';
import { CANCEL_HINT, KeyHints, NAVIGATE_HINT } from '@cli/tui/ui/KeyHints';

interface InitWizardOptions {
  readonly models: readonly ModelOptionData[];
  readonly colorEnabled?: boolean;
}

interface InitWizardResult {
  readonly answers: InitAnswers;
  readonly gitignore: boolean;
}

const OUTPUT_DESCRIPTIONS: Record<CliOutputFormat, string> = {
  text: 'human-readable text (default)',
  json: 'a single JSON object',
  ndjson: 'newline-delimited JSON stream',
};

const STEPS = Object.freeze(['model', 'output', 'gitignore'] as const);
type Step = (typeof STEPS)[number];

const STEP_TITLES: Record<Step, string> = {
  model: 'Default model',
  output: 'Default output format',
  gitignore: 'Add .texra/ to .gitignore?',
};

interface Draft {
  model?: string;
  outputFormat?: CliOutputFormat;
  gitignore?: boolean;
}

function initWizardModelSelectItems(
  models: readonly ModelOptionData[],
): ReadonlyArray<SelectItem<string>> {
  const hasAvailableModel = models.some(isModelOptionAvailable);
  return models.map((model) => {
    const available = isModelOptionAvailable(model);
    const status = cliModelStatus(model);
    return {
      value: model.value,
      label: model.label || model.value,
      description: available ? status : `${status} (unavailable now)`,
      disabled: hasAvailableModel && !available,
    };
  });
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
    if (merged.model === undefined || merged.outputFormat === undefined) {
      throw new Error(
        'texra init wizard reached its last step with an unanswered question: STEPS and InitAnswers are out of sync.',
      );
    }
    props.onResolve({
      answers: {
        model: merged.model,
        outputFormat: merged.outputFormat,
      },
      gitignore: merged.gitignore ?? false,
    });
    app.exit();
  };

  let picker: React.JSX.Element;
  switch (step) {
    case 'model':
      picker = (
        <Select
          key={step}
          initialIndex={Math.max(
            0,
            props.options.models.findIndex(isModelOptionAvailable),
          )}
          items={initWizardModelSelectItems(props.options.models)}
          onSelect={(model) => commit({ model })}
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
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={COLOR_HINT}>
        texra init
      </Text>
      <Text
        dimColor
      >{`Step ${index + 1}/${stepCount} · ${STEP_TITLES[step]}`}</Text>
      <Box marginTop={1} flexDirection="column">
        {picker}
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            NAVIGATE_HINT,
            { key: 'Enter', action: 'select' },
            CANCEL_HINT,
          ]}
        />
      </Box>
    </Box>
  );
}

export function runInitWizard(
  options: InitWizardOptions,
): Effect.Effect<InitWizardResult | undefined> {
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
