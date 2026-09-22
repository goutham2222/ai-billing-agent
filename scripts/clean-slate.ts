import { Client } from 'pg';
import { supabase } from '../src/lib/supabase.js';
import { env } from '../src/config/env.js';

/**
 * Normalizes PostgreSQL connection string by handling bracketed passwords
 * and properly encoding special URI characters.
 */
function normalizeDatabaseUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.password) {
      let pw = decodeURIComponent(parsed.password);
      if (pw.startsWith('[') && pw.endsWith(']')) {
        pw = pw.slice(1, -1);
      }
      parsed.password = encodeURIComponent(pw);
    }
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

/**
 * Recursively lists all file paths in a Supabase Storage bucket.
 */
async function listAllFiles(bucketName: string, folder = ''): Promise<string[]> {
  const { data, error } = await supabase.storage.from(bucketName).list(folder, {
    limit: 100,
    sortBy: { column: 'name', order: 'asc' },
  });

  if (error || !data) {
    return [];
  }

  let filePaths: string[] = [];
  for (const item of data) {
    const itemPath = folder ? `${folder}/${item.name}` : item.name;
    // Objects with an id or with metadata are files; items without metadata/id are folder placeholders
    if (item.id || item.metadata) {
      filePaths.push(itemPath);
    } else {
      const nestedFiles = await listAllFiles(bucketName, itemPath);
      filePaths = filePaths.concat(nestedFiles);
    }
  }

  return filePaths;
}

/**
 * Empties all files from a Supabase Storage bucket.
 */
async function emptyStorageBucket(bucketName: string): Promise<number> {
  const allFiles = await listAllFiles(bucketName);
  if (allFiles.length === 0) {
    return 0;
  }

  // Remove files in chunks of 50
  let deletedCount = 0;
  for (let i = 0; i < allFiles.length; i += 50) {
    const chunk = allFiles.slice(i, i + 50);
    const { error } = await supabase.storage.from(bucketName).remove(chunk);
    if (error) {
      console.warn(`  ⚠️ Failed to delete chunk in bucket '${bucketName}':`, error.message);
    } else {
      deletedCount += chunk.length;
    }
  }

  return deletedCount;
}

async function cleanSlate(): Promise<void> {
  console.log('====================================================');
  console.log('🧹 SUPABASE CLEAN-SLATE RESET UTILITY');
  console.log('====================================================\n');

  // ----------------------------------------------------
  // Step 1: Reset Database Tables
  // ----------------------------------------------------
  console.log('📦 Step 1: Clearing Database Tables & Sequences...');

  let directPgSuccess = false;
  if (env.READONLY_DATABASE_URL) {
    const connectionString = normalizeDatabaseUrl(env.READONLY_DATABASE_URL);
    const client = new Client({
      connectionString,
      ssl: { rejectUnauthorized: false },
    });

    try {
      await client.connect();
      console.log('  🔗 Connected directly via PostgreSQL client.');

      // Truncate respecting foreign key relationships and restart sequences
      await client.query(`
        TRUNCATE TABLE pending_actions, bills, customers RESTART IDENTITY CASCADE;
      `);
      console.log('  ✅ Executed: TRUNCATE TABLE pending_actions, bills, customers RESTART IDENTITY CASCADE;');

      // Reset sequence explicitly if exists
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE c.relkind = 'S' AND c.relname = 'bills_bill_no_seq'
          ) THEN
            ALTER SEQUENCE bills_bill_no_seq RESTART WITH 1;
          END IF;
        END $$;
      `);
      console.log('  ✅ Sequence bills_bill_no_seq restarted from 1.');

      directPgSuccess = true;
    } catch (pgErr: unknown) {
      const msg = pgErr instanceof Error ? pgErr.message : String(pgErr);
      console.warn(`  ⚠️ Direct PG query failed: ${msg}. Falling back to Supabase client delete.`);
    } finally {
      await client.end().catch(() => {});
    }
  }

  if (!directPgSuccess) {
    console.log('  🔄 Clearing via Supabase Admin Client...');
    // 1. Clear pending_actions
    const { error: paErr } = await supabase
      .from('pending_actions')
      .delete()
      .neq('status', '__never_match__');
    if (paErr) console.warn('  ⚠️ Failed to clear pending_actions:', paErr.message);
    else console.log('  ✅ Cleared pending_actions table.');

    // 2. Clear bills (references customers)
    const { error: billsErr } = await supabase
      .from('bills')
      .delete()
      .neq('payment_status', '__never_match__');
    if (billsErr) console.warn('  ⚠️ Failed to clear bills:', billsErr.message);
    else console.log('  ✅ Cleared bills table.');

    // 3. Clear customers
    const { error: custErr } = await supabase
      .from('customers')
      .delete()
      .neq('name', '__never_match__');
    if (custErr) console.warn('  ⚠️ Failed to clear customers:', custErr.message);
    else console.log('  ✅ Cleared customers table.');
  }

  // ----------------------------------------------------
  // Step 2: Reset Supabase Storage Buckets
  // ----------------------------------------------------
  console.log('\n🗂️ Step 2: Emptying Supabase Storage Buckets...');

  const { data: existingBuckets, error: listBucketsErr } = await supabase.storage.listBuckets();
  if (listBucketsErr) {
    console.warn('  ⚠️ Could not fetch list of storage buckets:', listBucketsErr.message);
  }

  const existingBucketNames = new Set((existingBuckets || []).map((b) => b.name));

  // Buckets to check and clean: 'bills', 'invoices', and env.SUPABASE_STORAGE_BUCKET ('billing-media')
  const targetBuckets = Array.from(
    new Set(['bills', 'invoices', env.SUPABASE_STORAGE_BUCKET].filter(Boolean))
  );

  for (const bucketName of targetBuckets) {
    if (!existingBucketNames.has(bucketName)) {
      console.log(`  ℹ️ Bucket '${bucketName}' does not exist on Supabase Storage. Skipping.`);
      continue;
    }

    try {
      const removedCount = await emptyStorageBucket(bucketName);
      console.log(`  ✅ Emptied bucket '${bucketName}': ${removedCount} file(s) removed.`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`  ⚠️ Error clearing bucket '${bucketName}': ${msg}`);
    }
  }

  console.log('\n====================================================');
  console.log('✨ Clean-slate complete! Environment is ready for fresh testing.');
  console.log('====================================================\n');
}

cleanSlate().catch((err) => {
  console.error('❌ Clean-slate execution failed:', err);
  process.exit(1);
});

