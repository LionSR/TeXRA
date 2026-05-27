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
const { normalizeReview, parseModelJson } = require(
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
      'diff --git a/paper.tex b/paper.tex\n+\\\\section{Validation}\n',
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

function validateCodeReviewActionHelpers() {
  assert(
    parseModelJson('{"body":"direct"}').body === 'direct',
    'TeXRA review parser should parse direct JSON',
  );
  assert(
    parseModelJson('```json\n{"body":"fenced"}\n```').body === 'fenced',
    'TeXRA review parser should parse fenced JSON',
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

  const anchors = parseCommentableLines(`diff --git a/paper.tex b/paper.tex
--- a/paper.tex
+++ b/paper.tex
@@ -1,3 +1,4 @@
 unchanged
-old
+new
+added
 done
`);
  const file = anchors.files.find((entry) => entry.path === 'paper.tex');
  assert(
    JSON.stringify(file?.right) === JSON.stringify([{ start: 2, end: 3 }]),
    'commentable line parser should report changed head lines',
  );
  assert(
    JSON.stringify(file?.left) === JSON.stringify([{ start: 2, end: 2 }]),
    'commentable line parser should report removed base lines',
  );
}

try {
  const buildResult = run('pnpm', ['run', 'build'], {
    cwd: cliRoot,
    env: { TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL: '1' },
  });
  assertSuccess(buildResult, 'pnpm run build');
  validateBinarySmoke();
  validateRunCommand();
  validateToolUseAgentRunCommand();
  validateCodeReviewActionHelpers();
  console.log('CLI run validation passed');
} finally {
  const rebuildResult = run('pnpm', ['run', 'build'], {
    cwd: cliRoot,
    env: { TEXRA_CLI_INCLUDE_INTERNAL_VALIDATION_MODEL: '' },
  });
  assertSuccess(rebuildResult, 'pnpm run build after validation');
}
