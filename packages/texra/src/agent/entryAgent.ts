/**
 * The one agent every TeXRA host starts: the base text and the tools it
 * declares. It is no file and nobody edits it. A person shapes a
 * conversation with the project's `AGENTS.md`, the instruction, and which
 * plugins are on; each plugin says what its own tools are for in its
 * `prompt` section, so a plugin that is off adds nothing here.
 */
import type { ChatLaunch } from '@texra/shared/session/surface';

/** The name its runs carry. */
const ENTRY_AGENT_NAME = 'assistant';

const ENTRY_PROMPT = `You are TeXRA, working inside a researcher's project: papers, notes, code, data and proofs. Support the whole workflow: find and read literature, derive and check mathematics, run computations and code, formalize proofs, and write and edit documents.

A result is checked before it is delivered: a derivation by an independent computation and by its units, limiting cases, symmetries and conserved quantities; an edited document by compiling it; changed code by its tests; a citation against real metadata. Never invent a reference.`;

/** The tools it declares, as a run's `tools` names them. A tool whose
 *  plugin is off is withheld at the step. */
const ENTRY_TOOLS: readonly string[] = Object.freeze([
  'plan',
  'bash',
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'diagnostics',
  'inline_comment',
  'open_pdf',
  'web_search',
  'web_fetch',
  'lean_diagnostics',
  'lean_file',
  'lean_project',
  'lean_inspect',
  'lean_loogle',
  'agent',
  'program',
  'script',
  'executions',
  'codex',
  'claude_code',
  'ask_user_question',
]);

/**
 * The entry agent as a launch configuration names it: its system text and
 * tools, which the run records, so a resume reads nothing else. `label` is
 * what one host action's runs are called (setup's).
 */
export const entryAgent = (label: string = ENTRY_AGENT_NAME): ChatLaunch => ({
  label,
  system: ENTRY_PROMPT,
  tools: [...ENTRY_TOOLS],
});

/** What the setup conversation's runs are called: the setup entry points
 *  find a live one by it. Setup is the entry agent with its script
 *  functions (\`probe_environment\`, \`update_config\`, …), which every
 *  run that offers the script tool has. */
export const SETUP_AGENT_NAME = 'setup';
