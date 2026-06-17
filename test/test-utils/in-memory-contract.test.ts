import { InMemoryJobRepository } from '@kmgeon/stepflow';
import { describeJobRepositoryContract } from '../../src/test/job-repository-contract';

describeJobRepositoryContract('InMemoryJobRepository', () => new InMemoryJobRepository());
