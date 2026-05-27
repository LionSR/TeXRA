const fs = require('node:fs');
const path = require('node:path');

const { writeOutput } = require('./github-output.cjs');

const DEFAULT_PROMPT_CONTEXT_PATH = '.texra-action/review-prompt-context.md';

const PROMPT_CONTEXT_FIELDS = [
  ['PR number', 'PR_NUMBER'],
  ['Repository', 'REPOSITORY'],
  ['Repository owner', 'REPOSITORY_OWNER'],
  ['Repository name', 'REPOSITORY_NAME'],
  ['Pull request title JSON (untrusted)', 'PR_TITLE_JSON'],
  ['Pull request body JSON (untrusted)', 'PR_BODY_JSON'],
  ['Base ref', 'BASE_REF'],
  ['Base SHA', 'BASE_SHA'],
  ['Head ref', 'HEAD_REF'],
  ['Head SHA', 'HEAD_SHA'],
  ['Trigger event', 'TRIGGER_EVENT'],
  ['Review mode', 'REVIEW_MODE'],
  ['TeXRA review model', 'TEXRA_REVIEW_MODEL'],
];

function promptContextText(env = process.env) {
  const lines = PROMPT_CONTEXT_FIELDS.map(
    ([label, name]) => `${label}: ${env[name] ?? ''}`,
  );
  return `${lines.join('\n')}\n`;
}

function writePromptContext({
  env = process.env,
  outputPath = env.TEXRA_PROMPT_CONTEXT_OUTPUT || DEFAULT_PROMPT_CONTEXT_PATH,
} = {}) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, promptContextText(env));
  return outputPath;
}

function main() {
  const outputPath = writePromptContext();
  writeOutput('path', outputPath);
  console.log(`Wrote TeXRA review prompt context to ${outputPath}.`);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_PROMPT_CONTEXT_PATH,
  PROMPT_CONTEXT_FIELDS,
  promptContextText,
  writePromptContext,
};
