import { readFile } from 'node:fs/promises';
import { initializeApp, cert, deleteApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const TARGET_PROJECT = 'ucvm-timetable-staging';
const VALID_ROLES = new Set(['cc', 'instructor', 'adfad', 'dvm_office', 'adc']);
const args = process.argv.slice(2);
const valueAfter = name => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const file = valueAfter('--file');
const apply = args.includes('--apply');
const confirmation = valueAfter('--confirm-target');

function fail(message) { throw new Error(message); }
function normalizeUsers(input) {
  const users = Array.isArray(input) ? input : input.users;
  if (!Array.isArray(users) || !users.length) fail('Allowlist file must contain a non-empty array or { "users": [...] }.');
  const seen = new Set();
  return users.map((user, index) => {
    const email = String(user.email || '').trim().toLowerCase();
    const name = String(user.name || '').trim();
    const role = String(user.role || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email) || !name || !VALID_ROLES.has(role)) fail(`Invalid user at index ${index}.`);
    if (seen.has(email)) fail(`Duplicate email: ${email}.`);
    seen.add(email);
    return { email, name, role };
  });
}

async function main() {
  if (!file) fail('Usage: npm run staging:allowlist -- --file C:\\secure\\staging-users.json [--apply --confirm-target ucvm-timetable-staging]');
  const users = normalizeUsers(JSON.parse(await readFile(file, 'utf8')));
  console.table(users);
  if (!apply) { console.log('Dry run complete. Re-run with --apply --confirm-target ucvm-timetable-staging to write staging only.'); return; }
  if (confirmation !== TARGET_PROJECT) fail(`--confirm-target ${TARGET_PROJECT} is required.`);
  const credentialPath = process.env.TIMETABLE_STAGING_SERVICE_ACCOUNT;
  if (!credentialPath) fail('TIMETABLE_STAGING_SERVICE_ACCOUNT must point to a staging service-account JSON file.');
  const account = JSON.parse(await readFile(credentialPath, 'utf8'));
  if (account.project_id !== TARGET_PROJECT) fail(`Credential project must be ${TARGET_PROJECT}.`);
  const app = initializeApp({ credential: cert(account), projectId: TARGET_PROJECT }, 'staging-allowlist');
  const db = getFirestore(app);
  try {
    for (let index = 0; index < users.length; index += 400) {
      const batch = db.batch();
      for (const user of users.slice(index, index + 400)) {
        batch.set(db.collection('authorized_users').doc(user.email), {
          ...user, importedAt: FieldValue.serverTimestamp(), importedBy: 'staging-bootstrap'
        }, { merge: true });
      }
      await batch.commit();
    }
    console.log(`Seeded ${users.length} staging allowlist entries. No Firebase Auth users were created.`);
  } finally {
    await deleteApp(app);
  }
}

main().catch(error => { console.error(`Allowlist bootstrap failed: ${error.message}`); process.exitCode = 1; });
