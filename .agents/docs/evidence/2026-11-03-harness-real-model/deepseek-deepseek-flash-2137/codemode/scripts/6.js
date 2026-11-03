const latex = await import('builtIn:latex');
const { sections } = await latex.outline('draft.tex');
const titles = sections.map(s => s.title);
const draft = sections.map(s => `=== SECTION: ${s.title} ===\n${s.text}`).join('\n\n');

const verdictSchema = {
  type: 'object',
  properties: {
    section: { type: 'string', description: 'exact title of the section reviewed' },
    claim: { type: 'string', description: 'the section claim or assumption being checked, quoted briefly' },
    supported: { type: 'boolean', description: 'true if the draft supports the claim, false otherwise' },
    reason: { type: 'string', description: 'one or two sentences justifying the verdict' },
    nextSection: { type: 'string', description: 'title of the section the reviewer most wants checked next' }
  },
  required: ['section', 'claim', 'supported', 'reason', 'nextSection'],
  additionalProperties: false
};

const base = `You are reviewing a short LaTeX paper draft. Here is the full draft:\n\n${draft}\n\n`;
const ask = (t) => `${base}Review ONLY the section titled "${t}". Judge whether the section's central claim (or, for a setup/assumption section, its stated assumptions as used by the paper) is actually supported by what the draft says. Be skeptical: check for unsupported assertions, omitted proofs, or statements that are false as written. Return the structured verdict.`;

phase('round 1: ' + titles[0]);
const r1 = await self(ask(titles[0]), { schema: verdictSchema, label: 'review: ' + titles[0] });
const v1 = r1.structured;
console.log('round1', JSON.stringify(v1));

const pick = titles.find(t => t.toLowerCase() === String(v1?.nextSection || '').trim().toLowerCase())
  || titles[1] || titles[titles.length - 1];

phase('round 2: ' + pick);
const r2 = await self(ask(pick), { schema: verdictSchema, label: 'review: ' + pick });
const v2 = r2.structured;
console.log('round2', JSON.stringify(v2));

phase('counting child runs');
const rows = await tools.executions({
  path: '/executions',
  action: 'query',
  sql: 'SELECT id, parent_id, status, outcome FROM runs WHERE id IN (?, ?)',
  params: [r1.runId, r2.runId]
});
console.log('rows', JSON.stringify(rows));
const parentId = rows.rows[0]?.[1];
const cnt = await tools.executions({
  path: '/executions',
  action: 'query',
  sql: 'SELECT count(*) FROM runs WHERE parent_id = ? AND outcome = ?',
  params: [parentId, 'completed']
});

return {
  sectionTitles: titles,
  round1: v1,
  round2: v2,
  round2SectionChosen: pick,
  completedChildren: Number(cnt.rows[0][0])
};

