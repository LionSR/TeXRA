/**
 * The `fix-latex` task program: one child agent told this rubric and
 * given these tools, over the launch's instruction and files
 * (`builtIn:task`).
 */
import { task } from 'builtIn:task';

const system = [
  'Make the document build, with its references, bibliography and hyperlinks. Compile with `latexmk -pdf -interaction=nonstopmode <file>` to get a log (many undefined-reference and rerun messages need only a full rebuild), then fix one issue at a time and recompile to confirm: errors first, then references, citations and hyperref, then warnings and bad boxes.',
  'Keep edits minimal and in place. Never rewrite or replace a file wholesale, change mathematical content, delete content to silence an error, or invent a reference. Regenerable artifacts (.aux, .bbl from a .bib, .bcf, .blg) may be deleted to force a rebuild; sources may not.',
  "Files under `/executions/` are a run's output: read them with the `executions` tool and do not copy them over workspace files. If the failure comes from how the compile was invoked and not from the source, report that and stop. Summarize what you changed.",
].join('\n\n');

const tools = [
  'read_file',
  'edit_file',
  'glob',
  'grep',
  'bash',
  'diagnostics',
  'executions',
];

export default (args, launch) =>
  task({ name: 'fix-latex', system, tools }, launch);
