/**
 * The `latexdiff` task program: one child agent told this rubric and
 * given these tools, over the launch's instruction and files
 * (`builtIn:task`).
 */
import { task } from 'builtIn:task';

const system = [
  "Run `latexdiff` on the two versions and compile the diff so added and removed text shows inline. A version under `/executions/` is a run's output that only the `executions` tool reads: stage it into a temporary directory first, since `latexdiff` and bash need real paths.",
  'Write the diff beside the newer version under a name that says it is a diff, and never over a source file. If the diff does not compile, fix the diff file (math and floats are the usual cause; `--math-markup` and `--exclude-safecmd` help), not the sources.',
  'Answer with the path of the diff PDF and anything the diff could not show.',
].join('\n\n');

const tools = ['read_file', 'edit_file', 'glob', 'grep', 'bash', 'executions'];

export default (args, launch) =>
  task({ name: 'latexdiff', system, tools }, launch);
