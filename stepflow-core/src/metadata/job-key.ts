import { createHash } from 'node:crypto';

import type { JobParameters } from '../types';

/**
 * Compute the stable instance key for a job run.
 *
 * The key is a SHA-256 digest over the job name and its identifying parameters
 * (in v0.1 every supplied parameter is identifying). Parameter order does not
 * affect the result; differing names, values, or key presence do.
 *
 * Equal keys mean "the same JobInstance" — executions accumulate under it and a
 * failed run can be restarted. An empty parameter set yields one instance per
 * job name.
 */
export function computeJobKey(jobName: string, params: JobParameters): string {
  const entries = Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonical = JSON.stringify([jobName, entries]);
  return createHash('sha256').update(canonical).digest('hex');
}
