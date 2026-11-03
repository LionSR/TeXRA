const draft = String.raw`\section{Setup}
Let $K \subset \mathbb{R}^n$ be compact and $f\colon K \to \mathbb{R}$ continuous.
\section{Main bound}
We claim $\sup_K |f| \le 1$. The proof is omitted.
\section{Discussion}
The bound is sharp for constant functions.`;

const schema1 = {
  type: 'object',
  properties: {
    verdict: { type: 'string', description: 'One-sentence verdict on the Setup section.' },
    sound: { type: 'boolean', description: 'Whether the Setup section is adequate as stated.' },
    gaps: { type: 'array', items: { type: 'string' }, description: 'Gaps found in the Setup section.' },
    section: { type: 'string', description: 'Name of the section the gap points to, e.g. "Main bound".' }
  },
  required: ['verdict', 'sound', 'gaps', 'section'],
  additionalProperties: false
};

const schema2 = {
  type: 'object',
  properties: {
    verdict: { type: 'string', description: 'One-sentence verdict on the reviewed section.' },
    sound: { type: 'boolean', description: 'Whether that section holds as written.' },
    gaps: { type: 'array', items: { type: 'string' }, description: 'Gaps found in that section.' }
  },
  required: ['verdict', 'sound', 'gaps'],
  additionalProperties: false
};

const r1 = await self({
  fork: false,
  label: 'Round 1 review — Setup',
  prompt: `You are reviewing a short mathematics draft.

--- DRAFT ---
${draft}
--- END DRAFT ---

Round 1: review ONLY the \`Setup\` section. Is it mathematically adequate as stated for the rest of the draft? Name any gap precisely (missing hypotheses, undefined symbols, quantifier problems, unused/over-strong assumptions). In the \`section\` field, name the section the gap points to (e.g. "Main bound"), or "Setup" if the gap is self-contained there. Be concise and concrete.`,
  schema: schema1
});

const v1 = r1.structured;
console.log('ROUND 1 verdict:', v1.verdict, '| section:', v1.section, '| gaps:', JSON.stringify(v1.gaps));

const signoffSentence = `${v1.verdict}${v1.gaps.length ? ' Gaps: ' + v1.gaps.join('; ') + '.' : ''} Gap points to the "${v1.section}" section.`;
const signoff = await tools.await_signoff({ verdict: signoffSentence });
console.log('SIGN-OFF:', signoff.output);

const target = (v1.section && v1.section.trim()) ? v1.section.trim() : 'Main bound';

const r2 = await self({
  fork: false,
  label: `Round 2 review — ${target}`,
  prompt: `You are reviewing a short mathematics draft.

--- DRAFT ---
${draft}
--- END DRAFT ---

Round 1 reviewed the \`Setup\` section and returned this verdict: "${v1.verdict}" with gaps ${JSON.stringify(v1.gaps)}, pointing to the "${target}" section.

Round 2: review the "${target}" section only, in light of round 1's gap. Judge whether the claim survives as stated, whether the omitted proof is acceptable, and precisely what hypothesis or argument is missing. Be concise and concrete.`,
  schema: schema2
});

const v2 = r2.structured;
console.log('ROUND 2 verdict:', v2.verdict, '| gaps:', JSON.stringify(v2.gaps));

return {
  round1: { verdict: v1.verdict, sound: v1.sound, gaps: v1.gaps, section: v1.section },
  signoff_verdict_sent: signoffSentence,
  round2: { section_reviewed: target, verdict: v2.verdict, sound: v2.sound, gaps: v2.gaps }
};
