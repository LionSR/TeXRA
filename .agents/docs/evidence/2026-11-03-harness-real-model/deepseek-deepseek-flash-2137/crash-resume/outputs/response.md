**Both rounds ran, with the round-1 verdict signed off before round 2 started.**

**Round 1 — Setup: pass, no gaps.** $K \subset \mathbb{R}^n$ compact and $f\colon K \to \mathbb{R}$ continuous are correctly stated and quantified; compactness + continuity make $\sup_K|f|$ a well-defined finite number. Only nits: the ambient space is implicit in $\mathbb{R}^n$, and $K = \varnothing$ isn't excluded (harmless). The verdict named no gap in Setup, so round 2 went to **Main bound**.

**Round 2 — Main bound: fail.** Two independent problems:
- The claim $\sup_K |f| \le 1$ is **false** as stated: nothing bounds $f$. With $K=\{0\}$, $f \equiv 2$, every Setup hypothesis holds yet $\sup_K|f| = 2 > 1$. Worse, $f \mapsto cf$ preserves both hypotheses for any $c>0$, so no fixed numerical bound can hold for this class at all.
- **No proof**: "The proof is omitted" is an unproved assertion; there is no argument, citation, or result in the draft to lean on.

The bound only holds if an extra hypothesis like $|f| \le 1$ on $K$ is added — and then it is a tautology, so the section establishes nothing either way. Also note the Discussion claim ("sharp for constant functions") is moot until the Main bound has content.

Fix: state the missing hypothesis explicitly, or replace the claim with what compactness + continuity actually give — finiteness and attainment of $\sup_K|f|$ (extreme value theorem).
