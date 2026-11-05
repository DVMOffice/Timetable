// Boots the real index.html and the unmodified app scripts in a simulated
// browser against the local Supabase stand-in, then drives the UI by clicking.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { startLocalSupabase } from './helpers/local-supabase.mjs';
import { load, loadExport } from '../db/migrate-to-supabase.mjs';
import '../supabase-compat.js';

const compat = globalThis.SupabaseCompat;
const STAGING = 'ucvm-timetable-staging';
const hasExport = existsSync(`db/export/${STAGING}/sessions.json`);
const WINTER_START = '2027-01-04';

let sb, window, document, fallCount;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, what) {
  for (let i = 0; i < 600; i++) {
    const value = check();
    if (value) return value;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const byId = id => document.getElementById(id);
const closeModal = () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));

function type(el, value) {
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
  el.dispatchEvent(new window.Event('change', { bubbles: true }));
}
async function openSessionFromSearch(text) {
  type(byId('search-input'), text);
  const row = await until(() => document.querySelector('#search-results-body tr[data-id]'), `search result for ${text}`);
  row.click();
  await until(() => byId('detail-close-btn'), 'session detail');
}
async function clearSearch() { closeModal(); type(byId('search-input'), ''); }

async function signIn(email) {
  byId('role-account-btn').click();
  await until(() => byId('si-email'), 'sign-in form');
  byId('si-email').value = email;
  byId('si-password').value = 'pw';
  byId('signin-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => byId('role-account-btn').textContent.includes('('), `${email} signed in`);
}
async function signOut() {
  await window.firebase.auth().signOut();
  await until(() => byId('role-account-btn').textContent === 'Sign In', 'signed out');
}
const sessionRow = async id => (await sb.pg.query('select * from public.sessions where id = $1', [id])).rows[0];

before(async () => {
  if (!hasExport) return;
  sb = await startLocalSupabase();
  const db = compat.createFirestore(sb.client, {});
  sb.actAs(sb.service);
  const data = loadExport(STAGING);
  await load(db, data);
  const seed = { date: '2026-11-10', day: 'Tuesday', year: '2', week: 12, type: 'LEC', course: '308', courseName: 'Test', room: 'R1', dateRange: 'Nov 9-13', academicCycle: '2026-2027', finalizedInstructors: '' };
  await db.collection('sessions').doc('e2eA').set({ ...seed, topic: 'Zebrafish alpha', startTime: '08:30', endTime: '09:30', primaryInstructor: 'Tess Alpha' });
  await db.collection('sessions').doc('e2eB').set({ ...seed, topic: 'Zebrafish beta', startTime: '13:00', endTime: '14:00', primaryInstructor: 'Ben Beta' });
  await db.collection('settings').doc('sessionsVersion').set({ updatedAt: compat.SERVER_TS_SENTINEL }, { merge: true });
  fallCount = data.sessions.filter(d => d.data.date < WINTER_START).length + 2;

  await sb.createUser({ email: 'dvmprogram@ucalgary.ca' });
  await sb.createUser({ email: 'tess@x.ca', name: 'Tess Alpha', nameLower: 'alpha tess', role: 'instructor' });
  await sb.createUser({ email: 'ben@x.ca', name: 'Ben Beta', nameLower: 'ben beta', role: 'instructor' });
  await sb.createUser({ email: 'adfad@x.ca', name: 'Ad Fad', nameLower: 'ad fad', role: 'adfad' });
  await sb.createUser({ email: 'dvm@x.ca', name: 'Dee Vee', nameLower: 'dee vee', role: 'dvm_office' });
  sb.actAs(sb.anon);

  const html = readFileSync('index.html', 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
  const dom = new JSDOM(html, { url: 'https://staging.example/', runScripts: 'outside-only', pretendToBeVisual: true });
  window = dom.window;
  document = window.document;
  window.confirm = () => true;
  window.prompt = () => 'pw';
  window.print = () => {};
  window.console.log = () => {};
  const run = file => window.eval(`${readFileSync(file, 'utf8')}\n//# sourceURL=${file}`);
  ['courseData.js', 'courseCatalog.js', 'calendarEngine.js', 'environment.js'].forEach(run);
  window.firebase = compat.createFirebase(sb.client, {
    storage: window.localStorage, cachePrefix: 'timetable:test:', resetRedirect: () => 'https://staging.example/reset-password.html',
  });
  ['app.js', 'auth-roles.js', 'change-requests.js', 'approvals.js'].forEach(run);
  await until(() => byId('conn-text').textContent === 'Connected', 'the app to connect');
});
after(() => { if (window) window.close(); });

const opts = { skip: !hasExport && 'no local export' };

test('the app boots and shows the whole semester', opts, async () => {
  assert.equal(window.Timetable.getAllSessions().length, fallCount);
  const sample = window.Timetable.getAllSessions().find(s => s.id === 'e2eA');
  assert.equal(sample.startTime, '08:30');
  assert.equal(sample.year, '2');
  assert.ok(document.querySelector('#calendar-body .tg-wrap'), 'week grid rendered');
  byId('cal-month-btn').click();
  assert.ok(document.querySelector('#calendar-body .cal-month'), 'month grid rendered');
  byId('cal-week-btn').click();
});

test('switching semester loads the other sessions', opts, async () => {
  document.querySelector('[data-semester="winter"]').click();
  await until(() => window.Timetable.getAllSessions().every(s => s.date >= WINTER_START) && window.Timetable.getAllSessions().length > 0, 'winter sessions');
  document.querySelector('[data-semester="fall"]').click();
  await until(() => window.Timetable.getAllSessions().length === fallCount, 'fall sessions');
});

test('a visitor gets no edit or request buttons', opts, async () => {
  await openSessionFromSearch('Zebrafish alpha');
  assert.equal(byId('detail-edit-btn'), null);
  assert.equal(byId('detail-request-btn'), null);
  await clearSearch();
});

test('admin edits a session, it reaches the feed, and restore brings it back', opts, async () => {
  byId('admin-toggle').click();
  await until(() => byId('admin-toggle').textContent === 'Exit Admin Mode', 'admin mode');

  await openSessionFromSearch('Zebrafish beta');
  byId('detail-edit-btn').click();
  await until(() => byId('f-topic'), 'edit form');
  byId('f-topic').value = 'Zebrafish beta edited';
  byId('save-btn').click();
  await until(() => byId('save-status')?.textContent === 'Saved ✓', 'save to finish');
  assert.equal((await sessionRow('e2eB')).topic, 'Zebrafish beta edited');
  await until(() => byId('latest-updates-body').textContent.includes('Topic: Zebrafish beta → Zebrafish beta edited'), 'the updates feed');
  await until(() => window.Timetable.getAllSessions().find(s => s.id === 'e2eB').topic === 'Zebrafish beta edited', 'sessions to refresh');
  await sleep(600);

  await openSessionFromSearch('Zebrafish beta edited');
  byId('detail-edit-btn').click();
  await until(() => byId('f-topic'), 'edit form');
  byId('f-topic').value = 'Zebrafish beta second';
  byId('save-btn').click();
  await until(() => byId('save-status')?.textContent === 'Saved ✓', 'second save');
  await until(() => window.Timetable.getAllSessions().find(s => s.id === 'e2eB').topic === 'Zebrafish beta second', 'sessions to refresh');
  await sleep(600);

  await openSessionFromSearch('Zebrafish beta second');
  byId('detail-edit-btn').click();
  await until(() => byId('history-toggle'), 'history link');
  byId('history-toggle').click();
  await until(() => document.querySelectorAll('.history-item').length === 2, 'both versions');
  const versions = [...document.querySelectorAll('.history-item')];
  assert.match(versions[0].textContent, /second/, 'newest version first');
  versions[1].click();
  for (let i = 0; i < 300 && (await sessionRow('e2eB')).topic !== 'Zebrafish beta edited'; i++) await sleep(10);
  assert.equal((await sessionRow('e2eB')).topic, 'Zebrafish beta edited');
  await until(() => window.Timetable.getAllSessions().find(s => s.id === 'e2eB').topic === 'Zebrafish beta edited', 'restored session to refresh');
  await sleep(600);
  await clearSearch();

  await window.firebase.auth().signOut();
  await until(() => byId('admin-toggle').textContent === 'Administrator Login', 'admin sign-out');
});

test('a blocked email is sent to Request Access and its login is removed', opts, async () => {
  byId('role-account-btn').click();
  await until(() => byId('goto-signup-btn'), 'sign-in form');
  byId('goto-signup-btn').click();
  await until(() => byId('su-email'), 'sign-up form');
  byId('su-name').value = 'Nobody Here';
  byId('su-email').value = 'nobody@x.ca';
  byId('su-password').value = 'secret1';
  byId('signup-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => byId('request-access-btn'), 'the Request Access link');
  assert.equal((await sb.pg.query(`select 1 from auth.users where email = 'nobody@x.ca'`)).rows.length, 0);
  closeModal();
});

test('the whole swap, clicked through as each person', opts, async () => {
  await signIn('tess@x.ca');
  await openSessionFromSearch('Zebrafish alpha');
  await until(() => byId('detail-request-btn'), 'Request Change for your own session').then(b => b.click());
  byId('menu-swap-btn').click();
  type(await until(() => byId('sw-search'), 'swap form'), 'Zebrafish beta');
  (await until(() => document.querySelector('#sw-results [data-sid="e2eB"]'), 'swap partner')).click();
  document.querySelector('.sw-field-cb[value="time"]').checked = true;
  byId('sw-note').value = 'Clinic clash';
  byId('sw-submit-btn').click();
  await until(() => !byId('sw-submit-btn'), 'the swap to submit');
  type(byId('search-input'), '');
  const { rows: [request] } = await sb.pg.query('select * from public.change_requests');
  assert.equal(request.status, 'pending_faculty_b');
  assert.equal(request.session_a_id, 'e2eA');
  assert.equal(request.faculty_b_name_lower, 'ben beta');
  await signOut();

  await signIn('ben@x.ca');
  await until(() => byId('my-requests-btn')?.style.display !== 'none' && byId('my-requests-btn'), 'My Requests').then(b => b.click());
  (await until(() => document.querySelector('[data-accept-swap]'), 'the incoming swap')).click();
  await until(() => !document.querySelector('[data-accept-swap]'), 'the acceptance');
  closeModal();
  await signOut();

  await signIn('adfad@x.ca');
  await until(() => byId('approvals-btn'), 'Approvals').then(b => b.click());
  (await until(() => document.querySelector('[data-approve]'), 'the ADFAD queue')).click();
  await until(() => byId('ap-body')?.textContent.includes('No pending'), 'ADFAD approval');
  assert.equal((await sessionRow('e2eA')).start_time.slice(0, 5), '08:30', 'stage 1 must not change the timetable');
  closeModal();
  await signOut();

  await signIn('dvm@x.ca');
  await until(() => byId('approvals-btn')?.style.display !== 'none' && byId('approvals-btn'), 'Approvals').then(b => b.click());
  await until(() => byId('ap-body')?.textContent.includes('already approved by ADFAD Office'), 'the DVM queue');
  document.querySelector('[data-approve]').click();
  await until(() => byId('ap-body')?.textContent.includes('No pending'), 'DVM approval');
  closeModal();

  assert.equal((await sessionRow('e2eA')).start_time.slice(0, 5), '13:00');
  assert.equal((await sessionRow('e2eB')).start_time.slice(0, 5), '08:30');
  const { rows: [done] } = await sb.pg.query('select * from public.change_requests');
  assert.equal(done.status, 'approved');
  assert.equal(done.checklist_d2l_update, false);
  const reviews = await sb.pg.query('select stage from public.change_request_reviews order by stage');
  assert.deepEqual(reviews.rows.map(r => r.stage), ['adfad', 'dvm_office', 'faculty_b']);
  const audit = await sb.pg.query('select type from public.admin_audit_log order by type');
  assert.deepEqual(audit.rows.map(r => r.type), ['change_request_adfad_approved', 'change_request_dvm_approved']);
  await until(() => window.Timetable.getAllSessions().find(s => s.id === 'e2eA').startTime === '13:00', 'the calendar to refresh');
  await until(() => byId('latest-updates-body').textContent.includes('Start Time: 08:30 → 13:00'), 'the swap in the feed');
  await signOut();
});

test('exports and the roster still work', opts, async () => {
  const csv = [];
  window.URL.createObjectURL = blob => { csv.push(blob); return 'blob:x'; };
  window.URL.revokeObjectURL = () => {};
  document.querySelector('[data-export="master-csv"]').click();
  assert.equal(csv.length, 1);
  window.Timetable.db.collection('roster').onSnapshot(() => {});
  const roster = await window.Timetable.db.collection('roster').get();
  assert.equal(roster.size, 257);
  assert.match(roster.docs[0].id, /^year[123]_/);
});
