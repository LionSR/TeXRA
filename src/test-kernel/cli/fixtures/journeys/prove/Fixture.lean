/-- Doubling a natural number adds it to itself. -/
theorem double_eq_add (n : Nat) : 2 * n = n + n := by
  sorry

/-- The sum of the first `n` odd numbers. -/
def oddSum : Nat → Nat
  | 0 => 0
  | n + 1 => oddSum n + (2 * n + 1)

/-- The first `n` odd numbers add up to `n ^ 2`. -/
theorem oddSum_eq_sq (n : Nat) : oddSum n = n ^ 2 := by
  sorry
