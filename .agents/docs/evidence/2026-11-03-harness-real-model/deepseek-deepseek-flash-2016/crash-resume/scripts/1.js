
const draft = `\\section{Setup}
Let $K \\subset \\mathbb{R}^n$ be compact and $f\\colon K \\to \\mathbb{R}$ continuous.
\\section{Main bound}
We claim $\\sup_K |f| \\le 1$. The proof is omitted.
\\section{Discussion}
The bound is sharp for constant functions.`;

const schema = {
  type: "object",
  properties: {
    verdict: { type: "string" },
    gap: { type: "string" },
    section: { type: "string" }
  },
  required: ["verdict", "gap"],
  additionalProperties: false
};

const r1 = await self(
  `Review the Setup section of this draft and return a structured verdict naming any gap, plus the section your verdict points to as needing review next.\n\n${draft}`,
  { fork: false, schema, label: "Round 1: Setup review" }
);
const v1 = r1.structured;
console.log("Round 1:", JSON.stringify(v1));

const signoff = await tools.await_signoff({ verdict: v1.verdict });
console.log("Signoff:", signoff.output);

const target = v1.section && v1.section.trim() ? v1.section : "Main bound";
const r2 = await self(
  `Review the "${target}" section of this draft. Round 1's verdict was: ${v1.verdict} (gap: ${v1.gap}). Return a structured verdict.\n\n${draft}`,
  { fork: false, schema, label: `Round 2: ${target} review` }
);

return { round1: v1, signoff: signoff.output, round2_target: target, round2: r2.structured };

