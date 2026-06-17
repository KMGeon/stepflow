import { readFileSync } from 'node:fs';

import mysql from 'mysql2/promise';
import type { Pool } from 'mysql2/promise';
import { afterAll, beforeAll, describe } from 'vitest';

import { MySqlJobRepository } from '../../src/infrastructure/mysql';
import { describeJobRepositoryContract } from '@kmgeon/stepflow/test';

const url = process.env.MYSQL_URL;
const pool: Pool | undefined = url ? mysql.createPool({ uri: url, connectionLimit: 4 }) : undefined;

const TABLES = [
  'execution_context',
  'job_execution_params',
  'step_execution',
  'job_execution',
  'job_instance',
];

async function applySchema(p: Pool): Promise<void> {
  const sql = readFileSync(new URL('../../src/infrastructure/schema.sql', import.meta.url), 'utf8');
  const statements = sql
    .replace(/--[^\n]*/g, '') // strip line comments (they may contain semicolons)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const statement of statements) {
    await p.query(statement);
  }
}

async function truncateAll(p: Pool): Promise<void> {
  const conn = await p.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const table of TABLES) {
      await conn.query(`TRUNCATE TABLE ${table}`);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    conn.release();
  }
}

describe.skipIf(!url)('MySqlJobRepository (integration, opt-in via MYSQL_URL)', () => {
  beforeAll(async () => {
    if (!pool) throw new Error('pool is required when MYSQL_URL is set');
    await applySchema(pool);
  });

  afterAll(async () => {
    if (pool) await pool.end();
  });

  describeJobRepositoryContract('MySqlJobRepository', async () => {
    if (!pool) throw new Error('pool is required when MYSQL_URL is set');
    await truncateAll(pool);
    return new MySqlJobRepository(pool);
  });
});
