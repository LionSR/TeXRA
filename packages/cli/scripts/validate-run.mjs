#!/usr/bin/env node

import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cliRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.dirname(path.dirname(cliRoot));
const binaryPath = path.join(cliRoot, 'dist/bin/texra.js');
const require = createRequire(import.meta.url);
const { normalizeReview, normalizeReviewFile, parseModelJson } = require(
  path.join(
    repoRoot,
    '.github/actions/texra-code-review/scripts/normalize-review.cjs',
  ),
);
const { parseCommentableLines } = require(
  path.join(
    repoRoot,
    '.github/actions/texra-code-review/scripts/write-commentable-lines.cjs',
  ),
);
const { resolveReviewModel } = require(
  path.join(
    repoRoot,
    '.github/actions/texra-code-review/scripts/resolve-model.cjs',
  ),
);
const { promptContextText, writePromptContext } = require(
  path.join(
    repoRoot,
    '.github/actions/texra-code-review/scripts/write-prompt-context.cjs',
  ),
);
const { loadKnownThreadIds, postTexraReview } = require(
  path.join(
    repoRoot,
    '.github/actions/texra-code-review/scripts/post-review.cjs',
  ),
);
const { collectTexraThreads } = require(
  path.join(
    repoRoot,
    '.github/actions/texra-code-review/scripts/collect-threads.cjs',
  ),
);
const validationEnv = 'TEXRA_INTERNAL_VALIDATE_MODEL_HANDLER';
const validationFlagEnv = 'TEXRA_INTERNAL_VALIDATE_MODEL_HANDLER_FLAG';
const validationFlagContent = 'texra-cli-run-validation\n';

function run(command, args, options = {}) {
  const env = {
    ...process.env,
    CI: '1',
    ...options.env,
  };
  if (options.validationModel) {
    if (!options.validationFlagPath) {
      throw new Error('validationModel requires validationFlagPath');
    }
    env[validationEnv] = '1';
    env[validationFlagEnv] = options.validationFlagPath;
  }

  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    env,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message ?? '',
    signal: result.signal ?? '',
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertSuccess(result, label) {
  assert(
    result.status === 0,
    `${label} failed with exit ${result.status}${result.signal ? ` signal ${result.signal}` : ''}${result.error ? ` error ${result.error}` : ''}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
}

function parseNdjson(stdout, label) {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  assert(lines.length > 0, `${label} produced no NDJSON records`);
  return lines.map((line) => JSON.parse(line));
}

function validateBinarySmoke() {
  const help = run(process.execPath, [binaryPath, '--help']);
  assertSuccess(help, 'texra --help');
  assert(
    help.stdout.includes('TeXRA CLI'),
    'help output should name TeXRA CLI',
  );

  const version = run(process.execPath, [binaryPath, 'version']);
  assertSuccess(version, 'texra version');
  assert(
    version.stdout.trim().length > 0,
    'version output should be non-empty',
  );

  const agentsText = run(process.execPath, [binaryPath, 'agents', 'list']);
  assertSuccess(agentsText, 'texra agents list');
  assert(
    agentsText.stdout.trim().length > 0,
    'agents list should prove resource-backed agent loading',
  );

  const agentsNdjson = run(process.execPath, [
    binaryPath,
    '--output-format',
    'ndjson',
    'agents',
    'list',
  ]);
  assertSuccess(agentsNdjson, 'texra --output-format ndjson agents list');
  assert(
    parseNdjson(agentsNdjson.stdout, 'agents list NDJSON').every(
      (record) => record.kind === 'agent',
    ),
    'agents list NDJSON records should have kind=agent',
  );
}

function validateRunCommand() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'texra-cli-run-'));
  try {
    const inputPath = path.join(cwd, 'paper.tex');
    const validationFlagPath = path.join(
      cwd,
      '.texra-internal-validation-model-handler',
    );
    writeFileSync(inputPath, '\\section{Input}\nOriginal text.\n');
    writeFileSync(validationFlagPath, validationFlagContent);

    const baseArgs = [
      binaryPath,
      'run',
      'polish',
      '--input',
      'paper.tex',
      '--output',
      'paper.polished.tex',
      '--cwd',
      cwd,
      '--approval-policy',
      'never',
      '--print',
    ];

    const text = run(process.execPath, baseArgs, {
      cwd: repoRoot,
      validationModel: true,
      validationFlagPath,
    });
    assertSuccess(text, 'texra run text');
    const copiedOutputPath = path.join(realpathSync(cwd), 'paper.polished.tex');
    const outputPathPattern = /^r\d+\/paper\.polished\.tex$/;
    assert(
      text.stdout.trim() === copiedOutputPath,
      'text run output should print the filesystem copy path when --output is used',
    );

    const json = run(
      process.execPath,
      [...baseArgs, '--output-format', 'json'],
      { cwd: repoRoot, validationModel: true, validationFlagPath },
    );
    assertSuccess(json, 'texra run JSON');
    const jsonResult = JSON.parse(json.stdout);
    assert(
      jsonResult.category === 'workflow',
      'JSON run output should serialize the workflow result',
    );
    const finalOutput = jsonResult.outputs.at(-1);
    assert(
      outputPathPattern.test(finalOutput?.relativePath ?? ''),
      'JSON run output should report the run-storage output path',
    );
    assert(
      finalOutput.location === 'runStorage',
      'JSON run output should identify extracted output as run storage',
    );
    assert(
      jsonResult.runDirectory ===
        path.dirname(path.dirname(finalOutput.absolutePath)),
      'JSON run output should report the execution run directory',
    );
    assert(
      jsonResult.copiedOutput === copiedOutputPath,
      'JSON run output should report the filesystem copy path',
    );
    assert(
      readFileSync(finalOutput.absolutePath, 'utf8').includes(
        'Validated CLI Runtime',
      ),
      'texra run should write the validation output through the real workflow path',
    );

    const ndjson = run(
      process.execPath,
      [...baseArgs, '--output-format', 'ndjson'],
      { cwd: repoRoot, validationModel: true, validationFlagPath },
    );
    assertSuccess(ndjson, 'texra run NDJSON');
    assert(
      parseNdjson(ndjson.stdout, 'run NDJSON').some(
        (record) => record.kind === 'result',
      ),
      'run NDJSON should include a result record',
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function validateToolUseAgentRunCommand() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'texra-cli-agent-run-'));
  try {
    const promptPath = path.join(cwd, 'review-prompt.md');
    const contextPath = path.join(cwd, 'pr.diff');
    const validationFlagPath = path.join(
      cwd,
      '.texra-internal-validation-model-handler',
    );
    writeFileSync(
      promptPath,
      'Review this change for mathematical and physical correctness.\n',
    );
    writeFileSync(
      contextPath,
      String.raw`diff --git a/paper.tex b/paper.tex
+\section{Validation}
`,
    );
    writeFileSync(validationFlagPath, validationFlagContent);

    const result = run(
      process.execPath,
      [
        binaryPath,
        'agents',
        'run',
        'review',
        '--instruction-file',
        'review-prompt.md',
        '--context',
        'pr.diff',
        '--cwd',
        cwd,
        '--approval-policy',
        'never',
        '--output-format',
        'json',
        '--print',
      ],
      { cwd: repoRoot, validationModel: true, validationFlagPath },
    );
    assertSuccess(result, 'texra agents run review JSON');

    const jsonResult = JSON.parse(result.stdout);
    assert(
      jsonResult.category === 'toolUse',
      'JSON agent run output should serialize the tool-use result',
    );
    assert(
      String(jsonResult.lastResponse ?? '').includes('Validated CLI Runtime'),
      'tool-use agent run should return the validation model response',
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

async function validateCodeReviewActionHelpers() {
  assert(
    parseModelJson('{"body":"direct"}').body === 'direct',
    'TeXRA review parser should parse direct JSON',
  );
  assert(
    parseModelJson('```json\n{"body":"fenced"}\n```').body === 'fenced',
    'TeXRA review parser should parse fenced JSON',
  );
  assert(
    parseModelJson(
      `\`\`\`json
${JSON.stringify({
  body: 'fenced',
  comments: [{ path: 'paper.tex', line: 1, body: 'body contains ```' }],
})}
\`\`\``,
    ).comments[0].body === 'body contains ```',
    'TeXRA review parser should keep fenced JSON intact when strings contain backticks',
  );
  assert(
    parseModelJson('text before {"body":"embedded"} text after').body ===
      'embedded',
    'TeXRA review parser should parse embedded JSON',
  );

  const normalized = normalizeReview(`\`\`\`json
{
  "body": "## TeXRA Code Review\\n\\nLooks correct.",
  "comments": [
    {
      "path": "paper.tex",
      "line": 3,
      "side": "RIGHT",
      "body": "Check this equation."
    }
  ],
  "threadActions": [
    {
      "action": "unresolve",
      "threadId": "thread-id",
      "body": "This is relevant again."
    }
  ]
}
\`\`\``);
  assert(
    normalized.comments.length === 1,
    'TeXRA review normalization should preserve valid inline comments',
  );
  assert(
    normalized.thread_actions[0]?.action === 'unresolve',
    'TeXRA review normalization should preserve unresolve thread actions',
  );
  const normalizedThreadActions = normalizeReview(
    JSON.stringify({
      body: '## TeXRA Code Review\n\nLooks correct.',
      thread_actions: [{ action: 'resolve', thread_id: 'PRRT_thread' }],
      threadActions: [
        { action: 'resolve', threadId: 'PRRT_thread', body: 'Fixed.' },
      ],
      resolved_threads: [{ thread_id: 'PRRT_thread' }],
    }),
  ).thread_actions;
  assert(
    normalizedThreadActions.length === 1 &&
      normalizedThreadActions[0]?.body === 'Fixed.',
    'TeXRA review normalization should deduplicate thread action aliases',
  );
  assert(
    normalizeReview('{"body":"   ","comments":[]}').body ===
      'TeXRA completed without a final review message.',
    'TeXRA review normalization should not post raw JSON when body and summary are empty',
  );

  const anchors = parseCommentableLines(`diff --git a/paper.tex b/paper.tex
--- a/paper.tex
+++ b/paper.tex
@@ -1,4 +1,6 @@
 unchanged
-old
---flag
+new
+++count;
+--sql
+++ b/not-a-header
 done
`);
  const file = anchors.files.find((entry) => entry.path === 'paper.tex');
  assert(
    JSON.stringify(file?.right) === JSON.stringify([{ start: 2, end: 5 }]),
    'commentable line parser should report changed head lines',
  );
  assert(
    JSON.stringify(file?.left) === JSON.stringify([{ start: 2, end: 3 }]),
    'commentable line parser should report removed base lines',
  );
  const suppressedBlankAnchors =
    parseCommentableLines(`diff --git a/paper.tex b/paper.tex
--- a/paper.tex
+++ b/paper.tex
@@ -1,4 +1,4 @@
 unchanged

-old
+new
 after
`);
  const suppressedBlankFile = suppressedBlankAnchors.files.find(
    (entry) => entry.path === 'paper.tex',
  );
  assert(
    JSON.stringify(suppressedBlankFile?.right) ===
      JSON.stringify([{ start: 3, end: 3 }]),
    'commentable line parser should count bare empty context lines',
  );

  const reviewCwd = mkdtempSync(path.join(tmpdir(), 'texra-review-output-'));
  try {
    const resultJson = path.join(reviewCwd, 'result.json');
    const outputFile = path.join(reviewCwd, 'review.md');
    writeFileSync(
      resultJson,
      JSON.stringify({ lastResponse: 'success', status: 'success' }),
    );
    const { finalMessage } = normalizeReviewFile({
      resultJson,
      outputFile,
      runnerTemp: reviewCwd,
    });
    assert(
      finalMessage === 'TeXRA completed without a final review message.',
      'review normalization should not use status-only strings as review bodies',
    );
  } finally {
    rmSync(reviewCwd, { recursive: true, force: true });
  }

  const threadsCwd = mkdtempSync(path.join(tmpdir(), 'texra-review-threads-'));
  const threadsOutput = path.join(threadsCwd, 'nested', 'threads.json');
  const previousThreadsOutput = process.env.TEXRA_THREADS_OUTPUT;
  try {
    process.env.TEXRA_THREADS_OUTPUT = threadsOutput;
    const payload = await collectTexraThreads({
      github: {
        graphql: async () => {
          throw new Error('validation failure');
        },
      },
      context: {
        repo: { owner: 'owner', repo: 'repo' },
        payload: { pull_request: { number: 1 } },
      },
      core: {
        warning: () => undefined,
        setOutput: (name, value) => {
          if (name === 'path') {
            assert(
              value === threadsOutput,
              'thread collection should report the custom output path',
            );
          }
        },
      },
    });
    assert(
      payload.threads.length === 0,
      'thread collection should return an empty payload on GraphQL failure',
    );
    assert(
      JSON.parse(readFileSync(threadsOutput, 'utf8')).threads.length === 0,
      'thread collection should create custom output directories',
    );
    const unavailableThreadsOutput = path.join(
      threadsCwd,
      'nested',
      'threads-unavailable.json',
    );
    process.env.TEXRA_THREADS_OUTPUT = unavailableThreadsOutput;
    const unavailablePayload = await collectTexraThreads({
      github: {
        graphql: async () => ({ repository: null }),
      },
      context: {
        repo: { owner: 'owner', repo: 'repo' },
        payload: { pull_request: { number: 1 } },
      },
      core: {
        warning: () => undefined,
        setOutput: () => undefined,
      },
    });
    assert(
      unavailablePayload.threads.length === 0,
      'thread collection should return an empty payload when GraphQL data is unavailable',
    );
    writeFileSync(
      threadsOutput,
      JSON.stringify({ threads: [{ id: 'PRRT_known_thread' }] }),
    );
    assert(
      loadKnownThreadIds(threadsOutput).has('PRRT_known_thread'),
      'thread action validation should read known thread ids',
    );
  } finally {
    if (previousThreadsOutput == null) {
      delete process.env.TEXRA_THREADS_OUTPUT;
    } else {
      process.env.TEXRA_THREADS_OUTPUT = previousThreadsOutput;
    }
    rmSync(threadsCwd, { recursive: true, force: true });
  }

  assert(
    resolveReviewModel({
      providerKeys: { deepseek: 'key', openai: 'key' },
    }).model === 'deepseekproT',
    'review model resolution should default DeepSeek reviews to DeepSeek Pro Thinking',
  );
  assert(
    resolveReviewModel({
      providerKeys: { openai: 'key' },
    }).model === 'gpt55',
    'review model resolution should choose an OpenAI model when only OpenAI is configured',
  );
  assert(
    resolveReviewModel({
      providerKeys: { openRouter: 'key' },
    }).model === 'gptoss',
    'review model resolution should choose an OpenRouter-routed model when only OpenRouter is configured',
  );
  assert(
    resolveReviewModel({
      providerKeys: { deepseek: 'key' },
      providerModels: { deepseek: 'deepseekT' },
    }).model === 'deepseekT',
    'review model resolution should honor provider-specific model overrides',
  );
  assert(
    resolveReviewModel({
      configuredModel: 'gemini31p',
      providerKeys: { deepseek: 'key' },
    }).model === 'gemini31p',
    'review model resolution should honor the global model override',
  );
  const actionText = readFileSync(
    path.join(repoRoot, '.github/actions/texra-code-review/action.yml'),
    'utf8',
  );
  assert(
    actionText.includes('texra_status=$?'),
    'TeXRA action should preserve command stderr before exiting on failure',
  );
  assert(
    readFileSync(
      path.join(repoRoot, '.github/workflows/texra-code-review.yml'),
      'utf8',
    ).includes('git merge-base "$BASE_SHA" "$HEAD_SHA"'),
    'TeXRA review workflow should diff from the PR merge base',
  );

  const promptContextCwd = mkdtempSync(
    path.join(tmpdir(), 'texra-review-prompt-context-'),
  );
  try {
    const outputPath = path.join(promptContextCwd, 'nested', 'context.md');
    const contextText = promptContextText({
      PR_NUMBER: '7',
      REPOSITORY: 'owner/repo',
      PR_TITLE_JSON: '"safe title"',
      TEXRA_REVIEW_MODEL: 'deepseekproT',
    });
    assert(
      contextText.includes('PR number: 7') &&
        contextText.includes(
          'Pull request title JSON (untrusted): "safe title"',
        ) &&
        contextText.includes('TeXRA review model: deepseekproT'),
      'prompt context text should include review metadata in a stable format',
    );
    assert(
      writePromptContext({ env: { PR_NUMBER: '8' }, outputPath }) ===
        outputPath,
      'prompt context writer should return the output path',
    );
    assert(
      readFileSync(outputPath, 'utf8').includes('PR number: 8'),
      'prompt context writer should create parent directories and write metadata',
    );
  } finally {
    rmSync(promptContextCwd, { recursive: true, force: true });
  }

  const postCwd = mkdtempSync(path.join(tmpdir(), 'texra-review-post-'));
  const previousPostEnv = {
    HEAD_SHA: process.env.HEAD_SHA,
    TEXRA_COMMENTABLE_LINES_JSON: process.env.TEXRA_COMMENTABLE_LINES_JSON,
    TEXRA_REVIEW_AGENT: process.env.TEXRA_REVIEW_AGENT,
    TEXRA_RESOLVE_THREADS: process.env.TEXRA_RESOLVE_THREADS,
    TEXRA_REVIEW_JSON: process.env.TEXRA_REVIEW_JSON,
    TEXRA_REVIEW_MODEL: process.env.TEXRA_REVIEW_MODEL,
    TEXRA_THREADS_JSON: process.env.TEXRA_THREADS_JSON,
  };
  try {
    const reviewJson = path.join(postCwd, 'review.json');
    const threadJson = path.join(postCwd, 'threads.json');
    writeFileSync(
      reviewJson,
      JSON.stringify({
        body: '## TeXRA Code Review\n\nNo new findings.',
        comments: [{ path: 'paper.tex', line: 1, body: 'Inline finding.' }],
        thread_actions: [
          {
            action: 'resolve',
            thread_id: 'PRRT_thread',
            body: 'Confirmed fixed.',
          },
          {
            action: 'reply',
            thread_id: 'PRRT_thread',
            body: 'Additional note.',
          },
        ],
      }),
    );
    writeFileSync(
      threadJson,
      JSON.stringify({ threads: [{ id: 'PRRT_thread', isResolved: false }] }),
    );
    process.env.HEAD_SHA = 'HEAD';
    process.env.TEXRA_COMMENTABLE_LINES_JSON = path.join(
      postCwd,
      'missing-commentable-lines.json',
    );
    process.env.TEXRA_REVIEW_AGENT = 'review';
    process.env.TEXRA_RESOLVE_THREADS = 'false';
    process.env.TEXRA_REVIEW_JSON = reviewJson;
    process.env.TEXRA_REVIEW_MODEL = 'deepseekT';
    process.env.TEXRA_THREADS_JSON = threadJson;

    let postedReviewBody = '';
    let postedInlineComments = [];
    const replies = [];
    const notices = [];
    await postTexraReview({
      github: {
        rest: {
          pulls: {
            createReview: async ({ body, comments }) => {
              postedReviewBody = body;
              postedInlineComments = comments;
            },
          },
        },
        graphql: async (query, variables) => {
          if (query.includes('addPullRequestReviewThreadReply')) {
            replies.push(variables.body);
          }
        },
      },
      context: {
        repo: { owner: 'owner', repo: 'repo' },
        payload: { pull_request: { number: 1 } },
      },
      core: {
        notice: (message) => notices.push(message),
        warning: () => undefined,
      },
    });
    assert(
      replies.length === 0,
      'thread actions should not add replies when the TeXRA identity token is unavailable',
    );
    assert(
      notices.some((message) => message.includes('review-thread action')),
      'skipped thread actions should produce a notice',
    );
    assert(
      postedReviewBody.includes(
        'Reviewed by TeXRA agent `review` with model `deepseekT`.',
      ),
      'posted review body should include TeXRA reviewer attribution',
    );
    assert(
      !postedInlineComments[0]?.body.includes('Reviewed by TeXRA agent'),
      'inline comments should not include TeXRA reviewer attribution',
    );

    const threadMutations = [];
    process.env.TEXRA_RESOLVE_THREADS = 'true';
    writeFileSync(
      reviewJson,
      JSON.stringify({
        body: '## TeXRA Code Review\n\nNo new findings.',
        comments: [],
        thread_actions: [
          { action: 'resolve', thread_id: 'PRRT_thread' },
          { action: 'unresolve', thread_id: 'PRRT_thread' },
        ],
      }),
    );
    await postTexraReview({
      github: {
        rest: {
          pulls: {
            createReview: async () => undefined,
          },
        },
        graphql: async (query) => {
          if (query.includes('unresolveReviewThread')) {
            threadMutations.push('unresolve');
          } else if (query.includes('resolveReviewThread')) {
            threadMutations.push('resolve');
          }
        },
      },
      context: {
        repo: { owner: 'owner', repo: 'repo' },
        payload: { pull_request: { number: 1 } },
      },
      core: {
        notice: () => undefined,
        warning: () => undefined,
      },
    });
    assert(
      JSON.stringify(threadMutations) ===
        JSON.stringify(['resolve', 'unresolve']),
      'thread action posting should update resolved state within a batch',
    );

    process.env.TEXRA_RESOLVE_THREADS = 'false';
    writeFileSync(
      reviewJson,
      JSON.stringify({
        body: '## TeXRA Code Review\n\nNo new findings.',
        comments: [{ path: 'paper.tex', line: 1, body: 'Inline finding.' }],
        thread_actions: [
          {
            action: 'resolve',
            thread_id: 'PRRT_thread',
            body: 'Confirmed fixed.',
          },
          {
            action: 'reply',
            thread_id: 'PRRT_thread',
            body: 'Additional note.',
          },
        ],
      }),
    );

    let fallbackAttempt = 0;
    let fallbackReviewBody = '';
    await postTexraReview({
      github: {
        rest: {
          pulls: {
            createReview: async ({ body }) => {
              fallbackAttempt += 1;
              if (fallbackAttempt === 1) {
                throw new Error('invalid inline anchor');
              }
              fallbackReviewBody = body;
            },
          },
        },
        graphql: async () => undefined,
      },
      context: {
        repo: { owner: 'owner', repo: 'repo' },
        payload: { pull_request: { number: 1 } },
      },
      core: {
        notice: () => undefined,
        warning: () => undefined,
      },
    });
    assert(
      fallbackReviewBody.includes(
        '### Inline comments that could not be placed',
      ),
      'inline fallback should preserve unposted inline comments in the review body',
    );
    assert(
      fallbackReviewBody
        .trim()
        .endsWith('Reviewed by TeXRA agent `review` with model `deepseekT`.'),
      'posted review fallback body should keep TeXRA reviewer attribution at the end',
    );
  } finally {
    for (const [name, value] of Object.entries(previousPostEnv)) {
      if (value == null) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    rmSync(postCwd, { recursive: true, force: true });
  }
}

async function validateCliRunArtifacts() {
  const buildResult = run('pnpm', ['run', 'build'], {
    cwd: cliRoot,
    env: { TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL: '1' },
  });
  assertSuccess(buildResult, 'pnpm run build');
  validateBinarySmoke();
  validateRunCommand();
  validateToolUseAgentRunCommand();
  await validateCodeReviewActionHelpers();
  console.log('CLI run validation passed');
}

function rebuildCliWithoutInternalValidationModel() {
  const rebuildResult = run('pnpm', ['run', 'build'], {
    cwd: cliRoot,
    env: { TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL: '' },
  });
  assertSuccess(rebuildResult, 'pnpm run build after validation');
}

try {
  await validateCliRunArtifacts();
} finally {
  rebuildCliWithoutInternalValidationModel();
}
