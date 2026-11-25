/**
 * The program `annotate`: a review of LaTeX files written into them as
 * \criticize annotations. Each round a fresh child edits the files in place
 * with its file tools; then the program reads the files and checks what a
 * prompt can only ask for: outside the annotations (and the lines of the
 * macro's definition) every file is what it was when the program started,
 * whitespace aside. A round that changed anything else is followed by one
 * told what it changed, up to ROUNDS rounds.
 */

/** The \criticize annotation: its arguments, scale and definition. */
const CRITICIZE = [
  '% The \\criticize annotation: \\criticize{comment}{severity}{confidence}.',
  '% Severity: 5 fatal (invalidates a main claim or result), 4 critical',
  '% (seriously weakens the paper), 3 major, 2 minor, 1 cosmetic, 0 verified',
  '% correct. Confidence: 1 (a guess) to 5 (certain).',
  '\\usepackage{xcolor}',
  '\\newcommand{\\criticize}[3]{\\ifmmode\\textcolor{\\ifnum#2=5 red\\else\\ifnum#2=4 orange\\else\\ifnum#2=3 yellow!80!red\\else\\ifnum#2=2 yellow!60!black\\else\\ifnum#2=0 green!60!black\\else gray\\fi\\fi\\fi\\fi\\fi!\\ifnum#3<3 30\\else\\ifnum#3<5 70\\else 100\\fi\\fi!black}{\\text{[#1 (S#2/C#3)]}}\\else\\textcolor{\\ifnum#2=5 red\\else\\ifnum#2=4 orange\\else\\ifnum#2=3 yellow!80!red\\else\\ifnum#2=2 yellow!60!black\\else\\ifnum#2=0 green!60!black\\else gray\\fi\\fi\\fi\\fi\\fi!\\ifnum#3<3 30\\else\\ifnum#3<5 70\\else 100\\fi\\fi!black}{[#1 (S#2/C#3)]}\\fi}',
].join('\n');

/** How to write a \criticize annotation. */
const ANNOTATIONS = [
  'Write each annotation as \\criticize{comment}{severity}{confidence}, placed where the issue is. Its comment is part of the document and must compile: escape special characters and close every brace and math delimiter. Say what is wrong and what would fix it. Its definition and scale follow; add the definition to the preamble if it is not already there:',
  CRITICIZE,
].join('\n');

const REVIEWER = [
  'You review research papers by adding \\criticize annotations to their LaTeX files, in place, with your file tools. You never rewrite: outside your annotations and the definition of the macro, every file stays as it is, character for character. The program that started you compares the files with what they were and rejects any other change.',
  'Read every file, appendices included, before you annotate. Review from the point of view the instruction names; with none, as a careful referee of the mathematics. Work through each derivation and claim yourself before you judge it, and annotate every point that needs action: errors, gaps, unsupported or overstated claims, undefined terms, and inconsistencies between the files. Rate each by its severity and your confidence. Then check each annotation you added: verify the claim behind it again, correct its severity and confidence, and remove the ones that do not hold.',
  ANNOTATIONS,
  'Your answer goes to the person who started the program: the main findings in a few sentences, most severe first.',
].join('\n\n');

const ROUNDS = 3;
const MACRO = '\\criticize';
const DEFINITION = CRITICIZE.split('\n');

/** The lines `read_file` shows in one call. */
const PAGE = 2000;

/** The whole text of file, read a page at a time: `read_file` numbers its
 *  lines and shows no more than a page of them. */
const read = async (file) => {
  const lines = [];
  for (let start = 1; ; start += PAGE) {
    const { output } = await tools.read_file({
      path: file,
      range: { start, end: start + PAGE - 1 },
    });
    const page = output === '' ? [] : output.split('\n');
    lines.push(...page.map((line) => line.replace(/^ *\d+\t/, '')));
    if (page.length < PAGE) return lines.join('\n');
  }
};

/** text without its \criticize{...}{...}{...} annotations, braces balanced. */
const withoutAnnotations = (text) => {
  let kept = '';
  let from = 0;
  for (;;) {
    const at = text.indexOf(MACRO + '{', from);
    if (at < 0) return kept + text.slice(from);
    kept += text.slice(from, at);
    let end = at + MACRO.length;
    while (text[end] === '{') {
      let depth = 0;
      do {
        if (text[end] === '\\') end += 1;
        else if (text[end] === '{') depth += 1;
        else if (text[end] === '}') depth -= 1;
        end += 1;
      } while (depth > 0 && end < text.length);
    }
    from = end;
  }
};

/** The lines of the macro's definition that text holds. */
const definitionLines = (text) =>
  DEFINITION.filter((line) =>
    text.split('\n').some((held) => held.trim() === line),
  );

/** What a round must leave as it found it: text without its annotations,
 *  without the definition lines a round may add (those not in `held`, the
 *  ones the file started with), and with each run of whitespace as one
 *  space, so words a round joined or split still differ. */
const original = (text, held) =>
  withoutAnnotations(
    text
      .split('\n')
      .filter(
        (line) =>
          held.includes(line.trim()) || !DEFINITION.includes(line.trim()),
      )
      .join('\n'),
  )
    .replace(/\s+/g, ' ')
    .trim();

export default async (args, { instruction, inputFiles, contextFiles }) => {
  // `main.TEX` is a LaTeX file too.
  const isTex = (file) => /\.tex$/i.test(file);
  const files = inputFiles.filter(isTex);
  const skipped = inputFiles.filter((file) => !isTex(file));
  if (files.length === 0)
    throw new Error(
      'annotate works on .tex files: pass the documents to review as inputFiles.',
    );
  const held = {};
  const before = {};
  for (const file of files) {
    const text = await read(file);
    held[file] = definitionLines(text);
    before[file] = original(text, held[file]);
  }
  const task = [
    ...(instruction.trim()
      ? ['<instruction>\n' + instruction.trim() + '\n</instruction>']
      : []),
    'The files to annotate: ' + files.join(', ') + '.',
    ...(contextFiles.length > 0
      ? [
          'Read these for context and do not change them: ' +
            contextFiles.join(', ') +
            '.',
        ]
      : []),
  ].join('\n\n');
  // A file the program does not work on is named, never dropped unsaid.
  const answer = (verdict, reply) =>
    [
      ...(verdict ? [verdict] : []),
      ...(skipped.length > 0
        ? ['Not .tex files, so not reviewed: ' + skipped.join(', ') + '.']
        : []),
      reply,
    ].join('\n\n');
  let changed = [];
  let reply = null;
  for (let round = 1; round <= ROUNDS; round += 1) {
    const label = 'Round ' + round;
    section(label);
    reply = await agent(
      changed.length === 0
        ? task
        : task +
            '\n\nAn earlier round changed text outside \\criticize{...} annotations in ' +
            changed.join(', ') +
            '. Restore the original text there exactly (git diff shows your changes when the project is a repository) and keep only the annotations.',
      {
        system: REVIEWER,
        tools: ['read_file', 'edit_file', 'glob', 'grep', 'bash'],
        label,
        id: 'round-' + round,
      },
    );
    changed = [];
    for (const file of files)
      if (original(await read(file), held[file]) !== before[file])
        changed.push(file);
    if (changed.length === 0) return answer('', reply.response);
  }
  return answer(
    'After ' +
      ROUNDS +
      ' rounds, text outside the annotations still differs from the original in ' +
      changed.join(', ') +
      '. Compare those files with their earlier version before you rely on them.',
    reply.response,
  );
};
