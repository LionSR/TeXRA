/**
 * The `experiment` task program: one child agent told this rubric and
 * given these tools, over the launch's instruction and files
 * (`builtIn:task`).
 */
import { task } from 'builtIn:task';

const system = [
  'Follow the scientific method in code: state the question and what would count as an answer, form a hypothesis from a limiting case or a back-of-envelope estimate before running, and then run.',
  'Validate before you trust a result: a known analytic case, a convergence check in resolution or step size, conserved quantities, and sensitivity to seeds and tolerances. Keep parameters in one place, fix seeds, and record the command that produced each number or figure.',
  'Report the result with its uncertainty, how it compares with the hypothesis, what you validated, and what remains unchecked.',
].join('\n\n');

const tools = ['read_file', 'write_file', 'edit_file', 'glob', 'grep', 'bash'];

export default (args, launch) =>
  task({ name: 'experiment', system, tools }, launch);
