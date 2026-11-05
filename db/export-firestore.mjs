// export-firestore.mjs — copies Firestore collections to local JSON, ready for
// db/migrate-to-supabase.mjs. Read-only against Firebase.
//
//   node db/export-firestore.mjs --project ucvm-timetable-staging
//   node db/export-firestore.mjs --project ucvm-timetable-staging --key C:\secure\staging.json
//
// Without --key only the publicly readable collections are reachable. With a
// service-account key, all ten are, and the key must belong to --project.
// Output goes to db/export/<project>/, which is git-ignored and holds real
// names, emails and student UCIDs.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECTS = {
  'ucvm-timetable-staging': 'AIzaSyBaUh041muZ0fPKOBZDTn1rLkQXjgWKP98',
  'timetable-23438': 'AIzaSyBqLdbPBn2V8tPSlJ8Q2LEmBKy1o7FtEa0',
};
const PUBLIC_COLLECTIONS = ['sessions', 'sessions_history', 'change_log', 'roster', 'settings'];
const PRIVATE_COLLECTIONS = ['users', 'authorized_users', 'access_requests', 'change_requests', 'admin_audit_log'];

const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const project = option('--project');
const keyPath = option('--key');
if (!PROJECTS[project]) {
  console.error(`--project is required: ${Object.keys(PROJECTS).join(' or ')}`);
  process.exit(1);
}

function decodeRestValue(v) {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return { __ts: v.timestampValue };
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decodeRestValue);
  if ('mapValue' in v) return decodeRestFields(v.mapValue.fields || {});
  throw new Error(`Unsupported Firestore value: ${Object.keys(v)[0]}`);
}
function decodeRestFields(fields) {
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, decodeRestValue(v)]));
}

async function readPublic(collection) {
  const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/${collection}`;
  const docs = [];
  let pageToken = '';
  do {
    const url = `${base}?pageSize=300&key=${PROJECTS[project]}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${collection}: HTTP ${res.status}`);
    const body = await res.json();
    (body.documents || []).forEach(d => docs.push({ id: d.name.split('/').pop(), data: decodeRestFields(d.fields || {}) }));
    pageToken = body.nextPageToken || '';
  } while (pageToken);
  return docs;
}

async function adminReader() {
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore, Timestamp } = await import('firebase-admin/firestore');
  const account = JSON.parse(fs.readFileSync(keyPath, 'utf8').replace(/^\uFEFF/, ''));
  if (account.project_id !== project) throw new Error(`Key belongs to ${account.project_id}, expected ${project}.`);
  const db = getFirestore(initializeApp({ credential: cert(account), projectId: project }));
  const plain = v => {
    if (v instanceof Timestamp) return { __ts: v.toDate().toISOString() };
    if (Array.isArray(v)) return v.map(plain);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
    return v;
  };
  return async collection => (await db.collection(collection).get()).docs.map(d => ({ id: d.id, data: plain(d.data()) }));
}

const outDir = path.join(HERE, 'export', project);
fs.mkdirSync(outDir, { recursive: true });
const read = keyPath ? await adminReader() : readPublic;
const collections = keyPath ? [...PUBLIC_COLLECTIONS, ...PRIVATE_COLLECTIONS] : PUBLIC_COLLECTIONS;
if (!keyPath) console.log(`No --key: skipping ${PRIVATE_COLLECTIONS.join(', ')}.`);
for (const collection of collections) {
  const docs = await read(collection);
  fs.writeFileSync(path.join(outDir, `${collection}.json`), JSON.stringify(docs));
  console.log(`${collection.padEnd(18)} ${docs.length}`);
}
console.log(`Saved to ${path.relative(process.cwd(), outDir)}`);
