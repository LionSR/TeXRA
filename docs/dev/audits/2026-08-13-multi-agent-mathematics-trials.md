# Multi-agent mathematics trials, 2026-08-13

This note records direct trials of TeXRA's CLI team runner at commit
`b0de5a63cc`. It is intended to make the mathematical and product observations
reproducible without access to the development conversation.

## Environment and command form

The available `mathematician` and `physicist` presets both resolved to the
remote `orchestrator` root. The runs used the subscription-backed `gpt56--`
model and this command form:

```sh
texra multi-agent run <preset> \
  --model gpt56-- \
  --api-mode included \
  --approval-policy yolo \
  --no-input \
  --no-color \
  --output-format json \
  --instruction '<trial prompt>'
```

The execution identifiers below can be inspected with `texra history` on the
machine that performed the trials. A different account or agent catalog may
resolve a different team and is therefore a distinct experimental condition.

## Trial 1: finite groups of order \(p^2\)

- Preset: `mathematician`
- Execution: `4ff3ceffc7fb`
- Runtime: 4 min 13 s
- Root tool calls: 18

Prompt:

> Prove the following theorem rigorously: if G is a finite group of order p^2
> for a prime p, then G is abelian. Exercise the multi-agent workflow: use
> delegate_multi_agents to obtain at least two genuinely distinct proof routes
> and one adversarial audit for hidden assumptions or circularity. Reconcile
> any disagreement. Your final answer must be self-contained, identify exactly
> where the class equation and the structure of G/Z(G) are used, and separate
> the cases |Z(G)|=p and |Z(G)|=p^2. Do not cite the theorem being proved or any
> stronger classification theorem as a black box.

Expected checks:

1. The class equation must imply \(p\mid |Z(G)|\), not merely assert that the
   center of a finite \(p\)-group is nontrivial.
2. If \(|Z(G)|=p^2\), then \(Z(G)=G\).
3. If \(|Z(G)|=p\), then \(G/Z(G)\) has prime order and is cyclic.
4. The proof must establish, rather than cite without explanation, that a
   cyclic quotient by the center makes the group abelian.

Observed result: all four checks passed. The live status exposed separate
`mathematician-order-p2`, `prover`, and `review` participants. The synthesis
used the class equation only to restrict the center to the two required cases,
then wrote arbitrary elements as \(a^r z_1\) and \(a^s z_2\) in the quotient
case. No retry was needed and no mathematical disagreement survived review.

## Trial 2: driven damped oscillator

- Preset: `physicist`
- Execution: `db157022a0e0`
- Runtime: 2 min 41 s
- Root tool calls: 27

Prompt:

> Analyze the steady-state response of m x¨ + c x˙ + k x = F0 cos(omega t)
> for m=2 kg, c=4 N s/m, k=50 N/m, F0=10 N, and omega=4 rad/s.
> Exercise the multi-agent workflow with delegate_multi_agents: assign distinct
> agents to (i) derive the complex-amplitude solution and phase convention,
> (ii) independently calculate the numerical amplitude and cycle-averaged
> input/dissipated power, and (iii) audit dimensions and derive the
> displacement-resonance frequency, including the condition under which it
> exists. Reconcile sign or phase disagreements explicitly. Give enough
> intermediate arithmetic that the numerical values can be checked without
> software.

Expected numerical checks:

\[
k-m\omega^2=18\ \mathrm{N/m},\qquad c\omega=16\ \mathrm{N/m},
\]

\[
A=\frac{10}{\sqrt{580}}\approx0.4152\ \mathrm m,
\qquad
\phi=\operatorname{atan2}(16,18)\approx0.7266,
\]

\[
\langle P\rangle=\frac12c\omega^2A^2
=\frac{160}{29}\approx5.52\ \mathrm W,
\]

and

\[
\omega_{\mathrm{disp}}
=\sqrt{\frac{k}{m}-\frac{c^2}{2m^2}}
=\sqrt{23}\approx4.80\ \mathrm{rad\,s^{-1}},
\]

with a positive-frequency displacement peak precisely when \(c^2<2km\).

Observed result: every numerical and dimensional check passed. The synthesis
also reconciled the sign change caused by choosing \(e^{-i\omega t}\) instead
of \(e^{i\omega t}\): the complex phase changes sign, while the physical
displacement remains the same.

The live status showed concurrent work but named only the first task and
rendered the remaining participant as `+1`. This is compact, but it prevents a
reader from checking which approaches are concurrently active without opening
the detailed subagent view.

## Trial 3: logarithmic improper integral

- Preset: `mathematician`
- Execution: `d92489a767b0`
- Runtime: 4 min 04 s
- Root tool calls: 2

Prompt:

> Evaluate I = integral from 0 to infinity of log(1+x^2)/(1+x^2) dx
> rigorously. Exercise delegate_multi_agents with distinct approaches: one
> route using x=tan(theta), one using a parameter integral differentiated under
> the integral sign, and one independent audit that checks convergence,
> endpoint limits, and a numerical estimate. The synthesis must compare the
> routes, justify every interchange or differentiation, and explicitly reject
> any tempting divergent split into separate improper integrals. If agents
> disagree on a constant or factor of two, resolve it from first principles.

Expected checks:

1. The value is \(\pi\log 2\).
2. The substitution \(x=\tan\theta\) reduces the integral to
   \(-2\int_0^{\pi/2}\log(\cos\theta)\,d\theta\), with the endpoint
   singularity shown to be integrable.
3. A parameter proof must justify differentiation under the integral sign and
   the limit at the parameter endpoint.
4. The numerical value is approximately \(2.177586090303602\).
5. Terms that diverge separately after integration by parts must not be split
   into independent improper integrals.

Observed result: all five checks passed. The root delegated one outer
`integral-three-route-synthesis` task and used only two root-level tool calls.
The final mathematics contains the requested independent arguments, but the
compact status does not reveal their internal fan-out. This run therefore
provides strong synthesis evidence and weaker interface evidence for distinct
concurrent approaches.

## Trial 4: intentional failure and recovery

- Preset: `mathematician`
- Execution: `725172379147`
- Runtime: 1 min 14 s
- Root tool calls: 6

Prompt:

> Establish rigorously that sum_{n=1}^infinity (-1)^{n-1}/n = log 2,
> including a quantitative remainder bound. This is also a bounded
> runtime-recovery exercise. First call delegate_multi_agents with a workflow
> containing one agent() call whose agentName is exactly
> definitely-missing-agent, alongside an available mathematical attempt;
> observe and report the failed call rather than concealing it. Then recover by
> making a second delegation with an available reviewer/prover, and synthesize
> a correct proof. The final answer must distinguish the intentional runtime
> failure from mathematical disagreement, state how recovery occurred, and
> verify the remainder bound independently. Do not claim the failed agent
> contributed mathematics.

Expected checks:

1. The missing agent must fail visibly and must not be credited with a result.
2. A later delegation must recover the task with an available agent.
3. The mathematical result must follow from a finite identity, without an
   unjustified exchange of an infinite sum and an integral.
4. The remainder must satisfy
   \[
   R_N=(-1)^N\int_0^1\frac{x^N}{1+x}\,dx,
   \qquad |R_N|\le\frac1{N+1}.
   \]

Observed result: the first workflow returned to the root after the missing
agent failure; the live status then showed a second delegation to `prover`.
The final response explicitly stated that `definitely-missing-agent`
contributed no mathematics. It also reported that the accompanying workflow
agent required an input document, so that branch did not produce a result.
Recovery succeeded through the second delegation, and the final proof passed
the exact remainder checks.

## Product conclusions

- Team resolution, delegation, synthesis, and recovery all completed in real
  mathematical runs without weakening the mathematical acceptance criteria.
- The compact progress status remains legible during long runs, but concurrent
  ownership is partially hidden behind `+N`, and nested workflow structure is
  represented by only its outer task label.
- The settings interface corrections made during the same audit are captured
  in commits `cc407df910`, `98edb7fa98`, and `b0de5a63cc`: delegation roles now
  come from backend capability data, the roster alone owns active-team state,
  and apply/delete actions use separate native controls.
- No new recovery mechanism is justified by these trials. The intentional
  missing-agent failure was isolated and recovered by an ordinary subsequent
  delegation. The remaining status limitation is an information-presentation
  question, not evidence of incorrect lifecycle ownership.
