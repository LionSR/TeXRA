// Standard library imports
import { strict as assert } from 'node:assert';

// Third-party imports
import { describe, it } from 'vitest';

// Local imports
import {
  AgentCategory,
  CODEX_FILE_CHANGE_TOOL,
  CODEX_THREAD_TOOL,
  CODEX_TODO_TOOL,
  CODEX_TURN_TOOL,
} from '@shared/schemas';
import {
  buildCodexConfig,
  toCodexCliReasoningEffort,
} from '@tools/codexConfig';
import {
  buildCodexCommandToolLog,
  buildCodexFileChangeToolLog,
  buildCodexMcpToolLog,
  buildCodexThreadToolLog,
  buildCodexTodoToolLog,
  CODEX_AGENT_NAME,
  CODEX_DISPLAY_MODEL,
  buildCodexTurnToolLog,
  buildCodexUsageStats,
} from '@tools/codexShared';

describe('buildCodexConfig', () => {
  it('uses Codex-specific tool-use metadata for child streams', () => {
    const config = buildCodexConfig('Inspect the failing CI job');

    assert.equal(config.agent, CODEX_AGENT_NAME);
    assert.equal(config.model, CODEX_DISPLAY_MODEL);
    assert.equal(config.agentCategory, AgentCategory.ToolUse);
    assert.equal(config.instruction, 'Inspect the failing CI job');
  });
});

describe('toCodexCliReasoningEffort', () => {
  it.each(['low', 'medium', 'high'] as const)(
    'passes the CLI-compatible %s tier through unchanged',
    (tier) => {
      assert.equal(toCodexCliReasoningEffort(tier), tier);
    },
  );

  it("caps 'xhigh' to 'high' so the Codex CLI config deserializer accepts it", () => {
    // Regression: the Codex CLI's Rust-side config deserializer rejects
    // 'xhigh' with `unknown variant 'xhigh', expected one of 'minimal',
    // 'low', 'medium', 'high' in 'model_reasoning_effort'`.
    assert.equal(toCodexCliReasoningEffort('xhigh'), 'high');
  });
});

describe('buildCodexFileChangeToolLog', () => {
  it('builds a structured Codex patch log entry', () => {
    const log = buildCodexFileChangeToolLog({
      changes: [{ kind: 'update', path: '/tmp/workspace/src/App.ts' }],
      status: 'completed',
    });

    assert.deepEqual(log, {
      toolName: CODEX_FILE_CHANGE_TOOL,
      summary: 'update App.ts',
      input: {
        changes: [{ kind: 'update', path: '/tmp/workspace/src/App.ts' }],
        patchStatus: 'completed',
      },
      status: 'completed',
    });
  });

  it('deduplicates repeated file-change entries', () => {
    const log = buildCodexFileChangeToolLog({
      changes: [
        { kind: 'update', path: '/tmp/workspace/src/App.ts' },
        { kind: 'update', path: '/tmp/workspace/src/App.ts' },
        { kind: 'add', path: '/tmp/workspace/src/New.ts' },
      ],
      status: 'completed',
    });

    assert.deepEqual(log?.input, {
      changes: [
        { kind: 'update', path: '/tmp/workspace/src/App.ts' },
        { kind: 'add', path: '/tmp/workspace/src/New.ts' },
      ],
      patchStatus: 'completed',
    });
  });

  it('surfaces failed patches as native errors', () => {
    const log = buildCodexFileChangeToolLog({
      changes: [{ kind: 'update', path: '/tmp/workspace/src/App.ts' }],
      status: 'failed',
    });

    assert.deepEqual(log, {
      toolName: CODEX_FILE_CHANGE_TOOL,
      summary: 'failed update App.ts',
      input: {
        changes: [{ kind: 'update', path: '/tmp/workspace/src/App.ts' }],
        patchStatus: 'failed',
      },
      error: 'Patch apply failed',
      isError: true,
      status: 'completed',
    });
  });
});

describe('buildCodexCommandToolLog', () => {
  it('builds a native bash log entry with command output', () => {
    const log = buildCodexCommandToolLog({
      command: 'lake env lean MPS/ParentHamiltonian/UniqueGroundState.lean',
      aggregated_output: 'warning: rebuilding\n',
      exit_code: 0,
      status: 'completed',
    });

    assert.deepEqual(log, {
      toolName: 'bash',
      summary: 'lake env lean MPS/ParentHamiltonian/UniqueGroundState.lean',
      input: {
        command: 'lake env lean MPS/ParentHamiltonian/UniqueGroundState.lean',
      },
      output: 'warning: rebuilding',
      status: 'completed',
    });
  });

  it('marks failed commands as errors and falls back to exit info when empty', () => {
    const log = buildCodexCommandToolLog({
      command:
        'lake env lean MPS/ParentHamiltonian/UniqueGroundState.lean --very-long-flag value',
      aggregated_output: '',
      exit_code: 1,
      status: 'failed',
    });

    assert.deepEqual(log, {
      toolName: 'bash',
      summary: 'lake env lean MPS/ParentHamiltonian/UniqueGroundState.lean …',
      input: {
        command:
          'lake env lean MPS/ParentHamiltonian/UniqueGroundState.lean --very-long-flag value',
      },
      output: '(exit 1)',
      error: 'Command failed (exit 1)',
      isError: true,
      status: 'completed',
    });
  });

  it('keeps failed SDK status as error even when exit code is zero', () => {
    const log = buildCodexCommandToolLog({
      command: 'lake build',
      aggregated_output: 'sandbox denied',
      exit_code: 0,
      status: 'failed',
    });

    assert.deepEqual(log, {
      toolName: 'bash',
      summary: 'lake build',
      input: { command: 'lake build' },
      output: 'sandbox denied',
      error: 'Command failed (exit 0)',
      isError: true,
      status: 'completed',
    });
  });

  it('keeps running commands in progress while streaming output', () => {
    const log = buildCodexCommandToolLog({
      command: 'lake build',
      aggregated_output: 'Compiling...\n',
      status: 'in_progress',
    });

    assert.deepEqual(log, {
      toolName: 'bash',
      summary: 'lake build',
      input: { command: 'lake build' },
      output: 'Compiling...',
      status: 'in_progress',
    });
  });
});

describe('buildCodexMcpToolLog', () => {
  it('preserves structured and block MCP output for native rendering', () => {
    const log = buildCodexMcpToolLog({
      id: 'mcp-1',
      type: 'mcp_tool_call',
      server: 'github',
      tool: 'search',
      arguments: { query: 'codex' },
      result: {
        structured_content: { total: 1 },
        content: [{ type: 'text', text: 'Found one result' }],
      },
      status: 'completed',
    });

    assert.deepEqual(log, {
      toolName: 'mcp:github/search',
      input: { query: 'codex' },
      output: {
        status: 'completed',
        structuredContent: { total: 1 },
        contentBlocks: [{ type: 'text', text: 'Found one result' }],
      },
      status: 'completed',
    });
  });
});

describe('buildCodexThreadToolLog', () => {
  it('builds a native thread lifecycle card', () => {
    const log = buildCodexThreadToolLog({
      type: 'thread.started',
      thread_id: 'thread_123',
    });

    assert.deepEqual(log, {
      toolName: CODEX_THREAD_TOOL,
      summary: 'Created',
      input: { threadId: 'thread_123' },
      status: 'completed',
    });
  });
});

describe('buildCodexTodoToolLog', () => {
  it('builds a native checklist card', () => {
    const log = buildCodexTodoToolLog(
      {
        id: 'todo-1',
        type: 'todo_list',
        items: [
          { text: 'Inspect logs', completed: true },
          { text: 'Patch formatter', completed: false },
        ],
      },
      'in_progress',
    );

    assert.deepEqual(log, {
      toolName: CODEX_TODO_TOOL,
      summary: '1/2 completed',
      input: {
        items: [
          { text: 'Inspect logs', completed: true },
          { text: 'Patch formatter', completed: false },
        ],
        completedCount: 1,
        totalCount: 2,
      },
      status: 'in_progress',
    });
  });
});

describe('buildCodexTurnToolLog', () => {
  it.each([
    {
      name: 'builds a structured Codex turn summary entry',
      options: { state: 'completed', wallTimeMs: 518_000 },
      expected: {
        toolName: CODEX_TURN_TOOL,
        summary: 'Completed',
        input: { state: 'completed', wallTimeMs: 518_000 },
        status: 'completed',
      },
    },
    {
      name: 'builds a running Codex turn entry',
      options: { state: 'running' },
      expected: {
        toolName: CODEX_TURN_TOOL,
        summary: 'Running',
        input: { state: 'running' },
        status: 'in_progress',
      },
    },
    {
      name: 'marks a failed turn as an error even without an error message',
      options: { state: 'failed' },
      expected: {
        toolName: CODEX_TURN_TOOL,
        summary: 'Failed',
        input: { state: 'failed' },
        isError: true,
        status: 'completed',
      },
    },
    {
      name: 'attaches the error message when a failed turn has one',
      options: { state: 'failed', error: 'boom' },
      expected: {
        toolName: CODEX_TURN_TOOL,
        summary: 'Failed',
        input: { state: 'failed' },
        error: 'boom',
        isError: true,
        status: 'completed',
      },
    },
  ] as const)('$name', ({ options, expected }) => {
    assert.deepEqual(buildCodexTurnToolLog(options), expected);
  });
});

describe('buildCodexUsageStats', () => {
  it('maps Codex SDK usage into the shared token usage panel shape', () => {
    const usage = buildCodexUsageStats({
      input_tokens: 1200,
      output_tokens: 80,
      cached_input_tokens: 300,
      cache_write_input_tokens: 0,
      reasoning_output_tokens: 0,
    });

    assert.deepEqual(usage, {
      inputTokens: 1200,
      outputTokens: 80,
      cost: 0,
      cacheReadInputTokens: 300,
    });
  });
});
