const schema = {
  type: "object",
  properties: {
    section: { type: "string" },
    claim: { type: "string" },
    supported: { type: "boolean" },
    reason: { type: "string" }
  },
  required: ["section", "claim", "supported", "reason"],
  additionalProperties: false
};

const r2 = await self(
  `Review round 2 of the LaTeX draft in the workspace (draft.tex). Round 1 found the first section "Setup" merely introduces compactness and continuity hypotheses and asserts nothing to prove, so the substantive burden falls on the next section. Check ONLY the section titled "Main bound", whose body reads: "We claim $\\\\sup_K |f| \\\\le 1$. The proof is omitted." Decide whether the section's claim is supported by the draft. Return the section title, the claim, a boolean supported, and a one-sentence reason. Be strict: "the proof is omitted" means no argument is given, and the stated hypotheses (compact K, continuous f) do not imply a bound of 1.`,
  { fork: false, schema, label: "Review round 2: Main bound" }
);

return { r2: r2.structured, runId: r2.runId, outcome: r2.outcome };
