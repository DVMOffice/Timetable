import test from 'node:test';
import assert from 'node:assert/strict';
import { Timestamp, GeoPoint } from 'firebase-admin/firestore';
import { encode, decode, comparable, mirrorOperations, clearOperations, acquireLock } from '../scripts/refresh-staging.mjs';

function mockDb() {
  return {
    doc: path => ({ path, firestore: true }),
    collection: collection => ({ doc: id => ({ collection, id }) })
  };
}

test('typed rollback encoding preserves timestamps, geopoints, buffers, and references', () => {
  const db = mockDb();
  const source = {
    when: new Timestamp(100, 42), point: new GeoPoint(51.0447, -114.0719),
    bytes: Buffer.from('roster'), ref: { path: 'sessions/session-1', firestore: true }
  };
  const restored = decode(encode(source), db);
  assert.equal(restored.when.toMillis(), source.when.toMillis());
  assert.deepEqual(restored.point, source.point);
  assert.equal(restored.bytes.toString(), 'roster');
  assert.equal(restored.ref.path, 'sessions/session-1');
});

test('mirror operations upsert changed documents and delete documents absent from production', () => {
  const db = mockDb();
  const operations = mirrorOperations(db, 'sessions', { keep: { value: 1 }, add: { value: 2 } }, { keep: { value: 1 }, remove: { value: 3 } });
  assert.deepEqual(operations.map(operation => [operation.type, operation.ref.id]), [['set', 'add'], ['delete', 'remove']]);
});

test('comparison is independent of Firestore object key order', () => {
  assert.equal(comparable({ b: 2, a: { y: 1, x: 0 } }), comparable({ a: { x: 0, y: 1 }, b: 2 }));
});

test('clear operations delete every staging-only workflow document', () => {
  const operations = clearOperations(mockDb(), 'change_log', { a: {}, b: {} });
  assert.deepEqual(operations.map(operation => operation.ref.id), ['a', 'b']);
});

test('a refreshing or failed maintenance document cannot acquire a concurrent lock', async () => {
  for (const status of ['refreshing', 'failed']) {
    const db = {
      collection: () => ({ doc: () => ({}) }),
      runTransaction: callback => callback({ get: async () => ({ exists: true, data: () => ({ status }) }) })
    };
    await assert.rejects(() => acquireLock(db, 'run-1'), new RegExp(`Refresh lock is ${status}`));
  }
});
