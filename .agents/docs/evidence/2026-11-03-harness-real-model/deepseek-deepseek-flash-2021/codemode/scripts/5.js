const latex = await import('builtIn:latex');

// 1. Split the draft into sections.
const { sections } = await latex.outline('draft.tex');
const titles = sections.map(s => s.title);
const byTitle = Object.fromEntries(sections.map(s => [s.title, s.text]));

// Full draft rendered compactly, so each reviewer sees the same context.
const draftContext = sections
  .map(s => `\\section{${s.title}}\n${s.text}`)
  .join('\n\n');

const verdictSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    section: { type: 'string', description: 'Exact title of the section reviewed' },
    claim: { type: 'string', description: 'The claim the section makes, in one sentence' },
    supported: { type: 'boolean', description: 'Is that claim supported by the draft?' },
    reasoning: { type: 'string', description: 'Why: evidence, or what is missing' },
    followUpSection: { type: 'string', description: 'Exact title of the section the next review should check' }
  },
  required: ['section', 'claim', 'supported', 'reasoning', 'followUpSection']
};

function reviewPrompt(sectionTitle, round) {
  return `You are reviewing a short LaTeX paper draft (workspace file draft.tex). ` +
    `Do not edit any file; this is a read-only review.

Here is the whole draft:

${draftContext}

Round ${round} of the review: check ONLY the section titled "${sectionTitle}".
Its text is:

${byTitle[sectionTitle]}

Judge whether the claim that section makes is actually supported by what the draft states.
Be strict about mathematics: a hypothesis-only setup makes no derivable claim, and a sentence
like "the proof is omitted" does not support a bound. Also propose as followUpSection the exact
title of the section that the next review round should examine (one of: ${titles.join(', ')}).
Name the section you checked and set supported accordingly.`;
}

// 2a. Round 1 — first section.
const r1 = await self(reviewPrompt(titles[0], 1), {
  schema: verdictSchema, fork: true, label: 'Review round 1'
});
const verdict1 = r1.structured;

// 2b. Round 2 — section chosen from round 1's verdict:
// the follow-up the reviewer named, unless it is the section just reviewed,
// in which case fall back to the next substantive section.
const candidate = verdict1.followUpSection && byTitle[verdict1.followUpSection] !== undefined &&
                  verdict1.followUpSection !== verdict1.section
  ? verdict1.followUpSection
  : titles.find(t => t !== verdict1.section) ?? titles[0];

const r2 = await self(reviewPrompt(candidate, 2), {
  schema: verdictSchema, fork: true, label: 'Review round 2'
});
const verdict2 = r2.structured;

// 3. Count child runs that ended completed, from the runs table.
let myId = null;
try {
  const cur = await tools.executions({ path: '/executions/current' });
  const blob = typeof cur === 'string' ? cur : (cur.output ?? JSON.stringify(cur));
  const m = String(blob).match(/"id"\s*:\s*"([^"]+)"/);
  if (m) myId = m[1];
} catch (e) { /* fall back below */ }

const childIds = [r1.runId, r2.runId].filter(Boolean);
let countRow;
if (myId) {
  countRow = await tools.executions({
    path: '/executions',
    action: 'query',
    sql: "SELECT count(*) AS n FROM runs WHERE parent_id = ? AND status = 'ended' AND outcome = 'completed'",
    params: [myId]
  });
} else {
  countRow = await tools.executions({
    path: '/executions',
    action: 'query',
    sql: `SELECT count(*) AS n FROM runs WHERE id IN (${childIds.map(() => '?').join(',')}) AND status = 'ended' AND outcome = 'completed'`,
    params: childIds
  });
}

const completedChildren = Number((countRow.rows ?? [])[0]?.[0] ?? 0);

return {
  sectionTitles: titles,
  verdicts: [verdict1, verdict2],
  completedChildren,
  details: { round2Candidate: candidate, parentId: myId, childRunIds: childIds, rawCount: countRow }
};
