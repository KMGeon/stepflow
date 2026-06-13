import { JobDefinitionError } from './errors';
import type { ExitStatus, Step, StepRun } from './types';

/** A step paired with its 1-based sequence number. */
export interface StepLocation {
  readonly step: Step;
  readonly seqNo: number;
}

/** An immutable, validated job definition produced by `defineJob(...).build()`. */
export interface Job {
  readonly name: string;
  readonly steps: readonly Step[];
  /** Name of the entry step (the first registered step). */
  readonly entry: string;
  /** Next step for a given step's exit status, or `null` to end the job. */
  next(stepName: string, exitStatus: ExitStatus): string | null;
  /** Look up a step and its sequence number; throws if the step is unknown. */
  stepAt(stepName: string): StepLocation;
}

/** Fluent surface for assembling a {@link Job}. */
export interface JobBuilder {
  /** Register a step. The first registered step becomes the entry point. */
  step(name: string, run: StepRun): JobBuilder;
  /** Override transitions for a step's exit statuses (linear COMPLETED is the default). */
  branch(stepName: string, mapping: Readonly<Record<string, string>>): JobBuilder;
  /** Validate the flow graph and produce an immutable {@link Job}. */
  build(): Job;
}

class JobBuilderImpl implements JobBuilder {
  readonly #name: string;
  readonly #steps: Step[] = [];
  readonly #branches = new Map<string, Record<string, string>>();

  constructor(name: string) {
    this.#name = name;
  }

  step(name: string, run: StepRun): this {
    this.#steps.push({ name, run });
    return this;
  }

  branch(stepName: string, mapping: Readonly<Record<string, string>>): this {
    const existing = this.#branches.get(stepName) ?? {};
    this.#branches.set(stepName, { ...existing, ...mapping });
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

    const name = this.#name;
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
