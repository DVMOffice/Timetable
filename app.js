// app.js — UCVM Timetable main orchestration logic

(async function() {
  'use strict';

  // ════════════════════════════════════════════════════════════
  // FIREBASE SETUP
  // ════════════════════════════════════════════════════════════
  const firebaseConfig = {
    apiKey: "AIzaSyBqLdbPBn2V8tPSlJ8Q2LEmBKy1o7FtEa0",
    authDomain: "timetable-23438.firebaseapp.com",
    projectId: "timetable-23438",
    storageBucket: "timetable-23438.firebasestorage.app",
    messagingSenderId: "577386132793",
    appId: "1:577386132793:web:c59f591e1450fcf88424e8"
  };
  firebase.initializeApp(firebaseConfig);
  const db = firebase.firestore();
  const SESSIONS_COL = 'sessions';
  const HISTORY_COL  = 'sessions_history';

  const connDot  = document.getElementById('conn-dot');
  const connText = document.getElementById('conn-text');

  // ════════════════════════════════════════════════════════════
  // STATE
  // ════════════════════════════════════════════════════════════
  let calView     = 'month';
  let calDate     = new Date();
  let allSessions = [];
  let filters = { search: '', year: 'all', month: 'all', week: 'all', course: 'all', type: 'all' };

  const { DOW7, dateKey, addDays, isToday, buildMonthGrid, buildWeekDays,
          calcAcademicWeekNumber, getAcademicCycleLabel, calcDayName, calcDateRange,
          monthLabel, weekLabel } = CalendarEngine;

  function escapeHtml(str) {
    const div = document.createElement('div'); div.textContent = str || ''; return div.innerHTML;
  }

  // ════════════════════════════════════════════════════════════
  // FIRESTORE LIVE LISTENER
  // ════════════════════════════════════════════════════════════
  db.collection(SESSIONS_COL).onSnapshot(
    snap => {
      allSessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      connDot.className = 'conn-dot online';
      connText.textContent = 'Connected';
      renderAll();
    },
    err => {
      console.error('[Firestore]', err);
      connDot.className = 'conn-dot error';
      connText.textContent = 'Connection error';
      showToast('Could not connect to the database', true);
    }
  );

  // ── Latest Updates feed (from change_log) ──────────────────
  db.collection(CHANGELOG_COL).orderBy('changedAt', 'desc').limit(15).onSnapshot(
    snap => {
      const updates = snap.docs.map(d => d.data());
      renderLatestUpdates(updates);
    },
    err => console.error('[Changelog listener]', err)
  );

  function renderLatestUpdates(updates) {
    const el = document.getElementById('latest-updates-body');
    if (!el) return;
    if (!updates.length) {
      el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-3);font-size:12px">No updates yet</div>`;
      return;
    }
    el.innerHTML = updates.map(u => {
      const when = u.changedAt?.toDate ? u.changedAt.toDate() : null;
      const whenStr = when ? when.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) + ' at ' + when.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' }) : '—';
      const yearMatch = (u.course || '').match(/^(\d+)/);
      const courseCode = yearMatch ? yearMatch[1] : '';
      const year = CourseData.getYearForCourse(courseCode);
      const yearLabel = year ? `Year ${year}` : '';
      return `<div style="padding:10px 16px;border-bottom:1px solid var(--border);font-size:12.5px;display:flex;align-items:baseline;gap:10px">
        <span style="color:var(--text-3);white-space:nowrap;font-size:11px">${whenStr}</span>
        <span>
          ${yearLabel ? `<strong>${yearLabel}</strong>, ` : ''}<strong>${escapeHtml(u.course||'')}</strong> —
          new <strong>${escapeHtml(u.fieldChanged||'')}</strong>:
          ${u.oldValue ? `<span style="color:var(--text-3);text-decoration:line-through">${escapeHtml(u.oldValue)}</span> → ` : ''}
          <span style="color:var(--accent);font-weight:600">${escapeHtml(u.newValue||'(removed)')}</span>
        </span>
      </div>`;
    }).join('');
  }

  // ════════════════════════════════════════════════════════════
  // FILTERING
  // ════════════════════════════════════════════════════════════
  function getFiltered() {
    let data = [...allSessions];
    if (filters.year   !== 'all') data = data.filter(s => String(s.year) === String(filters.year));
    if (filters.month  !== 'all') data = data.filter(s => s.date && (new Date(s.date+'T12:00:00').getMonth()+1) === parseInt(filters.month));
    if (filters.week   !== 'all') data = data.filter(s => String(s.week) === String(filters.week));
    if (filters.course !== 'all') data = data.filter(s => String(s.course) === String(filters.course));
    if (filters.type   !== 'all') data = data.filter(s => s.type === filters.type);
    if (filters.search) {
      const q = filters.search.toLowerCase();
      data = data.filter(s =>
        (s.course||'').toLowerCase().includes(q) ||
        (s.courseName||'').toLowerCase().includes(q) ||
        (s.topic||'').toLowerCase().includes(q) ||
        (s.primaryInstructor||'').toLowerCase().includes(q) ||
        (s.secondaryInstructor||'').toLowerCase().includes(q) ||
        (s.instructorProposed||'').toLowerCase().includes(q));
    }
    return data;
  }

  function renderAll() {
    renderCalendar();
    renderTotalCount();
    renderChips();
    populateCourseFilterFromYear(filters.year);
    populateWeekFilter();
  }
  function renderTotalCount() {
    document.getElementById('total-count').textContent = allSessions.length;
  }

  function populateWeekFilter() {
    const sel = document.getElementById('filter-week');
    const current = sel.value;
    const weeks = [...new Set(allSessions.map(s => s.week).filter(w => w != null))].sort((a,b) => a-b);
    sel.innerHTML = '<option value="all">All Weeks</option>' +
      weeks.map(w => `<option value="${w}">Week ${w}</option>`).join('');
    if ([...sel.options].some(o => o.value === current)) sel.value = current;
  }

  // ── Filter bar: Course dropdown depends on selected Year ───
  function populateCourseFilterFromYear(year) {
    const sel = document.getElementById('filter-course');
    const current = sel.value;
    sel.innerHTML = '<option value="all">All Courses</option>';
    const list = year === 'all' ? CourseData.getAllCourses() : CourseData.getCoursesForYear(year);
    list.forEach(c => {
      const o = document.createElement('option');
      o.value = c.code;
      o.textContent = `${c.code} – ${c.name}`;
      sel.appendChild(o);
    });
    if ([...sel.options].some(o => o.value === current)) sel.value = current;
    else { sel.value = 'all'; filters.course = 'all'; }
  }

  // ════════════════════════════════════════════════════════════
  // CALENDAR RENDER — MONTH + WEEK
  // ════════════════════════════════════════════════════════════
  function renderCalendar() {
    const data = getFiltered();
    const el = document.getElementById('calendar-body');
    const labelEl = document.getElementById('cal-label');

    if (calView === 'month') {
      labelEl.textContent = monthLabel(calDate);
      renderMonthView(el, data);
    } else {
      const days = buildWeekDays(calDate);
      labelEl.textContent = weekLabel(days);
      renderWeekView(el, days, data);
    }
  }

  function renderMonthView(container, data) {
    const cells = buildMonthGrid(calDate.getFullYear(), calDate.getMonth());
    let html = `<div class="cal-month">
      <div class="cal-dow-header">${DOW7.map(d=>`<div class="cal-dow">${d}</div>`).join('')}</div>
      <div class="cal-grid">`;

    cells.forEach(cell => {
      const dk = dateKey(cell.date);
      const events = data.filter(s => s.date === dk).sort((a,b)=>(a.startTime||'').localeCompare(b.startTime||''));
      const isTd = isToday(cell.date);
      const dow  = cell.date.getDay();
      const isWeekend = dow === 0 || dow === 6;
      const cls = ['cal-cell', !cell.current && 'cal-other', isTd && 'cal-today', isWeekend && !isTd && 'weekend'].filter(Boolean).join(' ');

      html += `<div class="${cls}">
        <div class="cal-date-num">
          <span>${isTd ? `<span class="today-dot">${cell.date.getDate()}</span>` : cell.date.getDate()}</span>
          <span class="cal-add-mini" data-date="${dk}" title="Add session">＋</span>
        </div>
        <div class="cal-events">`;

      const MAX = 3;
      events.slice(0, MAX).forEach(s => html += renderEventChip(s));
      if (events.length > MAX) {
        const overflow = events.slice(MAX);
        html += `<div class="cal-overflow-wrap">`;
        overflow.forEach(s => html += renderEventChip(s, true));
        html += `<button class="cal-more-btn" data-count="${overflow.length}">+${overflow.length} more</button></div>`;
      }
      html += `</div></div>`;
    });
    html += '</div></div>';
    container.innerHTML = html;
    wireCalendarEvents(container);

    container.querySelectorAll('.cal-add-mini').forEach(btn => {
      btn.addEventListener('click', e => { e.stopPropagation(); openForm(null, btn.dataset.date); });
    });
  }

  function renderEventChip(s, hidden) {
    const unfinalized = !s.finalizedInstructors || s.finalizedInstructors.trim()==='';
    const bg = unfinalized ? '#FFFBEB' : '#EAF0FB';
    const dot = unfinalized ? '#D97706' : '#1A3A6B';
    const lockIcon = s.locked ? '🔒 ' : '';
    return `<div class="cal-event ${hidden?'cal-event-hidden':''} ${unfinalized?'cal-event-unfinalized':''}" style="background:${bg}" data-id="${s.id}">
      <span class="cal-event-dot" style="background:${dot}"></span>
      <span class="cal-event-text">${lockIcon}${escapeHtml(s.course||'—')} · ${escapeHtml(s.type||'')}</span>
    </div>`;
  }

  function renderWeekView(container, days, data) {
    let html = `<div class="cal-week"><div class="cal-week-header">`;
    days.forEach((d,i) => {
      const isTd = isToday(d);
      html += `<div class="cal-week-day-head ${isTd?'today-head':''}" data-date="${dateKey(d)}">
        <div class="week-dow">${DOW7[i]}</div>
        <div class="week-date">${d.getDate()}</div>
      </div>`;
    });
    html += '</div><div class="cal-week-body">';
    days.forEach(d => {
      const dk = dateKey(d);
      const events = data.filter(s => s.date === dk).sort((a,b)=>(a.startTime||'').localeCompare(b.startTime||''));
      const isTd = isToday(d);
      html += `<div class="cal-week-col ${isTd?'today-col':''}">`;
      events.forEach(s => {
        const unfinalized = !s.finalizedInstructors || s.finalizedInstructors.trim()==='';
        html += `<div class="entry-card ${unfinalized?'entry-unfinalized':''}" data-id="${s.id}">
          <div class="entry-course">${escapeHtml(s.course||'—')}${s.type?' · '+escapeHtml(s.type):''}</div>
          <div class="entry-topic">${escapeHtml(s.topic||'No topic yet')}</div>
          <div class="entry-meta">${s.startTime||'?'}${s.endTime?' – '+s.endTime:''} · ${escapeHtml(s.primaryInstructor||s.instructorProposed||'No instructor yet')}</div>
        </div>`;
      });
      html += `<button class="day-add-btn" data-date="${dk}">+ Add session</button>`;
      html += '</div>';
    });
    html += '</div></div>';
    container.innerHTML = html;
    wireCalendarEvents(container);

    container.querySelectorAll('.day-add-btn').forEach(btn => btn.addEventListener('click', () => openForm(null, btn.dataset.date)));
    container.querySelectorAll('.cal-week-day-head').forEach(head => head.addEventListener('click', () => openForm(null, head.dataset.date)));
  }

  function wireCalendarEvents(container) {
    container.querySelectorAll('.cal-event, .entry-card').forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        const s = allSessions.find(x => x.id === el.dataset.id);
        if (s) openForm(s, s.date);
      });
    });
    container.querySelectorAll('.cal-more-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const wrap = btn.closest('.cal-overflow-wrap');
        const hidden = wrap.querySelectorAll('.cal-event-hidden');
        const expanded = btn.dataset.expanded === '1';
        hidden.forEach(el => {
          el.style.display = expanded ? 'none' : 'flex';
          if (!expanded) el.onclick = e2 => { e2.stopPropagation(); const s = allSessions.find(x=>x.id===el.dataset.id); if (s) openForm(s, s.date); };
        });
        btn.dataset.expanded = expanded ? '0' : '1';
        btn.textContent = expanded ? `+${btn.dataset.count} more` : 'Show less';
      });
    });
  }

  // ════════════════════════════════════════════════════════════
  // CALENDAR NAVIGATION
  // ════════════════════════════════════════════════════════════
  document.getElementById('cal-prev').addEventListener('click', () => {
    calDate = calView==='month' ? new Date(calDate.getFullYear(),calDate.getMonth()-1,1) : addDays(calDate,-7);
    renderCalendar();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    calDate = calView==='month' ? new Date(calDate.getFullYear(),calDate.getMonth()+1,1) : addDays(calDate,7);
    renderCalendar();
  });
  document.getElementById('cal-today').addEventListener('click', () => { calDate = new Date(); renderCalendar(); });
  document.getElementById('cal-month-btn').addEventListener('click', () => {
    calView='month';
    document.getElementById('cal-month-btn').classList.add('active');
    document.getElementById('cal-week-btn').classList.remove('active');
    renderCalendar();
  });
  document.getElementById('cal-week-btn').addEventListener('click', () => {
    calView='week';
    document.getElementById('cal-week-btn').classList.add('active');
    document.getElementById('cal-month-btn').classList.remove('active');
    renderCalendar();
  });

  // ════════════════════════════════════════════════════════════
  // FILTER BAR WIRING
  // ════════════════════════════════════════════════════════════
  document.getElementById('search-input').addEventListener('input', e => { filters.search = e.target.value; renderAll(); });
  document.getElementById('filter-year').addEventListener('change', e => {
    filters.year = e.target.value;
    filters.course = 'all';
    renderAll();
  });
  document.getElementById('filter-month').addEventListener('change', e => { filters.month = e.target.value; renderAll(); });
  document.getElementById('filter-week').addEventListener('change', e => { filters.week = e.target.value; renderCalendar(); renderChips(); });
  document.getElementById('filter-course').addEventListener('change', e => { filters.course = e.target.value; renderCalendar(); renderChips(); });
  document.getElementById('filter-type').addEventListener('change', e => { filters.type = e.target.value; renderAll(); });

  function resetFilters() {
    filters = { search:'', year:'all', month:'all', week:'all', course:'all', type:'all' };
    document.getElementById('search-input').value = '';
    ['filter-year','filter-month','filter-week','filter-type'].forEach(id => document.getElementById(id).value='all');
    renderAll();
  }
  document.getElementById('reset-filters').addEventListener('click', resetFilters);
  document.getElementById('chips-clear').addEventListener('click', resetFilters);

  const MONTH_NAMES = ['','January','February','March','April','May','June','July','August','September','October','November','December'];
  function renderChips() {
    const active = [];
    if (filters.year   !== 'all') active.push({k:'year',  l:`Year ${filters.year}`});
    if (filters.week   !== 'all') active.push({k:'week',  l:`Week ${filters.week}`});
    if (filters.month  !== 'all') active.push({k:'month', l:`Month: ${MONTH_NAMES[parseInt(filters.month)]}`});
    if (filters.course !== 'all') {
      const c = CourseData.findCourse(filters.course);
      active.push({k:'course', l:`Course: ${filters.course}${c?' – '+c.name.slice(0,24):''}`});
    }
    if (filters.type   !== 'all') active.push({k:'type',  l:`Type: ${filters.type}`});
    if (filters.search)           active.push({k:'search',l:`"${filters.search}"`});

    const row = document.getElementById('active-chips-row');
    const chips = document.getElementById('filter-chips');
    if (!active.length) { row.classList.add('hidden'); return; }
    row.classList.remove('hidden');
    chips.innerHTML = active.map(c => `<span class="fbar-chip">${c.l}<button class="fbar-chip-x" data-k="${c.k}">×</button></span>`).join('');
    chips.querySelectorAll('.fbar-chip-x').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const k = btn.dataset.k;
        filters[k] = k==='search' ? '' : 'all';
        if (k==='search') document.getElementById('search-input').value='';
        else document.getElementById(`filter-${k}`).value='all';
        if (k === 'year') filters.course = 'all';
        renderAll();
      });
    });
  }

  // ════════════════════════════════════════════════════════════
  // SUBMISSION FORM MODAL
  // ════════════════════════════════════════════════════════════
  function buildCourseOptionsHtml(year, selectedCode) {
    if (!year) return `<option value="">Select Year first…</option>`;
    const list = CourseData.getCoursesForYear(year);
    return `<option value="">Select course…</option>` +
      list.map(c => `<option value="${c.code}" ${c.code===selectedCode?'selected':''}>${c.code} – ${c.name}</option>`).join('');
  }

  function openForm(session, dateStr) {
    const isEdit = !!session;
    const isLocked = !!session?.locked;
    const readOnly = isLocked && !isAdmin;
    const modal = document.getElementById('modal');
    const day = calcDayName(dateStr);
    const weekNum = session?.week || calcAcademicWeekNumber(dateStr);
    const sessionYear = session?.year || '';
    const disabledAttr = readOnly ? 'disabled' : '';

    modal.innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header">
          <div class="modal-title">${isEdit ? (readOnly ? '🔒 Session Locked' : 'Edit Session') : 'New Session'}</div>
          <div class="modal-subtitle">${day}, ${new Date(dateStr+'T12:00:00').toLocaleDateString('en-CA',{month:'long',day:'numeric',year:'numeric'})} · Academic Week ${weekNum}${readOnly ? ' · Locked by an admin — view only' : ''}</div>
        </div>
        <div class="modal-body">
          <form id="session-form">
            <fieldset ${disabledAttr} style="border:none;padding:0;margin:0">
            <div class="form-grid">
              <div class="form-field">
                <label class="form-label">Week # <span class="form-hint" style="text-transform:none;font-weight:400">(auto)</span></label>
                <input type="number" class="form-input" id="f-week" value="${weekNum}" />
              </div>
              <div class="form-field">
                <label class="form-label">Year <span class="req">*</span></label>
                <select class="form-select" id="f-year" required>
                  <option value="">Select…</option>
                  <option value="1" ${sessionYear==='1'?'selected':''}>Year 1</option>
                  <option value="2" ${sessionYear==='2'?'selected':''}>Year 2</option>
                  <option value="3" ${sessionYear==='3'?'selected':''}>Year 3</option>
                </select>
              </div>
              <div class="form-field full">
                <label class="form-label">Course <span class="req">*</span></label>
                <select class="form-select" id="f-course" required ${!sessionYear?'disabled':''}>
                  ${buildCourseOptionsHtml(sessionYear, session?.course)}
                </select>
                <span class="form-hint" id="course-hint">${sessionYear ? '' : 'Select a Year above to see its courses'}</span>
              </div>
              <div class="form-field">
                <label class="form-label">Start Time <span class="req">*</span></label>
                <input type="time" class="form-input" id="f-start" value="${session?.startTime||''}" required />
              </div>
              <div class="form-field">
                <label class="form-label">End Time</label>
                <input type="time" class="form-input" id="f-end" value="${session?.endTime||''}" />
              </div>
              <div class="form-field">
                <label class="form-label">Type <span class="req">*</span></label>
                <select class="form-select" id="f-type" required>
                  <option value="">Select type…</option>
                  ${['Lecture','Lab','SRL'].map(t =>
                    `<option value="${t}" ${session?.type===t?'selected':''}>${t}</option>`).join('')}
                </select>
              </div>
              <div class="form-field">
                <label class="form-label"># of Instructors</label>
                <input type="number" class="form-input" id="f-numinstr" min="0" value="${session?.numInstructors||''}" />
              </div>
              <div class="form-field full">
                <label class="form-label">Topic</label>
                <input type="text" class="form-input" id="f-topic" placeholder="What is being covered" value="${escapeHtml(session?.topic||'')}" />
              </div>
              <div class="form-field">
                <label class="form-label">Instructor Proposed</label>
                <input type="text" class="form-input" id="f-instrproposed" placeholder="Suggested instructor" value="${escapeHtml(session?.instructorProposed||'')}" />
                <span class="form-hint">Use this if the instructor isn't confirmed yet</span>
              </div>
              <div class="form-field">
                <label class="form-label">Primary Instructor</label>
                <input type="text" class="form-input" id="f-primary" value="${escapeHtml(session?.primaryInstructor||'')}" />
              </div>
              <div class="form-field">
                <label class="form-label">Secondary Instructor</label>
                <input type="text" class="form-input" id="f-secondary" value="${escapeHtml(session?.secondaryInstructor||'')}" />
              </div>
              <div class="form-field">
                <label class="form-label">Finalized Instructors</label>
                <input type="text" class="form-input" id="f-finalized" placeholder="Leave blank if TBD" value="${escapeHtml(session?.finalizedInstructors||'')}" />
                <span class="form-hint">Leave blank until confirmed</span>
              </div>
              <div class="form-field full">
                <label class="form-label">Notes</label>
                <textarea class="form-textarea" id="f-notes">${escapeHtml(session?.notes||'')}</textarea>
              </div>
            </div>
            </fieldset>
          </form>
          ${isEdit ? `<div class="history-toggle" id="history-toggle">View version history</div><div class="history-panel" id="history-panel"></div>` : ''}
        </div>
        <div class="modal-footer">
          <div style="display:flex;align-items:center;gap:10px">
            ${isEdit && !readOnly ? `<button class="btn-danger-text" id="delete-btn">Delete session</button>` : ''}
            ${isEdit && isAdmin ? `<button class="btn-secondary" id="lock-btn" style="padding:6px 12px;font-size:12px;border-radius:6px">${isLocked ? '🔓 Unlock' : '🔒 Lock'}</button>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:12px">
            <span class="save-status" id="save-status"></span>
            <button class="btn btn-secondary" id="cancel-btn">${readOnly ? 'Close' : 'Cancel'}</button>
            ${readOnly ? '' : `<button class="btn btn-primary" id="save-btn">${isEdit ? 'Save Changes' : 'Submit'}</button>`}
          </div>
        </div>
      </div>`;

    modal.classList.add('open');
    document.getElementById('modal-close').onclick = closeForm;
    document.getElementById('modal-backdrop').onclick = closeForm;
    document.getElementById('cancel-btn').onclick = closeForm;
    if (isEdit && isAdmin) {
      document.getElementById('lock-btn').onclick = () => { toggleLock(session); closeForm(); };
    }
    if (!readOnly) {
      document.getElementById('save-btn').onclick = () => saveSession(session, dateStr, day);
    }
    if (isEdit) {
      if (!readOnly) document.getElementById('delete-btn').onclick = () => deleteSession(session);
      document.getElementById('history-toggle').onclick = () => loadHistory(session.id);
    }

    if (!readOnly) {
      document.getElementById('f-year').addEventListener('change', e => {
        const year = e.target.value;
        const courseSel = document.getElementById('f-course');
        const hint = document.getElementById('course-hint');
        if (!year) {
          courseSel.innerHTML = `<option value="">Select Year first…</option>`;
          courseSel.disabled = true;
          hint.textContent = 'Select a Year above to see its courses';
        } else {
          courseSel.innerHTML = buildCourseOptionsHtml(year, null);
          courseSel.disabled = false;
          hint.textContent = '';
        }
      });
    }
  }

  function closeForm() {
    const modal = document.getElementById('modal');
    modal.classList.remove('open'); modal.innerHTML = '';
  }

  const CHANGELOG_COL = 'change_log';

  // Human-readable labels for the changelog
  const FIELD_LABELS = {
    week: 'Week', dateRange: 'Date Range', academicCycle: 'Academic Cycle',
    date: 'Date', day: 'Day', year: 'Year', startTime: 'Start Time', endTime: 'End Time',
    course: 'Course', courseName: 'Course Name', courseDept: 'Department',
    type: 'Type', topic: 'Topic', numInstructors: '# of Instructors',
    instructorProposed: 'Instructor Proposed', primaryInstructor: 'Primary Instructor',
    secondaryInstructor: 'Secondary Instructor', finalizedInstructors: 'Finalized Instructors',
    notes: 'Notes',
  };

  function detectChanges(oldData, newData) {
    const changes = [];
    Object.keys(FIELD_LABELS).forEach(key => {
      const oldVal = oldData?.[key] ?? '';
      const newVal = newData?.[key] ?? '';
      if (String(oldVal) !== String(newVal)) {
        changes.push({ field: key, fieldLabel: FIELD_LABELS[key], oldValue: String(oldVal), newValue: String(newVal) });
      }
    });
    return changes;
  }

  async function logChanges(sessionId, courseLabel, changes) {
    if (!changes.length) return;
    const batch = changes.map(c =>
      db.collection(CHANGELOG_COL).add({
        sessionId,
        course: courseLabel,
        fieldChanged: c.fieldLabel,
        oldValue: c.oldValue,
        newValue: c.newValue,
        changedAt: firebase.firestore.FieldValue.serverTimestamp(),
      })
    );
    await Promise.all(batch);
  }

  async function saveSession(existing, dateStr, day) {
    const statusEl = document.getElementById('save-status');
    const saveBtn = document.getElementById('save-btn');
    const year   = document.getElementById('f-year').value;
    const courseCode = document.getElementById('f-course').value;
    const type   = document.getElementById('f-type').value;
    const start  = document.getElementById('f-start').value;

    if (!year || !courseCode || !type || !start) {
      statusEl.className = 'save-status error'; statusEl.textContent = 'Please fill required fields (Year, Course, Type, Start Time)';
      return;
    }

    const courseInfo = CourseData.findCourse(courseCode);

    const data = {
      week: parseInt(document.getElementById('f-week').value) || null,
      year: year,
      date: dateStr, day: day,
      dateRange: calcDateRange(dateStr),
      academicCycle: getAcademicCycleLabel(dateStr),
      startTime: start,
      endTime: document.getElementById('f-end').value || '',
      course: courseCode,
      courseName: courseInfo ? courseInfo.name : '',
      courseDept: courseInfo ? courseInfo.dept : '',
      type: type,
      topic: document.getElementById('f-topic').value.trim(),
      numInstructors: parseInt(document.getElementById('f-numinstr').value) || null,
      instructorProposed: document.getElementById('f-instrproposed').value.trim(),
      primaryInstructor: document.getElementById('f-primary').value.trim(),
      secondaryInstructor: document.getElementById('f-secondary').value.trim(),
      finalizedInstructors: document.getElementById('f-finalized').value.trim(),
      notes: document.getElementById('f-notes').value.trim(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };

    saveBtn.disabled = true;
    statusEl.className = 'save-status saving'; statusEl.textContent = 'Saving…';

    try {
      let docId = existing?.id;
      if (docId) {
        await db.collection(SESSIONS_COL).doc(docId).set(data, { merge: true });
      } else {
        const ref = await db.collection(SESSIONS_COL).add({ ...data, createdAt: firebase.firestore.FieldValue.serverTimestamp() });
        docId = ref.id;
      }
      await db.collection(HISTORY_COL).add({ sessionId: docId, ...data, savedAt: firebase.firestore.FieldValue.serverTimestamp() });

      // Detect what changed and log it in a clean, readable changelog
      const courseLabel = `${data.course} - ${data.courseName || ''}`;
      const changes = existing ? detectChanges(existing, data) : detectChanges({}, data);
      await logChanges(docId, courseLabel, changes);

      statusEl.className = 'save-status success'; statusEl.textContent = 'Saved ✓';
      showToast(existing ? 'Session updated' : 'Session submitted');
      setTimeout(closeForm, 500);
    } catch (err) {
      console.error('[Save error]', err);
      statusEl.className = 'save-status error'; statusEl.textContent = 'Failed to save — try again';
      saveBtn.disabled = false;
    }
  }

  async function deleteSession(session) {
    if (session.locked && !isAdmin) { showToast('This session is locked', true); return; }
    if (!confirm('Delete this session? This cannot be undone (history will still record it existed).')) return;
    try {
      await db.collection(SESSIONS_COL).doc(session.id).delete();
      showToast('Session deleted'); closeForm();
    } catch (err) {
      console.error('[Delete error]', err);
      showToast('Could not delete — try again', true);
    }
  }

  async function loadHistory(sessionId) {
    const panel = document.getElementById('history-panel');
    const isOpen = panel.classList.contains('open');
    if (isOpen) { panel.classList.remove('open'); return; }

    panel.innerHTML = '<div style="font-size:11px;color:var(--text-3)">Loading…</div>';
    panel.classList.add('open');

    try {
      const snap = await db.collection(HISTORY_COL).where('sessionId','==',sessionId).orderBy('savedAt','desc').limit(20).get();
      if (snap.empty) { panel.innerHTML = '<div style="font-size:11px;color:var(--text-3)">No history yet</div>'; return; }

      panel.innerHTML = snap.docs.map(doc => {
        const v = doc.data();
        const when = v.savedAt?.toDate ? v.savedAt.toDate().toLocaleString('en-CA',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
        return `<div class="history-item" data-vid="${doc.id}">
          <span>${when} — ${escapeHtml(v.primaryInstructor||v.instructorProposed||'no instructor')} · ${escapeHtml(v.topic||'no topic')}</span>
          <span class="history-restore">Restore</span>
        </div>`;
      }).join('');

      panel.querySelectorAll('.history-item').forEach(item => {
        item.addEventListener('click', async () => {
          const vDoc = await db.collection(HISTORY_COL).doc(item.dataset.vid).get();
          const v = vDoc.data();
          if (!v) return;
          if (!confirm('Restore this version? This will overwrite the current session data.')) return;
          const { sessionId: sid, savedAt, ...patch } = v;
          await db.collection(SESSIONS_COL).doc(sid).set(patch, { merge: true });
          showToast('Version restored'); closeForm();
        });
      });
    } catch (err) {
      console.error('[History error]', err);
      panel.innerHTML = '<div style="font-size:11px;color:var(--danger)">Could not load history</div>';
    }
  }

  // ════════════════════════════════════════════════════════════
  // EXPORT MASTER CSV
  // ════════════════════════════════════════════════════════════
  function exportCSV() {
    if (!allSessions.length) { showToast('No sessions to export yet', true); return; }
    const headers = ['Week','Date Range','Academic Cycle','Date','Day','Year','Start Time','End Time','Course','Course Name','Type','Topic','# of Instructors','Instructor Proposed','Primary Instructor','Secondary Instructor','Finalized Instructors','Notes'];
    const rows = allSessions
      .sort((a,b) => (a.date||'').localeCompare(b.date||'') || (a.startTime||'').localeCompare(b.startTime||''))
      .map(s => [
        s.week||'', s.dateRange||'', s.academicCycle||'', s.date||'', s.day||'', s.year||'', s.startTime||'', s.endTime||'',
        `"${(s.course||'').replace(/"/g,'""')}"`,
        `"${(s.courseName||'').replace(/"/g,'""')}"`,
        s.type||'',
        `"${(s.topic||'').replace(/"/g,'""')}"`, s.numInstructors||'',
        `"${(s.instructorProposed||'').replace(/"/g,'""')}"`,
        `"${(s.primaryInstructor||'').replace(/"/g,'""')}"`,
        `"${(s.secondaryInstructor||'').replace(/"/g,'""')}"`,
        `"${(s.finalizedInstructors||'').replace(/"/g,'""')}"`,
        `"${(s.notes||'').replace(/"/g,'""')}"`,
      ]);
    const csv = [headers, ...rows].map(r => r.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `ucvm_timetable_master_${dateKey(new Date())}.csv`; a.click();
    URL.revokeObjectURL(url);
    showToast('Master list exported');
  }
  document.getElementById('export-btn').addEventListener('click', exportCSV);
  document.getElementById('export-btn-2').addEventListener('click', exportCSV);

  // ════════════════════════════════════════════════════════════
  // ADMIN MODE
  // ════════════════════════════════════════════════════════════
  const ADMIN_PASSWORD = 'Changes26'; // ← change this to update the admin password
  let isAdmin = sessionStorage.getItem('timetable_admin') === '1';

  function updateAdminUI() {
    const btn = document.getElementById('admin-toggle');
    btn.style.opacity = isAdmin ? '1' : '.35';
    btn.title = isAdmin ? 'Admin mode active (click to exit)' : '⚙';
    renderCalendar(); // re-render so lock buttons show/hide
  }

  document.getElementById('admin-toggle').addEventListener('click', () => {
    if (isAdmin) {
      isAdmin = false;
      sessionStorage.removeItem('timetable_admin');
      showToast('Admin mode off');
      updateAdminUI();
      return;
    }
    const entered = prompt('Enter admin password:');
    if (entered === ADMIN_PASSWORD) {
      isAdmin = true;
      sessionStorage.setItem('timetable_admin', '1');
      showToast('Admin mode on');
      updateAdminUI();
    } else if (entered !== null) {
      showToast('Incorrect password', true);
    }
  });

  async function toggleLock(session) {
    try {
      await db.collection(SESSIONS_COL).doc(session.id).set({ locked: !session.locked }, { merge: true });
      showToast(session.locked ? 'Session unlocked' : 'Session locked');
    } catch (err) {
      console.error('[Lock error]', err);
      showToast('Could not update lock status', true);
    }
  }

  // ════════════════════════════════════════════════════════════
  // DARK MODE
  // ════════════════════════════════════════════════════════════
  let darkMode = JSON.parse(localStorage.getItem('timetable_dark') || 'false');
  if (darkMode) document.documentElement.classList.add('dark');
  document.getElementById('dark-toggle').textContent = darkMode ? '☀️' : '🌙';
  document.getElementById('dark-toggle').addEventListener('click', () => {
    darkMode = !darkMode;
    document.documentElement.classList.toggle('dark', darkMode);
    document.getElementById('dark-toggle').textContent = darkMode ? '☀️' : '🌙';
    localStorage.setItem('timetable_dark', JSON.stringify(darkMode));
  });

  // ════════════════════════════════════════════════════════════
  // TOAST
  // ════════════════════════════════════════════════════════════
  function showToast(msg, isError) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show' + (isError ? ' error' : '');
    setTimeout(() => { t.className = 'toast' + (isError ? ' error' : ''); }, 2600);
  }

  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeForm(); });

  // Initial render — populate course filter and render calendar while waiting for first snapshot
  populateCourseFilterFromYear('all');
  document.getElementById('admin-toggle').style.opacity = isAdmin ? '1' : '.35';
  renderCalendar();

})();
