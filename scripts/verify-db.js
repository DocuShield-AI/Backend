const { Client } = require('pg');
require('dotenv').config();

const expectedTables = [
  'workspaces',
  'users',
  'subscriptions',
  'contracts',
  'ingestion_jobs',
  'clauses',
  'risk_flags',
  'notification_logs',
  'audit_logs',
  'rag_query_cache',
];

async function main() {
  const client = new Client({ connectionString: process.env.DIRECT_URL });
  await client.connect();

  const tablesRes = await client.query(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`,
  );
  const existing = new Set(tablesRes.rows.map((r) => r.tablename));

  console.log('=== TABLES (10 expected) ===');
  let allPresent = true;
  for (const t of expectedTables) {
    const ok = existing.has(t);
    if (!ok) allPresent = false;
    console.log(`  ${ok ? 'OK ' : 'MISSING'} ${t}`);
  }
  console.log(allPresent ? '\nAll 10 tables present.\n' : '\n!!! Some tables missing.\n');

  // pgvector extension + embedding column type
  const ext = await client.query(
    `SELECT extname FROM pg_extension WHERE extname = 'vector'`,
  );
  console.log('=== pgvector extension ===');
  console.log(`  vector extension enabled: ${ext.rowCount > 0}`);

  const col = await client.query(
    `SELECT format_type(a.atttypid, a.atttypmod) AS full_type, t.typname AS type_name
     FROM pg_attribute a
     JOIN pg_type t ON t.oid = a.atttypid
     WHERE a.attrelid = 'clauses'::regclass AND a.attname = 'embedding'`,
  );
  console.log('\n=== clauses.embedding column ===');
  if (col.rows[0]) {
    console.log(`  full type: ${col.rows[0].full_type}`);
    console.log(`  type name: ${col.rows[0].type_name}`);
    const match = /^vector\((\d+)\)$/.exec(col.rows[0].full_type);
    if (match && match[1] === '768') {
      console.log('  ✓ vector(768) verified\n');
    } else {
      console.log(`  ! Expected vector(768)\n`);
    }
  } else {
    console.log('  ! embedding column not found\n');
  }

  // Compound unique constraints (Prisma implements @@unique as unique indexes)
  console.log('=== Compound unique constraints ===');
  const uniq = [
    { table: 'contracts', cols: ['workspace_id', 'file_hash'] },
    { table: 'rag_query_cache', cols: ['contract_id', 'normalized_question'] },
  ];
  for (const u of uniq) {
    const res = await client.query(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename = $1`,
      [u.table],
    );
    const found = res.rows.find((r) => r.indexdef.includes(`(${u.cols.join(', ')})`));
    console.log(`  ${u.table} (${u.cols.join(', ')}) ${found ? '✓ present' : '✗ MISSING'}: ${found ? found.indexname : ''}`);
  }

  await client.end();
}

main().catch((e) => {
  console.error('Verification failed:', e.message);
  process.exit(1);
});
