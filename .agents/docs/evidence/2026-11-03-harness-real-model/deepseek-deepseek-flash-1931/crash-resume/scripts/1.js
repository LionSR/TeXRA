phase("Round 1: check Setup");
const r1 = await self(
  `You are reviewing a draft paper excerpt. Here it is:

\\section{Setup}
Let $K \\subset \\mathbb{R}^n$ be compact and $f\\colon K \\to \\mathbb{R}$ continuous.
\\section{Main bound}
We claim $\\sup_K |f| \\le 1$. The proof is omitted.
\\section{Discussion}
The bound is sharp for constant functions.

Task: check ONLY the Setup section. Report whether it is well-posed / has any gap (missing hypotheses, undefined symbols, quantifiers, etc.). Do not review other sections; if an issue belongs to another section, note its location but do not analyze it. Be concise.`,
  {
    label: "round 1: Setup verdict",
    schema: {
      type: "object",
      properties: {
        verdict: { type: "string", description: "One-line overall verdict on Setup" },
        gaps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              issue: { type: "string" },
              section: { type: "string", description: "Section the issue lives in" },
              why: { type: "string" }
            },
            required: ["issue", "section", "why"]
          }
        },
        pointed_section: { type: "string", description: "Section round 2 should examine next, or 'Main bound' if none" }
      },
      required: ["verdict", "gaps", "pointed_section"]
    }
  }
);
console.log("ROUND 1:", JSON.stringify(r1.structured ?? r1.response));

const v1 = r1.structured?.verdict ?? r1.response;
const signoff = await await_signoff({ verdict: v1 });
console.log("SIGNOFF:", signoff.output);

phase("Round 2: check pointed section");
const target = r1.structured?.pointed_section ?? "Main bound";
const r2 = await self(
  `You are reviewing a draft paper excerpt. Here it is:

\\section{Setup}
Let $K \\subset \\mathbb{R}^n$ be compact and $f\\colon K \\to \\mathbb{R}$ continuous.
\\section{Main bound}
We claim $\\sup_K |f| \\le 1$. The proof is omitted.
\\section{Discussion}
The bound is sharp for constant functions.

Round 1 reviewed only the Setup section and returned this verdict:
${JSON.stringify(r1.structured ?? r1.response)}

Task: check ONLY the section "${target}" — the one round 1's verdict points to. Report its gaps (e.g. unjustified claims, missing proof, unsupported sharpness statement). Do not re-review Setup. Be concise.`,
  {
    label: `round 2: ${target} verdict`,
    schema: {
      type: "object",
      properties: {
        section_reviewed: { type: "string" },
        verdict: { type: "string" },
        gaps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              issue: { type: "string" },
              why: { type: "string" }
            },
            required: ["issue", "why"]
          }
        }
      },
      required: ["section_reviewed", "verdict", "gaps"]
    }
  }
);
console.log("ROUND 2:", JSON.stringify(r2.structured ?? r2.response));

return {
  round1: r1.structured ?? r1.response,
  signoff: signoff.output,
  round2: r2.structured ?? r2.response
};
