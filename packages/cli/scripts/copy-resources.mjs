/* global console, process */
import { cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stageHtmlExportAssets } from '../../../scripts/copy-html-export-assets.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(scriptDir, '..');
const source = path.resolve(packageDir, '../extension/resources');
const repoRoot = path.resolve(packageDir, '../..');
const targetInput = process.env.TEXRA_CLI_RESOURCES_OUTDIR?.trim();
const target = targetInput
  ? path.resolve(packageDir, targetInput)
  : path.resolve(packageDir, 'dist/resources');
const runtimeResourceEntries = [
  'agents',
  'docs/agent-creation',
  'goal',
  'shared',
  'templates/agentCreatorToolUse.yaml',
  'templates/agentCreatorWorkflow.yaml',
  'templates/agentTemplate-toolUse.yaml',
  'templates/agentTemplate-workflowSingle.yaml',
  'templates/instructionPolish.yaml',
  'tool_use_agents',
];

// Built (not checked-in) assets: only present once the extension's own
// prepare:*-assets step has run. Missing is expected when the CLI is built
// standalone without building the extension first — skip with a warning
// rather than failing the whole resource copy over an optional entry.
const optionalRuntimeResourceEntries = ['traceViewer'];

async function copyEntry(entry, { optional = false } = {}) {
  try {
    await cp(path.join(source, entry), path.join(target, entry), {
      recursive: true,
    });
  } catch (err) {
    if (optional && err.code === 'ENOENT') {
      console.warn(
        `[copy-resources] skipping "${entry}": not built yet (${path.join(source, entry)})`,
      );
      return;
    }
    throw err;
  }
}

await rm(target, { recursive: true, force: true });
await Promise.all([
  ...runtimeResourceEntries.map((entry) => copyEntry(entry)),
  ...optionalRuntimeResourceEntries.map((entry) =>
    copyEntry(entry, { optional: true }),
  ),
  cp(path.join(repoRoot, 'skills'), path.join(target, 'skills'), {
    recursive: true,
  }),
  // Sourced directly from root node_modules (katex, highlight.js,
  // markdown-it-texmath) rather than copied from the extension package's own
  // `resources/htmlExport/`, so `texra history show --export html` has real
  // KaTeX/highlight.js CSS assets to stage regardless of whether the
  // extension package has been built in this checkout.
  stageHtmlExportAssets(path.join(target, 'htmlExport')),
]);
