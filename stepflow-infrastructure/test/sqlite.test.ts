import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { describe } from 'vitest';

import { SqliteJobRepository } from '../src/sqlite';
import { describeJobRepositoryContract } from '@stepflow/test';

const schema = readFileSync(new URL('../src/schema.sqlite.sql', import.meta.url), 'utf8');

// In-memory: no infra, no env gate — runs on every CI invocation.
describe('SqliteJobRepository (in-memory)', () => {
  describeJobRepositoryContract('SqliteJobRepository', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(schema);
    return new SqliteJobRepository(db);
  });
});
