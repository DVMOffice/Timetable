// auth-roles.js — self-signup + role directory (Course Coordinator / Instructor /
// ADFAD Office / DVM Program Office / ADC) layered on top of app.js's Firebase
// setup. Reads window.Timetable.{db, escapeHtml, showToast} exported by app.js.
// Public/anonymous viewing of the timetable is completely unaffected — accounts
// here are only for people who need to submit or approve change requests.
(function () {
  'use strict';
  if (!window.Timetable || typeof firebase === 'undefined') return;

  const { db, escapeHtml, showToast } = window.Timetable;
  const USERS_COL = 'users';
  const AUTHORIZED_USERS_COL = 'authorized_users';
  const ACCESS_REQUESTS_COL = 'access_requests';
  const ADMIN_AUDIT_COL = 'admin_audit_log';
  const ADMIN_EMAIL = 'dvmprogram@ucalgary.ca';
  const ROLE_LABELS = {
    cc: 'Course Coordinator',
    instructor: 'Instructor',
    adfad: 'ADFAD Office',
    dvm_office: 'DVM Program Office',
    adc: 'ADC',
  };
  function normalizeRole(raw) {
    const v = String(raw || '').trim().toLowerCase();
    if (ROLE_LABELS[v]) return v;
    const byLabel = Object.entries(ROLE_LABELS).find(([, label]) => label.toLowerCase() === v);
    return byLabel ? byLabel[0] : null;
  }

  let currentUser = null;    // firebase auth user, excluding the shared admin account
  let currentProfile = null; // users/{uid} doc data
  const roleListeners = [];

  function onRoleChange(cb) { roleListeners.push(cb); cb(currentProfile); }
  function notifyRoleChange() { roleListeners.forEach(cb => cb(currentProfile)); }

  // Admin-only audit trail for account/role-management actions — CSV
  // imports, revokes, access-request decisions, and (via
  // window.Timetable.logAdminAudit, called from approvals.js) each
  // approval-stage decision on a change request. Deliberately separate from
  // change_log/Latest Updates, which is public — these events name real
  // people (who imported whom, who revoked whom), so this collection is
  // admin-read-only (see the Firestore rules in CHANGE_REQUESTS_SETUP.md).
  async function logAdminAudit(type, summary, detail) {
    const actorUser = firebase.auth().currentUser;
    try {
      await db.collection(ADMIN_AUDIT_COL).add({
        type, summary, detail: detail || null,
        actor: actorUser ? { uid: actorUser.uid, email: actorUser.email } : null,
        at: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } catch (err) {
      console.error('[auth-roles] audit log write failed', err);
    }
  }

  function modalEl() { return document.getElementById('modal'); }
  function closeModal() { const m = modalEl(); m.classList.remove('open'); m.innerHTML = ''; }
  function wireModalChrome(extraCloseIds) {
    document.getElementById('modal-close').onclick = closeModal;
    document.getElementById('modal-backdrop').onclick = closeModal;
    (extraCloseIds || []).forEach(id => {
      const el = document.getElementById(id);
      if (el) el.onclick = closeModal;
    });
  }

  // Password field with a Show/Hide reveal toggle — used on both sign-in and
  // sign-up. Call wirePasswordToggle(id) after inserting this into the DOM.
  function passwordFieldHtml(id, extraAttrs) {
    return `<div style="position:relative">
      <input class="form-input" id="${id}" type="password" required${extraAttrs || ''} style="padding-right:56px">
      <button type="button" id="${id}-toggle" style="position:absolute;right:6px;top:50%;transform:translateY(-50%);padding:2px 4px;background:none;border:none;cursor:pointer;font-size:11px;font-weight:700;color:var(--accent)">Show</button>
    </div>`;
  }
  function wirePasswordToggle(id) {
    const input = document.getElementById(id);
    const btn = document.getElementById(`${id}-toggle`);
    btn.onclick = () => {
      const showing = input.type === 'text';
      input.type = showing ? 'password' : 'text';
      btn.textContent = showing ? 'Show' : 'Hide';
    };
  }

  // ════════════════════════════════════════════════════════════
  // NAVBAR BUTTON
  // ════════════════════════════════════════════════════════════
  function ensureNavButton() {
    if (document.getElementById('role-account-btn')) { updateNavButton(); return; }
    const actions = document.querySelector('.navbar-actions');
    if (!actions) return;
    const btn = document.createElement('button');
    btn.className = 'admin-login-btn';
    btn.id = 'role-account-btn';
    actions.insertBefore(btn, actions.firstChild);
    btn.addEventListener('click', () => { currentUser ? openAccountMenu() : openSignInModal(); });
    updateNavButton();
  }

  function updateNavButton() {
    const btn = document.getElementById('role-account-btn');
    if (!btn) return;
    if (!currentUser) { btn.textContent = 'Sign In'; btn.classList.remove('is-admin'); return; }
    const label = currentProfile
      ? (currentProfile.status === 'active' ? (ROLE_LABELS[currentProfile.role] || currentProfile.role)
         : currentProfile.status === 'revoked' ? 'Access revoked'
         : 'Pending approval')
      : '…';
    btn.textContent = `${currentProfile && currentProfile.name ? currentProfile.name : currentUser.email} (${label})`;
    btn.classList.toggle('is-admin', !!currentProfile && currentProfile.status === 'active');
  }

  function openAccountMenu() {
    modalEl().innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header">
          <div class="modal-title">My Account</div>
          <div class="modal-subtitle">${escapeHtml(currentUser.email)}</div>
        </div>
        <div class="modal-body">
          <span class="save-status" id="account-menu-status"></span>
        </div>
        <div class="modal-footer">
          <button class="btn-danger-text" id="delete-account-btn" type="button">Delete my account</button>
          <div style="display:flex;gap:10px">
            <button class="btn btn-secondary" id="modal-cancel-btn" type="button">Cancel</button>
            <button class="btn btn-primary" id="sign-out-btn" type="button">Sign Out</button>
          </div>
        </div>
      </div>`;
    modalEl().classList.add('open');
    wireModalChrome(['modal-cancel-btn']);
    document.getElementById('sign-out-btn').onclick = () => {
      firebase.auth().signOut().then(() => { closeModal(); showToast('Signed out'); });
    };
    document.getElementById('delete-account-btn').onclick = async () => {
      if (!confirm(`Permanently delete this account (${currentUser.email})?\n\nThis removes your login and profile entirely — you'd need to sign up again from scratch to use it. This cannot be undone.`)) return;
      const statusEl = document.getElementById('account-menu-status');
      statusEl.className = 'save-status saving'; statusEl.textContent = 'Deleting…';
      const uid = currentUser.uid;
      // Delete the Firestore profile FIRST, while still authenticated — the
      // rule that allows this only matches the signed-in user's own uid, so
      // it must happen before the auth account (and request.auth) is gone.
      try { await db.collection(USERS_COL).doc(uid).delete(); }
      catch (err) { console.error('[auth-roles] profile delete failed (continuing to auth delete)', err); }
      try {
        await firebase.auth().currentUser.delete();
        closeModal();
        showToast('Account deleted');
      } catch (err) {
        console.error('[auth-roles] account delete failed', err);
        statusEl.className = 'save-status error';
        statusEl.textContent = err.code === 'auth/requires-recent-login'
          ? 'For security, sign out and back in, then try deleting again right away'
          : 'Could not delete — try again';
      }
    };
  }

  // ════════════════════════════════════════════════════════════
  // SIGN IN
  // ════════════════════════════════════════════════════════════
  function openSignInModal() {
    modalEl().innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header">
          <div class="modal-title">Sign In</div>
          <div class="modal-subtitle">Course Coordinators, Instructors, and approvers sign in here</div>
        </div>
        <div class="modal-body">
          <form id="signin-form">
            <div class="form-grid">
              <div class="form-field full"><label class="form-label">Email</label><input class="form-input" id="si-email" type="email" required></div>
              <div class="form-field full">
                <label class="form-label">Password</label>
                ${passwordFieldHtml('si-password')}
                <button type="button" id="forgot-password-btn" class="btn-danger-text" style="padding:4px 0 0;font-size:11.5px">Forgot password?</button>
              </div>
            </div>
            <span class="save-status" id="signin-status"></span>
          </form>
        </div>
        <div class="modal-footer">
          <button class="btn-danger-text" id="goto-signup-btn" type="button">Need an account? Create one</button>
          <div style="display:flex;gap:10px">
            <button class="btn btn-secondary" id="modal-cancel-btn" type="button">Cancel</button>
            <button class="btn btn-primary" type="submit" form="signin-form">Sign In</button>
          </div>
        </div>
      </div>`;
    modalEl().classList.add('open');
    wireModalChrome(['modal-cancel-btn']);
    wirePasswordToggle('si-password');
    document.getElementById('goto-signup-btn').onclick = openSignUpModal;
    document.getElementById('forgot-password-btn').onclick = async () => {
      const status = document.getElementById('signin-status');
      const email = document.getElementById('si-email').value.trim();
      if (!email) { status.className = 'save-status error'; status.textContent = 'Enter your email above first'; return; }
      status.className = 'save-status saving'; status.textContent = 'Sending reset email…';
      try {
        await firebase.auth().sendPasswordResetEmail(email);
        status.className = 'save-status success';
        status.textContent = `Password reset email sent to ${email} — check your inbox`;
      } catch (err) {
        console.error('[auth-roles] password reset error', err);
        status.className = 'save-status error';
        // Firebase deliberately doesn't reveal auth/user-not-found here — that
        // would let anyone probe which emails have accounts.
        status.textContent = err.code === 'auth/invalid-email'
          ? 'That email address looks invalid'
          : 'If an account exists for that email, a reset link was sent';
      }
    };
    document.getElementById('signin-form').addEventListener('submit', async e => {
      e.preventDefault();
      const status = document.getElementById('signin-status');
      const email = document.getElementById('si-email').value.trim();
      const password = document.getElementById('si-password').value;
      status.className = 'save-status saving'; status.textContent = 'Signing in…';
      try {
        await firebase.auth().signInWithEmailAndPassword(email, password);
        closeModal();
        showToast('Signed in');
      } catch (err) {
        console.error('[auth-roles] sign-in error', err);
        status.className = 'save-status error';
        status.textContent = (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential' || err.code === 'auth/user-not-found')
          ? 'Incorrect email or password — use "Forgot password?" below if needed'
          : 'Sign-in failed — try again';
      }
    });
  }

  // ════════════════════════════════════════════════════════════
  // SIGN UP (self-signup, stays pending until admin approves)
  // ════════════════════════════════════════════════════════════
  function openSignUpModal() {
    modalEl().innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header">
          <div class="modal-title">Create Account</div>
          <div class="modal-subtitle">Your email must already be on the DVM Program Office's authorized list.</div>
        </div>
        <div class="modal-body">
          <form id="signup-form">
            <div class="form-grid">
              <div class="form-field full"><label class="form-label">Full Name</label><input class="form-input" id="su-name" required></div>
              <div class="form-field full"><label class="form-label">Email</label><input class="form-input" id="su-email" type="email" required></div>
              <div class="form-field full"><label class="form-label">Password</label>${passwordFieldHtml('su-password', ' minlength="6"')}</div>
            </div>
            <span class="save-status" id="signup-status"></span>
          </form>
        </div>
        <div class="modal-footer">
          <button class="btn-danger-text" id="goto-signin-btn" type="button">Already have an account? Sign in</button>
          <div style="display:flex;gap:10px">
            <button class="btn btn-secondary" id="modal-cancel-btn" type="button">Cancel</button>
            <button class="btn btn-primary" type="submit" form="signup-form">Create Account</button>
          </div>
        </div>
      </div>`;
    modalEl().classList.add('open');
    wireModalChrome(['modal-cancel-btn']);
    wirePasswordToggle('su-password');
    document.getElementById('goto-signin-btn').onclick = openSignInModal;
    document.getElementById('signup-form').addEventListener('submit', async e => {
      e.preventDefault();
      const status = document.getElementById('signup-status');
      const name = document.getElementById('su-name').value.trim();
      const email = document.getElementById('su-email').value.trim();
      const password = document.getElementById('su-password').value;
      status.className = 'save-status saving'; status.textContent = 'Creating account…';

      let cred;
      try {
        cred = await firebase.auth().createUserWithEmailAndPassword(email, password);
      } catch (err) {
        console.error('[auth-roles] sign-up error', err);
        status.className = 'save-status error';
        status.textContent = err.code === 'auth/email-already-in-use'
          ? 'An account with this email already exists'
          : (err.message || 'Could not create account');
        return;
      }

      // The allowlist check needs to run as an authenticated read (Firestore
      // rules can't safely let a signed-out visitor probe authorized_users),
      // so the Firebase Auth account is created FIRST, then deleted again
      // right away if the email turns out not to be authorized — from the
      // requester's side this still reads as one blocked signup, not two steps.
      try {
        status.textContent = 'Checking authorization…';
        const authDoc = await db.collection(AUTHORIZED_USERS_COL).doc(email.toLowerCase()).get();
        if (!authDoc.exists) {
          await cred.user.delete();
          status.className = 'save-status error';
          status.innerHTML = `This email isn't authorized. <button type="button" id="request-access-btn" class="btn-danger-text" style="text-decoration:underline;padding:0">Request Access</button>`;
          document.getElementById('request-access-btn').onclick = () => openAccessRequestForm({ name, email });
          return;
        }
        const role = authDoc.data().role;
        // Email lowercased consistently with the authorized_users doc ID, so
        // a later admin lookup by email (e.g. revoking access) matches
        // regardless of what case the person typed at signup. nameLower
        // uses app.js's shared word-order-insensitive normalizer (so
        // "Hall David" and "David Hall" are the same person) — Firestore
        // rules match against this to check "am I the instructor named on
        // this swap" without needing a .lower() call inside the rule
        // itself; change-requests.js normalizes a swap's facultyBNameLower
        // identically, so all three stay in agreement.
        const nameLower = window.Timetable.normalizeNameForMatch ? window.Timetable.normalizeNameForMatch(name) : name.trim().toLowerCase();
        const profile = { email: email.toLowerCase(), name, nameLower, role, requestedRole: role, status: 'active' };
        await db.collection(USERS_COL).doc(cred.user.uid).set({
          ...profile,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          reviewedBy: 'auto (authorized list)', reviewedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        // onAuthStateChanged already fired (with no users/{uid} doc to read
        // yet) by the time this write completes, so it won't pick this up on
        // its own — update the local profile state directly so the nav
        // button and My Requests/Approvals buttons reflect it immediately
        // instead of only after a refresh.
        currentUser = cred.user;
        currentProfile = profile;
        updateNavButton();
        notifyRoleChange();
        closeModal();
        showToast(`Account created — you're signed in as ${ROLE_LABELS[role] || role}`);
      } catch (err) {
        console.error('[auth-roles] authorization check failed', err);
        try { await cred.user.delete(); } catch (delErr) { console.error('[auth-roles] rollback delete failed', delErr); }
        status.className = 'save-status error';
        status.textContent = 'Could not verify authorization — try again';
      }
    });
  }

  // ════════════════════════════════════════════════════════════
  // REQUEST ACCESS (fallback for a genuine staff/instructor whose email
  // isn't on the authorized list yet — queues a request for the admin
  // instead of leaving them at a dead-end error)
  // ════════════════════════════════════════════════════════════
  function openAccessRequestForm(prefill) {
    const roleOptions = Object.entries(ROLE_LABELS).map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join('');
    modalEl().innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header">
          <div class="modal-title">Request Access</div>
          <div class="modal-subtitle">The DVM Program Office will review this and add you to the authorized list</div>
        </div>
        <div class="modal-body">
          <form id="ar-form">
            <div class="form-grid">
              <div class="form-field full"><label class="form-label">Full Name</label><input class="form-input" id="ar-name" value="${escapeHtml(prefill.name || '')}" required></div>
              <div class="form-field full"><label class="form-label">Email</label><input class="form-input" id="ar-email" type="email" value="${escapeHtml(prefill.email || '')}" required></div>
              <div class="form-field full"><label class="form-label">What Best Describes You</label>
                <select class="form-select" id="ar-role">${roleOptions}</select>
              </div>
              <div class="form-field full"><label class="form-label">Note (optional)</label><textarea class="form-textarea" id="ar-note" placeholder="e.g. department, course you teach"></textarea></div>
            </div>
            <span class="save-status" id="ar-status"></span>
          </form>
        </div>
        <div class="modal-footer">
          <div></div>
          <div style="display:flex;gap:10px">
            <button class="btn btn-secondary" id="ar-cancel-btn" type="button">Cancel</button>
            <button class="btn btn-primary" type="submit" form="ar-form">Submit Request</button>
          </div>
        </div>
      </div>`;
    modalEl().classList.add('open');
    wireModalChrome(['ar-cancel-btn']);
    document.getElementById('ar-form').addEventListener('submit', async e => {
      e.preventDefault();
      const status = document.getElementById('ar-status');
      const name = document.getElementById('ar-name').value.trim();
      const email = document.getElementById('ar-email').value.trim().toLowerCase();
      const claimedRole = document.getElementById('ar-role').value;
      const note = document.getElementById('ar-note').value.trim();
      status.className = 'save-status saving'; status.textContent = 'Submitting…';
      try {
        await db.collection(ACCESS_REQUESTS_COL).add({
          name, email, claimedRole, note, status: 'pending',
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        closeModal();
        showToast('Access request submitted — the DVM Program Office will review it.');
      } catch (err) {
        console.error('[auth-roles] access request failed', err);
        status.className = 'save-status error';
        status.textContent = 'Could not submit — try again';
      }
    });
  }

  // ════════════════════════════════════════════════════════════
  // ADMIN: ACCESS REQUESTS PANEL — approving one adds the person straight
  // to authorized_users (a one-off equivalent of a CSV import row); they
  // still have to go back and complete signup themselves afterward.
  // ════════════════════════════════════════════════════════════
  async function openAccessRequests() {
    modalEl().innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header"><div class="modal-title">Access Requests</div></div>
        <div class="modal-body" id="ar-list-body">Loading…</div>
        <div class="modal-footer"><div></div><button class="btn btn-secondary" id="ar-list-close-btn">Close</button></div>
      </div>`;
    modalEl().classList.add('open');
    wireModalChrome(['ar-list-close-btn']);

    let snap;
    try {
      snap = await db.collection(ACCESS_REQUESTS_COL).where('status', '==', 'pending').get();
    } catch (err) {
      console.error('[auth-roles] access requests fetch failed', err);
      document.getElementById('ar-list-body').innerHTML = '<div style="color:var(--danger);font-size:13px">Could not load access requests.</div>';
      return;
    }
    const body = document.getElementById('ar-list-body');
    if (snap.empty) { body.innerHTML = '<div style="color:var(--text-3);font-size:13px">No pending access requests.</div>'; return; }
    const roleOptions = Object.entries(ROLE_LABELS).map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join('');
    body.innerHTML = snap.docs.map(doc => {
      const r = doc.data();
      return `
        <div class="detail-row" style="align-items:center;flex-wrap:wrap;gap:8px">
          <span class="detail-value" style="flex:1 1 220px">
            <strong>${escapeHtml(r.name || '')}</strong><br>
            <span style="color:var(--text-3);font-size:12px">${escapeHtml(r.email || '')} · claims ${escapeHtml(ROLE_LABELS[r.claimedRole] || r.claimedRole || '')}${r.note ? ` · ${escapeHtml(r.note)}` : ''}</span>
          </span>
          <select class="form-select" id="ar-role-${doc.id}" style="width:auto">${roleOptions}</select>
          <button class="btn btn-primary" data-approve="${doc.id}">Add & Approve</button>
          <button class="btn-danger-text" data-reject="${doc.id}">Reject</button>
        </div>`;
    }).join('');
    snap.docs.forEach(doc => {
      const sel = document.getElementById(`ar-role-${doc.id}`);
      const claimed = doc.data().claimedRole;
      if (sel && claimed) sel.value = claimed;
    });
    body.querySelectorAll('[data-approve]').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.approve;
        const reqDoc = snap.docs.find(d => d.id === id);
        const { email, name } = reqDoc.data();
        const role = document.getElementById(`ar-role-${id}`).value;
        try {
          const batch = db.batch();
          batch.set(db.collection(AUTHORIZED_USERS_COL).doc(email), { email, name, role, importedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
          batch.update(db.collection(ACCESS_REQUESTS_COL).doc(id), {
            status: 'fulfilled',
            reviewedBy: (firebase.auth().currentUser && firebase.auth().currentUser.email) || '',
            reviewedAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
          await batch.commit();
          showToast('Added to authorized list — they can now sign up');
          logAdminAudit('access_request_approved', `Approved access request for ${name || email} as ${ROLE_LABELS[role] || role}`, { email, name, role });
          openAccessRequests();
        } catch (err) {
          console.error('[auth-roles] access request approve failed', err);
          showToast('Could not approve — try again', true);
        }
      };
    });
    body.querySelectorAll('[data-reject]').forEach(btn => {
      btn.onclick = async () => {
        if (!confirm('Reject this access request?')) return;
        const id = btn.dataset.reject;
        const reqDoc = snap.docs.find(d => d.id === id);
        const { email, name } = reqDoc.data();
        try {
          await db.collection(ACCESS_REQUESTS_COL).doc(id).update({
            status: 'rejected',
            reviewedBy: (firebase.auth().currentUser && firebase.auth().currentUser.email) || '',
            reviewedAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
          showToast('Access request rejected');
          logAdminAudit('access_request_rejected', `Rejected access request for ${name || email}`, { email, name });
          openAccessRequests();
        } catch (err) {
          console.error('[auth-roles] access request reject failed', err);
          showToast('Could not reject — try again', true);
        }
      };
    });
  }

  // ════════════════════════════════════════════════════════════
  // ADMIN: PENDING ACCOUNTS PANEL (wired from app.js's admin banner)
  // ════════════════════════════════════════════════════════════
  async function openPendingAccounts() {
    modalEl().innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header"><div class="modal-title">Pending Accounts</div></div>
        <div class="modal-body" id="pending-accounts-body">Loading…</div>
        <div class="modal-footer"><div></div><button class="btn btn-secondary" id="pa-close-btn">Close</button></div>
      </div>`;
    modalEl().classList.add('open');
    wireModalChrome(['pa-close-btn']);

    let snap;
    try {
      snap = await db.collection(USERS_COL).where('status', '==', 'pending').get();
    } catch (err) {
      console.error('[auth-roles] pending accounts fetch failed', err);
      document.getElementById('pending-accounts-body').innerHTML = '<div style="color:var(--danger);font-size:13px">Could not load pending accounts.</div>';
      return;
    }
    const body = document.getElementById('pending-accounts-body');
    if (snap.empty) {
      body.innerHTML = '<div style="color:var(--text-3);font-size:13px">No pending accounts.</div>';
      return;
    }
    const roleOptions = Object.entries(ROLE_LABELS).map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join('');
    body.innerHTML = snap.docs.map(doc => {
      const u = doc.data();
      return `
        <div class="detail-row" style="align-items:center;flex-wrap:wrap;gap:8px">
          <span class="detail-value" style="flex:1 1 220px">
            <strong>${escapeHtml(u.name || '')}</strong><br>
            <span style="color:var(--text-3);font-size:12px">${escapeHtml(u.email || '')} · requested ${escapeHtml(ROLE_LABELS[u.requestedRole] || u.requestedRole || '')}</span>
          </span>
          <select class="form-select" id="pa-role-${doc.id}" style="width:auto">${roleOptions}</select>
          <button class="btn btn-primary" data-approve="${doc.id}">Approve</button>
          <button class="btn-danger-text" data-reject="${doc.id}">Reject</button>
        </div>`;
    }).join('');
    snap.docs.forEach(doc => {
      const sel = document.getElementById(`pa-role-${doc.id}`);
      const requested = doc.data().requestedRole;
      if (sel && requested) sel.value = requested;
    });
    body.querySelectorAll('[data-approve]').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.dataset.approve;
        const role = document.getElementById(`pa-role-${id}`).value;
        try {
          await db.collection(USERS_COL).doc(id).update({
            role, status: 'active',
            reviewedBy: (firebase.auth().currentUser && firebase.auth().currentUser.email) || '',
            reviewedAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
          showToast('Account approved');
          openPendingAccounts();
        } catch (err) {
          console.error('[auth-roles] approve failed', err);
          showToast('Could not approve — try again', true);
        }
      };
    });
    body.querySelectorAll('[data-reject]').forEach(btn => {
      btn.onclick = async () => {
        if (!confirm('Reject this account request?')) return;
        const id = btn.dataset.reject;
        try {
          await db.collection(USERS_COL).doc(id).update({
            status: 'rejected',
            reviewedBy: (firebase.auth().currentUser && firebase.auth().currentUser.email) || '',
            reviewedAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
          showToast('Account rejected');
          openPendingAccounts();
        } catch (err) {
          console.error('[auth-roles] reject failed', err);
          showToast('Could not reject — try again', true);
        }
      };
    });
  }

  // ════════════════════════════════════════════════════════════
  // ADMIN: AUTHORIZED USERS CSV IMPORT (the allowlist self-signup checks
  // against — wired from app.js's admin banner)
  // ════════════════════════════════════════════════════════════
  const AU_FIELD_ALIASES = {
    email: ['email', 'e-mail', 'email address'],
    name: ['name', 'full name'],
    firstName: ['first name', 'firstname', 'given name'],
    lastName: ['last name', 'lastname', 'surname'],
    role: ['role', 'access', 'access level', 'position'],
  };
  // Two supported layouts, auto-detected from the first row:
  //  1. Flat, with a header row: Email, plus either a Name column or split
  //     First Name/Last Name columns, plus optionally a Role column. When
  //     there's no Role column at all, every row comes back in `invalid`
  //     with hasRoleColumn:false on the result — the import UI then offers
  //     a "apply this role to everyone in the file" picker and re-parses
  //     with defaultRole set, rather than rejecting the whole file.
  //  2. Role-grouped, no header: a row with just a role name (e.g. "ADFAD
  //     Office") in column A, blank column B, applies to every Name,Email
  //     row below it until the next role-name row or a blank separator row.
  //     This matches how staff lists actually get compiled in practice —
  //     one section per office, pasted straight out of a spreadsheet — so
  //     admins don't have to hand-reformat a real roster into three flat
  //     columns before it'll import.
  function mapCsvToAuthorizedUsers(rows, defaultRole) {
    if (!rows.length) return { valid: [], invalid: [], hasRoleColumn: true };
    const firstRowCells = rows[0].map(h => (h || '').trim().toLowerCase());
    const hasHeaderRow = firstRowCells.some(h => AU_FIELD_ALIASES.email.includes(h));
    return hasHeaderRow ? mapFlatAuRows(rows, defaultRole) : { ...mapRoleGroupedAuRows(rows), hasRoleColumn: true };
  }

  function mapFlatAuRows(rows, defaultRole) {
    const headers = rows[0].map(h => h.trim().toLowerCase());
    const fieldForHeader = {};
    headers.forEach((h, i) => { for (const [f, aliases] of Object.entries(AU_FIELD_ALIASES)) if (aliases.includes(h)) { fieldForHeader[i] = f; break; } });
    const hasRoleColumn = Object.values(fieldForHeader).includes('role');
    const valid = [], invalid = [];
    rows.slice(1).forEach(cells => {
      const row = {};
      cells.forEach((val, i) => { const f = fieldForHeader[i]; if (f) row[f] = (val || '').trim(); });
      const name = row.name || [row.firstName, row.lastName].filter(Boolean).join(' ');
      if (!row.email && !name && !row.role) return; // blank line
      const role = normalizeRole(row.role) || (!hasRoleColumn ? defaultRole : null);
      if (row.email && role) valid.push({ email: row.email.toLowerCase(), name, role });
      else invalid.push({ email: row.email || '', name, role: row.role || '', reason: !row.email ? 'Missing email' : !hasRoleColumn ? 'No role column — pick a default role above' : 'Unrecognized role' });
    });
    return { valid, invalid, hasRoleColumn };
  }

  function mapRoleGroupedAuRows(rows) {
    const valid = [], invalid = [];
    let currentRole = null, currentRoleLabel = '';
    rows.forEach(cells => {
      const col0 = (cells[0] || '').trim();
      const col1 = (cells[1] || '').trim();
      if (!col0 && !col1) return; // blank separator row between sections
      if (col0 && !col1) {
        // A lone value in column A with nothing in column B is a section
        // header naming the role for the rows that follow.
        const role = normalizeRole(col0);
        if (role) { currentRole = role; currentRoleLabel = col0; return; }
        invalid.push({ email: '', name: col0, role: '', reason: `"${col0}" isn't a recognized role name — rows under it are skipped until the next valid section` });
        currentRole = null;
        return;
      }
      if (!col0) { invalid.push({ email: col1, name: '', role: currentRoleLabel, reason: 'Missing name' }); return; }
      if (!currentRole) { invalid.push({ email: col1, name: col0, role: '', reason: 'No recognized role section above this row' }); return; }
      if (!col1.includes('@')) { invalid.push({ email: col1, name: col0, role: currentRoleLabel, reason: 'Email looks invalid' }); return; }
      valid.push({ email: col1.toLowerCase(), name: col0, role: currentRole });
    });
    return { valid, invalid };
  }

  async function revokeAuthorizedUser(email, name) {
    if (!confirm(`Revoke access for ${name || email}?\n\nThey won't be able to sign up with this email again. If they already have an active account, it will be deactivated immediately (they'll be signed out next time the app checks).`)) return;
    try {
      const batch = db.batch();
      batch.delete(db.collection(AUTHORIZED_USERS_COL).doc(email));
      const usersSnap = await db.collection(USERS_COL).where('email', '==', email).get();
      usersSnap.docs.forEach(doc => {
        batch.update(doc.ref, {
          status: 'revoked',
          revokedAt: firebase.firestore.FieldValue.serverTimestamp(),
          revokedBy: (firebase.auth().currentUser && firebase.auth().currentUser.email) || '',
        });
      });
      await batch.commit();
      showToast('Access revoked');
      logAdminAudit('authorized_user_revoked', `Revoked access for ${name || email}`, { email, name });
      await renderCurrentAuthorizedUsers();
    } catch (err) {
      console.error('[auth-roles] revoke failed', err);
      showToast('Could not revoke — try again', true);
    }
  }

  async function renderCurrentAuthorizedUsers() {
    const el = document.getElementById('au-current');
    if (!el) return;
    el.innerHTML = 'Loading…';
    let snap;
    try {
      snap = await db.collection(AUTHORIZED_USERS_COL).get();
    } catch (err) {
      console.error('[auth-roles] authorized-users list fetch failed', err);
      el.innerHTML = '<div style="color:var(--danger);font-size:13px">Could not load the current list.</div>';
      return;
    }
    if (snap.empty) { el.innerHTML = '<div style="color:var(--text-3);font-size:13px">No one is on the authorized list yet.</div>'; return; }
    const docs = snap.docs.slice().sort((a, b) => (a.data().name || a.data().email || '').localeCompare(b.data().name || b.data().email || ''));
    el.innerHTML = docs.map(doc => {
      const u = doc.data();
      return `<div class="detail-row" style="align-items:center;flex-wrap:wrap;gap:8px">
        <span class="detail-value" style="flex:1 1 220px">
          <strong>${escapeHtml(u.name || '')}</strong><br>
          <span style="color:var(--text-3);font-size:12px">${escapeHtml(u.email || '')} · ${escapeHtml(ROLE_LABELS[u.role] || u.role || '')}</span>
        </span>
        <button class="btn-danger-text" data-revoke="${doc.id}">Revoke</button>
      </div>`;
    }).join('');
    el.querySelectorAll('[data-revoke]').forEach(btn => {
      btn.onclick = () => {
        const u = docs.find(d => d.id === btn.dataset.revoke).data();
        revokeAuthorizedUser(btn.dataset.revoke, u.name);
      };
    });
  }

  function openAuthorizedUsersImport() {
    modalEl().innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box" style="width:min(720px,94vw)">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header"><div class="modal-title">📋 Authorized Users</div>
          <div class="modal-subtitle">CSV columns: Email, Name (optional), Role (${Object.values(ROLE_LABELS).join(' / ')}). Existing entries not in this file are left untouched.</div></div>
        <div class="modal-body">
          <div class="form-field full"><input type="file" accept=".csv" id="au-file-input" class="form-input" /></div>
          <div class="form-field full" id="au-role-picker" style="display:none;background:var(--surface-2);border-radius:8px;padding:10px 12px">
            <label class="form-label">This file has no Role column — apply one role to everyone in it</label>
            <div style="display:flex;gap:8px;align-items:center">
              <select class="form-select" id="au-default-role" style="width:auto;flex:1">${Object.entries(ROLE_LABELS).map(([v, l]) => `<option value="${v}">${escapeHtml(l)}</option>`).join('')}</select>
              <button class="btn btn-secondary" id="au-apply-role-btn" type="button">Apply</button>
            </div>
          </div>
          <div id="au-preview"></div>
          <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--border)">
            <label class="form-label">Currently Authorized</label>
            <div id="au-current" style="max-height:220px;overflow-y:auto;margin-top:6px">Loading…</div>
          </div>
        </div>
        <div class="modal-footer"><div></div>
          <div style="display:flex;align-items:center;gap:12px">
            <span class="save-status" id="au-status"></span>
            <button class="btn btn-secondary" id="au-cancel-btn">Cancel</button>
            <button class="btn btn-primary" id="au-confirm-btn" disabled>Import</button>
          </div>
        </div>
      </div>`;
    modalEl().classList.add('open');
    wireModalChrome(['au-cancel-btn']);
    renderCurrentAuthorizedUsers();

    let parsed = { valid: [], invalid: [] };
    let rawRows = [];
    document.getElementById('au-file-input').addEventListener('change', e => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        rawRows = window.Timetable.parseCSV(ev.target.result);
        parsed = mapCsvToAuthorizedUsers(rawRows);
        document.getElementById('au-role-picker').style.display = parsed.hasRoleColumn ? 'none' : '';
        renderPreview();
        document.getElementById('au-confirm-btn').disabled = parsed.valid.length === 0;
      };
      reader.readAsText(file);
    });

    document.getElementById('au-apply-role-btn').addEventListener('click', () => {
      const defaultRole = document.getElementById('au-default-role').value;
      parsed = mapCsvToAuthorizedUsers(rawRows, defaultRole);
      renderPreview();
      document.getElementById('au-confirm-btn').disabled = parsed.valid.length === 0;
    });

    function renderPreview() {
      const el = document.getElementById('au-preview');
      if (!parsed.valid.length && !parsed.invalid.length) { el.innerHTML = `<div style="padding:14px;text-align:center;color:var(--danger);font-size:12.5px">No rows found.</div>`; return; }
      const rows = [
        ...parsed.valid.map(r => `<tr style="border-top:1px solid var(--border)"><td>${escapeHtml(r.email)}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(ROLE_LABELS[r.role])}</td><td style="color:var(--success)">OK</td></tr>`),
        ...parsed.invalid.map(r => `<tr style="border-top:1px solid var(--border)"><td>${escapeHtml(r.email)}</td><td>${escapeHtml(r.name)}</td><td>${escapeHtml(r.role)}</td><td style="color:var(--danger)">${escapeHtml(r.reason)}</td></tr>`),
      ].join('');
      el.innerHTML = `<div style="font-size:12px;color:var(--text-3);margin:8px 0"><strong>${parsed.valid.length}</strong> ready to import${parsed.invalid.length ? `, <strong>${parsed.invalid.length}</strong> skipped (see reason column)` : ''}.</div>
        <div style="overflow-x:auto;max-height:280px;overflow-y:auto;border:1px solid var(--border);border-radius:6px">
          <table class="import-preview-table" style="width:100%;border-collapse:collapse">
            <thead><tr style="background:var(--surface-2)"><th>Email</th><th>Name</th><th>Role</th><th>Status</th></tr></thead>
            <tbody>${rows}</tbody>
          </table></div>`;
    }

    document.getElementById('au-confirm-btn').onclick = async () => {
      const statusEl = document.getElementById('au-status');
      const btn = document.getElementById('au-confirm-btn');
      btn.disabled = true; statusEl.className = 'save-status saving';
      const BATCH_SIZE = 400;
      let imported = 0;
      for (let i = 0; i < parsed.valid.length; i += BATCH_SIZE) {
        const chunk = parsed.valid.slice(i, i + BATCH_SIZE);
        statusEl.textContent = `Importing ${Math.min(i + BATCH_SIZE, parsed.valid.length)} of ${parsed.valid.length}…`;
        const batch = db.batch();
        chunk.forEach(r => {
          batch.set(db.collection(AUTHORIZED_USERS_COL).doc(r.email), {
            email: r.email, name: r.name, role: r.role,
            importedAt: firebase.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        });
        try { await batch.commit(); imported += chunk.length; }
        catch (err) { console.error('[auth-roles] authorized-users import batch failed', err); }
      }
      statusEl.className = imported === parsed.valid.length ? 'save-status success' : 'save-status error';
      statusEl.textContent = `Imported ${imported} of ${parsed.valid.length}`;
      showToast(`Authorized users list updated — ${imported} imported`);
      if (imported > 0) {
        logAdminAudit('authorized_users_import', `Imported ${imported} authorized user(s)`,
          { entries: parsed.valid.slice(0, imported).map(r => ({ email: r.email, name: r.name, role: r.role })) });
      }
      btn.disabled = false;
      await renderCurrentAuthorizedUsers();
    };
  }

  // ════════════════════════════════════════════════════════════
  // ADMIN: AUDIT LOG — read-only view of admin_audit_log, the
  // account/role-management trail that's deliberately kept separate from
  // change_log/Latest Updates (which is public and session-scoped). Fed by
  // logAdminAudit() calls here and from approvals.js. Wired from app.js's
  // admin banner.
  // ════════════════════════════════════════════════════════════
  const AUDIT_TYPE_LABEL = {
    authorized_users_import: '📋 Authorized users imported',
    authorized_user_revoked: '🚫 Access revoked',
    access_request_approved: '🙋 Access request approved',
    access_request_rejected: '🙋 Access request rejected',
    change_request_adfad_approved: '✅ ADFAD approved',
    change_request_dvm_approved: '✅ DVM Program Office approved',
    change_request_adc_approved: '✅ ADC approved',
    change_request_rejected: '❌ Change request rejected',
  };
  async function openAdminAuditLog() {
    modalEl().innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box" style="width:min(720px,96vw)">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header"><div class="modal-title">📜 Admin Audit Log</div>
          <div class="modal-subtitle">Account/role-management actions — imports, revokes, access requests, and approval-stage decisions</div></div>
        <div class="modal-body" id="audit-log-body">Loading…</div>
        <div class="modal-footer"><div></div><button class="btn btn-secondary" id="audit-log-close-btn">Close</button></div>
      </div>`;
    modalEl().classList.add('open');
    wireModalChrome(['audit-log-close-btn']);

    const body = document.getElementById('audit-log-body');
    let snap;
    try {
      snap = await db.collection(ADMIN_AUDIT_COL).get();
    } catch (err) {
      console.error('[auth-roles] audit log fetch failed', err);
      body.innerHTML = '<div style="color:var(--danger);font-size:13px">Could not load the audit log.</div>';
      return;
    }
    if (snap.empty) { body.innerHTML = '<div style="color:var(--text-3);font-size:13px">No admin actions logged yet.</div>'; return; }
    const docs = snap.docs.slice().sort((a, b) => (b.data().at?.toMillis?.() || 0) - (a.data().at?.toMillis?.() || 0)).slice(0, 100);
    body.innerHTML = docs.map(doc => {
      const e = doc.data();
      const when = e.at?.toDate ? e.at.toDate() : null;
      const whenStr = when ? when.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) + ' at ' + when.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' }) : '—';
      return `<div class="detail-row" style="flex-direction:column;align-items:stretch;gap:2px">
        <div style="display:flex;justify-content:space-between;gap:8px">
          <strong>${escapeHtml(AUDIT_TYPE_LABEL[e.type] || e.type)}</strong>
          <span style="color:var(--text-3);font-size:12px">${whenStr}</span>
        </div>
        <div style="font-size:12.5px">${escapeHtml(e.summary || '')}</div>
        <div style="font-size:11.5px;color:var(--text-3)">by ${escapeHtml(e.actor?.email || 'unknown')}</div>
      </div>`;
    }).join('');
  }

  // ════════════════════════════════════════════════════════════
  // AUTH STATE
  // ════════════════════════════════════════════════════════════
  firebase.auth().onAuthStateChanged(async user => {
    // The shared admin account is handled entirely by app.js's own
    // onAuthStateChanged (isAdmin). This layer only tracks the newer
    // per-person role accounts, so it explicitly ignores that account.
    if (!user || user.email === ADMIN_EMAIL) {
      currentUser = null;
      currentProfile = null;
      updateNavButton();
      notifyRoleChange();
      return;
    }
    currentUser = user;
    try {
      const snap = await db.collection(USERS_COL).doc(user.uid).get();
      currentProfile = snap.exists ? snap.data() : null;
    } catch (err) {
      console.error('[auth-roles] profile fetch failed', err);
      currentProfile = null;
    }
    if (currentProfile && currentProfile.status === 'revoked') {
      // Deleting/disabling another account's Firebase Auth credentials isn't
      // possible client-side (needs the Admin SDK) — this is the enforcement
      // point instead: the moment a revoked account's browser evaluates auth
      // state, it gets signed straight back out.
      updateNavButton();
      notifyRoleChange();
      showToast('Your access has been revoked. Contact the DVM Program Office.', true);
      firebase.auth().signOut();
      return;
    }
    updateNavButton();
    notifyRoleChange();
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensureNavButton);
  } else {
    ensureNavButton();
  }

  window.Timetable.onRoleChange = onRoleChange;
  window.Timetable.getCurrentRole = () => currentProfile;
  window.Timetable.getCurrentUser = () => currentUser;
  window.Timetable.openPendingAccounts = openPendingAccounts;
  window.Timetable.openAuthorizedUsersImport = openAuthorizedUsersImport;
  window.Timetable.openAccessRequests = openAccessRequests;
  window.Timetable.openAdminAuditLog = openAdminAuditLog;
  window.Timetable.logAdminAudit = logAdminAudit;
  // Shared modal chrome so change-requests.js/approvals.js don't each
  // reimplement the same close-button/backdrop wiring.
  window.Timetable.closeModal = closeModal;
  window.Timetable.wireModalChrome = wireModalChrome;
})();
