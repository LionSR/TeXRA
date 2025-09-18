export abstract class Node<TPrep = void, TExec = void, TShared = void> {
  protected async prep(_shared: TShared): Promise<TPrep> {
    return undefined as TPrep;
  }

  protected async exec(_prepResult: TPrep, _shared: TShared): Promise<TExec> {
    return undefined as TExec;
  }

  protected async post(
    execResult: TExec,
    _prepResult: TPrep,
    _shared: TShared,
  ): Promise<TExec> {
    return execResult;
  }

  public async run(shared: TShared): Promise<TExec> {
    const prepResult = await this.prep(shared);
    const execResult = await this.exec(prepResult, shared);
    return this.post(execResult, prepResult, shared);
  }
}
