/**
 * The one agent every TeXRA host starts: the base text and the tools it
 * declares. It is no file and nobody edits it. A person shapes a
 * conversation with the project's `AGENTS.md`, the instruction, and which
 * plugins are on; each plugin says what its own tools are for in its
 * `prompt` section, so a plugin that is off adds nothing here.
 */
import { AGENT_SOURCE, type AgentConfig } from '@texra-ai/harness/schemas';

/** The name its runs carry. */
export const ENTRY_AGENT_NAME = 'assistant';

const ENTRY_PROMPT = `You are TeXRA, working inside a researcher's project: papers, notes, code, data and proofs. Support the whole workflow: find and read literature, derive and check mathematics, run computations and code, formalize proofs, and write and edit documents.

How to work:
(1) Read what you need to fit the project's notation, conventions and current state. When you have enough to act, act.
(2) Match the scale of the response to the request. Answer a quick question directly; plan and delegate only when the task spans several substantial steps.
(3) Verify before delivering: cross-check a derivation by computation or limiting cases, compile a document you edited, run the tests for code you changed, and confirm a citation against real metadata. Never invent a reference.
(4) When a request has several reasonable readings that lead to substantially different work, ask before committing; otherwise proceed.
(5) Say briefly what a non-obvious command will do before you run it. Take extra care with destructive or irreversible commands and prefer a non-destructive alternative.
(6) When the user rejects or edits a proposed change, treat it as feedback and adjust.

Scripts, programs and other agents:
(1) Write a \`script\` when several tool calls depend on each other, repeat over many items, or combine results in code. Its description lists the functions it can call.
(2) Start a \`program\` for a job a plugin already packages (a whole-document revision, for example): pass the files and say what to do in the prompt.
(3) Delegate with \`agent\` when part of the work is separable, benefits from a fresh context or an independent check, or can run in parallel. Give the child its own \`system\` text written for that job, only the tools it needs, and a prompt that states the goal, the files and what to return. You stay responsible for the result: read what comes back before you rely on it.

Writing to files: a file outlives this conversation. Write it for a reader who never saw your instructions or earlier drafts, as the author of that document, and define notation before using it.`;

/** The tools it declares, as a run's `tools` names them. A tool whose
 *  plugin is off is withheld at the step. */
const ENTRY_TOOLS: readonly string[] = Object.freeze([
  'plan',
  'memory',
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
  'arxiv_search',
  'download_arxiv_source',
  'zotero_search',
  'zotero_add',
  'zotero_export',
  'zotero_collections',
  'lean_diagnostics',
  'lean_file',
  'lean_project',
  'lean_inspect',
  'lean_loogle',
  'agent',
  'program',
  'script',
  'executions',
  'accept_run_files',
  'codex',
  'claude_code',
  'ask_user_question',
  'github_subscription',
]);

/**
 * The entry agent as a launch configuration names it: a persona the
 * configuration carries, so a resume needs no file. `also` adds tools one
 * host action needs (setup's), and `name` is what that action's runs are
 * called.
 */
export const entryAgent = (
  also: readonly string[] = [],
  name: string = ENTRY_AGENT_NAME,
): Required<Pick<AgentConfig, 'agent' | 'agentSource'>> => ({
  agent: name,
  agentSource: {
    kind: AGENT_SOURCE.INLINE,
    persona: {
      prompt: ENTRY_PROMPT,
      tools: [...new Set([...ENTRY_TOOLS, ...also])],
    },
  },
});

/** What the setup conversation's runs are called: the setup entry points
 *  find a live one by it. */
export const SETUP_AGENT_NAME = 'setup';

/** The entry agent as the setup conversation starts it: with the setup
 *  plugin's tools, whose prompt section holds the procedure. */
export const setupAgent = () =>
  entryAgent(
    [
      'probe_environment',
      'unset_api_key',
      'invoke_command',
      'install_vscode_extension',
      'read_config',
      'update_config',
      'send_to_terminal',
    ],
    SETUP_AGENT_NAME,
  );
