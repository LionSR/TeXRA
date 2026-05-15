import { describe, expect, it } from 'vitest';

import type { AgentConfig } from '@agent/core/AgentConfig';
import type { AgentPrompt, AgentSetting } from '@agent/core/AgentDataclass';
import { getOutputFilesOrder } from '@agent/utils/userVars';
import { renderPrompt } from '@utils/prompt';

const emptyPrompt: AgentPrompt = {
  systemPrompt: '',
  userPrefix: '',
  userRequest: '',
};

describe('OUTPUT_FILES_ORDER prompt variable', () => {
  it('renders as an indexable filename array', async () => {
    const vars = getOutputFilesOrder(
      {
        outputFiles: ['main.tex', 'appendix.tex'],
      } as AgentConfig,
      {} as AgentSetting,
      emptyPrompt,
    );

    await expect(
      renderPrompt(
        '<document name="{{ OUTPUT_FILES_ORDER[0] }}">{{ OUTPUT_FILES_ORDER | join(", ") }}</document>',
        vars,
      ),
    ).resolves.toBe(
      '<document name="main.tex">main.tex, appendix.tex</document>',
    );
  });

  it('falls back to default output files as the same array value', async () => {
    const agentConfig = {} as AgentConfig;
    const vars = getOutputFilesOrder(
      agentConfig,
      {
        defaultOutputFiles: ['slides.tex'],
      } as AgentSetting,
      emptyPrompt,
    );

    expect(vars.OUTPUT_FILES_ORDER).toEqual(['slides.tex']);
    expect(agentConfig.outputFiles).toEqual(['slides.tex']);
  });

  it('uses input files when no explicit output list is provided', () => {
    const vars = getOutputFilesOrder(
      {
        inputFiles: ['main.tex', 'appendix.tex'],
        outputFiles: [],
      } as unknown as AgentConfig,
      { defaultOutputFiles: [] } as unknown as AgentSetting,
      {
        ...emptyPrompt,
        userRequest:
          '<document name="{{ OUTPUT_FILES_ORDER[0] }}">...</document>',
      },
    );

    expect(vars.OUTPUT_FILES_ORDER).toEqual(['main.tex', 'appendix.tex']);
  });

  it('keeps input files available for prompts that branch on output order', () => {
    const vars = getOutputFilesOrder(
      {
        inputFiles: ['main.tex'],
        outputFiles: [],
      } as unknown as AgentConfig,
      { defaultOutputFiles: [] } as unknown as AgentSetting,
      {
        ...emptyPrompt,
        userRequest:
          '{% if OUTPUT_FILES_ORDER %}{{ OUTPUT_FILES_ORDER[0] }}{% endif %}',
      },
    );

    expect(vars.OUTPUT_FILES_ORDER).toEqual(['main.tex']);
  });
});
