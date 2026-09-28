// change-requests.js — lets Course Coordinators/Instructors submit one of
// three request types against an existing session: a topic change, a swap
// with another session, or a session-type change (e.g. Lec > SRL). Each
// sits in change_requests/{id} until approvals.js routes it to the right
// approver(s): topic/swap need ADFAD Office approval THEN DVM Program
// Office approval (sequential); type changes need ADC approval only. Reads
// window.Timetable.{db, escapeHtml, showToast, FIELD_LABELS, getAllSessions,
// getCurrentUser, getCurrentRole, onRoleChange, closeModal, wireModalChrome}
// exported by app.js/auth-roles.js.
(function () {
  'use strict';
  if (!window.Timetable || typeof firebase === 'undefined') return;

  const { db, escapeHtml, showToast, FIELD_LABELS, closeModal, wireModalChrome } = window.Timetable;
  const CR_COL = 'change_requests';
  // Must match the <option> list in app.js's admin openForm() session-type field.
  const SESSION_TYPES = ['LEC', 'LAB', 'SRL', 'Quiz/Midterm', 'OSCE', 'Exam', 'Holiday', 'Event'];
  // Fields a swap can exchange between the two sessions — deliberately
  // excludes date (day/week/dateRange are derived from it and app.js's
  // recompute helpers aren't exported here) and course/year/type, which stay
  // admin-only restructuring actions.
  const SWAP_FIELD_GROUPS = [
    { key: 'time', label: 'Time', fields: ['startTime', 'endTime'] },
    { key: 'room', label: 'Room', fields: ['room'] },
    { key: 'group', label: 'Group', fields: ['group'] },
    { key: 'primaryInstructor', label: 'Primary Instructor', fields: ['primaryInstructor'] },
    { key: 'secondaryInstructor', label: 'Secondary Instructor', fields: ['secondaryInstructor'] },
    { key: 'topic', label: 'Topic', fields: ['topic'] },
  ];

  function modalEl() { return document.getElementById('modal'); }
  function sessionLabel(s) { return `${s.course || ''} ${s.type || ''} · ${s.day || ''}, ${s.date || ''} · ${s.startTime || ''}-${s.endTime || ''}${s.topic ? ' · ' + s.topic : ''}`; }
  function summarize(s) {
    return { course: s.course || '', courseName: s.courseName || '', type: s.type || '', year: s.year || '', date: s.date || '', day: s.day || '', startTime: s.startTime || '', endTime: s.endTime || '', topic: s.topic || '' };
  }
  function currentRequester() {
    const user = window.Timetable.getCurrentUser && window.Timetable.getCurrentUser();
    const profile = window.Timetable.getCurrentRole && window.Timetable.getCurrentRole();
    if (!user || !profile) return null;
    return { user, profile, info: { uid: user.uid, email: user.email, name: profile.name || '', role: profile.role } };
  }

  function describeStatus(r) {
    if (r.status === 'approved') return { label: 'Approved', color: 'var(--success)' };
    if (r.status === 'rejected') return { label: 'Rejected' + (r.rejectedStage ? ` (${r.rejectedStage})` : ''), color: 'var(--danger)' };
    if (r.status === 'pending_faculty_b') return { label: `Awaiting ${r.facultyBName || 'the other instructor'}'s response`, color: 'var(--text-3)' };
    if (r.status === 'pending_dvm') return { label: 'Pending DVM Program Office', color: 'var(--text-3)' };
    if (r.requestType === 'type_change') return { label: 'Pending ADC approval', color: 'var(--text-3)' };
    return { label: 'Pending ADFAD approval', color: 'var(--text-3)' };
  }

  // ════════════════════════════════════════════════════════════
  // LANDING MENU (opened from a session's detail popup in app.js — the
  // exported name stays openChangeRequestForm so app.js needed no changes)
  // ════════════════════════════════════════════════════════════
  function openChangeRequestForm(session) {
    if (!currentRequester()) { showToast('Sign in to submit a request', true); return; }
    modalEl().innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header">
          <div class="modal-title">Submit a Request</div>
          <div class="modal-subtitle">${escapeHtml(sessionLabel(session))}</div>
        </div>
        <div class="modal-body">
          <p style="font-size:13px;color:var(--text-2);margin:0 0 14px">
            Choose what you need to do. Topic changes and swaps are reviewed by ADFAD Office, then
            DVM Program Office. Session-type changes are reviewed by ADC. Nothing changes on the
            live timetable until fully approved.
          </p>
          <div style="display:flex;flex-direction:column;gap:10px">
            <button class="btn btn-secondary" id="menu-topic-btn" style="text-align:left;padding:12px 14px">📝 <strong>Update a Topic</strong><br><span style="font-size:12px;color:var(--text-3);font-weight:400">Change what this session covers</span></button>
            <button class="btn btn-secondary" id="menu-swap-btn" style="text-align:left;padding:12px 14px">🔄 <strong>Initiate a Swap</strong><br><span style="font-size:12px;color:var(--text-3);font-weight:400">Exchange time/room/instructor/etc. with another session</span></button>
            <button class="btn btn-secondary" id="menu-type-btn" style="text-align:left;padding:12px 14px">🔁 <strong>Request a Session Type Change</strong><br><span style="font-size:12px;color:var(--text-3);font-weight:400">e.g. Lecture → SRL</span></button>
          </div>
        </div>
        <div class="modal-footer"><div></div><button class="btn btn-secondary" id="menu-cancel-btn">Cancel</button></div>
      </div>`;
    modalEl().classList.add('open');
    wireModalChrome(['menu-cancel-btn']);
    document.getElementById('menu-topic-btn').onclick = () => openTopicChangeForm(session);
    document.getElementById('menu-swap-btn').onclick = () => openSwapForm(session);
    document.getElementById('menu-type-btn').onclick = () => openSessionTypeChangeForm(session);
  }

  // ════════════════════════════════════════════════════════════
  // TOPIC CHANGE
  // ════════════════════════════════════════════════════════════
  function openTopicChangeForm(session) {
    modalEl().innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header">
          <div class="modal-title">Update a Topic</div>
          <div class="modal-subtitle">${escapeHtml(sessionLabel(session))} · reviewed by ADFAD Office, then DVM Program Office</div>
        </div>
        <div class="modal-body">
          <form id="tc-form">
            <div class="form-grid">
              <div class="form-field full"><label class="form-label">Current ${escapeHtml(FIELD_LABELS.topic)}</label><input class="form-input" value="${escapeHtml(session.topic || '(none)')}" disabled></div>
              <div class="form-field full"><label class="form-label">New ${escapeHtml(FIELD_LABELS.topic)}</label><input class="form-input" id="tc-new-topic" value="${escapeHtml(session.topic || '')}" required></div>
              <div class="form-field full"><label class="form-label">Reason</label><textarea class="form-textarea" id="tc-reason" placeholder="Briefly explain why this change is needed"></textarea></div>
            </div>
            <span class="save-status" id="tc-status"></span>
          </form>
        </div>
        <div class="modal-footer">
          <div></div>
          <div style="display:flex;gap:10px">
            <button class="btn btn-secondary" id="tc-cancel-btn" type="button">Cancel</button>
            <button class="btn btn-primary" type="submit" form="tc-form">Submit Request</button>
          </div>
        </div>
      </div>`;
    modalEl().classList.add('open');
    wireModalChrome(['tc-cancel-btn']);
    document.getElementById('tc-form').addEventListener('submit', async e => {
      e.preventDefault();
      const requester = currentRequester();
      const statusEl = document.getElementById('tc-status');
      const newTopic = document.getElementById('tc-new-topic').value.trim();
      if (newTopic === (session.topic || '').trim()) {
        statusEl.className = 'save-status error'; statusEl.textContent = 'Enter a different topic';
        return;
      }
      statusEl.className = 'save-status saving'; statusEl.textContent = 'Submitting…';
      try {
        await db.collection(CR_COL).add({
          requestType: 'topic', status: 'pending',
          sessionId: session.id, sessionSummary: summarize(session),
          oldTopic: session.topic || '', newTopic,
          reason: document.getElementById('tc-reason').value.trim(),
          requestedBy: requester.info,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          adfadReview: null, dvmReview: null,
        });
        closeModal();
        showToast('Topic change submitted — sent to ADFAD Office for review');
      } catch (err) {
        console.error('[change-requests] topic submit failed', err);
        statusEl.className = 'save-status error'; statusEl.textContent = 'Could not submit — try again';
      }
    });
  }

  // ════════════════════════════════════════════════════════════
  // SESSION TYPE CHANGE
  // ════════════════════════════════════════════════════════════
  function openSessionTypeChangeForm(session) {
    const typeOptions = SESSION_TYPES.map(t => `<option value="${t}" ${session.type === t ? 'selected' : ''}>${t}</option>`).join('');
    modalEl().innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header">
          <div class="modal-title">Request a Session Type Change</div>
          <div class="modal-subtitle">${escapeHtml(sessionLabel(session))} · reviewed by ADC</div>
        </div>
        <div class="modal-body">
          <form id="stc-form">
            <div class="form-grid">
              <div class="form-field full"><label class="form-label">Current ${escapeHtml(FIELD_LABELS.type)}</label><input class="form-input" value="${escapeHtml(session.type || '')}" disabled></div>
              <div class="form-field full"><label class="form-label">New ${escapeHtml(FIELD_LABELS.type)}</label><select class="form-select" id="stc-new-type">${typeOptions}</select></div>
              <div class="form-field full"><label class="form-label">Reason</label><textarea class="form-textarea" id="stc-reason" placeholder="Briefly explain why this change is needed"></textarea></div>
            </div>
            <span class="save-status" id="stc-status"></span>
          </form>
        </div>
        <div class="modal-footer">
          <div></div>
          <div style="display:flex;gap:10px">
            <button class="btn btn-secondary" id="stc-cancel-btn" type="button">Cancel</button>
            <button class="btn btn-primary" type="submit" form="stc-form">Submit Request</button>
          </div>
        </div>
      </div>`;
    modalEl().classList.add('open');
    wireModalChrome(['stc-cancel-btn']);
    document.getElementById('stc-form').addEventListener('submit', async e => {
      e.preventDefault();
      const requester = currentRequester();
      const statusEl = document.getElementById('stc-status');
      const newType = document.getElementById('stc-new-type').value;
      if (newType === session.type) {
        statusEl.className = 'save-status error'; statusEl.textContent = 'Choose a different type';
        return;
      }
      statusEl.className = 'save-status saving'; statusEl.textContent = 'Submitting…';
      try {
        await db.collection(CR_COL).add({
          requestType: 'type_change', status: 'pending',
          sessionId: session.id, sessionSummary: summarize(session),
          oldType: session.type || '', newType,
          reason: document.getElementById('stc-reason').value.trim(),
          requestedBy: requester.info,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          adcReview: null,
        });
        closeModal();
        showToast('Session type change submitted — sent to ADC for review');
      } catch (err) {
        console.error('[change-requests] type-change submit failed', err);
        statusEl.className = 'save-status error'; statusEl.textContent = 'Could not submit — try again';
      }
    });
  }

  // ════════════════════════════════════════════════════════════
  // SWAP
  // ════════════════════════════════════════════════════════════
  function openSwapForm(sessionA) {
    let sessionB = null;
    modalEl().innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header">
          <div class="modal-title">Initiate a Swap</div>
          <div class="modal-subtitle">${escapeHtml(sessionLabel(sessionA))} · reviewed by ADFAD Office, then DVM Program Office</div>
        </div>
        <div class="modal-body">
          <div class="form-field full">
            <label class="form-label">Swap with…</label>
            <input class="form-input" id="sw-search" placeholder="Search by course, topic, or date">
            <div id="sw-results" style="max-height:160px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;margin-top:6px;display:none"></div>
            <div id="sw-selected" style="margin-top:8px;font-size:12.5px;color:var(--text-2)"></div>
          </div>
          <div class="form-field full" id="sw-fields-wrap" style="display:none">
            <label class="form-label">What to Swap</label>
            <div style="display:flex;flex-direction:column;gap:6px">
              ${SWAP_FIELD_GROUPS.map(g => `<label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:400"><input type="checkbox" class="sw-field-cb" value="${g.key}"> ${escapeHtml(g.label)}</label>`).join('')}
            </div>
          </div>
          <div class="form-field full"><label class="form-label">Note</label><textarea class="form-textarea" id="sw-note" placeholder="Any additional context for the reviewers"></textarea></div>
          <span class="save-status" id="sw-status"></span>
        </div>
        <div class="modal-footer">
          <div></div>
          <div style="display:flex;gap:10px">
            <button class="btn btn-secondary" id="sw-cancel-btn" type="button">Cancel</button>
            <button class="btn btn-primary" id="sw-submit-btn" disabled>Submit Request</button>
          </div>
        </div>
      </div>`;
    modalEl().classList.add('open');
    wireModalChrome(['sw-cancel-btn']);

    const resultsEl = document.getElementById('sw-results');
    const selectedEl = document.getElementById('sw-selected');
    const fieldsWrap = document.getElementById('sw-fields-wrap');
    const submitBtn = document.getElementById('sw-submit-btn');

    function renderSelected() {
      if (!sessionB) { selectedEl.innerHTML = ''; fieldsWrap.style.display = 'none'; submitBtn.disabled = true; return; }
      selectedEl.innerHTML = `Swapping with: <strong>${escapeHtml(sessionLabel(sessionB))}</strong> <button type="button" id="sw-clear-btn" class="btn-danger-text" style="padding:0">change</button>`;
      document.getElementById('sw-clear-btn').onclick = () => { sessionB = null; document.getElementById('sw-search').value = ''; renderSelected(); };
      fieldsWrap.style.display = '';
      submitBtn.disabled = false;
    }

    document.getElementById('sw-search').addEventListener('input', e => {
      const q = e.target.value.trim().toLowerCase();
      if (!q) { resultsEl.style.display = 'none'; resultsEl.innerHTML = ''; return; }
      const all = (window.Timetable.getAllSessions && window.Timetable.getAllSessions()) || [];
      const matches = all.filter(s => s.id !== sessionA.id &&
        `${s.course} ${s.topic} ${s.date} ${s.day}`.toLowerCase().includes(q)
      ).slice(0, 20);
      if (!matches.length) { resultsEl.style.display = ''; resultsEl.innerHTML = '<div style="padding:8px;font-size:12px;color:var(--text-3)">No matches</div>'; return; }
      resultsEl.style.display = '';
      resultsEl.innerHTML = matches.map(s => `<div class="roster-editable-cell" data-sid="${s.id}" style="padding:7px 10px;font-size:12.5px;border-bottom:1px solid var(--border)">${escapeHtml(sessionLabel(s))}</div>`).join('');
      resultsEl.querySelectorAll('[data-sid]').forEach(el => {
        el.onclick = () => {
          sessionB = all.find(s => s.id === el.dataset.sid);
          resultsEl.style.display = 'none'; resultsEl.innerHTML = '';
          renderSelected();
        };
      });
    });

    submitBtn.onclick = async () => {
      const requester = currentRequester();
      const statusEl = document.getElementById('sw-status');
      const checked = [...document.querySelectorAll('.sw-field-cb:checked')].map(cb => cb.value);
      if (!sessionB) { statusEl.className = 'save-status error'; statusEl.textContent = 'Pick a session to swap with'; return; }
      if (!checked.length) { statusEl.className = 'save-status error'; statusEl.textContent = 'Check at least one thing to swap'; return; }
      const facultyBName = (sessionB.primaryInstructor || '').trim();
      if (!facultyBName) { statusEl.className = 'save-status error'; statusEl.textContent = 'That session has no named instructor to request approval from — pick a different one'; return; }
      const swapFields = checked.flatMap(key => SWAP_FIELD_GROUPS.find(g => g.key === key).fields);
      const swapFieldLabels = checked.map(key => SWAP_FIELD_GROUPS.find(g => g.key === key).label);
      statusEl.className = 'save-status saving'; statusEl.textContent = 'Submitting…';
      // A swap needs Faculty B's acceptance only when there IS another
      // instructor to ask — if sessionB's named instructor is the requester
      // themselves (swapping between two of their own slots), skip straight
      // to the ADFAD/DVM Office queue, same as a topic change would.
      // normalizeNameForMatch (app.js) is word-order-insensitive, matching
      // how requesterRoleForSession checks session ownership and how
      // auth-roles.js stores nameLower — all three must agree or matching
      // silently breaks for anyone whose signup-name word order differs
      // from how a session's instructor field happens to be written.
      const normalize = window.Timetable.normalizeNameForMatch || (s => (s || '').trim().toLowerCase());
      const facultyBNameLower = normalize(facultyBName);
      const needsFacultyB = facultyBNameLower !== normalize(requester.profile.name);
      try {
        await db.collection(CR_COL).add({
          requestType: 'swap', status: needsFacultyB ? 'pending_faculty_b' : 'pending',
          sessionAId: sessionA.id, sessionASummary: summarize(sessionA),
          sessionBId: sessionB.id, sessionBSummary: summarize(sessionB),
          swapFields, swapFieldLabels,
          reason: document.getElementById('sw-note').value.trim(),
          requestedBy: requester.info,
          facultyBName, facultyBNameLower, facultyBReview: null,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          adfadReview: null, dvmReview: null,
        });
        closeModal();
        showToast(needsFacultyB ? `Swap submitted — waiting for ${facultyBName} to accept` : 'Swap submitted — sent to ADFAD Office for review');
      } catch (err) {
        console.error('[change-requests] swap submit failed', err);
        statusEl.className = 'save-status error'; statusEl.textContent = 'Could not submit — try again';
      }
    };
  }

  // ════════════════════════════════════════════════════════════
  // MY REQUESTS (nav button + panel so a requester can track status)
  // ════════════════════════════════════════════════════════════
  function updateMyRequestsButton(profile) {
    const show = !!profile && profile.status === 'active' && ['cc', 'instructor'].includes(profile.role);
    let btn = document.getElementById('my-requests-btn');
    if (!show) { if (btn) btn.style.display = 'none'; return; }
    if (!btn) {
      const actions = document.querySelector('.navbar-actions');
      if (!actions) return;
      btn = document.createElement('button');
      btn.className = 'admin-login-btn';
      btn.id = 'my-requests-btn';
      btn.textContent = 'My Requests';
      btn.addEventListener('click', openMyRequestsPanel);
      actions.insertBefore(btn, actions.firstChild);
    }
    btn.style.display = '';
  }

  function describeRequest(r) {
    if (r.requestType === 'topic') return `Topic: <s style="color:var(--text-3)">${escapeHtml(r.oldTopic || '—')}</s> → <strong>${escapeHtml(r.newTopic || '—')}</strong>`;
    if (r.requestType === 'type_change') return `Type: <s style="color:var(--text-3)">${escapeHtml(r.oldType || '—')}</s> → <strong>${escapeHtml(r.newType || '—')}</strong>`;
    if (r.requestType === 'swap') return `Swap ${escapeHtml((r.swapFieldLabels || []).join(', '))} with ${escapeHtml(sessionLabel(r.sessionBSummary || {}))}`;
    return '';
  }
  function requestSessionLabel(r) {
    if (r.requestType === 'swap') return sessionLabel(r.sessionASummary || {});
    return sessionLabel(r.sessionSummary || {});
  }

  async function openMyRequestsPanel() {
    const user = window.Timetable.getCurrentUser && window.Timetable.getCurrentUser();
    const profile = window.Timetable.getCurrentRole && window.Timetable.getCurrentRole();
    modalEl().innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box" style="width:min(680px,96vw)">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header"><div class="modal-title">My Change Requests</div></div>
        <div class="modal-body">
          <div id="mr-incoming"></div>
          <div id="mr-body">Loading…</div>
        </div>
        <div class="modal-footer"><div></div><button class="btn btn-secondary" id="mr-close-btn">Close</button></div>
      </div>`;
    modalEl().classList.add('open');
    wireModalChrome(['mr-close-btn']);
    if (!user) { document.getElementById('mr-body').innerHTML = '<div style="color:var(--danger);font-size:13px">Sign in to see your requests.</div>'; return; }
    await renderIncomingSwaps(user, profile);
    await renderMySubmittedRequests(user);
  }

  // Swaps where this account is Faculty B — the OTHER instructor whose
  // session is targeted — and hasn't yet accepted or rejected. Only once
  // they accept does the request move into the ADFAD/DVM Office queue;
  // rejecting here stops it before any approver ever sees it.
  async function renderIncomingSwaps(user, profile) {
    const el = document.getElementById('mr-incoming');
    if (!el) return;
    const normalize = window.Timetable.normalizeNameForMatch || (s => (s || '').trim().toLowerCase());
    const nameLower = (profile && (profile.nameLower || normalize(profile.name))) || '';
    if (!nameLower) { el.innerHTML = ''; return; }
    let snap;
    try {
      // Equality-only filter, matches the pre-lowercased field set at
      // submission time — no composite index needed.
      snap = await db.collection(CR_COL).where('facultyBNameLower', '==', nameLower).get();
    } catch (err) {
      console.error('[change-requests] incoming swaps fetch failed', err);
      return; // non-fatal — the submitted-requests list below still loads
    }
    const docs = snap.docs.filter(d => d.data().status === 'pending_faculty_b');
    if (!docs.length) { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="form-label" style="margin-bottom:6px">Swaps Awaiting Your Response</div>` +
      docs.map(doc => {
        const r = doc.data();
        return `<div class="detail-row" style="flex-direction:column;align-items:stretch;gap:4px;background:var(--surface-2);border-radius:8px;padding:8px 10px;margin-bottom:8px">
          <div><strong>${escapeHtml(r.requestedBy?.name || r.requestedBy?.email || 'Someone')}</strong> wants to swap ${escapeHtml((r.swapFieldLabels || []).join(', '))} between:</div>
          <div style="font-size:12px;color:var(--text-2)">Their session: ${escapeHtml(sessionLabel(r.sessionASummary || {}))}</div>
          <div style="font-size:12px;color:var(--text-2)">Your session: ${escapeHtml(sessionLabel(r.sessionBSummary || {}))}</div>
          ${r.reason ? `<div style="font-size:12px;color:var(--text-3)">Reason: ${escapeHtml(r.reason)}</div>` : ''}
          <div style="display:flex;gap:8px;margin-top:4px">
            <button class="btn btn-primary" data-accept-swap="${doc.id}">Accept</button>
            <button class="btn-danger-text" data-reject-swap="${doc.id}">Reject</button>
          </div>
        </div>`;
      }).join('');
    el.querySelectorAll('[data-accept-swap]').forEach(btn => {
      btn.onclick = async () => {
        const requester = currentRequester();
        if (!requester) return;
        try {
          await db.collection(CR_COL).doc(btn.dataset.acceptSwap).update({
            status: 'pending',
            facultyBReview: { by: requester.info, at: firebase.firestore.FieldValue.serverTimestamp(), note: '' },
          });
          showToast('Swap accepted — sent to ADFAD Office for review');
          await renderIncomingSwaps(user, profile);
        } catch (err) {
          console.error('[change-requests] swap accept failed', err);
          showToast('Could not accept — try again', true);
        }
      };
    });
    el.querySelectorAll('[data-reject-swap]').forEach(btn => {
      btn.onclick = async () => {
        const requester = currentRequester();
        if (!requester) return;
        const note = prompt('Reason for rejecting (optional):') || '';
        try {
          await db.collection(CR_COL).doc(btn.dataset.rejectSwap).update({
            status: 'rejected', rejectedStage: 'Faculty B', reviewNote: note,
            facultyBReview: { by: requester.info, at: firebase.firestore.FieldValue.serverTimestamp(), note },
          });
          showToast('Swap rejected');
          await renderIncomingSwaps(user, profile);
        } catch (err) {
          console.error('[change-requests] swap reject failed', err);
          showToast('Could not reject — try again', true);
        }
      };
    });
  }

  async function renderMySubmittedRequests(user) {
    const body = document.getElementById('mr-body');
    if (!body) return;
    let snap;
    try {
      // Equality-only filter (no orderBy) so this never needs a manually
      // created Firestore composite index — sort is done client-side below.
      snap = await db.collection(CR_COL).where('requestedBy.uid', '==', user.uid).get();
    } catch (err) {
      console.error('[change-requests] my-requests fetch failed', err);
      body.innerHTML = '<div style="color:var(--danger);font-size:13px">Could not load your requests.</div>';
      return;
    }
    if (snap.empty) { body.innerHTML = '<div style="color:var(--text-3);font-size:13px">No change requests yet.</div>'; return; }
    const docs = snap.docs.slice().sort((a, b) => (b.data().createdAt?.toMillis?.() || 0) - (a.data().createdAt?.toMillis?.() || 0));
    body.innerHTML = docs.map(doc => {
      const r = doc.data();
      const st = describeStatus(r);
      return `<div class="detail-row" style="flex-direction:column;align-items:stretch;gap:4px">
        <div style="display:flex;justify-content:space-between;gap:8px">
          <strong>${escapeHtml(requestSessionLabel(r))}</strong>
          <span style="font-weight:600;color:${st.color}">${escapeHtml(st.label)}</span>
        </div>
        <div style="font-size:12px;color:var(--text-2)">${describeRequest(r)}</div>
        ${r.reason ? `<div style="font-size:12px;color:var(--text-3)">Reason: ${escapeHtml(r.reason)}</div>` : ''}
        ${r.status === 'rejected' && r.reviewNote ? `<div style="font-size:12px;color:var(--danger)">Reviewer note: ${escapeHtml(r.reviewNote)}</div>` : ''}
      </div>`;
    }).join('');
  }

  window.Timetable.openChangeRequestForm = openChangeRequestForm;
  window.Timetable.CHANGE_REQUESTS_COL = CR_COL;
  if (window.Timetable.onRoleChange) window.Timetable.onRoleChange(updateMyRequestsButton);
})();
