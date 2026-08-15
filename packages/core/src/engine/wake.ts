/**
 * Coordinates push wakeups with the worker's idle sleeps. A wake that arrives while
 * no loop is sleeping is remembered (coalesced into one pending flag) so the next
 * sleep returns immediately - this closes the race where a store notification lands
 * between a null claim and the loop registering its waiter.
 */
export class WakeController {
  #pending = false;
  #waiters: Array<() => void> = [];

  /** Wake every sleeping loop now; if none is sleeping, remember one pending wake. */
  wakeAll(): void {
    if (this.#waiters.length === 0) {
      this.#pending = true;
      return;
    }
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const w of waiters) w();
  }

  /**
   * Sleep for `ms` using the injected sleeper, but resolve early on wakeAll().
   * Returns true when woken early (or when a pending wake was waiting), false when
   * the full interval elapsed.
   */
  async sleep(ms: number, sleeper: (ms: number) => Promise<void>): Promise<boolean> {
    if (this.#pending) {
      this.#pending = false;
      return true;
    }
    let woken = false;
    let wake!: () => void;
    const wakePromise = new Promise<void>((resolve) => {
      wake = () => {
        woken = true;
        resolve();
      };
    });
    this.#waiters.push(wake);
    try {
      await Promise.race([sleeper(ms).catch(() => {}), wakePromise]);
    } finally {
      const i = this.#waiters.indexOf(wake);
      if (i !== -1) this.#waiters.splice(i, 1);
    }
    return woken;
  }
}
