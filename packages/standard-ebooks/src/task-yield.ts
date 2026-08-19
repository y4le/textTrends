/**
 * Yield the current task back to the host's event loop so long CPU-bound work
 * (for example ZIP assembly) cannot starve rendering, I/O, or abort delivery.
 * `setTimeout(0)` schedules a real macrotask in both browsers and Node; the
 * resolved-promise fallback keeps the helper functional on hosts without
 * timers. Lives in its own module so tests can observe yields without reaching
 * into archive internals.
 */
export function yieldToEventLoop(): Promise<void> {
  if (typeof setTimeout === 'function') {
    return new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
  return Promise.resolve();
}
