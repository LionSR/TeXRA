/**
 * The goal: "Run as Goal" runs a background script of the conversation
 * that approved the plan, and that script only calls a strategy, the `goal`
 * export of the script module `goal.strategy` names. The strategy decides
 * the rounds, what context each starts from and when to stop, and resolves
 * to the goal's result (`GoalResultSchema`). The default strategy is the
 * goal plugin's own module, `builtIn:goal` (`goal.js`); a plugin replaces it
 * by shipping another module and naming it in the setting, and a script may
 * call any of them itself, or import the module's `judge` to check work its
 * own way.
 */

/**
 * The goal's script: the `goal` export of the module `strategy` names, on
 * `objective` with the cap `maxCostUsd`. What it resolves to is the
 * script's return, so the goal's run ends with it as its structured output.
 */
export const goalScript = (
  strategy: string,
  objective: string,
  maxCostUsd: number,
): string =>
  `const { goal } = await import(${JSON.stringify(strategy)});
return await goal(${JSON.stringify(objective)}, { maxCostUsd: ${JSON.stringify(maxCostUsd)} });`;
