import { InMemoryJobRepository } from '@kmgeon/stepflow-core';
import { describeJobRepositoryContract } from '../src/job-repository-contract';

describeJobRepositoryContract('InMemoryJobRepository', () => new InMemoryJobRepository());
