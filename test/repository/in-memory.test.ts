import { InMemoryJobRepository } from '../../src/repository/in-memory';
import { describeJobRepositoryContract } from '../contract/job-repository.contract';

describeJobRepositoryContract('InMemoryJobRepository', () => new InMemoryJobRepository());
