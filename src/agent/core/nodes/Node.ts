// Standard library imports
// (none needed)

// Third-party imports
// (none needed)

// Local imports
// (none needed)

/**
 * Base class representing a unit of work in the agent pipeline.
 *
 * Implementations can override the lifecycle hooks to participate in the
 * preparation, execution, and post-processing stages. Each hook is optional,
 * allowing subclasses to implement only the stages they need.
 */
export abstract class Node<TPrep = void, TExec = void, TShared = void> {
  /**
   * Prepare any data required before execution.
   */
  protected async prep(shared: TShared): Promise<TPrep> {
    return undefined as TPrep;
  }

  /**
   * Execute the core logic for the node.
   */
  protected abstract exec(
    prepResult: TPrep,
    shared: TShared,
  ): Promise<TExec>;

  /**
   * Perform cleanup or additional processing after execution.
   */
  protected async post(
    execResult: TExec,
    prepResult: TPrep,
    shared: TShared,
  ): Promise<TExec> {
    return execResult;
  }

  /**
   * Run the node through its lifecycle without retries.
   */
  public async run(shared: TShared): Promise<TExec> {
    const prepResult = await this.prep(shared);
    const execResult = await this.exec(prepResult, shared);
    return await this.post(execResult, prepResult, shared);
  }
}
