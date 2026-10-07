/** Serializes message processing, including cancellation cleanup before a session change. */
export function createMessageQueue<T>(
  process: (message: T, signal: AbortSignal) => Promise<void>,
  onError: (error: unknown) => void,
) {
  const pending: T[] = [];
  let worker: Promise<void> | undefined;
  let active: AbortController | undefined;

  async function drain(): Promise<void> {
    while (pending.length) {
      const message = pending.shift()!;
      active = new AbortController();
      try { await process(message, active.signal); }
      catch (error) { onError(error); }
      finally { active = undefined; }
    }
  }

  function start(): void {
    if (worker) return;
    // A message can arrive between drain's resolution and this finalizer.
    worker = Promise.resolve().then(drain).finally(() => {
      worker = undefined;
      if (pending.length) start();
    });
  }

  return {
    enqueue(message: T, interrupt = false): void {
      if (interrupt) {
        pending.length = 0;
        active?.abort(new Error('WeChat conversation control requested'));
      }
      pending.push(message);
      // Schedule rather than run inline, so worker is set even for synchronous failures.
      start();
    },
    async settled(): Promise<void> { while (worker) await worker; },
  };
}
