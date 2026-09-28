# Change Requests & Approvals — Setup Guide

How to get the role accounts / change-request / approval system running, and
how to test the swap flow end to end. This is a one-time setup (steps 1–2)
plus a repeatable test walkthrough (steps 3–5).

## How it works, briefly

- **Course Coordinators / Instructors** submit one of three request types —
  a **topic change**, a **swap** with another session, or a **session type
  change** (e.g. Lec → SRL) — but only from a session where *they themselves*
  are the listed instructor (matched by name against Primary/Secondary
  Instructor). Client-side only — see the caveat in "Requesting only your
  own sessions" below.
- **Swaps go through the other instructor first.** The moment a swap is
  submitted, it's not yet visible to ADFAD/DVM Office at all — it waits for
  the *other* session's instructor ("Faculty B") to accept or reject it (with
  an optional note on reject) from their own **My Requests** panel. Only
  once they accept does it enter the ADFAD → DVM Office queue.
- **Topic changes and session-type changes never need that peer step** —
  they don't involve a second instructor's session, so they go straight to
  approval.
- **Topic changes and swaps** then need two approvals in order: **ADFAD
  Office** first, then **DVM Program Office** second. Nothing touches the
  live timetable until the DVM Program Office approval.
- **Session type changes** need **ADC** approval only (single stage).
- Only people on the **authorized users** allowlist can create an account at
  all — self-signup checks the email against that list and blocks anyone not
  on it (with a "Request Access" fallback that queues them for you to add).
- Once a request is fully approved, it gets a 3-item follow-up checklist
  (Invite Update / DVM Hub Course Schedule Update / D2L Course Schedule
  Update) you check off later from the admin banner.
- Every account/role-management action (imports, revokes, access-request
  decisions, each approval stage) is recorded in an admin-only **Audit Log** —
  separate from the public Latest Updates feed, since it names real people.
- Anyone can reset their own password via **"Forgot password?"** on the Sign
  In modal — no admin involvement needed.

Relevant files: `auth-roles.js` (accounts/roles/allowlist), `change-requests.js`
(the three request forms), `approvals.js` (routing + applying approvals +
the task checklist).

---

## 1. Add the Firestore rules

Firebase Console → your project → **Firestore Database → Rules**. This is a
**full replacement** of whatever's in that tab now — paste it in, then
**Publish**. Without this step, signup and approvals will fail with
permission errors.

The original rules were a single catch-all (`match /{document=**}`, open
read for everyone, write restricted to the admin email) — that meant only
the admin account could write *anything*, including the new role/request
collections, and every collection (including real names/emails in `users`
and `authorized_users`) was world-readable with no login at all. This
replaces that with explicit per-collection rules: the public timetable data
(`sessions`, `sessions_history`, `change_log`, `settings`, `roster`) stays
exactly as open as before, and the collections holding real people's
names/emails/reasons (`users`, `authorized_users`, `change_requests`,
`access_requests`, `admin_audit_log`) become signed-in-or-admin only.
Checked against every `.collection(...)` call in the codebase — these 10 are
the complete set.

```
rules_version = '2';

service cloud.firestore {
  match /databases/{database}/documents {

    function isSignedIn() { return request.auth != null; }
    function myRole() { return get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role; }
    function myNameLower() { return get(/databases/$(database)/documents/users/$(request.auth.uid)).data.nameLower; }
    function isAdmin() { return isSignedIn() && request.auth.token.email == 'dvmprogram@ucalgary.ca'; }
    function isApprover() { return isSignedIn() && myRole() in ['adfad','dvm_office','adc']; }

    // ── Public timetable data — unchanged: open read, admin-only write ──
    match /sessions/{id}         { allow read: if true; allow write: if isAdmin(); }
    match /sessions_history/{id} { allow read: if true; allow write: if isAdmin(); }
    match /change_log/{id}       { allow read: if true; allow write: if isAdmin(); }
    match /settings/{id}         { allow read: if true; allow write: if isAdmin(); }
    match /roster/{id}           { allow read: if true; allow write: if isAdmin(); }

    // ── Role accounts / change-request system — signed-in-or-admin only ──
    match /authorized_users/{email} {
      allow get: if isSignedIn();       // signup's own allowlist check
      allow list, write: if isAdmin();  // only you browse/edit who's authorized
    }
    match /access_requests/{id} {
      allow create: if true;            // blocked-signup fallback — not signed in yet at this point
      allow read, update: if isAdmin();
    }
    match /change_requests/{id} {
      allow create, read: if isSignedIn();
      // Faculty B (the other instructor on a swap) can accept/reject their
      // own incoming swaps, in addition to approvers/admin.
      allow update: if isApprover() || isAdmin()
        || (isSignedIn() && resource.data.facultyBNameLower == myNameLower());
    }
    match /users/{uid} {
      allow get: if isSignedIn();
      allow list: if isAdmin();  // Pending Accounts + revoke-by-email both query this collection
      allow create: if isSignedIn() && request.auth.uid == uid;
      allow update: if isAdmin();
      allow delete: if isAdmin() || (isSignedIn() && request.auth.uid == uid);  // "Delete my account"
    }
    match /admin_audit_log/{id} {
      allow create: if isAdmin() || isApprover();  // approvers write entries when they approve/reject
      allow read: if isAdmin();                    // but only you can read the trail back
    }
  }
}
```

## 2. Populate the authorized-users allowlist

Sign in as admin (**Administrator Login**, bottom bar) → **📋 Authorized
Users** in the admin banner → upload a CSV:

```csv
Email,Name,Role
cc-test@ucalgary.ca,Test CC,Course Coordinator
instructor-test@ucalgary.ca,Test Instructor,Instructor
adfad-test@ucalgary.ca,Test ADFAD,ADFAD Office
dvm-test@ucalgary.ca,Test DVM Office,DVM Program Office
adc-test@ucalgary.ca,Test ADC,ADC
```

Role can be either the label ("Course Coordinator") or the short code
("cc") — both are recognized. Re-uploading a CSV adds/updates rows by email;
it never removes anyone not in the file.

The importer also auto-detects two other real-world layouts, so you don't
have to hand-reformat an existing roster:
- **Role-grouped, no header** — a role name alone on its own row (e.g.
  "ADFAD Office"), followed by `Name,Email` rows until a blank line or the
  next role name. Matches how office rosters usually get compiled.
- **Split name columns, no Role column at all** — e.g. `Last Name,First
  Name,Email`. Since nothing in a sheet like this maps to one of the five
  roles, a picker appears above the preview letting you choose one role to
  apply to everyone in that file.

(Course Coordinator vs. Instructor makes no functional difference in the
app today — both can submit the same requests — so it's a safe default
when a file doesn't distinguish them.)

**Tip:** testing the full swap approval chain needs at least 3 distinct
accounts (requester, ADFAD, DVM Office) — one email can't hold two roles. If
you don't have spare inboxes, `+` aliases work for testing (Gmail/Outlook
still deliver these to your real inbox): `dvmprogram+cc@ucalgary.ca`,
`dvmprogram+adfad@ucalgary.ca`, `dvmprogram+dvm@ucalgary.ca`, etc.

## 3. Create the test accounts

For each row above: **Sign In** → **Need an account? Create one** → enter
name/email/password. Since the email is on the allowlist, the account
auto-activates immediately and signs them in as that role — no separate
approval step for listed emails.

## 4. Walk through a swap

Since requesting a change now requires the signed-in account's **name** to
match the session's instructor field, the requester test account needs to
be signed up with a **real instructor's name** on it — but there's no need
to use their real email for that. Firebase Auth accounts are keyed by
email, not name, so signing up as `dvmprogram+cc@ucalgary.ca` with Full
Name **"Timothy Olchowy"** (or any other real instructor already in the
data) is enough to pass the "is this your session?" check, without ever
touching that person's actual inbox or identity. Do the same for a second,
*different* real instructor's name to act as Faculty B (e.g. "Catherine
Wagg") — you need two different names to exercise the peer-acceptance step;
using the same name for both would skip straight to ADFAD (see below).

1. **As the requester test account** (named after a real instructor, e.g.
   Timothy Olchowy): click one of *their* sessions → **Request Change** →
   **Initiate a Swap**. Search for a second session taught by a *different*
   instructor, pick it, check which fields to exchange (Time, Room, Group,
   Primary/Secondary Instructor, Topic), add a note, submit.
2. **Sign out, sign in as the second instructor's test account** (Faculty
   B — e.g. Catherine Wagg): open **My Requests** — the swap appears at the
   top under "Swaps Awaiting Your Response," showing both sessions and what's
   being exchanged. Click **Accept**. (Reject is also available here, with
   an optional note explaining why — that stops the request immediately,
   before ADFAD or DVM Office ever see it.)
3. **Sign out, sign in as ADFAD:** an **Approvals** button appears in the top
   nav. Open it, find the swap, click **Approve**. This only records the
   ADFAD sign-off — the timetable doesn't change yet.
4. **Sign out, sign in as DVM Program Office:** the same swap now appears in
   *their* Approvals queue (labeled "already approved by ADFAD Office").
   Click **Approve** — this is the point it actually applies: both sessions'
   checked fields get exchanged.
5. **Verify:** refresh the calendar and confirm both sessions swapped
   correctly; check **Latest Updates** for two entries (one per session);
   sign back in as the original requester and check **My Requests** — it
   should show "Approved".

Topic changes and session-type changes skip step 2 entirely (no second
instructor's session is involved) and go straight to ADFAD → DVM Office (or
ADC, for type changes).

### Requesting only your own sessions

This match is done by comparing the signed-in account's name against the
session's Primary/Secondary Instructor text, client-side — like every other
role gate in this app, it's not enforced by Firestore rules. A signed-in
CC/Instructor account could still technically submit a request for a
session that isn't theirs by calling the API directly; the UI just never
offers them that option. Tightening this at the rules level would mean
having the rule fetch the target session document and compare names inside
the rule itself — doable, but real added complexity that wasn't built here.

## 5. Afterward

As admin, **✅ Task Checklist** (admin banner) lists approved requests so you
can check off Invite Update / DVM Hub / D2L follow-ups once done elsewhere.

## Revoking access

**📋 Authorized Users** now also shows everyone currently on the list, each
with a **Revoke** button. Revoking someone: removes them from the allowlist
(they can't sign up with that email again), and if they already had an
active account, immediately deactivates it — `users/{uid}`'s `status`
becomes `'revoked'`, and the next time that account's browser checks its
auth state, it's automatically signed back out with a toast explaining why.

One limitation: this can't touch their Firebase Auth login credentials
directly (deleting another account's login needs the Admin SDK, which this
static site doesn't have) — only their in-app access is cut off. Their
email/password still technically authenticate, they're just immediately
signed back out and treated as having no role.

## Admin Audit Log

**📜 Audit Log** (admin banner) is a chronological, admin-only record of
account/role-management actions: CSV imports, revocations, access-request
approvals/rejections, and every change-request approval-stage decision
(including the ADFAD stage-1 approval, which isn't visible anywhere else
once DVM Office's approval supersedes it). Each entry shows what happened,
when, and who did it.

This is intentionally a *separate* collection from `change_log`/Latest
Updates — that feed is public (visible to anonymous timetable viewers), and
these entries name real people, so mixing them in would leak exactly the
data the Firestore rules rewrite locked down. Approvers can write entries
(since their own approve/reject actions generate them) but only the admin
account can read the log back.

## Password reset

The Sign In modal has a **"Forgot password?"** link — enter the email,
click it, and Firebase sends a real reset email directly (no custom backend
needed for this one; it's a built-in Firebase Auth feature, unlike the
custom notification emails discussed above). This only works for
self-signup role accounts, not the shared admin account — if that
password is lost, it's still the Firebase Console reset path.

## Cleaning up test data

Revoke handles removing test *people* from the authorized list. There's
still no in-app delete for change requests themselves — those (and any
`access_requests` you want to clear out) need a manual delete in the
Firebase console under Firestore Database, in the `change_requests` and
`access_requests` collections. This is your live production database, so
clearly-named test accounts (as above) make everything easy to find.
