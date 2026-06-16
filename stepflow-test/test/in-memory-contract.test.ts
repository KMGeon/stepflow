import { InMemoryJobRepository } from '@stepflow/core';
import { describeJobRepositoryContract } from '../src/job-repository-contract';

describeJobRepositoryContract('InMemoryJobRepository', () => new InMemoryJobRepository());
