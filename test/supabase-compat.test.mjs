import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { startLocalSupabase } from './helpers/local-supabase.mjs';
import { canonical, load, loadExport, verify } from '../db/migrate-to-supabase.mjs';
import '../supabase-compat.js';

const compat = globalThis.SupabaseCompat;
const ts = compat.SERVER_TS_SENTINEL;
const STAGING = 'ucvm-timetable-staging';

let sb, db, admin, instructorA, instructorB, adfad, dvm, adc, stranger;
const person = (u, name, role) => ({ uid: u.uid, email: u.email, name, role });

before(async () => {
  sb = await startLocalSupabase();
  db = compat.createFirestore(sb.client, {});
  admin = await sb.createUser({ email: 'dvmprogram@ucalgary.ca' });
  instructorA = await sb.createUser({ email: 'a@x.ca', name: 'Ann Lee', nameLower: 'ann lee', role: 'instructor' });
  instructorB = await sb.createUser({ email: 'b@x.ca', name: 'Bo Ray', nameLower: 'bo ray', role: 'instructor' });
  adfad = await sb.createUser({ email: 'adfad@x.ca', name: 'Ad Fad', nameLower: 'ad fad', role: 'adfad' });
  dvm = await sb.createUser({ email: 'dvm@x.ca', name: 'Dee Vee', nameLower: 'dee vee', role: 'dvm_office' });
  adc = await sb.createUser({ email: 'adc@x.ca', name: 'Ay Dee', nameLower: 'ay dee', role: 'adc' });
  stranger = await sb.createUser({ email: 's@x.ca', name: 'Sam Oak', nameLower: 'oak sam', role: 'cc' });
});

const denied = (promise) => assert.rejects(promise, err => err.code === 'permission-denied');

test('documents survive the trip through typed columns exactly', async () => {
  sb.actAs(sb.service);
  const docs = {
    typed: { date: '2026-09-10', startTime: '08:30', endTime: '13:15', year: '2', week: 3, type: 'LAB', course: '308', numInstructors: 2, group: 'C, D', column: 'A' },
    emptyValues: { course: '', numInstructors: '', notes: '', secondaryInstructor: '' },
    explicitNull: { numInstructors: null },
    wrongShapes: { date: 'Oct 12', startTime: '8:30 AM', endTime: '25:00', year: 3, type: 'Lec', week: 'three', hideSecondaryOnTile: false },
    absent: { topic: 'only a topic' },
  };
  for (const [id, data] of Object.entries(docs)) {
    await db.collection('sessions').doc(id).set(data);
    assert.deepEqual((await db.collection('sessions').doc(id).get()).data(), data, id);
  }
});

test('a merge moves a value between its column and extra without leaving a stale copy', async () => {
  sb.actAs(sb.service);
  const ref = db.collection('sessions').doc('moving');
  await ref.set({ numInstructors: 2, topic: 'kept' });
  await ref.set({ numInstructors: '' }, { merge: true });
  assert.deepEqual((await ref.get()).data(), { numInstructors: '', topic: 'kept' });
  await ref.set({ numInstructors: 4 }, { merge: true });
  assert.deepEqual((await ref.get()).data(), { numInstructors: 4, topic: 'kept' });
});

test('set without merge replaces the whole document', async () => {
  sb.actAs(sb.service);
  const ref = db.collection('sessions').doc('replaced');
  await ref.set({ topic: 'old', room: 'R1', custom: 1 });
  await ref.set({ topic: 'new' });
  assert.deepEqual((await ref.get()).data(), { topic: 'new' });
});

test('update fails on a missing document, delete does not', async () => {
  sb.actAs(sb.service);
  await assert.rejects(db.collection('sessions').doc('nope').update({ topic: 'x' }), err => err.code === 'not-found');
  await db.collection('sessions').doc('nope').delete();
});

test('undefined is rejected, as Firestore does', async () => {
  sb.actAs(sb.service);
  await assert.rejects(db.collection('sessions').doc('u').set({ topic: undefined }), /undefined/);
});

test('a failing batch writes nothing', async () => {
  sb.actAs(sb.service);
  const batch = db.batch();
  batch.set(db.collection('sessions').doc('atomic'), { topic: 'should vanish' });
  batch.update(db.collection('sessions').doc('missing-doc'), { topic: 'x' });
  await assert.rejects(batch.commit());
  assert.equal((await db.collection('sessions').doc('atomic').get()).exists, false);
});

test('server timestamps are shared across a batch and work inside snapshots', async () => {
  sb.actAs(sb.service);
  const batch = db.batch();
  batch.set(db.collection('sessions').doc('stamped'), { updatedAt: ts });
  batch.set(db.collection('sessions_history').doc('stamped-v1'), { sessionId: 'stamped', updatedAt: ts, savedAt: ts });
  await batch.commit();
  const session = (await db.collection('sessions').doc('stamped').get()).data();
  const version = (await db.collection('sessions_history').doc('stamped-v1').get()).data();
  assert.equal(typeof session.updatedAt.toDate().getTime(), 'number');
  assert.equal(session.updatedAt.toMillis(), version.updatedAt.toMillis());
  assert.equal(version.savedAt.toMillis(), session.updatedAt.toMillis());
  assert.equal(version.sessionId, 'stamped');
});

test('queries return every row in Firestore order, even past the API row cap', async () => {
  const capped = await startLocalSupabase({ maxRows: 7 });
  const local = compat.createFirestore(capped.client, {});
  capped.actAs(capped.service);
  const batch = local.batch();
  const ids = ['b', 'Z', 'a', 'c1', 'c10', 'c2'];
  for (let i = 0; i < 20; i++) batch.set(local.collection('sessions').doc(`n${i}`), { date: '2026-09-01' });
  ids.forEach(id => batch.set(local.collection('sessions').doc(id), { date: '2026-09-02' }));
  batch.set(local.collection('sessions').doc('winter'), { date: '2027-02-01' });
  await batch.commit();
  const snap = await local.collection('sessions').where('date', '<', '2027-01-04').get();
  assert.equal(snap.size, 26);
  assert.deepEqual(snap.docs.slice(-6).map(d => d.id), ['Z', 'a', 'b', 'c1', 'c10', 'c2']);
});

test('the cache source serves the last server result and misses cleanly', async () => {
  const store = new Map();
  const storage = {
    getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k),
    key: i => [...store.keys()][i], get length() { return store.size; },
  };
  const cached = compat.createFirestore(sb.client, { storage });
  sb.actAs(sb.service);
  const query = cached.collection('roster').where('year', '==', 'year1');
  await assert.rejects(query.get({ source: 'cache' }));
  await cached.collection('roster').doc('year1_1').set({ year: 'year1', ucid: '1', group6: 'A' });
  await query.get({ source: 'server' });
  const hit = await query.get({ source: 'cache' });
  assert.equal(hit.metadata.fromCache, true);
  assert.equal(hit.docs[0].data().group6, 'A');
  await cached.collection('roster').doc('year1_1').set({ group6: 'B' }, { merge: true });
  await assert.rejects(query.get({ source: 'cache' }), 'a write invalidates cached queries');
});

test('visitors read public data but nothing private, and write nothing', async () => {
  sb.actAs(sb.anon);
  await db.collection('sessions').get();
  for (const name of ['users', 'authorized_users', 'access_requests', 'change_requests', 'admin_audit_log']) {
    await denied(db.collection(name).get());
  }
  await denied(db.collection('sessions').doc('x').set({ topic: 'hack' }));
  await denied(db.collection('settings').doc('sessionsVersion').set({ updatedAt: ts }, { merge: true }));
  await denied(db.collection('admin_audit_log').add({ type: 'x' }));
});

test('anyone can file an access request but only the admin can read it', async () => {
  sb.actAs(sb.anon);
  const ref = await db.collection('access_requests').add({ name: 'New', email: 'n@x.ca', claimedRole: 'cc', note: '', status: 'pending', createdAt: ts });
  sb.actAs(instructorA);
  assert.equal((await ref.get()).exists, false);
  sb.actAs(admin);
  assert.equal((await ref.get()).data().email, 'n@x.ca');
  await ref.update({ status: 'rejected', reviewedBy: 'dvmprogram@ucalgary.ca', reviewedAt: ts });
  assert.equal((await ref.get()).data().status, 'rejected');
});

test('signup can check its own allowlist entry, not list others', async () => {
  sb.actAs(admin);
  await db.collection('authorized_users').doc('a@x.ca').set({ email: 'a@x.ca', name: 'Ann Lee', role: 'instructor', importedAt: ts }, { merge: true });
  await db.collection('authorized_users').doc('other@x.ca').set({ email: 'other@x.ca', name: 'O', role: 'cc', importedAt: ts }, { merge: true });
  sb.actAs(instructorA);
  assert.equal((await db.collection('authorized_users').doc('a@x.ca').get()).data().role, 'instructor');
  assert.equal((await db.collection('authorized_users').doc('other@x.ca').get()).exists, false);
  assert.equal((await db.collection('authorized_users').get()).size, 1);
  sb.actAs(admin);
  assert.equal((await db.collection('authorized_users').get()).size, 2);
});

test('a new user can create their own profile, and delete their account', async () => {
  const user = await sb.createUser({ email: 'new@x.ca' });
  sb.actAs(user);
  await db.collection('users').doc(user.uid).set({ email: 'new@x.ca', name: 'New', nameLower: 'new', role: 'cc', requestedRole: 'cc', status: 'active', createdAt: ts, reviewedBy: 'auto (authorized list)', reviewedAt: ts });
  assert.equal((await db.collection('users').doc(user.uid).get()).data().status, 'active');
  await denied(db.collection('users').doc(user.uid).update({ role: 'adfad' }));
  sb.actAs(admin);
  assert.equal((await db.collection('users').where('email', '==', 'new@x.ca').get()).size, 1);
  sb.actAs(user);
  assert.equal((await sb.client.rpc('delete_my_account')).error, null);
  assert.equal((await sb.pg.query('select 1 from auth.users where id = $1', [user.uid])).rows.length, 0);
  sb.actAs(admin);
  assert.equal((await db.collection('users').where('email', '==', 'new@x.ca').get()).size, 0);
});

test('a revoked account loses its role immediately', async () => {
  const user = await sb.createUser({ email: 'rev@x.ca', name: 'Rev', nameLower: 'rev', role: 'dvm_office' });
  sb.actAs(admin);
  await db.collection('users').doc(user.uid).update({ status: 'revoked', revokedAt: ts, revokedBy: 'dvmprogram@ucalgary.ca' });
  sb.actAs(user);
  await denied(db.collection('sessions').doc('x').set({ topic: 'no' }));
});

test('the staging refresh lock blocks browser writes', async () => {
  sb.actAs(sb.service);
  await db.collection('settings').doc('stagingRefresh').set({ status: 'refreshing', runId: 'r1', startedAt: ts, error: null }, { merge: true });
  sb.actAs(admin);
  await denied(db.collection('sessions').doc('blocked').set({ topic: 'no' }));
  sb.actAs(sb.anon);
  await denied(db.collection('access_requests').add({ email: 'x@x.ca', status: 'pending' }));
  sb.actAs(sb.service);
  await db.collection('settings').doc('stagingRefresh').set({ status: 'idle', error: null }, { merge: true });
  const state = (await db.collection('settings').doc('stagingRefresh').get()).data();
  assert.equal(state.status, 'idle');
  assert.equal(state.runId, 'r1');
  assert.equal(state.error, null);
  sb.actAs(admin);
  await db.collection('sessions').doc('unblocked').set({ topic: 'yes' });
});

test('the full swap workflow, using the same calls as the app', async () => {
  sb.actAs(admin);
  const sessions = db.collection('sessions');
  await sessions.doc('swapA').set({ topic: 'A', startTime: '08:30', endTime: '09:30', room: 'R1', primaryInstructor: 'Ann Lee' });
  await sessions.doc('swapB').set({ topic: 'B', startTime: '10:00', endTime: '11:00', room: 'R2', primaryInstructor: 'Bo Ray' });

  sb.actAs(instructorA);
  const requestedBy = person(instructorA, 'Ann Lee', 'instructor');
  const ref = await db.collection('change_requests').add({
    requestType: 'swap', status: 'pending_faculty_b',
    sessionAId: 'swapA', sessionASummary: { course: '308', topic: 'A' }, sessionBId: 'swapB', sessionBSummary: { course: '308', topic: 'B' },
    swapFields: ['startTime', 'endTime'], swapFieldLabels: ['Time'], reason: 'clash', requestedBy,
    facultyBName: 'Bo Ray', facultyBNameLower: 'bo ray', facultyBReview: null, createdAt: ts, adfadReview: null, dvmReview: null,
  });
  const fresh = async () => (await ref.get()).data();
  let req = await fresh();
  assert.equal(req.facultyBReview, null);
  assert.deepEqual(req.requestedBy, requestedBy);
  assert.deepEqual(req.swapFields, ['startTime', 'endTime']);
  assert.equal((await db.collection('change_requests').where('requestedBy.uid', '==', instructorA.uid).get()).size, 1);

  sb.actAs(stranger);
  await denied(ref.update({ status: 'pending' }));

  sb.actAs(instructorB);
  assert.equal((await db.collection('change_requests').where('facultyBNameLower', '==', 'bo ray').get()).size, 1);
  await ref.update({ status: 'pending', facultyBReview: { by: person(instructorB, 'Bo Ray', 'instructor'), at: ts, note: '' } });

  sb.actAs(adfad);
  assert.equal((await db.collection('change_requests').where('status', '==', 'pending').get()).size, 1);
  await ref.update({ status: 'pending_dvm', adfadReview: { by: person(adfad, 'Ad Fad', 'adfad'), at: ts, note: '' } });
  await db.collection('admin_audit_log').add({ type: 'change_request_adfad_approved', summary: 's', detail: { requestId: ref.id }, actor: { uid: adfad.uid, email: adfad.email }, at: ts });

  // applySwap(), which firestore.rules would refuse for this role.
  sb.actAs(dvm);
  const [a, b] = await Promise.all([sessions.doc('swapA').get(), sessions.doc('swapB').get()]);
  const fullA = { ...a.data(), startTime: b.data().startTime, endTime: b.data().endTime, updatedAt: ts };
  const fullB = { ...b.data(), startTime: a.data().startTime, endTime: a.data().endTime, updatedAt: ts };
  const batch = db.batch();
  batch.set(sessions.doc('swapA'), fullA, { merge: true });
  batch.set(sessions.doc('swapB'), fullB, { merge: true });
  batch.set(db.collection('settings').doc('sessionsVersion'), { updatedAt: ts }, { merge: true });
  await batch.commit();
  await db.collection('sessions_history').add({ sessionId: 'swapA', ...fullA, savedAt: ts });
  await db.collection('change_log').add({
    sessionId: 'swapA', course: '308 - X', sessionTopic: 'A', sessionYear: '2', sessionType: 'LAB', sessionStartTime: '10:00', sessionDate: '2026-09-10', sessionWeek: 3,
    changedFields: [{ fieldLabel: 'Start Time', oldValue: '08:30', newValue: '10:00' }, { fieldLabel: 'End Time', oldValue: '09:30', newValue: '11:00' }], changedAt: ts,
  });
  await ref.update({ status: 'approved', dvmReview: { by: person(dvm, 'Dee Vee', 'dvm_office'), at: ts, note: '' }, checklist: { inviteUpdate: false, dvmHubUpdate: false, d2lUpdate: false } });

  req = await fresh();
  assert.equal(req.status, 'approved');
  assert.equal(req.facultyBReview.by.name, 'Bo Ray');
  assert.equal(req.adfadReview.by.role, 'adfad');
  assert.equal(req.dvmReview.note, '');
  assert.equal(typeof req.dvmReview.at.toMillis(), 'number');
  assert.equal((await sessions.doc('swapA').get()).data().startTime, '10:00');
  assert.equal((await sessions.doc('swapB').get()).data().startTime, '08:30');

  const feed = await db.collection('change_log').orderBy('changedAt', 'desc').limit(100).get();
  assert.deepEqual(feed.docs[0].data().changedFields.map(f => f.fieldLabel), ['Start Time', 'End Time']);

  sb.actAs(admin);
  await ref.update({ 'checklist.inviteUpdate': true });
  assert.deepEqual((await fresh()).checklist, { inviteUpdate: true, dvmHubUpdate: false, d2lUpdate: false });
  assert.equal((await db.collection('admin_audit_log').get()).docs[0].data().actor.email, adfad.email);
  sb.actAs(adfad);
  await denied(db.collection('admin_audit_log').get().then(s => { if (s.empty) throw Object.assign(new Error('hidden'), { code: 'permission-denied' }); }));
});

test('Faculty B can reject a swap with a note, and an approver can reject with reviewedBy', async () => {
  sb.actAs(instructorA);
  const base = { requestType: 'swap', sessionAId: 'a', sessionBId: 'b', sessionASummary: {}, sessionBSummary: {}, swapFields: ['room'], swapFieldLabels: ['Room'], requestedBy: person(instructorA, 'Ann Lee', 'instructor'), facultyBName: 'Bo Ray', facultyBNameLower: 'bo ray', createdAt: ts };
  const one = await db.collection('change_requests').add({ ...base, status: 'pending_faculty_b', facultyBReview: null });
  const two = await db.collection('change_requests').add({ ...base, status: 'pending' });
  sb.actAs(instructorB);
  await one.update({ status: 'rejected', rejectedStage: 'Faculty B', reviewNote: 'no thanks', facultyBReview: { by: person(instructorB, 'Bo Ray', 'instructor'), at: ts, note: 'no thanks' } });
  sb.actAs(adfad);
  const reviewer = person(adfad, 'Ad Fad', 'adfad');
  await two.update({ status: 'rejected', rejectedStage: 'ADFAD Office', reviewNote: '', reviewedBy: reviewer, reviewedAt: ts });
  const first = (await one.get()).data();
  assert.equal(first.reviewNote, 'no thanks');
  assert.equal(first.facultyBReview.note, 'no thanks');
  const second = (await two.get()).data();
  assert.deepEqual(second.reviewedBy, reviewer);
  assert.equal(second.rejectedStage, 'ADFAD Office');
  const decision = await sb.pg.query(`select decision from public.change_request_reviews where request_id = $1`, [one.id]);
  assert.equal(decision.rows[0].decision, 'rejected');
});

test('ADC can apply a type change; an instructor cannot edit sessions directly', async () => {
  sb.actAs(adc);
  await db.collection('sessions').doc('swapA').set({ type: 'SRL', updatedAt: ts }, { merge: true });
  sb.actAs(instructorA);
  await denied(db.collection('sessions').doc('swapA').set({ topic: 'mine' }, { merge: true }));
  sb.actAs(adfad);
  await denied(db.collection('sessions').doc('swapA').set({ topic: 'mine' }, { merge: true }));
  await denied(db.collection('sessions').doc('swapA').delete());
});

test('version restore writes old timestamps back unchanged', async () => {
  sb.actAs(admin);
  const old = compat.Timestamp.fromIso('2026-01-02T03:04:05.678Z');
  await db.collection('sessions').doc('restore').set({ topic: 'now', updatedAt: ts });
  await db.collection('sessions_history').doc('restore-v1').set({ sessionId: 'restore', topic: 'then', updatedAt: old, savedAt: old });
  const { sessionId, savedAt, ...patch } = (await db.collection('sessions_history').doc('restore-v1').get()).data();
  await db.collection('sessions').doc(sessionId).set(patch, { merge: true });
  const restored = (await db.collection('sessions').doc('restore').get()).data();
  assert.equal(restored.topic, 'then');
  assert.equal(restored.updatedAt.toMillis(), old.toMillis());
  assert.equal(savedAt.toMillis(), old.toMillis());
});

test('live listeners fire once at the start with a Firestore-shaped snapshot', async () => {
  sb.actAs(sb.anon);
  const doc = await new Promise((resolve, reject) => { db.collection('settings').doc('rosterNotice').onSnapshot(resolve, reject); });
  assert.equal(doc.exists, false);
  const snap = await new Promise((resolve, reject) => { db.collection('change_log').orderBy('changedAt', 'desc').limit(100).onSnapshot(resolve, reject); });
  assert.equal(typeof snap.empty, 'boolean');
});

test('real staging data loads and matches field by field', { skip: !existsSync(`db/export/${STAGING}/sessions.json`) && 'no local export' }, async () => {
  const fresh = await startLocalSupabase();
  const local = compat.createFirestore(fresh.client, {});
  fresh.actAs(fresh.service);
  const data = loadExport(STAGING);
  await load(local, data);
  assert.deepEqual(await verify(local, data), []);
  const fall = await local.collection('sessions').where('date', '<', '2027-01-04').get();
  const expected = data.sessions.filter(d => d.data.date < '2027-01-04').map(d => d.id).sort();
  assert.deepEqual(fall.docs.map(d => d.id).slice().sort(), expected);
  assert.ok(canonical(fall.docs[0].data()));
});
