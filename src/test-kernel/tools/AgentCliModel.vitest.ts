// The model and effort the Claude Code and Codex tools run with: which models
// each CLI accepts, the settings' defaults, and what the reasoning policy
// sends (default, @effort suffix, snapping, and the Codex CLI's own ceiling).
import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { ReasoningEffort } from 'llm-zoo';

import { modelConfig } from '@texra-ai/llm';
import { settingDefault } from '@shared/config/settingsAccess';
import {
  CLAUDE_AGENT_MODEL_SETTING,
  CODEX_MODEL_SETTING,
  ClaudeAgentModelSchema,
  ToolError,
  type AgentCliEffort,
  isClaudeCodeModel,
  isCodexModel,
} from '@shared/schemas';
import {
  installSettingsCatalog,
  settingByKey,
} from '@shared/state/stateSettings';
import {
  ClaudeAgentStateKey,
  CodexStateKey,
} from '@texra/shared/settingsView/integrationSettings';
import { TEXRA_SETTINGS } from '@texra/shared/settingsView/texraSettings';
import { selectAgentCliModel } from '@texra/tools/agentCliModel';
import { readClaudeCodeRun } from '@texra/tools/claudeAgentShared';
import { CODEX_MODEL_RULE, codexRun } from '@texra/tools/codexConfig';

import { scriptedSpawnerLayer } from '../support/childProcessTestLayer';
import { makeFakeSettingsStores } from '../support/settingsStoresFake';

const MEDIUM = ReasoningEffort.MEDIUM;
const CLAUDE_AGENT_DEFAULT_MODEL = 'anthropic/claude-sonnet-5-5';
const CODEX_DEFAULT_MODEL = 'openai/gpt-6.1-sol';
const CodexModelSchema = CODEX_MODEL_SETTING.schema.unwrap();

// The plugins' rows, as a host's `installProcessRuntime` installs them: this
// suite runs in the pure tier, which has no fake platform to do it.
installSettingsCatalog(TEXRA_SETTINGS);

describe('agent CLI model settings', () => {
  it('defaults both efforts to medium and both models to registry models', () => {
    const row = (key: string) => {
      const entry = settingByKey(key);
      if (!entry) throw new Error(`no row ${key}`);
      return settingDefault(entry);
    };
    expect(row(ClaudeAgentStateKey.EFFORT)).toBe(MEDIUM);
    expect(row(CodexStateKey.REASONING_EFFORT)).toBe(MEDIUM);
    expect(row(ClaudeAgentStateKey.MODEL)).toBe(CLAUDE_AGENT_DEFAULT_MODEL);
    expect(row(CodexStateKey.MODEL)).toBe(CODEX_DEFAULT_MODEL);
  });

  it('offers every current Anthropic model, and only those, to Claude Code', () => {
    const options = ClaudeAgentModelSchema.options;
    expect(options).toContain(CLAUDE_AGENT_DEFAULT_MODEL);
    expect(options.length).toBe(CLAUDE_AGENT_MODEL_SETTING.enumLabels.length);
    for (const ref of options) {
      const config = modelConfig(ref);
      expect(config && isClaudeCodeModel(config)).toBe(true);
      expect(config?.deprecated).not.toBe(true);
    }
  });

  it('offers current Codex-served models, with the default among them', () => {
    const options = CodexModelSchema.options;
    expect(options).toContain(CODEX_DEFAULT_MODEL);
    expect(options.length).toBe(CODEX_MODEL_SETTING.enumLabels.length);
    for (const ref of options) {
      const config = modelConfig(ref);
      expect(config && isCodexModel(config)).toBe(true);
      expect(config?.deprecated).not.toBe(true);
    }
    expect(
      CodexModelSchema.safeParse('anthropic/claude-sonnet-5-5').success,
    ).toBe(false);
  });
});

describe('readClaudeCodeRun', () => {
  const claudeRun = (
    model: string,
    effort?: AgentCliEffort,
    userEffort?: AgentCliEffort,
  ) => {
    const fake = makeFakeSettingsStores();
    return Effect.gen(function* () {
      if (userEffort) {
        yield* fake.repoState.update(ClaudeAgentStateKey.EFFORT, userEffort);
      }
      return yield* readClaudeCodeRun(fake.stores, { model, effort });
    });
  };

  it.effect('rejects a model that is not a served Anthropic model', () =>
    Effect.gen(function* () {
      const openai = yield* Effect.flip(claudeRun('openai/gpt-6.1-sol'));
      expect(openai).toBeInstanceOf(ToolError);
      expect(openai.message).toMatch(
        /Claude Code cannot run "openai\/gpt-6\.1-sol".*Anthropic/,
      );
      expect(yield* Effect.flip(claudeRun('claude-sonnet-5'))).toBeInstanceOf(
        ToolError,
      );
    }),
  );

  it.effect(
    'sends the API id, the default medium effort and adaptive thinking',
    () =>
      Effect.gen(function* () {
        expect(yield* claudeRun(CLAUDE_AGENT_DEFAULT_MODEL)).toEqual({
          ref: 'anthropic/claude-sonnet-5-5',
          model: 'claude-sonnet-5-5',
          effort: 'medium',
          thinking: { type: 'adaptive' },
          note: undefined,
        });
      }),
  );

  it.effect(
    "takes the model string's @effort, and the call's effort over it",
    () =>
      Effect.gen(function* () {
        const suffixed = 'anthropic/claude-opus-5-5@high';
        expect((yield* claudeRun(suffixed)).effort).toBe('high');
        expect((yield* claudeRun(suffixed, ReasoningEffort.LOW)).effort).toBe(
          'low',
        );
      }),
  );

  it.effect(
    'snaps a level the model lacks to the nearest one and says so',
    () =>
      Effect.gen(function* () {
        // Opus 4.6 has no xhigh; high and max are equally near, so it goes up.
        const run = yield* claudeRun(
          'anthropic/claude-opus-4-6',
          ReasoningEffort.XHIGH,
        );
        expect(run.effort).toBe('max');
        expect(run.note).toMatch(/no xhigh effort; using max/);
      }),
  );

  it.effect(
    'sends neither effort nor adaptive thinking to a budget-sized model',
    () =>
      Effect.gen(function* () {
        const run = yield* claudeRun(
          'anthropic/claude-haiku-4-5-20251001',
          undefined,
          ReasoningEffort.HIGH,
        );
        expect(run.effort).toBeUndefined();
        expect(run.thinking).toBeUndefined();
      }),
  );
});

describe('codexRun', () => {
  it('rejects a model the Codex backend does not serve', () => {
    expect(() =>
      selectAgentCliModel('openai/o3-2025-04-16', CODEX_MODEL_RULE),
    ).toThrow(/Codex cannot run "openai\/o3-2025-04-16"/);
    expect(() =>
      selectAgentCliModel('anthropic/claude-sonnet-5-5', CODEX_MODEL_RULE),
    ).toThrow(ToolError);
  });

  const catalog = (efforts: readonly string[]) =>
    JSON.stringify({
      models: [
        { slug: 'other-model', supported_reasoning_levels: [] },
        {
          slug: 'gpt-6.1-sol',
          supported_reasoning_levels: efforts.map((effort) => ({ effort })),
        },
      ],
    });

  const runWith = (
    effort: string | undefined,
    binaryPath: string | undefined,
    answer: Parameters<typeof scriptedSpawnerLayer>[0],
  ) => {
    const fake = makeFakeSettingsStores();
    const spawner = scriptedSpawnerLayer(answer);
    return Effect.gen(function* () {
      if (effort) {
        yield* fake.repoState.update(CodexStateKey.REASONING_EFFORT, effort);
      }
      const run = yield* codexRun(fake.stores, binaryPath);
      return { run, calls: spawner.calls };
    }).pipe(Effect.provide(spawner.layer));
  };

  it.effect('runs the default model at medium without probing the CLI', () =>
    Effect.gen(function* () {
      const { run, calls } = yield* runWith(
        undefined,
        '/codex/default',
        () => ({
          stdout: catalog(['low']),
        }),
      );
      expect(run).toEqual({
        ref: CODEX_DEFAULT_MODEL,
        slug: 'gpt-6.1-sol',
        effort: 'medium',
        note: undefined,
      });
      expect(calls).toHaveLength(0);
    }),
  );

  it.effect('keeps a level above high that the CLI reports for the slug', () =>
    Effect.gen(function* () {
      const { run, calls } = yield* runWith('xhigh', '/codex/new', () => ({
        stdout: catalog(['low', 'medium', 'high', 'xhigh']),
      }));
      expect(run.effort).toBe('xhigh');
      expect(calls.map((call) => call.args)).toEqual([
        ['debug', 'models', '--bundled'],
      ]);
    }),
  );

  it.effect("caps at the CLI's highest level for the slug, with a note", () =>
    Effect.gen(function* () {
      const { run } = yield* runWith('max', '/codex/xhigh-only', () => ({
        stdout: catalog(['low', 'medium', 'high', 'xhigh']),
      }));
      expect(run.effort).toBe('xhigh');
      expect(run.note).toMatch(/no max effort; using xhigh/);
    }),
  );

  it.effect('caps at high when the probe fails', () =>
    Effect.gen(function* () {
      const { run } = yield* runWith('xhigh', '/codex/missing', () => ({
        exitCode: 127,
      }));
      expect(run.effort).toBe('high');
      expect(run.note).toMatch(/using high/);
    }),
  );

  it.effect('caps at high without a resolved binary', () =>
    Effect.gen(function* () {
      const { run, calls } = yield* runWith('max', undefined, () => 'hang');
      expect(run.effort).toBe('high');
      expect(calls).toHaveLength(0);
    }),
  );
});
