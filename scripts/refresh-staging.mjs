import { readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { initializeApp, cert, deleteApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp, GeoPoint } from 'firebase-admin/firestore';

const SOURCE_PROJECT = 'timetable-23438';
const TARGET_PROJECT = 'ucvm-timetable-staging';
const MIRROR_COLLECTIONS = ['sessions', 'roster'];
const CLEAR_COLLECTIONS = ['sessions_history', 'change_log', 'change_requests', 'access_requests', 'admin_audit_log'];
const BATCH_SIZE = 400;

function option(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
const apply = process.argv.includes('--apply');
const dryRun = process.argv.includes('--dry-run') || !apply;
const confirmation = option('--confirm-target');

function usage(message) {
  if (message) console.error(`\nError: ${message}`);
  console.error('Usage: npm run staging:refresh -- --dry-run');
  console.error('   or: npm run staging:refresh -- --apply --confirm-target ucvm-timetable-staging');
  process.exitCode = 1;
}

function loadCredential(envName, expectedProject) {
  const credentialPath = process.env[envName];
  if (!credentialPath) throw new Error(`${envName} must point to a service-account JSON file.`);
  return readFile(credentialPath, 'utf8').then(text => {
    const serviceAccount = JSON.parse(text);
    if (serviceAccount.project_id !== expectedProject) {
      throw new Error(`${envName} belongs to ${serviceAccount.project_id || 'an unknown project'}, expected ${expectedProject}.`);
    }
    return serviceAccount;
  });
}

function encode(value) {
  if (value instanceof Timestamp) return { __type: 'timestamp', seconds: value.seconds, nanoseconds: value.nanoseconds };
  if (value instanceof GeoPoint) return { __type: 'geoPoint', latitude: value.latitude, longitude: value.longitude };
  if (Buffer.isBuffer(value)) return { __type: 'buffer', base64: value.toString('base64') };
  if (value && typeof value.path === 'string' && value.firestore) return { __type: 'reference', path: value.path };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  return value;
}

function decode(value, db) {
  if (Array.isArray(value)) return value.map(item => decode(item, db));
  if (!value || typeof value !== 'object') return value;
  if (value.__type === 'timestamp') return new Timestamp(value.seconds, value.nanoseconds);
  if (value.__type === 'geoPoint') return new GeoPoint(value.latitude, value.longitude);
  if (value.__type === 'buffer') return Buffer.from(value.base64, 'base64');
  if (value.__type === 'reference') return db.doc(value.path);
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decode(item, db)]));
}

function cloneForTarget(value, targetDb) {
  // Firestore references, if any are introduced later, must point to staging
  // after a copy rather than carrying a reference to production.
  return decode(encode(value), targetDb);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function comparable(value) {
  return JSON.stringify(canonicalize(encode(value)));
}

async function readCollection(db, name) {
  const snapshot = await db.collection(name).get();
  return new Map(snapshot.docs.map(doc => [doc.id, doc.data()]));
}

async function readSelected(db) {
  const collections = {};
  for (const collection of [...MIRROR_COLLECTIONS, ...CLEAR_COLLECTIONS]) {
    collections[collection] = Object.fromEntries((await readCollection(db, collection)).entries());
  }
  const rosterNotice = await db.collection('settings').doc('rosterNotice').get();
  return { collections, rosterNotice: rosterNotice.exists ? rosterNotice.data() : null };
}

function counts(selected) {
  return Object.fromEntries(Object.entries(selected.collections).map(([name, docs]) => [name, Object.keys(docs).length]));
}

async function commitOperations(db, operations) {
  for (let index = 0; index < operations.length; index += BATCH_SIZE) {
    const batch = db.batch();
    for (const operation of operations.slice(index, index + BATCH_SIZE)) {
      if (operation.type === 'delete') batch.delete(operation.ref);
      else batch.set(operation.ref, operation.data);
    }
    await batch.commit();
  }
}

function mirrorOperations(db, collection, sourceDocs, targetDocs) {
  const operations = [];
  for (const [id, sourceData] of Object.entries(sourceDocs)) {
    const targetData = targetDocs[id];
    const prepared = cloneForTarget(sourceData, db);
    if (!targetData || comparable(prepared) !== comparable(targetData)) {
      operations.push({ type: 'set', ref: db.collection(collection).doc(id), data: prepared });
    }
  }
  for (const id of Object.keys(targetDocs)) {
    if (!(id in sourceDocs)) operations.push({ type: 'delete', ref: db.collection(collection).doc(id) });
  }
  return operations;
}

function clearOperations(db, collection, targetDocs) {
  return Object.keys(targetDocs).map(id => ({ type: 'delete', ref: db.collection(collection).doc(id) }));
}

async function assertSelectedMatches(db, source) {
  const target = await readSelected(db);
  for (const collection of MIRROR_COLLECTIONS) {
    if (comparable(source.collections[collection]) !== comparable(target.collections[collection])) {
      throw new Error(`Verification failed: staging ${collection} does not match production.`);
    }
  }
  if (comparable(source.rosterNotice) !== comparable(target.rosterNotice)) {
    throw new Error('Verification failed: staging settings/rosterNotice does not match production.');
  }
  for (const collection of CLEAR_COLLECTIONS) {
    if (Object.keys(target.collections[collection]).length) throw new Error(`Verification failed: ${collection} was not cleared.`);
  }
}

async function setRefreshState(db, data) {
  await db.collection('settings').doc('stagingRefresh').set(data, { merge: true });
}

async function acquireLock(db, runId) {
  const ref = db.collection('settings').doc('stagingRefresh');
  await db.runTransaction(async transaction => {
    const current = await transaction.get(ref);
    const status = current.exists ? current.data().status : 'idle';
    if (status === 'refreshing' || status === 'failed') {
      throw new Error(`Refresh lock is ${status}. Inspect settings/stagingRefresh before running again.`);
    }
    transaction.set(ref, { status: 'refreshing', runId, startedAt: FieldValue.serverTimestamp(), error: null }, { merge: true });
  });
}

async function restoreSnapshot(db, snapshot) {
  const current = await readSelected(db);
  for (const collection of [...MIRROR_COLLECTIONS, ...CLEAR_COLLECTIONS]) {
    await commitOperations(db, mirrorOperations(db, collection, snapshot.collections[collection], current.collections[collection]));
  }
  const rosterNoticeRef = db.collection('settings').doc('rosterNotice');
  if (snapshot.rosterNotice) await rosterNoticeRef.set(cloneForTarget(snapshot.rosterNotice, db));
  else await rosterNoticeRef.delete();
}

async function main() {
  if (apply && confirmation !== TARGET_PROJECT) return usage(`--confirm-target ${TARGET_PROJECT} is required for writes.`);
  const [sourceCredential, targetCredential] = await Promise.all([
    loadCredential('TIMETABLE_PROD_SERVICE_ACCOUNT', SOURCE_PROJECT),
    loadCredential('TIMETABLE_STAGING_SERVICE_ACCOUNT', TARGET_PROJECT)
  ]);
  const sourceApp = initializeApp({ credential: cert(sourceCredential), projectId: SOURCE_PROJECT }, 'production-source');
  const targetApp = initializeApp({ credential: cert(targetCredential), projectId: TARGET_PROJECT }, 'staging-target');
  const sourceDb = getFirestore(sourceApp);
  const targetDb = getFirestore(targetApp);
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}`;
  let backupPath = null;
  let locked = false;

  try {
    const [source, target] = await Promise.all([readSelected(sourceDb), readSelected(targetDb)]);
    const operationCounts = {};
    for (const collection of MIRROR_COLLECTIONS) {
      operationCounts[collection] = mirrorOperations(targetDb, collection, source.collections[collection], target.collections[collection]).length;
    }
    for (const collection of CLEAR_COLLECTIONS) operationCounts[collection] = Object.keys(target.collections[collection]).length;
    console.table({ source: counts(source), stagingBefore: counts(target), operations: operationCounts });
    console.log(`settings/rosterNotice: ${source.rosterNotice ? 'copy' : 'delete'}`);
    if (dryRun) {
      console.log('Dry run complete. No staging data, lock, or sessionsVersion was written.');
      return;
    }

    backupPath = path.join(os.tmpdir(), `staging-refresh-backup-${runId}.json`);
    await writeFile(backupPath, JSON.stringify({ runId, createdAt: new Date().toISOString(), snapshot: encode(target) }), { mode: 0o600 });
    await acquireLock(targetDb, runId);
    locked = true;

    for (const collection of MIRROR_COLLECTIONS) {
      await commitOperations(targetDb, mirrorOperations(targetDb, collection, source.collections[collection], target.collections[collection]));
    }
    for (const collection of CLEAR_COLLECTIONS) {
      await commitOperations(targetDb, clearOperations(targetDb, collection, target.collections[collection]));
    }
    const rosterNoticeRef = targetDb.collection('settings').doc('rosterNotice');
    if (source.rosterNotice) await rosterNoticeRef.set(cloneForTarget(source.rosterNotice, targetDb));
    else await rosterNoticeRef.delete();

    await assertSelectedMatches(targetDb, source);

    // This is the only write to settings/sessionsVersion in the entire tool.
    // It happens after every selected collection has copied and verified.
    const finalBatch = targetDb.batch();
    finalBatch.set(targetDb.collection('settings').doc('sessionsVersion'), { updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    finalBatch.set(targetDb.collection('settings').doc('stagingRefresh'), {
      status: 'idle', runId, finishedAt: FieldValue.serverTimestamp(), error: null
    }, { merge: true });
    await finalBatch.commit();
    locked = false;
    await rm(backupPath, { force: true });
    backupPath = null;
    console.log('Staging refresh succeeded. sessionsVersion was updated once after verification.');
  } catch (error) {
    console.error(`Staging refresh failed: ${error.message}`);
    if (locked && backupPath) {
      try {
        const backup = JSON.parse(await readFile(backupPath, 'utf8'));
        await restoreSnapshot(targetDb, decode(backup.snapshot, targetDb));
        await setRefreshState(targetDb, { status: 'idle', rollbackAt: FieldValue.serverTimestamp(), error: error.message });
        locked = false;
        await rm(backupPath, { force: true });
        backupPath = null;
        console.error('Rollback succeeded. sessionsVersion was left unchanged.');
      } catch (rollbackError) {
        await setRefreshState(targetDb, { status: 'failed', failedAt: FieldValue.serverTimestamp(), error: `${error.message}; rollback failed: ${rollbackError.message}` }).catch(() => {});
        console.error(`Rollback failed. Maintenance gate remains active; backup retained at ${backupPath}.`);
      }
    }
    if (!locked && backupPath) {
      await rm(backupPath, { force: true });
      backupPath = null;
    }
    process.exitCode = 1;
  } finally {
    await Promise.allSettled([deleteApp(sourceApp), deleteApp(targetApp)]);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

export { MIRROR_COLLECTIONS, CLEAR_COLLECTIONS, encode, decode, canonicalize, comparable, mirrorOperations, clearOperations, acquireLock };
