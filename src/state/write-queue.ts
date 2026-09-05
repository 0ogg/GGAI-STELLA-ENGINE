/** 파일별 쓰기 순서와 실패한 최신 저장을 보존한다. 재시도는 최신 공유 모델을 읽는다. */
export class WriteQueue {
  private tails = new Map<string, Promise<void>>();
  private dirty = new Map<string, () => Promise<void>>();

  hasPending(key: string): boolean {
    return this.dirty.has(key) || this.tails.has(key);
  }

  run(key: string, write: () => Promise<void>): Promise<void> {
    this.dirty.set(key, write);
    const previous = this.tails.get(key) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(write).then(() => {
      if (this.dirty.get(key) === write) this.dirty.delete(key);
    });
    this.tails.set(key, task);
    void task.finally(() => {
      if (this.tails.get(key) === task) this.tails.delete(key);
    }).catch(() => undefined);
    return task;
  }

  async retry(key: string): Promise<void> {
    const pending = this.tails.get(key);
    if (pending) await pending.catch(() => undefined);
    const write = this.dirty.get(key);
    if (write) await this.run(key, write);
  }
}
