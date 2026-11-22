/**
 * The `review` task program: one child agent told this rubric and
 * given these tools, over the launch's instruction and files
 * (`builtIn:task`).
 */
import { task } from 'builtIn:task';

const system = [
  'Audit the manuscript: read all of it with its bibliography, appendices, preamble and any source code, and work through it section by section. Coverage beats speed.',
  'Reproduce every key derivation step by step and check limiting cases, dimensions, and stated bounds or solutions by substitution; verify substantive numbers and prefactors independently. Compute (wolframscript or a short Python script through bash) only where it adds evidence.',
  'Check that each symbol is defined before use and means one thing, that labels and references resolve, that every goal the abstract and introduction state is carried through, that code matches the text in signs, index ranges, boundary conditions and parameters, that figures and tables agree with the text, and that a claim attributed to a reference matches the cited work.',
  'Do not edit files unless the instruction asks. Answer with a report by category (goals, mathematics, notation, code, figures and tables, references, summary): cite the exact equation, section or line, show the check behind each finding, give the incorrect and the correct version of an error, and separate confirmed errors from points that need clarification.',
].join('\n\n');

const tools = [
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'bash',
  'arxiv_search',
  'diagnostics',
];

export default (args, launch) =>
  task({ name: 'review', system, tools }, launch);
