// migrate-to-supabase.mjs — loads a db/export-firestore.mjs export into Supabase,
// then reads every document back through the app's mapping and compares it with
// the original, field by field.
//
//   node db/migrate-to-supabase.mjs --project ucvm-timetable-staging --dry-run
//   node db/migrate-to-supabase.mjs --project ucvm-timetable-staging --apply --confirm-target ucvm-timetable-staging
//   node db/migrate-to-supabase.mjs --project ucvm-timetable-staging --verify-only
//
// users is skipped: its ids are Firebase Auth ids, and staging accounts are
// separate, so testers sign up again.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAdminDb, compat } from '../scripts/supabase-admin.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COLLECTIONS = ['sessions', 'sessions_history', 'change_log', 'roster', 'settings',
  'authorized_users', 'access_requests', 'change_requests', 'admin_audit_log'];
const BATCH_SIZE = 200;

export function canonical(value) {
  if (value && typeof value.toMillis === 'function') return { __ms: value.toMillis() };
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  }
  return value;
}

export function loadExport(project) {
  const dir = path.join(HERE, 'export', project);
  const out = {};
  for (const collection of COLLECTIONS) {
    const file = path.join(dir, `${collection}.json`);
    if (!fs.existsSync(file)) continue;
    out[collection] = JSON.parse(fs.readFileSync(file, 'utf8')).map(d => ({ id: d.id, data: compat.decodeJson(d.data) }));
  }
  return out;
}

export async function load(db, data) {
  for (const [collection, docs] of Object.entries(data)) {
    for (let i = 0; i < docs.length; i += BATCH_SIZE) {
      const batch = db.batch();
      docs.slice(i, i + BATCH_SIZE).forEach(d => batch.set(db.collection(collection).doc(d.id), d.data));
      await batch.commit();
    }
    console.log(`loaded ${collection.padEnd(18)} ${docs.length}`);
  }
}

export async function verify(db, data) {
  const problems = [];
  for (const [collection, docs] of Object.entries(data)) {
    const snap = await db.collection(collection).get();
    const actual = new Map(snap.docs.map(d => [d.id, d.data()]));
    if (actual.size !== docs.length) problems.push(`${collection}: ${docs.length} exported, ${actual.size} in Supabase`);
    for (const { id, data: expected } of docs) {
      const a = JSON.stringify(canonical(expected));
      const b = JSON.stringify(canonical(actual.get(id)));
      if (a !== b) problems.push(`${collection}/${id} differs`);
    }
    console.log(`checked ${collection.padEnd(18)} ${docs.length}`);
  }
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const project = option('--project');
  if (!project) throw new Error('--project is required.');
  const data = loadExport(project);
  if (!Object.keys(data).length) throw new Error(`No export found for ${project}. Run db/export-firestore.mjs first.`);
  for (const [collection, docs] of Object.entries(data)) console.log(`${collection.padEnd(18)} ${docs.length}`);

  const apply = args.includes('--apply');
  if (!apply && !args.includes('--verify-only')) { console.log('Dry run: nothing written.'); return; }
  if (apply && option('--confirm-target') !== project) throw new Error(`--confirm-target ${project} is required.`);

  const { db } = createAdminDb();
  if (apply) await load(db, data);
  const problems = await verify(db, data);
  problems.slice(0, 20).forEach(p => console.error(p));
  console.log(problems.length ? `${problems.length} problem(s) found.` : 'Every document matches its Firestore original.');
  if (problems.length) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error(err.message || err); process.exitCode = 1; });
}
