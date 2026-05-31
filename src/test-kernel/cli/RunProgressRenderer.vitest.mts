import { describe, expect, it } from 'vitest';

import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { pickGlobalArgs } from '@cli/runtime/globalArgs';
import {
  createRunProgressRenderer,
  shouldRenderRunProgress,
} from '@cli/runtime/runProgressRenderer';
import { createCliRuntimeHost } from '@cli/runtime/runtimeHost';
import type { CliContext } from '@cli/runtime/cliContext';
import { STREAM_STATUS } from '@shared/schemas';

function context(overrides: Partial<CliContext> = {}): CliContext {
  return {
    cwd: '/tmp/project',
    mode: 'interactive',
    outputFormat: 'text',
    approvalPolicy: 'never',
    quietLogs: false,
    renderRunProgress: true,
    stderrIsTty: true,
    colorEnabled: true,
    version: '0.0.0',
    resourcesPath: '/tmp/resources',
    ...overrides,
  };
}

function workflowTaskState(
  overrides: {
    streamId?: string;
    agent?: string;
    inputFiles?: string[];
  } = {},
) {
  return {
    streamId: overrides.streamId ?? 'stream-1',
    taskState: {
      agentConfig: {
        agent: overrides.agent ?? 'polish',
        agentCategory: AgentCategory.Workflow,
        model: 'deepseekT',
        inputFiles: overrides.inputFiles ?? ['paper.tex'],
        contextFiles: [],
        mediaFiles: [],
        outputFiles: [],
        editedFile: null,
        editedFiles: [],
        toolConfig: {
          autoExtractFigure: false,
          autoExtractTikzFigure: false,
          attachTeXCount: false,
          attachDiagnostics: false,
          autoCompileInputPdf: false,
        },
        memories: [],
        instruction: '',
        workingDirectory: '/tmp/project',
      },
      activeFiles: {
        input: true,
        output: false,
        media: false,
        context: false,
      },
    },
  };
}

describe('CLI run progress renderer', () => {
  it('renders a single ANSI status line and clears it on close', () => {
    let now = 0;
    let output = '';
    const renderer = createRunProgressRenderer(context(), {
      colorEnabled: true,
      write: (text) => {
        output += text;
      },
      nowMs: () => now,
    });

    expect(renderer).toBeDefined();
    renderer?.handle('setTaskState', workflowTaskState());
    expect(output).toBe('\r\x1b[2Kpolish paper.tex · 0s');

    now = 1200;
    renderer?.handle('updateConversationProgress', {
      streamId: 'stream-1',
      progress: { conversationTurns: 2, toolCallCount: 0 },
    });
    expect(output).toContain('\r\x1b[2K[r2] · polish paper.tex · 1s');

    renderer?.clear();
    expect(output.endsWith('\r\x1b[2K')).toBe(true);
  });

  it('prints phase changes on separate lines when ANSI is disabled', () => {
    let output = '';
    const renderer = createRunProgressRenderer(
      context({ colorEnabled: false }),
      {
        colorEnabled: false,
        write: (text) => {
          output += text;
        },
        nowMs: () => 0,
      },
    );

    renderer?.handle('setTaskState', workflowTaskState());
    renderer?.handle('updateStreamDescription', {
      streamId: 'stream-1',
      description: 'drafting',
    });
    renderer?.handle('updateActiveProcesses', {
      parentStreamId: 'stream-1',
      processes: [
        {
          executionId: 'process-1',
          agentName: 'bash',
          toolName: 'Bash',
          status: 'running',
        },
      ],
    });

    expect(output).toBe(
      'polish paper.tex · 0s\n' +
        'polish paper.tex · drafting · 0s\n' +
        'polish paper.tex · drafting · tool: Bash · 0s\n',
    );
  });

  it('keeps the root run visible when child streams update progress', () => {
    let output = '';
    const renderer = createRunProgressRenderer(
      context({ colorEnabled: false }),
      {
        colorEnabled: false,
        write: (text) => {
          output += text;
        },
        nowMs: () => 0,
      },
    );

    renderer?.handle(
      'setTaskState',
      workflowTaskState({
        streamId: 'root-stream',
        agent: 'coordinator',
        inputFiles: ['main.tex'],
      }),
    );
    renderer?.handle(
      'setTaskState',
      workflowTaskState({
        streamId: 'child-stream',
        agent: 'reviewer',
        inputFiles: ['chapter.tex'],
      }),
    );
    renderer?.handle('updateStreamDescription', {
      streamId: 'child-stream',
      description: 'reviewing chapter.tex',
    });
    renderer?.handle('updateActiveSubagents', {
      parentStreamId: 'root-stream',
      children: [
        {
          executionId: 'child-1',
          childStreamId: 'child-stream',
          agentName: 'reviewer',
          status: 'running',
        },
        {
          executionId: 'child-2',
          childStreamId: 'child-stream-2',
          agentName: 'compiler',
          status: 'running',
        },
        {
          executionId: 'child-3',
          childStreamId: 'child-stream-3',
          agentName: 'proofreader',
          status: 'running',
        },
      ],
    });

    expect(output).toBe(
      'coordinator main.tex · 0s\n' +
        'coordinator main.tex · subagents: reviewer +2 · 0s\n',
    );
  });

  it('can claim the root stream from conversation progress', () => {
    let output = '';
    const renderer = createRunProgressRenderer(
      context({ colorEnabled: false }),
      {
        colorEnabled: false,
        write: (text) => {
          output += text;
        },
        minIntervalMs: 0,
        nowMs: () => 0,
      },
    );

    renderer?.handle('updateConversationProgress', {
      streamId: 'root-stream',
      progress: { conversationTurns: 2, toolCallCount: 4 },
    });
    renderer?.handle(
      'setTaskState',
      workflowTaskState({
        streamId: 'child-stream',
        agent: 'reviewer',
        inputFiles: ['chapter.tex'],
      }),
    );

    expect(output).toBe('[r2] · running · tools: 4 · 0s\n');
  });

  it('keeps named active children visible when earlier entries are unnamed', () => {
    let output = '';
    const renderer = createRunProgressRenderer(
      context({ colorEnabled: false }),
      {
        colorEnabled: false,
        write: (text) => {
          output += text;
        },
        nowMs: () => 0,
      },
    );

    renderer?.handle('setTaskState', workflowTaskState());
    renderer?.handle('updateActiveProcesses', {
      parentStreamId: 'stream-1',
      processes: [
        {
          executionId: 'process-1',
          agentName: '',
          toolName: '',
          status: 'running',
        },
        {
          executionId: 'process-2',
          agentName: 'latexmk',
          status: 'running',
        },
      ],
    });

    expect(output).toBe(
      'polish paper.tex · 0s\npolish paper.tex · tool: latexmk · 0s\n',
    );
  });

  it('does not overwrite a terminal status with late root descriptions', () => {
    let now = 0;
    let output = '';
    const renderer = createRunProgressRenderer(
      context({ colorEnabled: false }),
      {
        colorEnabled: false,
        write: (text) => {
          output += text;
        },
        minIntervalMs: 0,
        nowMs: () => now,
      },
    );

    renderer?.handle(
      'setTaskState',
      workflowTaskState({
        streamId: 'root-stream',
        agent: 'orchestrator',
        inputFiles: [],
      }),
    );
    renderer?.handle('updateActiveProcesses', {
      parentStreamId: 'root-stream',
      processes: [
        {
          executionId: 'tool-1',
          agentName: 'bash',
          toolName: 'Bash',
          status: 'running',
        },
      ],
    });
    now = 11000;
    renderer?.handle('updateStreamStatus', {
      streamId: 'root-stream',
      status: STREAM_STATUS.STOPPED,
      previousStatus: STREAM_STATUS.RUNNING,
    });
    renderer?.handle('updateStreamDescription', {
      streamId: 'root-stream',
      description: 'Running Mathematician multi-agent preset',
    });
    renderer?.handle('updateActiveProcesses', {
      parentStreamId: 'root-stream',
      processes: [
        {
          executionId: 'tool-2',
          agentName: 'late-tool',
          toolName: 'LateTool',
          status: 'running',
        },
      ],
    });

    expect(output).toBe(
      'orchestrator · 0s\n' +
        'orchestrator · tool: Bash · 0s\n' +
        'orchestrator · stopped · 11s\n',
    );
  });

  it('uses a separate render flag from platform log suppression', () => {
    expect(
      createRunProgressRenderer(
        context({ quietLogs: true, renderRunProgress: true }),
      ),
    ).toBeDefined();
    expect(
      createRunProgressRenderer(context({ renderRunProgress: false })),
    ).toBe(undefined);
  });

  it('derives the run progress flag from quiet and structured-output contexts', () => {
    expect(shouldRenderRunProgress(context())).toBe(true);
    expect(shouldRenderRunProgress(context({ quietLogs: true }))).toBe(false);
    expect(shouldRenderRunProgress(context({ mode: 'headless' }))).toBe(true);
    expect(shouldRenderRunProgress(context({ outputFormat: 'json' }))).toBe(
      false,
    );
    expect(shouldRenderRunProgress(context({ outputFormat: 'ndjson' }))).toBe(
      false,
    );
    expect(shouldRenderRunProgress(context({ stderrIsTty: false }))).toBe(true);
  });

  it('routes progress events even when ordinary CLI logs are quiet', async () => {
    let output = '';
    const originalWrite = process.stderr.write;
    process.stderr.write = ((
      chunk: string | Uint8Array,
      ...args: unknown[]
    ) => {
      output += String(chunk);
      const callback = args.find(
        (arg): arg is (error?: Error | null) => void =>
          typeof arg === 'function',
      );
      callback?.();
      return true;
    }) as typeof process.stderr.write;

    try {
      const host = createCliRuntimeHost(
        context({ quietLogs: true, renderRunProgress: true }),
      );
      host.emit('setTaskState', workflowTaskState());
      await host.close();
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(output).toContain('polish paper.tex · 0s');
  });

  it('writes subagent progress events to stdout in ndjson mode', async () => {
    let output = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = ((
      chunk: string | Uint8Array,
      ...args: unknown[]
    ) => {
      output += String(chunk);
      const callback = args.find(
        (arg): arg is (error?: Error | null) => void =>
          typeof arg === 'function',
      );
      callback?.();
      return true;
    }) as typeof process.stdout.write;

    try {
      const host = createCliRuntimeHost(
        context({ outputFormat: 'ndjson', renderRunProgress: false }),
      );
      host.emit('updateActiveSubagents', {
        parentStreamId: 'parent-stream',
        children: [
          {
            executionId: 'child-execution',
            childStreamId: 'child-stream',
            agentName: 'review',
            status: 'running',
          },
        ],
      });
      await host.close();
    } finally {
      process.stdout.write = originalWrite;
    }

    const records = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

    expect(records).toEqual([
      expect.objectContaining({
        kind: 'progress',
        event: 'updateActiveSubagents',
        payload: {
          parentStreamId: 'parent-stream',
          children: [
            {
              executionId: 'child-execution',
              childStreamId: 'child-stream',
              agentName: 'review',
              status: 'running',
            },
          ],
        },
      }),
    ]);
  });

  it('maps the global quiet flag into CLI context args', () => {
    expect(
      pickGlobalArgs({
        quiet: true,
        'output-format': 'text',
        'approval-policy': 'never',
      }).quiet,
    ).toBe(true);
  });
});
