/** Thrown by `build()` when a job definition is structurally invalid. */
export class JobDefinitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobDefinitionError';
  }
}
