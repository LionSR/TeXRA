
const draft = String.raw`
\section{Setup}
Let $K \subset \mathbb{R}^n$ be compact and $f\colon K \to \mathbb{R}$ continuous.
\section{Main bound}
We claim $\sup_K |f| \le 1$. The proof is omitted.
\section{Discussion}
The bound is sharp for constant functions.
`;

const schema = {
  type: "object",
  additionalProperties: false,
  required: ["section", "verdict", "gaps", "next_section"],
  properties: {
    section: { type: "string" },
    verdict: { type: "string" },
    gaps: { type: "array", items: { type: "string" } },
    next_section: { type: "string", description: "Exact section title for the next round; empty if none." }
  }
};

const r1 = await self(
  `You are reviewing a math draft strictly, section by section.

Full draft:
${draft}

Round 1 task: review ONLY the "Setup" section (do not audit other sections).
Check: are all objects introduced and quantified correctly (compactness, domain, codomain, continuity), is notation well-defined, are hypotheses needed later missing?

Verdict "pass" if Setup has no gap of its own; otherwise "fail" with the specific gap (gaps array, can be empty).
In "next_section" put the exact section title (Setup / Main bound / Discussion) round 2 should review: the section your verdict points to, or "Main bound" if it names none.`,
  { schema, label: "round 1: Setup" }
);

const v1 = r1.structured;
console.log("ROUND 1:", JSON.stringify(v1));

const so1 = await tools.await_signoff({
  verdict: `Round 1 (Setup): ${v1.verdict} Gaps: ${v1.gaps.join("; ") || "none"}. Next round reviews: ${v1.next_section || "Main bound"}.`
});
console.log("SIGNOFF 1:", so1.output);

const target = (v1.next_section || "").trim() || "Main bound";

const r2 = await self(
  `You are reviewing a math draft strictly, section by section.

Full draft:
${draft}

Round 1 reviewed Setup. Its result: ${JSON.stringify(v1)}
Round 1 pointed round 2 at the section: "${target}".

Round 2 task: review ONLY the "${target}" section. Judge it against what the draft actually establishes: is the claim proved, and exactly what is missing (hypotheses/quantifiers, unproved assertion, dependence on results not in the draft)? State concretely whether the claim is even true under the Setup hypotheses, and give a counterexample if it fails.

Verdict "pass" or "fail", gaps listed. Set "section" to "${target}" and "next_section" to "".`,
  { schema, label: `round 2: ${target}` }
);

const v2 = r2.structured;
console.log("ROUND 2:", JSON.stringify(v2));

await tools.await_signoff({
  verdict: `Round 2 (${target}): ${v2.verdict} Gaps: ${v2.gaps.join("; ") || "none"}.`
});

return { round1: v1, round2: v2 };

