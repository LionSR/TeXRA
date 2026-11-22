import { rounds } from 'builtIn:rounds';

const WRITER = [
  "You write and maintain formalization blueprints: LaTeX documents, built with the leanblueprint package and its CLI, that split a proof into small statements with explicit dependencies and link each to its Lean declaration. Follow the package's own macros and the file layout leanblueprint new creates; invent no parallel conventions.",
  'The macros. Inside a definition, lemma, proposition, theorem or corollary, each with a \\label: \\lean{Name.decl} links Lean declarations (comma-separated), \\leanok marks the statement formalized, \\mathlibok marks it in Mathlib, \\uses{label, ...} lists the statements it depends on, and \\notready marks one that needs more blueprint work. Inside a proof: \\uses{...} for what the proof relies on, \\leanok when the proof is formalized, and \\proves{label} for a proof separated from its statement.',
  'Write the mathematics as a paper does, in standard notation: no Lean syntax, identifiers or type signatures in the prose. A Lean predicate becomes a sentence, a typeclass assumption becomes "let G be a group", a type becomes the set it stands for. \\lean{} is the only place a Lean name appears. Refer to statements by \\ref to their labels, never by number. Each statement states its hypotheses in full; a proof sketch gives the strategy in a sentence or two, enough for a formalizer to follow.',
  "To write a new blueprint, survey the Lean project first, then design the dependency graph backward from the main results: each node one well-defined fact. To bring an existing one up to date, check every \\lean name against the source (renamed or removed declarations), every \\leanok against lean_diagnostics (no error, no sorry; call lean_file on a Lean file first, since Lean reads a file only when it opens it), every statement against its declaration's type (lean_inspect hover), and every \\uses against what the proof actually relies on; add entries for significant declarations the blueprint lacks. Before you answer, run leanblueprint web and leanblueprint checkdecls and fix what they report: the program checks your work with the same two commands.",
  'Your answer goes to the person who started the program: what you wrote or changed, what is out of sync or mathematically suspect, and what you left for them.',
].join('\n\n');

/** What leanblueprint itself checks: the blueprint builds, and every
 *  \lean name is a declaration of the built project. */
const CHECK = 'leanblueprint web && leanblueprint checkdecls';

export default async (args, launch) => {
  // A missing CLI fails the launch before any round is paid for.
  try {
    await tools.bash({ command: 'leanblueprint --version' });
  } catch {
    throw new Error(
      'blueprint checks its work with the leanblueprint CLI, which is not installed: pip install leanblueprint.',
    );
  }
  return rounds(
    {
      name: 'blueprint',
      system: WRITER,
      tools: [
        'read_file',
        'write_file',
        'edit_file',
        'glob',
        'grep',
        'bash',
        'lean_diagnostics',
        'lean_inspect',
        'lean_file',
        'lean_loogle',
        'web_search',
        'web_fetch',
        'arxiv_search',
      ],
      rounds: 2,
      extension: '.tex',
      describes:
        "the blueprint's .tex files (a project without one starts with leanblueprint new)",
      fallback: 'Bring this blueprint up to date with the Lean project.',
      check: async () => {
        try {
          await tools.bash({ command: CHECK, timeout: 600000 });
          return {
            clean: true,
            report:
              'The blueprint builds, and leanblueprint checkdecls finds every \\lean declaration.',
          };
        } catch (failure) {
          return {
            clean: false,
            report: CHECK + ' failed:\n' + failure.message,
          };
        }
      },
    },
    launch,
  );
};
