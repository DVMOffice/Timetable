# Staging Migration Plan: Firebase to Supabase

**Goal:** extract the Firestore structure on `staging-branch`, move it into a
relational Supabase (Postgres) database, and keep every function of the app
working exactly as it does today.

**Scope:** the staging environment only (`staging-branch`, Firebase project
`ucvm-timetable-staging`, `ucvm-timetable-staging.web.app`). Production and
`main` are not touched. §11 covers what carries over to production later.

**Based on:** `staging-branch` at `edcd061` and a read-only scan of the staging
database on Nov 5, 2026.

---

## 1. The approach

Keep the app code and replace what sits underneath it.

The app talks to Firebase through a small set of calls: about 130 database call
sites, but only around a dozen distinct operations (§5). A new file,
`supabase-compat.js`, provides those same calls and sends them to Supabase. The
app keeps calling `db.collection('sessions').where(...)` and
`firebase.auth().signOut()`, and it can't tell the difference.

```
Today:    app files  ->  Firebase SDK      ->  Firestore + Firebase Auth
Staging:  app files  ->  supabase-compat   ->  Postgres  + Supabase Auth
          (unchanged)    (new file)            (relational tables, RLS)
```

**What changes**

| File | Change |
|---|---|
| `app.js`, `approvals.js`, `auth-roles.js`, `change-requests.js` | **None.** This is the main acceptance test. |
| `index.html` | Script tags only: Firebase scripts out, Supabase and the compat file in |
| `environment.js` | Add the Supabase URL and publishable key. Keep `firebaseConfig.projectId`, because `app.js` checks it at startup. |
| `firebase.json` | Add `db/**`, `supabase/**` and `tmp/**` to the hosting ignore list |
| `supabase-compat.js`, `reset-password.html` | New |
| `scripts/refresh-staging.mjs`, `scripts/seed-staging-allowlist.mjs`, and the tests | Now write to Supabase |
| `data-feed.html` | None. It reads production directly and isn't published on staging. |

**Why not rewrite the call sites?** That is the cleaner long-term design, but it
touches every feature, including the one-off repair buttons, and each edit is a
chance to change behaviour. The compat layer can be replaced later, one feature
at a time, with the database already in place.

---

## 2. What the extraction found

| Collection | Staging documents | Readable without a key |
|---|---|---|
| `sessions` | 1,975 | Yes |
| `roster` | 257 | Yes |
| `sessions_history` | 8 | Yes |
| `change_log` | 6 | Yes |
| `settings` | 3 (`rosterNotice`, `sessionsVersion`, `stagingRefresh`) | Yes |
| `users`, `authorized_users`, `access_requests`, `change_requests`, `admin_audit_log` | Unknown | No (HTTP 403, as expected) |

Findings that affect the design:

1. **Empty and missing are different values.** `numInstructors` has four forms:
   a number (791 in staging), an empty string (884), `null` (4), or absent. In
   production data the six `Event` rows have `course: ""`. The first export
   script turned these into `NULL` without reporting them, so its "0 issues"
   result was too generous. §4.3 fixes this.
2. **Row order matters.** Firestore returns rows sorted by document ID. In the
   production export, 167 groups of sessions share the same date, time and
   course, and the lab tables list stations in the order rows arrive. Postgres
   must use the same order (§5.3).
3. **Fall has over 1,000 sessions** (1,066 in the production export), which is
   more than one default API response is likely to return. The compat layer must
   page through results.
4. **The `stagingRefresh` lock has its own fields** (`status`, `runId`,
   `startedAt`, `finishedAt`, `error`), and the rules depend on them.

### Check first: approvals may already be failing

`firestore.rules` lets only the admin write `sessions`, `sessions_history`,
`change_log` and `settings`, yet `approvals.js` writes all four while signed in
as DVM Office or ADC. By those rules, the final approval step should fail with a
permission error. That comes from reading the code. It hasn't been run yet, so
Phase 0 tests it. See decision 1 in §3.

---

## 3. Decisions needed

| # | Decision | Recommendation |
|---|---|---|
| 1 | If DVM Office or ADC approval does fail today, should the rebuilt rules copy that failure? | **No.** A copied bug isn't a working function. Allow those two roles to write the four tables so approval works as documented. The catch is that they could then edit any session through the API, so plan a server-side approval function as a follow-up. |
| 2 | `main` has a fix that `staging-branch` lacks (`a86e9f4`: calendar tiles showing stale instructor names). Bring it in first? | **Yes**, so the baseline in Phase 0 matches what production does. |
| 3 | Who owns the Supabase organization? | The DVM Program Office, not a personal account. Staging fits the Free plan, but a Free project pauses after 1 week without activity, so expect to wake it up after quiet periods. |
| 4 | How will staging send password-reset emails? | Add testers to the Supabase team for early testing. Built-in email only reaches team members, at 2 per hour. Set up custom SMTP before the final sign-off, since production will need it anyway. |

---

## 4. Phase 1 — Extract

### 4.0 Set a baseline (Phase 0)

Do this before changing anything, while staging still runs on Firebase:

1. Create `feature/supabase-staging` from `staging-branch`, and apply decision 2.
2. Add `db/**`, `supabase/**` and `tmp/**` to the `firebase.json` ignore list.
   It currently serves the whole folder, so a deploy from this folder would
   publish `db/export/`, which holds student UCIDs.
3. Commit the `db/export/` ignore rules. Today they exist only in this
   computer's `.git/info/exclude`.
4. Test the approval question from §2 as DVM Office and as ADC. Record the result.
5. Save the baseline: master and filtered CSV and ICS exports for both semesters,
   plus screenshots of a sample of week views and lab tables.

### 4.1 Make the export safe for staging

`db/export-firestore.mjs` has the **production** project hard-coded, so running
it today reads production. Change it to:

- require `--project` and refuse to run without it;
- check that a service-account key belongs to that project, as the refresh tool
  already does;
- write to `db/export/<project>/`, so the two environments can't mix.

### 4.2 Extract the structure

Add `db/extract-schema.mjs`, which reads every collection with the staging
service-account key and writes `firestore-schema.json`: each field's name, types
and how often it appears. It records **no values**, so that file is safe to
commit.

Most staging workflow collections are cleared on each refresh, so they may hold
few documents. Treat the code as the source of truth for those shapes, and use
this scan to catch anything the code doesn't show.

### 4.3 Export the data

Update the conversion with one rule: **every document must come back exactly as
it went in.**

- A value that fits its typed column goes in the column.
- A value that doesn't fit, such as `numInstructors: ""`, goes in `extra` under
  its **original field name**. Reading the row restores it.
- Absent stays absent: the column is `NULL` and `extra` has no entry.

**Done when:** the structure file is committed, and an export of staging
completes with a report covering all ten collections.

---

## 5. Phase 2 — Build the compat layer

### 5.1 Calls it must provide

| Area | Calls used on this branch |
|---|---|
| Setup | `firebase.initializeApp`, `firebase.firestore()`, `db.enablePersistence` |
| References | `collection`, `doc(id)`, `doc()` with an auto-generated ID available immediately |
| Reads | `get`, `get({ source })` with `cache` or `server`, `where` with `==`, `<`, `>=`, `orderBy`, `limit` |
| Results | `docs`, `empty`, `size`, `forEach`, `metadata.fromCache`, `exists`, `data()`, `id`, `ref` |
| Writes | `add`, `set`, `set(..., { merge: true })`, `update` (including `checklist.<key>`), `delete`, `batch()` and `commit()` |
| Live updates | `onSnapshot`, on three `settings` documents and on the `change_log` and `roster` queries |
| Values | `FieldValue.serverTimestamp()`; returned timestamps need `toDate()` and `toMillis()` |
| Auth | `onAuthStateChanged`, `signInWithEmailAndPassword`, `createUserWithEmailAndPassword`, `signOut`, `sendPasswordResetEmail`, `currentUser`, `user.delete()` |
| Errors | The Firebase codes the app checks, such as `auth/wrong-password` and `auth/email-already-in-use` |

Anything outside this list should throw a clear error rather than do nothing.

### 5.2 How writes work

- Every `set`, `update`, `delete`, `add` and `commit` calls one Postgres function,
  `apply_writes(ops)`, so a batch stays all-or-nothing.
- It runs with the caller's permissions, so RLS decides what's allowed, just as
  the Firestore rules do.
- `serverTimestamp()` becomes the database's `now()`.
- A merge changes only the fields provided. A plain `set` replaces the record.
- Nested data is split across tables here: `changedFields` into
  `change_log_fields`, and review objects into `change_request_reviews`.

### 5.3 How reads work

- `get` reads from per-collection views that rebuild the document shape. For
  example, `change_requests_doc` puts `requestedBy`, `adfadReview` and `checklist`
  back together.
- Names and types convert at this boundary: `start_time` to `startTime`, `08:30:00`
  to `08:30`, year `2` to `'2'`.
- **Ordering:** use `ORDER BY <filter field>, id`, with `id` in `COLLATE "C"`, to
  match Firestore's sort.
- **Paging:** always loop with `.range()` until every row has arrived.

### 5.4 Cache and live updates

- `get({ source: 'cache' })` reads a saved copy of that query, kept per
  environment, and throws if there's none. The app already falls back to the
  server when that happens.
- Any write clears the saved queries for that collection, as Firestore's local
  cache would reflect the write.
- `onSnapshot` fires once at the start, then again on each Realtime event, and
  after a reconnect. Realtime is enabled only for `settings`, `change_log` and
  `roster`, which are all public-read.

### 5.5 Accounts

| App call | On Supabase |
|---|---|
| `createUserWithEmailAndPassword` | `signUp`, with email confirmation off to match immediate activation |
| `user.delete()` | A `delete_my_account` function, because browsers can't delete their own Supabase login |
| `sendPasswordResetEmail` | `resetPasswordForEmail`, redirecting to `reset-password.html` |

The signup flow stays as it is: create the account, check the allowlist, delete
the account if it isn't listed.

`reset-password.html` is the one new screen. Firebase hosts this page itself
today, and Supabase sends users back to your own site instead.

Staging accounts are separate from production and testers set their own
passwords, so **no password migration is needed**. Testers simply sign up again.

**Create the admin account (`dvmprogram@ucalgary.ca`) first.** Admin status comes
from that email, and signups aren't email-verified, so whoever registers it first
becomes admin.

**Done when:** unit tests cover every call in §5.1 and the app loads on a local
Supabase instance with those four files unchanged.

---

## 6. Phase 3 — Build the Supabase database

1. Create the `ucvm-timetable-staging` project in a Canadian region if available.
   Check university data-residency rules first, as the data includes student IDs.
2. Use the Supabase CLI and keep the schema in `supabase/migrations/`, so the
   database can be rebuilt from Git and reused for production.
3. Use the **publishable key** in the browser. The older `anon` and
   `service_role` keys are being deprecated by the end of 2026. Secret keys stay
   out of the repo and the browser.

### 6.1 Changes to `db/schema.sql`

| Change | Why |
|---|---|
| Remove the `sessions.course` foreign key | Firestore accepts any code, including `""`. `courses` stays as reference data. |
| Remove the `updated_at` and `sessionsVersion` triggers | The app sets these itself. Restore, for example, deliberately writes an older `updatedAt`. |
| Add `extra JSONB` to `change_requests`, `users` and other document tables | Supports the rule in §4.3 |
| `users.id` becomes `uuid`, referencing `auth.users` | Supabase user IDs are UUIDs |
| Use `COLLATE "C"` on `id` columns | Keeps Firestore's order |
| Add the views and `apply_writes` from §5 | Used by the compat layer |
| Turn on RLS for every table, and add explicit grants | Without RLS, the publishable key could read everything |

The relational structure stays: 13 tables with typed columns, child tables for
change-log fields and reviews, and indexes for each query the app runs.

### 6.2 Row-level security

This copies `firestore.rules`. `writes_allowed()` replaces `writesAllowed()` by
reading the `stagingRefresh` row.

| Table | Read | Write |
|---|---|---|
| `sessions`, `sessions_history`, `change_log`, `change_log_fields`, `settings`, `roster` | Everyone | Admin (plus decision 1), when writes are allowed |
| `courses` | Everyone | None from the app |
| `authorized_users` | Own email, or admin | Admin |
| `users` | Own row, or admin | Create own row; admin updates; delete own row or admin |
| `access_requests` | Admin | Anyone creates; admin updates |
| `change_requests`, `change_request_reviews` | Signed-in users | Signed-in users create; approvers, admin or the named Faculty B update |
| `admin_audit_log` | Admin | Admin or approvers create |

Postgres can't separate Firestore's `get` from `list`, so `users` and
`authorized_users` become "own row, or admin". The app only ever reads its own
row in those cases, so no function changes, and the data is a little better
protected.

**Done when:** migrations rebuild an empty project from nothing, and an SQL test
script proves each role can and can't do what this table says.

---

## 7. Phase 4 — Migrate the data

1. Load the staging export into the Supabase project with `psql`, then create
   accounts for testers.
2. Add `db/verify-migration.mjs`, which reads every document back through the
   compat layer's conversion and **compares it field by field with the Firestore
   original**. Any difference fails, including `""` versus missing, and types.
3. Rewrite `scripts/refresh-staging.mjs`: read production Firestore and write to
   Supabase. Keep the dry run, target confirmation, lock, verification and
   rollback, and port the tests in `test/`.
4. Rewrite `scripts/seed-staging-allowlist.mjs` to write to Supabase.

**Done when:** the verifier reports no differences and `npm test` passes.

---

## 8. Phase 5 — Prove nothing changed

Deploy the feature branch to a Firebase Hosting **preview channel**, and add that
URL to Supabase's allowed redirect URLs. Firebase staging keeps running beside it
for comparison.

### Automated

- [ ] `app.js`, `approvals.js`, `auth-roles.js` and `change-requests.js` show no diff against `staging-branch`.
- [ ] Master and filtered CSV and ICS exports match the Phase 0 baseline exactly, using the same data.
- [ ] The document round-trip check passes for all ten collections.
- [ ] Signed out with only the publishable key: private tables can't be read, and no table can be changed.

### Manual, as each role

- [ ] **Visitor:** week and month views, lab tables in the same order, roster, course list, all filters, search, updates feed, exports, dark mode, phone width.
- [ ] **Admin:** add, edit, delete, version restore, CSV import (create, update, blank cells kept), roster edit, notice edit, every banner button.
- [ ] **Accounts:** allowed signup, blocked signup, Request Access, sign in, wrong password message, password reset, delete account, revoke.
- [ ] **Allowlist:** all three CSV layouts.
- [ ] **Topic change:** ADFAD, then DVM Office, then the timetable updates.
- [ ] **Type change:** ADC only.
- [ ] **Swap:** Faculty B accept, Faculty B reject, self-swap, each swappable field, two update entries.
- [ ] **Messy instructor names:** the `edcd061` cases, such as `Name (Other, Other)` and `Eq: Name, SA: Other`.
- [ ] **Follow-up:** task checklist and audit log.
- [ ] **Live behaviour:** a change in one tab reaches a second tab, and reconnecting recovers.
- [ ] **Staging refresh:** the maintenance screen appears and writes are blocked during a run.

**Done when:** all of it passes and a tester from the DVM Program Office signs off.

---

## 9. Phase 6 — Switch staging over

1. Refresh the data, re-run the verifier, and create tester accounts.
2. Merge `feature/supabase-staging` into `staging-branch` and deploy.
3. Tell testers they need to sign up again.
4. Keep the Firebase staging project unchanged for at least two weeks.

**Rollback:** revert the merge and redeploy. The app files are unchanged and the
Firebase project is intact, so this takes minutes. Only test data created on
Supabase in the meantime is lost.

---

## 10. Risks

| Risk | Mitigation |
|---|---|
| The compat layer behaves slightly differently from Firebase | Unit tests per call, round-trip check, export comparison with the baseline |
| A script reads or writes production by mistake | Required `--project`, key checks, confirmation flags |
| RLS mistake exposes private data | RLS on every table, plus the signed-out checks in §8 |
| Student data published or committed | The `firebase.json` and `.gitignore` fixes in Phase 0 |
| Direct writes stay as trusted as they are today | Same security level as now by design; server-side checks are follow-up work |
| The compat layer becomes permanent | Treat it as a bridge and replace it feature by feature after production moves |

**Unverified assumptions, to confirm while building:**

- the default limit on rows per API response (1,000 from memory; the docs I read
  didn't state it);
- the exact event Supabase fires when a reset link opens;
- that Supabase auth callbacks shouldn't `await` other Supabase calls directly.

---

## 11. Later: production

This plan is designed to be reused, but production needs extra work:

- Real account handling: whether passwords carry over isn't clear from Supabase's
  docs, so test it, or have people use "Forgot password?" once.
- Mapping Firebase user IDs to Supabase IDs on existing requests.
- Custom SMTP, which is required there.
- The Pro plan, because Free projects pause and have no backups. Pro starts at
  $25/month.
- A planned read-only cutover, ideally **Dec 19 – Jan 3** or a later break.
- `data-feed.html`, which needs porting because Excel depends on it.
- `staging-branch` and `main` reconciled first, since accounts and swap aren't on
  `main`.

---

## 12. Rough effort

For one developer who knows the code. Estimates only.

| Phase | Estimate |
|---|---|
| 0–1. Baseline and extract | 2–3 days |
| 2. Compat layer | 6–8 days |
| 3. Database and RLS | 3–4 days |
| 4. Data and tooling | 2–3 days |
| 5. Testing | 3–5 days |
| 6. Switch | 1 day |
| **Total** | **About 3–5 weeks** |

---

## Sources

Checked Nov 5, 2026. Limits and prices change, so recheck them before relying on them.

- [Migrate from Firebase Auth](https://supabase.com/docs/guides/platform/migrating-to-supabase/firebase-auth)
- [Custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
- [Pricing](https://supabase.com/pricing)
- [Realtime limits](https://supabase.com/docs/guides/realtime/limits)
- [API keys](https://supabase.com/docs/guides/api/api-keys)
- [Password-based auth](https://supabase.com/docs/guides/auth/passwords)
