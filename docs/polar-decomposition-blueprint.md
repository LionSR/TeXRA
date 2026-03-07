# Polar Decomposition in Lean 4 — Formalization Blueprint

## 1. Mathematical Overview

The **polar decomposition** states that every bounded linear operator $A$ on a Hilbert space can be written as

$$A = U \cdot P$$

where:
- $P = |A| = \sqrt{A^* A}$ is a positive semidefinite operator (the **absolute value** of $A$)
- $U$ is a **partial isometry** with $\ker U = \ker A$

For the **right polar decomposition**: $A = U P$ where $P = \sqrt{A^* A}$.
For the **left polar decomposition**: $A = P' U$ where $P' = \sqrt{A A^*}$.

In the finite-dimensional (matrix) case, $U$ is unitary when $A$ is invertible.

---

## 2. Current State of the Formalization

### 2.1 Completed Definitions

| File | Contents |
|------|----------|
| `Defs.lean` | `Matrix.polarDecomp` — defines $U = A \cdot P^{-1}$ for invertible $P$; `Matrix.IsUnitaryPolarDecomp` — predicate for $(U, P)$ being a valid unitary polar decomposition |
| `AbsoluteValue.lean` | `Matrix.absValue` — $|A| = \sqrt{A^* A}$ via positive semidefinite square root |
| `Basic.lean` | Core lemmas for the invertible case |
| `Matrix.lean` | Matrix-specific polar decomposition results |
| `PartialIsometry.lean` | `Matrix.IsPartialIsometry` — definition and basic properties |

### 2.2 Proved Results

- **Invertible case**: When $A$ is invertible, $A^* A$ is positive definite, $P = \sqrt{A^* A}$ is invertible, and $U = A P^{-1}$ is unitary. The decomposition $A = U P$ holds and $U$ is unique.

### 2.3 Open Goals (`sorry`)

- **General (non-invertible) case**: The existence of a partial isometry $U$ such that $A = U P$ with $\ker U = \ker A$.
- This is the main theorem to be formalized.

---

## 3. Proof Strategy

### 3.1 Approach: SVD-Based (Recommended for Matrices)

For the finite-dimensional case (matrices over $\mathbb{C}$), the cleanest path goes through the **Singular Value Decomposition (SVD)**:

#### Step 1: Spectral Decomposition of $A^* A$

$A^* A$ is Hermitian and positive semidefinite. By the spectral theorem (available in Mathlib as `Matrix.IsHermitian.spectral_theorem`):

$$A^* A = W \cdot \Sigma^2 \cdot W^*$$

where $W$ is unitary and $\Sigma^2 = \text{diag}(\sigma_1^2, \ldots, \sigma_n^2)$ with $\sigma_i \geq 0$ (the singular values).

**Mathlib API**: `Matrix.IsHermitian.spectral_theorem` gives eigenvalue decomposition for Hermitian matrices.

#### Step 2: Construct the PSD Square Root

$$P = \sqrt{A^* A} = W \cdot \Sigma \cdot W^*$$

where $\Sigma = \text{diag}(\sigma_1, \ldots, \sigma_n)$.

**Mathlib API**: `CFC.sqrt` provides the continuous functional calculus square root for positive elements in C*-algebras. For matrices, this can also be constructed directly from the spectral decomposition.

#### Step 3: Construct the Partial Isometry

Define $U$ on the column space of $P$:
- For each eigenvector $w_i$ of $A^* A$ with $\sigma_i > 0$: define $U w_i = \frac{1}{\sigma_i} A w_i$
- For each eigenvector $w_i$ with $\sigma_i = 0$: define $U w_i = 0$ (or extend arbitrarily)

Then $A = U P$ and $U$ is a partial isometry with initial space $(\ker A)^\perp = \text{range}(P)$.

#### Step 4: Verify Properties

- $U^* U$ is the orthogonal projection onto $(\ker A)^\perp$
- $U U^*$ is the orthogonal projection onto $\text{range}(A)$
- $\ker U = \ker A = \ker P$

### 3.2 Alternative Approach: Extension of Isometries

For the general (infinite-dimensional, operator-theoretic) case:

1. Define $U_0 : \text{range}(P) \to \text{range}(A)$ by $U_0(Px) = Ax$
2. Show $U_0$ is a well-defined isometry: $\|Px\| = \|Ax\|$ since $\|Px\|^2 = \langle Px, Px \rangle = \langle A^* A x, x \rangle = \|Ax\|^2$
3. Extend $U_0$ to all of $H$ by setting $U = 0$ on $(\text{range}(P))^\perp = \ker P = \ker A$
4. The resulting $U$ is a partial isometry

This approach is more general but requires careful handling of closures of ranges.

---

## 4. Dependency Graph

```
Matrix.IsHermitian.spectral_theorem  (Mathlib)
    │
    ▼
eigenvalue_decomposition_of_AstarA
    │
    ├──────────────────────┐
    ▼                      ▼
psd_square_root        singular_values_nonneg
    │                      │
    ▼                      ▼
absValue_eq_W_Sigma_Wstar  svd_factorization
    │                      │
    └──────────┬───────────┘
               ▼
    partial_isometry_construction
               │
               ▼
    polar_decomposition_general
               │
    ┌──────────┼──────────┐
    ▼          ▼          ▼
ker_U_eq    A_eq_UP    uniqueness
_ker_A                 _of_P
```

---

## 5. Detailed Lemma Breakdown

### 5.1 Foundations (use existing Mathlib)

| Lemma | Mathlib Reference | Status |
|-------|-------------------|--------|
| Hermitian matrices have real eigenvalues | `Matrix.IsHermitian.eigenvalues_real` | Available |
| Spectral theorem for Hermitian matrices | `Matrix.IsHermitian.spectral_theorem` | Available |
| PSD matrices have nonneg eigenvalues | `Matrix.PosSemidef.eigenvalues_nonneg` | Available |
| CFC square root for positive elements | `CFC.sqrt` | Available |
| `star_mul_self` gives PSD matrix | `Matrix.PosSemidef.conjTranspose_mul_self` | Available |

### 5.2 New Lemmas to Formalize

#### Block A: Absolute Value Properties

```
A1. absValue_sq : |A|^2 = A^* A
A2. absValue_posSemidef : |A|.PosSemidef
A3. absValue_ker : ker |A| = ker A
A4. absValue_range_closure : closure (range |A|) = (ker A)^⊥
A5. absValue_unique : P.PosSemidef ∧ P^2 = A^* A → P = |A|
```

#### Block B: Singular Value Decomposition (Matrix Case)

```
B1. AstarA_hermitian : (A^* A).IsHermitian
B2. AstarA_posSemidef : (A^* A).PosSemidef
B3. singular_values_def : σ_i = √(eigenvalue_i(A^* A))
B4. singular_values_nonneg : 0 ≤ σ_i
B5. svd_exists : ∃ U V Σ, A = U * Σ * V^* ∧ U.Unitary ∧ V.Unitary ∧ Σ.IsDiag ∧ Σ.nonneg
```

#### Block C: Partial Isometry Construction

```
C1. partial_isometry_from_svd : U = V_left * V_right^* is a partial isometry
C2. partial_isometry_ker : ker U = ker A
C3. partial_isometry_range : range U = range A  (closure in infinite dim)
C4. partial_isometry_adjoint_prop : U^* U = orthogonalProjection (ker A)^⊥
```

#### Block D: Main Theorems

```
D1. polar_decomp_exists : ∀ A, ∃ U P, A = U * P ∧ P.PosSemidef ∧ U.IsPartialIsometry ∧ ker U = ker A
D2. polar_decomp_unique_P : P is uniquely determined as |A|
D3. polar_decomp_unique_U : U is unique on range(P)
D4. polar_decomp_unitary_iff : U.Unitary ↔ A.Invertible  (square matrix case)
D5. left_polar_decomp : ∃ U' P', A = P' * U' ∧ P'.PosSemidef ∧ U'.IsPartialIsometry
```

---

## 6. Mathlib API Mapping

### Key Namespaces

| Concept | Mathlib Location |
|---------|-----------------|
| Hermitian matrices | `Mathlib.LinearAlgebra.Matrix.Hermitian` |
| Positive semidefinite | `Mathlib.LinearAlgebra.Matrix.PosDef` |
| Spectral theorem | `Mathlib.LinearAlgebra.Matrix.Spectrum` |
| Unitary matrices | `Mathlib.LinearAlgebra.UnitaryGroup` |
| CFC (functional calculus) | `Mathlib.Analysis.CStarAlgebra.ContinuousFunctionalCalculus` |
| CFC square root | `CFC.sqrt`, `CFC.sq_sqrt` |
| Orthogonal projection | `Mathlib.Analysis.InnerProductSpace.Projection` |
| Star algebra | `Mathlib.Algebra.Star.Basic` |

### Key Lemmas to Use

```lean
-- Spectral theorem
Matrix.IsHermitian.spectral_theorem :
  hA.spectral_theorem = diagonal hA.eigenvalues

-- PSD eigenvalues
Matrix.PosSemidef.eigenvalues_nonneg :
  hA.eigenvalues i ≥ 0

-- CFC square root
CFC.sqrt_sq : CFC.sqrt a ^ 2 = a  -- for a ≥ 0
CFC.sq_sqrt : a ^ 2 |> CFC.sqrt = a  -- for a ≥ 0

-- Star/adjoint
star_mul_self_nonneg : 0 ≤ star a * a
```

---

## 7. File Organization

```
PolarDecomposition/
├── Defs.lean              -- Core definitions (exists)
├── AbsoluteValue.lean     -- |A| = √(A*A) properties (exists, extend)
├── PartialIsometry.lean   -- Partial isometry defs & lemmas (exists, extend)
├── Basic.lean             -- Invertible case (exists, proved)
├── Matrix.lean            -- Matrix-specific results (exists, extend)
├── SVD.lean               -- NEW: Singular value decomposition
├── General.lean           -- NEW: General (non-invertible) case
├── Uniqueness.lean        -- NEW: Uniqueness results
└── LeftPolar.lean         -- NEW: Left polar decomposition A = P'U
```

---

## 8. Implementation Roadmap

### Phase 1: Strengthen Foundations (Blocks A)
**Goal**: Complete the absolute value API

1. Prove `absValue_sq` using CFC or direct spectral computation
2. Prove `absValue_ker` — this is critical for the partial isometry construction
3. Prove `absValue_unique` — PSD square root uniqueness

### Phase 2: SVD for Matrices (Block B)
**Goal**: Establish SVD existence for finite-dimensional matrices

1. Use `Matrix.IsHermitian.spectral_theorem` on $A^* A$ to get eigendecomposition
2. Define singular values as square roots of eigenvalues
3. Construct left singular vectors from right singular vectors via $u_i = \frac{1}{\sigma_i} A v_i$
4. Assemble into SVD: $A = U \Sigma V^*$

### Phase 3: General Polar Decomposition (Blocks C, D)
**Goal**: The main theorem

1. From SVD: $P = V \Sigma V^*$ and $U_{\text{polar}} = U_{\text{svd}} V^*$
2. Verify $A = U_{\text{polar}} \cdot P$
3. Verify $U_{\text{polar}}$ is a partial isometry
4. Prove $\ker U_{\text{polar}} = \ker A$

### Phase 4: Uniqueness and Extensions (Block D)
**Goal**: Uniqueness and left decomposition

1. $P$ is uniquely determined (PSD square root uniqueness)
2. $U$ is unique on $\text{range}(P)$
3. Left polar decomposition via applying right decomposition to $A^*$

---

## 9. Technical Challenges and Mitigations

### Challenge 1: Square Root Construction
**Issue**: Mathlib's `CFC.sqrt` works in C*-algebras via continuous functional calculus, which may be overkill for matrices.
**Mitigation**: For the matrix case, construct the square root explicitly from the spectral decomposition: $\sqrt{M} = W \cdot \text{diag}(\sqrt{\lambda_i}) \cdot W^*$. This avoids CFC entirely.

### Challenge 2: Partial Isometry on Degenerate Subspaces
**Issue**: When $\sigma_i = 0$, we need to handle the kernel carefully.
**Mitigation**: Define $U$ to be zero on $\ker P$ and use `Finset.sum` over nonzero singular values only.

### Challenge 3: Connecting Matrix and Operator Viewpoints
**Issue**: Mathlib has both `Matrix` and `ContinuousLinearMap` hierarchies.
**Mitigation**: Start with the matrix case entirely within `Matrix n n ℂ`. The operator case can be a future extension using `ContinuousLinearMap` and `InnerProductSpace`.

### Challenge 4: Permutation of Eigenvalues
**Issue**: The spectral theorem returns eigenvalues in a specific order; SVD construction needs to match indices.
**Mitigation**: Use the same index type throughout. The spectral theorem gives `eigenvalues : n → ℝ` indexed by `n`; keep this indexing for singular values.

---

## 10. Testing Strategy

For each phase, verify:
1. **Type-check**: `lake build` passes with no errors
2. **No sorry**: All lemmas are fully proved (no `sorry` remaining)
3. **API usability**: Key theorems can be applied in simple examples (e.g., 2×2 matrices)

Intermediate checkpoints:
- After Phase 1: `absValue` API is complete and `sorry`-free
- After Phase 2: SVD exists and `sorry`-free
- After Phase 3: `polar_decomp_exists` is `sorry`-free — **this is the main milestone**
- After Phase 4: Full API including uniqueness

---

## 11. References

1. **Halmos, P.R.** — *A Hilbert Space Problem Book*, Problem 134 (polar decomposition)
2. **Conway, J.B.** — *A Course in Functional Analysis*, Theorem II.3.2
3. **Horn & Johnson** — *Matrix Analysis*, Theorem 7.3.1 (matrix polar decomposition)
4. **Mathlib docs** — `Mathlib.LinearAlgebra.Matrix.Hermitian`, `Mathlib.Analysis.CStarAlgebra.ContinuousFunctionalCalculus`
5. **Lean 4 / Mathlib4** — https://leanprover-community.github.io/mathlib4_docs/
