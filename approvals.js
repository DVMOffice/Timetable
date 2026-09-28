// approvals.js — routes change_requests (from change-requests.js) to the
// right approver(s) and applies them once fully approved:
//   - topic / swap  → ADFAD Office approves first (status 'pending' ->
//     'pending_dvm'), then DVM Program Office approves second (applies the
//     change and sets status 'approved'). Sequential — both required.
//   - type_change   → ADC approves alone (status 'pending' -> 'approved',
//     applied immediately). Single stage.
// Applying a change writes straight to sessions + sessions_history +
// change_log, exactly like a direct admin edit (saveSession() in app.js),
// so it shows up in Latest Updates and version history the same way. Once
// approved, a request also gets a 3-item task checklist (invite update, DVM
// Hub schedule update, D2L schedule update) the admin can check off later
// via openTaskChecklist(). Reads window.Timetable.{db, escapeHtml,
// showToast, SESSIONS_COL, HISTORY_COL, SETTINGS_COL, CHANGE_REQUESTS_COL,
// FIELD_LABELS, logChangeGroup, getCurrentUser, getCurrentRole,
// onRoleChange, closeModal, wireModalChrome} exported by
// app.js/auth-roles.js/change-requests.js.
(function () {
  'use strict';
  if (!window.Timetable || typeof firebase === 'undefined') return;

  const { db, escapeHtml, showToast, closeModal, wireModalChrome, FIELD_LABELS } = window.Timetable;
  const APPROVER_ROLES = ['adfad', 'dvm_office', 'adc'];
  const ROLE_STAGE_LABEL = { adfad: 'ADFAD Office', dvm_office: 'DVM Program Office', adc: 'ADC' };
  const CHECKLIST_ITEMS = [
    { key: 'inviteUpdate', label: 'Invite Update' },
    { key: 'dvmHubUpdate', label: 'DVM Hub Course Schedule Update' },
    { key: 'd2lUpdate', label: 'D2L Course Schedule Update' },
  ];

  function modalEl() { return document.getElementById('modal'); }
  // Resolved lazily (not destructured at load time) since app.js/change-requests.js
  // assign these onto window.Timetable after this file's IIFE already ran.
  function col(name) { return window.Timetable[name]; }
  function sessionLabel(s) { return `${s?.course || ''} ${s?.type || ''} · ${s?.day || ''}, ${s?.date || ''} · ${s?.startTime || ''}-${s?.endTime || ''}${s?.topic ? ' · ' + s.topic : ''}`; }
  function describeRequestBrief(r) {
    if (r.requestType === 'topic') return `Topic: <s style="color:var(--text-3)">${escapeHtml(r.oldTopic || '—')}</s> → <strong>${escapeHtml(r.newTopic || '—')}</strong>`;
    if (r.requestType === 'type_change') return `Type: <s style="color:var(--text-3)">${escapeHtml(r.oldType || '—')}</s> → <strong>${escapeHtml(r.newType || '—')}</strong>`;
    if (r.requestType === 'swap') return `Swap ${escapeHtml((r.swapFieldLabels || []).join(', '))} with ${escapeHtml(sessionLabel(r.sessionBSummary))}`;
    return '';
  }
  function requestSessionLabel(r) { return sessionLabel(r.requestType === 'swap' ? r.sessionASummary : r.sessionSummary); }

  // ════════════════════════════════════════════════════════════
  // NAV BUTTON
  // ════════════════════════════════════════════════════════════
  function updateApprovalsButton(profile) {
    const show = !!profile && profile.status === 'active' && APPROVER_ROLES.includes(profile.role);
    let btn = document.getElementById('approvals-btn');
    if (!show) { if (btn) btn.style.display = 'none'; return; }
    if (!btn) {
      const actions = document.querySelector('.navbar-actions');
      if (!actions) return;
      btn = document.createElement('button');
      btn.className = 'admin-login-btn';
      btn.id = 'approvals-btn';
      btn.textContent = 'Approvals';
      btn.addEventListener('click', openApprovalsPanel);
      actions.insertBefore(btn, actions.firstChild);
    }
    btn.style.display = '';
  }

  // ════════════════════════════════════════════════════════════
  // APPROVALS PANEL — each approver role only sees the queue relevant to it
  // ════════════════════════════════════════════════════════════
  async function openApprovalsPanel() {
    modalEl().innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box" style="width:min(720px,96vw)">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header"><div class="modal-title">Pending Change Requests</div></div>
        <div class="modal-body" id="ap-body">Loading…</div>
        <div class="modal-footer"><div></div><button class="btn btn-secondary" id="ap-close-btn">Close</button></div>
      </div>`;
    modalEl().classList.add('open');
    wireModalChrome(['ap-close-btn']);
    await renderApprovalsList();
  }

  async function renderApprovalsList() {
    const body = document.getElementById('ap-body');
    if (!body) return; // modal got closed while a request was in flight
    const profile = window.Timetable.getCurrentRole && window.Timetable.getCurrentRole();
    const role = profile && profile.role;
    if (!APPROVER_ROLES.includes(role)) { body.innerHTML = '<div style="color:var(--danger);font-size:13px">Not signed in as an approver.</div>'; return; }

    // Each query below is a single equality filter (no orderBy/second
    // field), so none of them ever need a manually created Firestore
    // composite index — the requestType filtering and sort happen client-side.
    let snap;
    try {
      const statusToQuery = role === 'dvm_office' ? 'pending_dvm' : 'pending';
      snap = await db.collection(col('CHANGE_REQUESTS_COL')).where('status', '==', statusToQuery).get();
    } catch (err) {
      console.error('[approvals] fetch failed', err);
      body.innerHTML = '<div style="color:var(--danger);font-size:13px">Could not load change requests.</div>';
      return;
    }
    let docs = snap.docs;
    if (role === 'adfad') docs = docs.filter(d => ['topic', 'swap'].includes(d.data().requestType));
    else if (role === 'adc') docs = docs.filter(d => d.data().requestType === 'type_change');
    // dvm_office: status 'pending_dvm' is only ever set on topic/swap requests, no extra filter needed.

    if (!docs.length) { body.innerHTML = '<div style="color:var(--text-3);font-size:13px">No pending change requests.</div>'; return; }
    docs = docs.slice().sort((a, b) => (a.data().createdAt?.toMillis?.() || 0) - (b.data().createdAt?.toMillis?.() || 0));
    body.innerHTML = docs.map(doc => {
      const r = doc.data();
      return `<div class="detail-row" style="flex-direction:column;align-items:stretch;gap:6px">
        <div><strong>${escapeHtml(requestSessionLabel(r))}</strong></div>
        <div style="font-size:12px;color:var(--text-3)">Requested by ${escapeHtml(r.requestedBy?.name || r.requestedBy?.email || '')}${r.status === 'pending_dvm' ? ' · already approved by ADFAD Office' : ''}</div>
        <div style="font-size:12px;color:var(--text-2)">${describeRequestBrief(r)}</div>
        ${r.reason ? `<div style="font-size:12px;color:var(--text-3)">Reason: ${escapeHtml(r.reason)}</div>` : ''}
        <div style="display:flex;gap:8px;margin-top:4px">
          <button class="btn btn-primary" data-approve="${doc.id}">Approve</button>
          <button class="btn-danger-text" data-reject="${doc.id}">Reject</button>
        </div>
      </div>`;
    }).join('');
    body.querySelectorAll('[data-approve]').forEach(btn => { btn.onclick = () => approveRequest(btn.dataset.approve); });
    body.querySelectorAll('[data-reject]').forEach(btn => { btn.onclick = () => rejectRequest(btn.dataset.reject); });
  }

  function reviewerInfo() {
    const user = window.Timetable.getCurrentUser && window.Timetable.getCurrentUser();
    const profile = window.Timetable.getCurrentRole && window.Timetable.getCurrentRole();
    if (!user || !profile) return null;
    return { uid: user.uid, email: user.email, name: profile.name || '', role: profile.role };
  }

  // Applies a topic or type_change request's single-field edit onto the
  // session's *current* data (not the stale summary from submission time),
  // so a concurrent unrelated admin edit isn't clobbered. Writes
  // sessions/sessions_history/change_log exactly like a direct admin edit.
  async function applySingleFieldChange(req, field, newValue) {
    const SESSIONS_COL = col('SESSIONS_COL');
    const sessionDoc = await db.collection(SESSIONS_COL).doc(req.sessionId).get();
    if (!sessionDoc.exists) return { ok: false, reason: 'Session no longer exists' };
    const oldValue = sessionDoc.data()[field] || '';
    const patch = { [field]: newValue, updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    const fullData = { ...sessionDoc.data(), ...patch };
    const batch = db.batch();
    batch.set(db.collection(SESSIONS_COL).doc(req.sessionId), fullData, { merge: true });
    batch.set(db.collection(col('SETTINGS_COL')).doc('sessionsVersion'), { updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await batch.commit();
    await db.collection(col('HISTORY_COL')).add({ sessionId: req.sessionId, ...fullData, savedAt: firebase.firestore.FieldValue.serverTimestamp() });
    await window.Timetable.logChangeGroup({ id: req.sessionId, ...fullData }, [{ fieldLabel: FIELD_LABELS[field] || field, oldValue, newValue }]);
    return { ok: true };
  }

  // Applies a swap: exchanges the requested fields' *current* values between
  // the two sessions, so a concurrent unrelated admin edit to either isn't
  // clobbered. Logs one change_log entry per session.
  async function applySwap(req) {
    const SESSIONS_COL = col('SESSIONS_COL');
    const [docA, docB] = await Promise.all([
      db.collection(SESSIONS_COL).doc(req.sessionAId).get(),
      db.collection(SESSIONS_COL).doc(req.sessionBId).get(),
    ]);
    if (!docA.exists || !docB.exists) return { ok: false, reason: 'One of the swapped sessions no longer exists' };
    const dataA = docA.data(), dataB = docB.data();
    const patchA = { updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    const patchB = { updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
    const changesA = [], changesB = [];
    (req.swapFields || []).forEach(field => {
      const label = FIELD_LABELS[field] || field;
      patchA[field] = dataB[field] || '';
      patchB[field] = dataA[field] || '';
      changesA.push({ fieldLabel: label, oldValue: dataA[field] || '', newValue: dataB[field] || '' });
      changesB.push({ fieldLabel: label, oldValue: dataB[field] || '', newValue: dataA[field] || '' });
    });
    const fullA = { ...dataA, ...patchA }, fullB = { ...dataB, ...patchB };
    const batch = db.batch();
    batch.set(db.collection(SESSIONS_COL).doc(req.sessionAId), fullA, { merge: true });
    batch.set(db.collection(SESSIONS_COL).doc(req.sessionBId), fullB, { merge: true });
    batch.set(db.collection(col('SETTINGS_COL')).doc('sessionsVersion'), { updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
    await batch.commit();
    const HISTORY_COL = col('HISTORY_COL');
    await Promise.all([
      db.collection(HISTORY_COL).add({ sessionId: req.sessionAId, ...fullA, savedAt: firebase.firestore.FieldValue.serverTimestamp() }),
      db.collection(HISTORY_COL).add({ sessionId: req.sessionBId, ...fullB, savedAt: firebase.firestore.FieldValue.serverTimestamp() }),
    ]);
    await window.Timetable.logChangeGroup({ id: req.sessionAId, ...fullA }, changesA);
    await window.Timetable.logChangeGroup({ id: req.sessionBId, ...fullB }, changesB);
    return { ok: true };
  }

  async function approveRequest(id) {
    const reviewer = reviewerInfo();
    if (!reviewer) { showToast('Sign in to approve requests', true); return; }
    const CR_COL = col('CHANGE_REQUESTS_COL');
    try {
      const fresh = await db.collection(CR_COL).doc(id).get();
      if (!fresh.exists) { showToast('This request no longer exists', true); await renderApprovalsList(); return; }
      const req = fresh.data();
      const expectedStatus = reviewer.role === 'dvm_office' ? 'pending_dvm' : 'pending';
      if (req.status !== expectedStatus) { showToast('This request was already reviewed', true); await renderApprovalsList(); return; }

      if (reviewer.role === 'adfad') {
        // Stage 1 of 2 for topic/swap — records the approval, does NOT touch sessions yet.
        await db.collection(CR_COL).doc(id).update({
          status: 'pending_dvm',
          adfadReview: { by: reviewer, at: firebase.firestore.FieldValue.serverTimestamp(), note: '' },
        });
        showToast('Approved — sent to DVM Program Office for final review');
        window.Timetable.logAdminAudit('change_request_adfad_approved', `ADFAD Office approved ${req.requestType} request for ${requestSessionLabel(req)}`, { requestId: id, requestType: req.requestType });
      } else {
        // Stage 2 (dvm_office, for topic/swap) or the only stage (adc, for type_change) — applies the change now.
        const result = req.requestType === 'topic' ? await applySingleFieldChange(req, 'topic', req.newTopic)
          : req.requestType === 'type_change' ? await applySingleFieldChange(req, 'type', req.newType)
          : await applySwap(req);
        if (!result.ok) {
          await db.collection(CR_COL).doc(id).update({ status: 'rejected', rejectedStage: ROLE_STAGE_LABEL[reviewer.role], reviewNote: result.reason, reviewedBy: reviewer, reviewedAt: firebase.firestore.FieldValue.serverTimestamp() });
          showToast(result.reason + ' — request auto-rejected', true);
          window.Timetable.logAdminAudit('change_request_rejected', `Auto-rejected ${req.requestType} request for ${requestSessionLabel(req)} — ${result.reason}`, { requestId: id, requestType: req.requestType });
          await renderApprovalsList();
          return;
        }
        const reviewField = reviewer.role === 'adc' ? 'adcReview' : 'dvmReview';
        const checklist = {};
        CHECKLIST_ITEMS.forEach(c => { checklist[c.key] = false; });
        await db.collection(CR_COL).doc(id).update({
          status: 'approved',
          [reviewField]: { by: reviewer, at: firebase.firestore.FieldValue.serverTimestamp(), note: '' },
          checklist,
        });
        showToast('Change approved and applied to the live timetable');
        const auditType = reviewer.role === 'adc' ? 'change_request_adc_approved' : 'change_request_dvm_approved';
        window.Timetable.logAdminAudit(auditType, `${ROLE_STAGE_LABEL[reviewer.role]} approved and applied ${req.requestType} request for ${requestSessionLabel(req)}`, { requestId: id, requestType: req.requestType });
      }
      await renderApprovalsList();
    } catch (err) {
      console.error('[approvals] approve failed', err);
      showToast('Could not approve — try again', true);
    }
  }

  async function rejectRequest(id) {
    const reviewer = reviewerInfo();
    if (!reviewer) { showToast('Sign in to reject requests', true); return; }
    const note = prompt('Reason for rejecting (optional):') || '';
    const CR_COL = col('CHANGE_REQUESTS_COL');
    try {
      const fresh = await db.collection(CR_COL).doc(id).get();
      const expectedStatus = reviewer.role === 'dvm_office' ? 'pending_dvm' : 'pending';
      if (!fresh.exists || fresh.data().status !== expectedStatus) { showToast('This request was already reviewed', true); await renderApprovalsList(); return; }
      const req = fresh.data();
      await db.collection(CR_COL).doc(id).update({
        status: 'rejected', rejectedStage: ROLE_STAGE_LABEL[reviewer.role], reviewNote: note,
        reviewedBy: reviewer, reviewedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      showToast('Change request rejected');
      window.Timetable.logAdminAudit(
        'change_request_rejected',
        `${ROLE_STAGE_LABEL[reviewer.role]} rejected ${req.requestType} request for ${requestSessionLabel(req)}${note ? ' — ' + note : ''}`,
        { requestId: id, requestType: req.requestType }
      );
      await renderApprovalsList();
    } catch (err) {
      console.error('[approvals] reject failed', err);
      showToast('Could not reject — try again', true);
    }
  }

  // ════════════════════════════════════════════════════════════
  // ADMIN: TASK CHECKLIST for approved requests (wired from app.js's admin
  // banner — the button is only ever rendered for the admin account, same
  // gating as Pending Accounts/Authorized Users)
  // ════════════════════════════════════════════════════════════
  async function openTaskChecklist() {
    modalEl().innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box" style="width:min(720px,96vw)">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header"><div class="modal-title">✅ Task Checklist</div>
          <div class="modal-subtitle">Follow-up tasks for approved change requests — revisit and check off as completed</div></div>
        <div class="modal-body">
          <label style="display:flex;align-items:center;gap:8px;font-size:12.5px;font-weight:600;margin-bottom:10px"><input type="checkbox" id="tcl-show-done"> Show fully completed items too</label>
          <div id="tcl-body">Loading…</div>
        </div>
        <div class="modal-footer"><div></div><button class="btn btn-secondary" id="tcl-close-btn">Close</button></div>
      </div>`;
    modalEl().classList.add('open');
    wireModalChrome(['tcl-close-btn']);
    document.getElementById('tcl-show-done').addEventListener('change', renderTaskChecklist);
    await renderTaskChecklist();
  }

  async function renderTaskChecklist() {
    const body = document.getElementById('tcl-body');
    if (!body) return;
    const showDone = document.getElementById('tcl-show-done').checked;
    let snap;
    try {
      snap = await db.collection(col('CHANGE_REQUESTS_COL')).where('status', '==', 'approved').get();
    } catch (err) {
      console.error('[approvals] checklist fetch failed', err);
      body.innerHTML = '<div style="color:var(--danger);font-size:13px">Could not load approved requests.</div>';
      return;
    }
    let docs = snap.docs.filter(d => d.data().checklist);
    if (!showDone) docs = docs.filter(d => CHECKLIST_ITEMS.some(c => !d.data().checklist[c.key]));
    if (!docs.length) { body.innerHTML = '<div style="color:var(--text-3);font-size:13px">Nothing outstanding.</div>'; return; }
    docs = docs.slice().sort((a, b) => (b.data().createdAt?.toMillis?.() || 0) - (a.data().createdAt?.toMillis?.() || 0));
    body.innerHTML = docs.map(doc => {
      const r = doc.data();
      const checklist = r.checklist || {};
      return `<div class="detail-row" style="flex-direction:column;align-items:stretch;gap:6px">
        <div><strong>${escapeHtml(requestSessionLabel(r))}</strong></div>
        <div style="font-size:12px;color:var(--text-2)">${describeRequestBrief(r)}</div>
        <div style="display:flex;gap:14px;flex-wrap:wrap">
          ${CHECKLIST_ITEMS.map(c => `<label style="display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:400"><input type="checkbox" class="tcl-item-cb" data-id="${doc.id}" data-key="${c.key}" ${checklist[c.key] ? 'checked' : ''}> ${escapeHtml(c.label)}</label>`).join('')}
        </div>
      </div>`;
    }).join('');
    body.querySelectorAll('.tcl-item-cb').forEach(cb => {
      cb.onchange = async () => {
        try {
          await db.collection(col('CHANGE_REQUESTS_COL')).doc(cb.dataset.id).update({ [`checklist.${cb.dataset.key}`]: cb.checked });
          if (!document.getElementById('tcl-show-done').checked) await renderTaskChecklist();
        } catch (err) {
          console.error('[approvals] checklist update failed', err);
          showToast('Could not save — try again', true);
          cb.checked = !cb.checked;
        }
      };
    });
  }

  window.Timetable.openApprovalsPanel = openApprovalsPanel;
  window.Timetable.openTaskChecklist = openTaskChecklist;
  if (window.Timetable.onRoleChange) window.Timetable.onRoleChange(updateApprovalsButton);
})();
