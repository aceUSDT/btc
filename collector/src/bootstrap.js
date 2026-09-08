import fs from 'node:fs/promises';
import { createClient } from '@clickhouse/client';

if (!process.env.CLICKHOUSE_URL) throw new Error('CLICKHOUSE_URL is required');

const client = createClient({
  url: process.env.CLICKHOUSE_URL,
  username: process.env.CLICKHOUSE_USER || 'default',
  password: process.env.CLICKHOUSE_PASSWORD || '',
  database: 'default',
  request_timeout: Number(process.env.CLICKHOUSE_BOOTSTRAP_TIMEOUT_MS || 180000)
});

const sql = await fs.readFile(new URL('../clickhouse/init.sql', import.meta.url), 'utf8');
const statements = sql
  .split(/;\s*(?:\n|$)/g)
  .map(s => s.trim())
  .filter(Boolean);

for (const query of statements) await client.command({ query });
await client.close();
console.log(`ClickHouse bootstrap complete: ${statements.length} statements`);
