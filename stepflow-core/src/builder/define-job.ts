import { JobDefinitionError } from '../errors';
import type { RetryPolicy } from '../engine/retry';
import type { ChunkStep, ChunkStepConfig, ExitStatus, JobStep, StepRun } from '../types';

/** A step paired with its 1-based sequence number. */
export interface StepLocation {
  readonly step: JobStep;
  readonly seqNo: number;
}

/** An immutable, validated job definition produced by `defineJob(...).build()`. */
export interface Job {
  readonly name: string;
  readonly steps: readonly JobStep[];
  /** Name of the entry step (the first registered step). */
  readonly entry: string;
  /** Next step for a given step's exit status, or `null` to end the job. */
  next(stepName: string, exitStatus: ExitStatus): string | null;
  /** Look up a step and its sequence number; throws if the step is unknown. */
  stepAt(stepName: string): StepLocation;
  /** Retry policy registered for a step, or `null` if it has none. */
  retryPolicy(stepName: string): RetryPolicy | null;
}

/** Fluent surface for assembling a {@link Job}. */
export interface JobBuilder {
  /** Register a step. The first registered step becomes the entry point. */
  step(name: string, run: StepRun): JobBuilder;
  /** Register a chunk-oriented step (read → process → write in committed chunks). */
  chunkStep<T, R>(name: string, config: ChunkStepConfig<T, R>): JobBuilder;
  /** Override transitions for a step's exit statuses (linear COMPLETED is the default). */
  branch(stepName: string, mapping: Readonly<Record<string, string>>): JobBuilder;
  /** Attach a retry policy to a step. Only thrown errors are retried (not explicit FAILED returns). */
  retry(stepName: string, policy: RetryPolicy): JobBuilder;
  /** Validate the flow graph and produce an immutable {@link Job}. */
  build(): Job;
}

class JobBuilderImpl implements JobBuilder {
  readonly #name: string;
  readonly #steps: JobStep[] = [];
  readonly #branches = new Map<string, Record<string, string>>();
  readonly #retries = new Map<string, RetryPolicy>();

  constructor(name: string) {
    this.#name = name;
  }

  step(name: string, run: StepRun): this {
    this.#steps.push({ name, run });
    return this;
  }

  chunkStep<T, R>(name: string, config: ChunkStepConfig<T, R>): this {
    if (!Number.isInteger(config.chunkSize) || config.chunkSize < 1) {
      throw new JobDefinitionError(
        `Job "${this.#name}" chunk step "${name}" has invalid chunkSize ${String(config.chunkSize)} (must be an integer >= 1)`,
      );
    }
    // The stored form is type-erased; item/result types are preserved only at the
    // call site. Item-type variance prevents a direct cast, so erase via unknown.
    const chunk = {
      name,
      chunkSize: config.chunkSize,
      reader: config.reader,
      ...(config.processor !== undefined ? { processor: config.processor } : {}),
      writer: config.writer,
    } as unknown as ChunkStep;
    this.#steps.push(chunk);
    return this;
  }

  branch(stepName: string, mapping: Readonly<Record<string, string>>): this {
    const existing = this.#branches.get(stepName) ?? {};
    this.#branches.set(stepName, { ...existing, ...mapping });
    return this;
  }

  retry(stepName: string, policy: RetryPolicy): this {
    this.#retries.set(stepName, policy);
    return this;
  }

  build(): Job {
    const [first] = this.#steps;
    if (first === undefined) {
      throw new JobDefinitionError(`Job "${this.#name}" has no steps`);
    }

    const locations = this.#indexSteps();
    const transitions = this.#buildTransitions(locations);
    this.#assertAllReachable(first.name, transitions, locations);

    for (const stepName of this.#retries.keys()) {
      const location = locations.get(stepName);
      if (location === undefined) {
        throw new JobDefinitionError(
          `Job "${this.#name}" sets retry on unknown step "${stepName}"`,
        );
      }
      if ('reader' in location.step) {
        throw new JobDefinitionError(
          `Job "${this.#name}" cannot set retry on chunk step "${stepName}" (chunk steps recover via checkpoint restart)`,
        );
      }
    }

    const name = this.#name;
    const retries = new Map(this.#retries);
    const job: Job = {
      name,
      steps: Object.freeze(this.#steps.slice()),
      entry: first.name,
      next(stepName: string, exitStatus: ExitStatus): string | null {
        return transitions.get(stepName)?.get(exitStatus) ?? null;
      },
      stepAt(stepName: string): StepLocation {
        const location = locations.get(stepName);
        if (location === undefined) {
          throw new JobDefinitionError(`Job "${name}" has no step "${stepName}"`);
        }
        return location;
      },
      retryPolicy(stepName: string): RetryPolicy | null {
        return retries.get(stepName) ?? null;
      },
    };
    return Object.freeze(job);
  }

  #indexSteps(): Map<string, StepLocation> {
    const locations = new Map<string, StepLocation>();
    this.#steps.forEach((step, index) => {
      if (locations.has(step.name)) {
        throw new JobDefinitionError(`Job "${this.#name}" has a duplicate step "${step.name}"`);
      }
      locations.set(step.name, { step, seqNo: index + 1 });
    });
    return locations;
  }

  #buildTransitions(locations: Map<string, StepLocation>): Map<string, Map<string, string>> {
    for (const [source, mapping] of this.#branches) {
      if (!locations.has(source)) {
        throw new JobDefinitionError(`Job "${this.#name}" branches on unknown step "${source}"`);
      }
      for (const [exitStatus, target] of Object.entries(mapping)) {
        if (!locations.has(target)) {
          throw new JobDefinitionError(
            `Job "${this.#name}" branch "${source}"/"${exitStatus}" targets unknown step "${target}"`,
          );
        }
      }
    }

    const transitions = new Map<string, Map<string, string>>();
    this.#steps.forEach((step, index) => {
      const outgoing = new Map<string, string>();
      const nextStep = this.#steps[index + 1];
      if (nextStep !== undefined) {
        outgoing.set('COMPLETED', nextStep.name);
      }
      const branch = this.#branches.get(step.name);
      if (branch !== undefined) {
        for (const [exitStatus, target] of Object.entries(branch)) {
          outgoing.set(exitStatus, target);
        }
      }
      transitions.set(step.name, outgoing);
    });
    return transitions;
  }

  #assertAllReachable(
    entry: string,
    transitions: Map<string, Map<string, string>>,
    locations: Map<string, StepLocation>,
  ): void {
    const reachable = new Set<string>([entry]);
    // BFS over a growing work-list; for-of reflects pushes made during iteration.
    const worklist: string[] = [entry];
    for (const current of worklist) {
      const outgoing = transitions.get(current);
      if (outgoing === undefined) continue;
      for (const target of outgoing.values()) {
        if (!reachable.has(target)) {
          reachable.add(target);
          worklist.push(target);
        }
      }
    }
    for (const name of locations.keys()) {
      if (!reachable.has(name)) {
        throw new JobDefinitionError(`Job "${this.#name}" step "${name}" is unreachable`);
      }
    }
  }
}

/** Begin defining a job. Chain `.step()` / `.branch()`, then `.build()`. */
export function defineJob(name: string): JobBuilder {
  return new JobBuilderImpl(name);
}

export { JobDefinitionError };
