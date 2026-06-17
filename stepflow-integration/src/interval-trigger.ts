import type { JobTrigger, TriggerHandle } from './trigger';

/**
 * A {@link JobTrigger} that fires every `periodMs` milliseconds. A tick is skipped
 * while a previous run is still in flight (no overlapping runs), and a run that
 * rejects is swallowed so the schedule keeps going. The first run fires one
 * `periodMs` after `start`; `stop` halts further firing.
 */
export function intervalTrigger(periodMs: number): JobTrigger {
  return {
    start(run): Promise<TriggerHandle> {
      let inFlight = false;
      const timer = setInterval(() => {
        if (inFlight) {
          return; // a previous run is still going — skip this tick (no overlap)
        }
        inFlight = true;
        void Promise.resolve()
          .then(run)
          .catch(() => undefined) // swallow run errors so the schedule survives
          .finally(() => {
            inFlight = false;
          });
      }, periodMs);
      return Promise.resolve({
        stop(): Promise<void> {
          clearInterval(timer);
          return Promise.resolve();
        },
      });
    },
  };
}
