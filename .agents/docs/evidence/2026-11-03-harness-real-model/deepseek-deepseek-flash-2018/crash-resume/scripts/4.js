const draft = [
  String.raw`\section{Setup}`,
  String.raw`Let $K \subset \mathbb{R}^n$ be compact and $f\colon K \to \mathbb{R}$ continuous.`,
  String.raw`\section{Main bound}`,
  String.raw`We claim $\sup_K |f| \le 1$. The proof is omitted.`,
  String.raw`\section{Discussion}`,
  'The bound is sharp for constant functions.'
].join('\n');

const schema1 = {
  type: 'object',
  properties: {
    verdict: { type: 'string' },
    sound: { type: 'boolean' },
    gaps: { type: 'array', items: { type: 'string' } },
    section: { type: 'string' }
  },
  required: ['verdict', 'sound', 'gaps', 'section'],
  additionalProperties: false
};

const schema2 = {
  type: 'object',
  properties: {
    verdict: { type: 'string' },
    sound: { type: 'boolean' },
    gaps: { type: 'array', items: { type: 'string' } }
  },
  required: ['verdict', 'sound', 'gaps'],
  additionalProperties: false
};

const r1 = await self(
  `You are reviewing a short mathematics draft.\n\n--- DRAFT ---\n${draft}\n--- END DRAFT ---\n\n` +
  `Round 1: review ONLY the "Setup" section. Is it mathematically adequate as stated for the rest of the draft? ` +
  `Name any gap precisely (missing hypotheses, undefined symbols, quantifier issues, over-strong or unused assumptions). ` +
  `In the "section" field name the section the gap points to (e.g. "Main bound"), or "Setup" if the gap is self-contained there. Be concise.`,
  { fork: false, label: 'Round 1 review — Setup', schema: schema1 }
);

const v1 = r1.structured;
console.log('ROUND 1:', JSON.stringify(v1));

const signoffSentence = `${v1.verdict}${v1.gaps.length ? ' Gaps: ' + v1.gaps.join('; ') + '.' : ''} Gap points to the "${v1.section}" section.`;
const signoff = await tools.await_signoff({ verdict: signoffSentence });
console.log('SIGN-OFF:', signoff.output);

const target = (v1.section || '').trim() || 'Main bound';

const r2 = await self(
  `You are reviewing a short mathematics draft.\n\n--- DRAFT ---\n${draft}\n--- END DRAFT ---\n\n` +
  `Round 1 reviewed the "Setup" section: verdict "${v1.verdict}", gaps ${JSON.stringify(v1.gaps)}, pointing to the "${target}" section.\n\n` +
  `Round 2: review the "${target}" section only, in light of round 1's gap. Judge whether the claim survives as stated, whether omitting the proof is acceptable, ` +
  `and precisely what hypothesis or argument is missing. Be concise.`,
  { fork: false, label: `Round 2 review — ${target}`, schema: schema2 }
);

const v2 = r2.structured;
console.log('ROUND 2:', JSON.stringify(v2));

return {
  round1: { verdict: v1.verdict, sound: v1.sound, gaps: v1.gaps, section: v1.section },
  signoff_verdict_sent: signoffSentence,
  round2: { section_reviewed: target, verdict: v2.verdict, sound: v2.sound, gaps: v2.gaps }
};
