// Server-side access to Supabase for the operations scripts. Returns the same
// db interface the app uses, so documents go through the same mapping as the
// browser. The secret key bypasses row-level security: it comes from the
// environment or a git-ignored .env.supabase, never from source.
import { existsSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import '../supabase-compat.js';

const compat = globalThis.SupabaseCompat;

export function loadSupabaseEnv() {
  if (existsSync('.env.supabase')) process.loadEnvFile('.env.supabase');
  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY must be set (see .env.supabase).');
  return { url, secretKey };
}

export function createAdminDb() {
  const { url, secretKey } = loadSupabaseEnv();
  const client = createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return { db: compat.createFirestore(client, {}), serverTimestamp: () => compat.SERVER_TS_SENTINEL };
}

export { compat };
