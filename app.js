// app.js — 2026-2027 UCVM Timetable main orchestration logic

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
  const SESSIONS_COL  = 'sessions';
  const HISTORY_COL   = 'sessions_history';
  const CHANGELOG_COL = 'change_log';

  const connDot  = document.getElementById('conn-dot');
  const connText = document.getElementById('conn-text');

  const SPY_HILL_URL = 'https://uofc.sharepoint.com/:f:/r/sites/YearTeachersCommittees/Shared%20Documents/General/2026-27%20Timetable/Spy%20Hill%20Labs%20Schedules%202026-2027?d=wa5cd30d6085246e6929b67f2c8a090f3&csf=1&web=1&e=sMu679';

  const { DOW7, dateKey, addDays, isToday, buildMonthGrid, buildWeekDays,
          calcAcademicWeekNumber, getAcademicCycleLabel, calcDayName,
          weekHeaderLabel, weekRangeLabel, weekButtonLabel, weekMonday,
          MONTH_SEQUENCE, monthLabel, timeToMinutes, DAY_START_MIN, DAY_END_MIN } = CalendarEngine;

  function escapeHtml(str) {
    const div = document.createElement('div'); div.textContent = str || ''; return div.innerHTML;
  }

  // ════════════════════════════════════════════════════════════
  // STATE
  // ════════════════════════════════════════════════════════════
  let calView     = 'week';
  let calDate     = new Date();
  let allSessions = [];
  let filters = { search: '', year: 'all', month: 'all', week: 'all', course: 'all', type: 'all' };
  let colorsOn = JSON.parse(localStorage.getItem('timetable_colors') ?? 'true');

  // ════════════════════════════════════════════════════════════
  // FIRESTORE LIVE LISTENER
  // ════════════════════════════════════════════════════════════
  db.collection(SESSIONS_COL).onSnapshot(
    snap => {
      allSessions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      connDot.className = 'conn-dot online';
      connText.textContent = 'Connected';
      populateWeekButtons();
      populateUpdatesFilters();
      renderAll();
    },
    err => {
      console.error('[Firestore]', err);
      connDot.className = 'conn-dot error';
      connText.textContent = 'Connection error';
      showToast('Could not connect to the database', true);
    }
  );

  // ── Latest Updates feed (from change_log — one grouped doc per save) ──
  let latestChanges = [];
  db.collection(CHANGELOG_COL).orderBy('changedAt', 'desc').limit(100).onSnapshot(
    snap => { latestChanges = snap.docs.map(d => d.data()); renderLatestUpdates(); },
    err => console.error('[Changelog listener]', err)
  );

  function populateUpdatesFilters() {
    const courseSel = document.getElementById('updates-filter-course');
    const weekSel = document.getElementById('updates-filter-week');
    if (courseSel.options.length <= 1) {
      CourseData.getAllCourses().forEach(c => {
        const o = document.createElement('option'); o.value = c.code; o.textContent = c.code; courseSel.appendChild(o);
      });
    }
    const weeks = [...new Set(allSessions.map(s => s.week).filter(w => w != null))].sort((a,b)=>a-b);
    const currentWeekVal = weekSel.value;
    weekSel.innerHTML = '<option value="all">All Weeks</option>' + weeks.map(w => `<option value="${w}">Week ${w}</option>`).join('');
    if ([...weekSel.options].some(o => o.value === currentWeekVal)) weekSel.value = currentWeekVal;
  }

  function describeChangedFields(fields) {
    if (!fields || !fields.length) return 'Updated';
    if (fields.length === 1) return `${fields[0].fieldLabel} updated`;
    if (fields.length === 2) return `${fields[0].fieldLabel} and ${fields[1].fieldLabel} updated`;
    return `${fields.length} items are updated`;
  }

  function renderLatestUpdates() {
    const el = document.getElementById('latest-updates-body');
    const yf = document.getElementById('updates-filter-year').value;
    const cf = document.getElementById('updates-filter-course').value;
    const wf = document.getElementById('updates-filter-week').value;

    let updates = latestChanges;
    if (yf !== 'all') updates = updates.filter(u => String(u.sessionYear) === yf);
    if (cf !== 'all') updates = updates.filter(u => (u.course||'').split(' - ')[0].trim() === cf);
    if (wf !== 'all') updates = updates.filter(u => String(u.sessionWeek) === wf);
    updates = updates.slice(0, 25);

    if (!updates.length) {
      el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-3);font-size:12px">No updates match this filter</div>`;
      return;
    }
    el.innerHTML = updates.map((u, i) => {
      const when = u.changedAt?.toDate ? u.changedAt.toDate() : null;
      const whenStr = when ? when.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) + ' at ' + when.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' }) : '—';
      const line2 = [u.sessionYear ? `Year ${u.sessionYear}` : '', u.course || '', u.sessionType || '', u.sessionStartTime || ''].filter(Boolean).join(' | ');
      return `<div class="update-item" data-idx="${i}">
        <div class="update-line-1">Updated on ${whenStr}</div>
        <div class="update-line-2">${escapeHtml(line2)}</div>
        <div class="update-line-3">${escapeHtml(describeChangedFields(u.changedFields))}</div>
      </div>`;
    }).join('');

    el.querySelectorAll('.update-item').forEach(item => {
      item.addEventListener('click', () => {
        const u = updates[parseInt(item.dataset.idx)];
        if (!u || !u.sessionDate) return;
        calDate = new Date(u.sessionDate + 'T12:00:00');
        calView = 'week';
        document.getElementById('cal-week-btn').classList.add('active');
        document.getElementById('cal-month-btn').classList.remove('active');
        renderCalendar();
      });
    });
  }
  ['updates-filter-year','updates-filter-course','updates-filter-week'].forEach(id =>
    document.getElementById(id).addEventListener('change', renderLatestUpdates));

  // ════════════════════════════════════════════════════════════
  // ROOM + COLOR
  // ════════════════════════════════════════════════════════════
  function getRoom(s) { return CourseData.getRoom(s); }

  // Deterministic, lighter pastel color per course code. Uses a golden-angle
  // hue step keyed off a stable index (not the raw string hash) so that
  // similar-looking course codes (200, 202, 204…) still land on well-separated
  // hues instead of clustering into one color per year.
  const colorCache = {};
  const COURSE_COLOR_ORDER = CourseData.getAllCourses().map(c => c.code);
  function getCourseColor(course) {
    if (!course) return { bg: 'var(--surface-2)', border: 'var(--border-2)' };
    if (colorCache[course]) return colorCache[course];
    let idx = COURSE_COLOR_ORDER.indexOf(course);
    if (idx === -1) { let h=0; for (let i=0;i<course.length;i++) h=course.charCodeAt(i)+((h<<5)-h); idx = Math.abs(h); }
    const hue = (idx * 137.508) % 360; // golden angle — maximally spread hues
    const c = { bg: `hsl(${hue}, 62%, 92%)`, border: `hsl(${hue}, 55%, 60%)` };
    colorCache[course] = c;
    return c;
  }

  function getInstructorDisplay(s) {
    if (String(s.type||'').toUpperCase() === 'LAB') {
      const parts = [];
      if (s.primaryInstructor) parts.push(`Primary: ${s.primaryInstructor}`);
      if (s.secondaryInstructor) parts.push(`Secondary: ${s.secondaryInstructor}`);
      return parts.length ? parts.join(' · ') : 'No instructor yet';
    }
    return s.finalizedInstructors || 'TBD';
  }

  // ════════════════════════════════════════════════════════════
  // FILTERING
  // ════════════════════════════════════════════════════════════
  function getFiltered() {
    let data = [...allSessions];
    if (filters.year   !== 'all') data = data.filter(s => String(s.year) === String(filters.year));
    if (filters.week   !== 'all') data = data.filter(s => String(s.week) === String(filters.week));
    if (filters.course !== 'all') data = data.filter(s => String(s.course) === String(filters.course));
    if (filters.type   !== 'all') data = data.filter(s => s.type === filters.type);
    if (filters.month  !== 'all') data = data.filter(s => s.date && s.date.slice(0,7) === filters.month);
    if (filters.search) {
      const q = filters.search.toLowerCase();
      data = data.filter(s =>
        (s.course||'').toLowerCase().includes(q) ||
        (s.courseName||'').toLowerCase().includes(q) ||
        (s.topic||'').toLowerCase().includes(q) ||
        (s.primaryInstructor||'').toLowerCase().includes(q) ||
        (s.secondaryInstructor||'').toLowerCase().includes(q) ||
        (s.finalizedInstructors||'').toLowerCase().includes(q));
    }
    return data;
  }

  function renderAll() {
    const searchActive = !!filters.search;
    document.getElementById('search-results-card').classList.toggle('hidden', !searchActive);
    document.getElementById('cal-card').classList.toggle('hidden', searchActive);
    if (searchActive) renderSearchResults(); else renderCalendar();
    renderChips();
  }

  // ── Custom Course dropdown (supports wrapped option text) ──────
  function populateCourseDropdown(year) {
    const list = year === 'all' ? CourseData.getAllCourses() : CourseData.getCoursesForYear(year);
    const listEl = document.getElementById('course-filter-list');
    listEl.innerHTML = `<div class="fbar-dropdown-item ${filters.course==='all'?'active':''}" data-code="all">All Courses</div>` +
      list.map(c => `<div class="fbar-dropdown-item ${filters.course===c.code?'active':''}" data-code="${c.code}">${escapeHtml(c.code)} – ${escapeHtml(c.name)}</div>`).join('');
    listEl.querySelectorAll('.fbar-dropdown-item').forEach(item => {
      item.addEventListener('click', () => {
        filters.course = item.dataset.code;
        updateCourseButtonLabel();
        listEl.classList.add('hidden');
        renderAll();
      });
    });
    if (!list.some(c => c.code === filters.course)) filters.course = 'all';
    updateCourseButtonLabel();
  }
  function updateCourseButtonLabel() {
    const btn = document.getElementById('course-filter-btn');
    if (filters.course === 'all') { btn.textContent = 'All Courses ▾'; return; }
    const c = CourseData.findCourse(filters.course);
    btn.textContent = (c ? `${c.code} – ${c.name}` : filters.course) + ' ▾';
  }
  document.getElementById('course-filter-btn').addEventListener('click', e => {
    e.stopPropagation();
    document.getElementById('course-filter-list').classList.toggle('hidden');
  });
  document.addEventListener('click', () => document.getElementById('course-filter-list').classList.add('hidden'));

  // ════════════════════════════════════════════════════════════
  // MONTH DROPDOWN (Aug 2026 → Apr 2027)
  // ════════════════════════════════════════════════════════════
  (function populateMonthDropdown() {
    const sel = document.getElementById('filter-month');
    MONTH_SEQUENCE.forEach(m => {
      const o = document.createElement('option'); o.value = m.value; o.textContent = m.label; sel.appendChild(o);
    });
  })();
  document.getElementById('filter-month').addEventListener('change', e => { filters.month = e.target.value; renderAll(); });

  // ════════════════════════════════════════════════════════════
  // YEAR + WEEK BUTTON NAVIGATION
  // ════════════════════════════════════════════════════════════
  document.getElementById('year-btn-row').addEventListener('click', e => {
    const btn = e.target.closest('.pill-btn'); if (!btn) return;
    document.querySelectorAll('#year-btn-row .pill-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filters.year = btn.dataset.year;
    filters.course = 'all';
    populateCourseDropdown(filters.year);
    renderAll();
  });

  function populateWeekButtons() {
    const row = document.getElementById('week-btn-row');
    if (row.dataset.built) return;
    row.dataset.built = '1';
    for (let w = 1; w <= 17; w++) {
      const btn = document.createElement('button');
      btn.className = 'pill-btn'; btn.dataset.week = w; btn.textContent = weekButtonLabel(w);
      row.appendChild(btn);
    }
  }
  document.getElementById('week-btn-row').addEventListener('click', e => {
    const btn = e.target.closest('.pill-btn'); if (!btn) return;
    document.querySelectorAll('#week-btn-row .pill-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    filters.week = btn.dataset.week;
    if (btn.dataset.week !== 'all') {
      calDate = weekMonday(parseInt(btn.dataset.week));
      calView = 'week';
      document.getElementById('cal-week-btn').classList.add('active');
      document.getElementById('cal-month-btn').classList.remove('active');
    }
    renderAll();
  });

  // ════════════════════════════════════════════════════════════
  // COLOR TOGGLE
  // ════════════════════════════════════════════════════════════
  function updateColorToggleBtn() {
    document.getElementById('color-toggle').textContent = `🎨 Colors: ${colorsOn ? 'On' : 'Off'}`;
  }
  updateColorToggleBtn();
  document.getElementById('color-toggle').addEventListener('click', () => {
    colorsOn = !colorsOn;
    localStorage.setItem('timetable_colors', JSON.stringify(colorsOn));
    updateColorToggleBtn();
    renderAll();
  });

  // ════════════════════════════════════════════════════════════
  // CALENDAR RENDER — MONTH + WEEK (compressed proportional time-grid)
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
      const wk = calcAcademicWeekNumber(dateKey(days[0]));
      labelEl.textContent = weekHeaderLabel(days, wk);
      renderWeekView(el, days, data);
    }
    syncSideColumnHeight();
  }

  function syncSideColumnHeight() {
    requestAnimationFrame(() => {
      const card = document.getElementById('cal-card');
      const side = document.querySelector('.side-column');
      if (card && side && !card.classList.contains('hidden')) {
        side.style.setProperty('--side-total-height', card.offsetHeight + 'px');
      }
    });
  }

  function renderMonthView(container, data) {
    const cells = buildMonthGrid(calDate.getFullYear(), calDate.getMonth())
      .filter(c => { const dow = c.date.getDay(); return dow !== 0 && dow !== 6; }); // Mon-Fri only

    let html = `<div class="cal-month">
      <div class="cal-dow-header">${DOW7.map(d=>`<div class="cal-dow">${d}</div>`).join('')}</div>
      <div class="cal-grid">`;

    cells.forEach(cell => {
      const dk = dateKey(cell.date);
      const events = data.filter(s => s.date === dk).sort((a,b)=>(a.startTime||'').localeCompare(b.startTime||''));
      const isTd = isToday(cell.date);
      const cls = ['cal-cell', !cell.current && 'cal-other', isTd && 'cal-today'].filter(Boolean).join(' ');

      html += `<div class="${cls}">
        <div class="cal-date-num">${isTd ? `<span class="today-dot">${cell.date.getDate()}</span>` : cell.date.getDate()}</div>
        <div class="cal-events">`;

      const MAX = 3;
      events.slice(0, MAX).forEach(s => html += renderMonthChip(s));
      if (events.length > MAX) {
        const overflow = events.slice(MAX);
        html += `<div class="cal-overflow-wrap">`;
        overflow.forEach(s => html += renderMonthChip(s, true));
        html += `<button class="cal-more-btn" data-count="${overflow.length}">+${overflow.length} more</button></div>`;
      }
      html += `</div></div>`;
    });
    html += '</div></div>';
    container.innerHTML = html;
    wireBlockClicks(container);
    wireOverflowButtons(container);
  }

  function renderMonthChip(s, hidden) {
    const color = colorsOn ? getCourseColor(s.course) : { bg: 'var(--surface-2)', border: 'var(--border-2)' };
    return `<div class="cal-event ${hidden?'cal-event-hidden':''}" style="background:${color.bg};border-left-color:${color.border}" data-id="${s.id}">
      <span class="cal-event-l1">${escapeHtml(s.course||'—')} ${escapeHtml(s.type||'')}</span>
      <span class="cal-event-l2">${escapeHtml(s.topic||'')}</span>
    </div>`;
  }

  // ── Timeline compression: empty (all-day, no-session) time ranges are
  // squeezed down to a small fixed width instead of consuming real space ──
  const GAP_COMPRESS_MIN = 20;
  function buildWeekTimeline(days, weekEvents) {
    const intervals = weekEvents.map(s => {
      let st = timeToMinutes(s.startTime);
      let en = timeToMinutes(s.endTime) ?? st + 50;
      st = Math.max(st, DAY_START_MIN); en = Math.min(en, DAY_END_MIN);
      if (en <= st) en = st + 5;
      return [st, en];
    });
    const points = new Set([DAY_START_MIN, DAY_END_MIN]);
    intervals.forEach(([s,e]) => { points.add(s); points.add(e); });
    for (let m = DAY_START_MIN; m <= DAY_END_MIN; m += 60) points.add(m);
    const sorted = [...points].sort((a,b)=>a-b);

    const segs = [];
    for (let i = 0; i < sorted.length-1; i++) {
      const t0 = sorted[i], t1 = sorted[i+1];
      if (t1 <= t0) continue;
      const hasContent = intervals.some(([s,e]) => s < t1 && e > t0);
      const dur = t1 - t0;
      segs.push({ t0, t1, weight: hasContent ? dur : Math.min(dur, GAP_COMPRESS_MIN) });
    }
    const total = segs.reduce((a,s)=>a+s.weight,0) || 1;
    let cum = 0;
    const bp = [{ t: sorted[0], pct: 0 }];
    segs.forEach(s => { cum += s.weight; bp.push({ t: s.t1, pct: cum/total*100 }); });

    function toPct(min) {
      for (let i = 0; i < bp.length-1; i++) {
        const a = bp[i], b = bp[i+1];
        if (min >= a.t && min <= b.t) return b.t === a.t ? a.pct : a.pct + (min-a.t)/(b.t-a.t) * (b.pct-a.pct);
      }
      return min <= sorted[0] ? 0 : 100;
    }
    const hourMarks = sorted.filter(m => (m - DAY_START_MIN) % 60 === 0);
    return { toPct, hourMarks };
  }
  function fmtHourLabel(min) {
    const h24 = Math.floor(min/60), m = min%60;
    const h12 = ((h24 + 11) % 12) + 1;
    return `${h12}:${String(m).padStart(2,'0')}${h24 < 12 ? 'am' : 'pm'}`;
  }

  // Group overlapping same-day events into clusters so we never render true
  // time-overlapping blocks — 2+ concurrent sessions become one stacked
  // mini-list block (Month-view style, "+N more" for anything past 3).
  function clusterEvents(events) {
    const sorted = [...events].sort((a,b) => a._start - b._start);
    const clusters = [];
    sorted.forEach(ev => {
      const last = clusters[clusters.length-1];
      if (last && ev._start < last.end) { last.end = Math.max(last.end, ev._end); last.items.push(ev); }
      else clusters.push({ start: ev._start, end: ev._end, items: [ev] });
    });
    return clusters;
  }

  function renderWeekView(container, days, data) {
    const weekEvents = data.filter(s => days.some(d => dateKey(d) === s.date));
    const timeline = buildWeekTimeline(days, weekEvents);

    let html = `<div class="tg-wrap"><div class="tg-corner"></div>`;
    days.forEach((d,i) => {
      const isTd = isToday(d);
      html += `<div class="tg-day-head ${isTd?'today-head':''}"><div class="week-dow">${DOW7[i]}</div><div class="week-date">${d.getDate()}</div></div>`;
    });
    html += `</div>`;

    html += `<div class="tg-body">
      <div class="tg-time-axis"><div class="tg-track">${timeline.hourMarks.map(m => `<div class="tg-hour-label" style="top:${timeline.toPct(m)}%">${fmtHourLabel(m)}</div>`).join('')}</div></div>`;

    days.forEach(d => {
      const dk = dateKey(d);
      const isTd = isToday(d);
      const events = weekEvents.filter(s => s.date === dk).map(s => {
        let st = Math.max(timeToMinutes(s.startTime), DAY_START_MIN);
        let en = Math.min(timeToMinutes(s.endTime) ?? st+50, DAY_END_MIN);
        if (en <= st) en = st + 5;
        return { ...s, _start: st, _end: en };
      });
      const clusters = clusterEvents(events);

      html += `<div class="tg-day-col ${isTd?'today-col':''}"><div class="tg-track">`;
      html += timeline.hourMarks.map(m => `<div class="tg-gridline" style="top:${timeline.toPct(m)}%"></div>`).join('');

      clusters.forEach(cluster => {
        const topPct = timeline.toPct(cluster.start), heightPct = Math.max(timeline.toPct(cluster.end) - topPct, 2);
        if (cluster.items.length === 1) {
          const s = cluster.items[0];
          const color = colorsOn ? getCourseColor(s.course) : null;
          const style = colorsOn
            ? `top:${topPct}%;height:${heightPct}%;background:${color.bg};border-left-color:${color.border}`
            : `top:${topPct}%;height:${heightPct}%`;
          html += `<div class="tg-block ${colorsOn?'':'colors-off'}" style="${style}" data-id="${s.id}">
            <div class="tg-block-l1">${escapeHtml(s.course||'—')} ${escapeHtml(s.type||'')}</div>
            <div class="tg-block-l2">${escapeHtml(s.topic||'')}</div>
            <div class="tg-block-l3">${escapeHtml(getRoom(s))}</div>
          </div>`;
        } else {
          const MAX = 3;
          const shown = cluster.items.slice(0, MAX), overflow = cluster.items.slice(MAX);
          html += `<div class="tg-cluster" style="top:${topPct}%;height:${heightPct}%">`;
          shown.forEach(s => {
            const color = colorsOn ? getCourseColor(s.course) : { bg:'var(--surface-2)', border:'var(--border-2)' };
            html += `<div class="tg-cluster-item" style="border-left:3px solid ${colorsOn?color.border:'var(--border-2)'};background:${colorsOn?color.bg:'transparent'}" data-id="${s.id}">
              <div class="tg-block-l1">${escapeHtml(s.course||'—')} ${escapeHtml(s.type||'')}</div>
            </div>`;
          });
          if (overflow.length) {
            html += `<div class="tg-cluster-item tg-cluster-hidden-wrap" style="display:none">` +
              overflow.map(s => `<div class="tg-cluster-item tg-cluster-hidden" style="border-left:3px solid ${colorsOn?getCourseColor(s.course).border:'var(--border-2)'}" data-id="${s.id}"><div class="tg-block-l1">${escapeHtml(s.course||'—')} ${escapeHtml(s.type||'')}</div></div>`).join('') +
              `</div>`;
            overflow.forEach(s => {
              const color = colorsOn ? getCourseColor(s.course) : { bg:'var(--surface-2)', border:'var(--border-2)' };
              html += `<div class="tg-cluster-item tg-cluster-hidden" style="border-left:3px solid ${colorsOn?color.border:'var(--border-2)'};background:${colorsOn?color.bg:'transparent'}" data-id="${s.id}">
                <div class="tg-block-l1">${escapeHtml(s.course||'—')} ${escapeHtml(s.type||'')}</div>
              </div>`;
            });
            html += `<div class="tg-cluster-more" data-count="${overflow.length}">+${overflow.length} more</div>`;
          }
          html += `</div>`;
        }
      });

      html += `</div></div>`;
    });
    html += `</div>`;

    container.innerHTML = html;
    wireBlockClicks(container);
    wireClusterMore(container);
  }

  function wireBlockClicks(container) {
    container.querySelectorAll('.cal-event, .tg-block, .tg-cluster-item').forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        const s = allSessions.find(x => x.id === el.dataset.id);
        if (s) openDetail(s);
      });
    });
  }
  function wireOverflowButtons(container) {
    container.querySelectorAll('.cal-more-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const wrap = btn.closest('.cal-overflow-wrap');
        const hidden = wrap.querySelectorAll('.cal-event-hidden');
        const expanded = btn.dataset.expanded === '1';
        hidden.forEach(el => { el.style.display = expanded ? 'none' : 'flex'; });
        btn.dataset.expanded = expanded ? '0' : '1';
        btn.textContent = expanded ? `+${btn.dataset.count} more` : 'Show less';
        wireBlockClicks(wrap);
      });
    });
  }
  function wireClusterMore(container) {
    container.querySelectorAll('.tg-cluster-more').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const cluster = btn.closest('.tg-cluster');
        const hidden = cluster.querySelectorAll('.tg-cluster-hidden');
        const expanded = btn.dataset.expanded === '1';
        hidden.forEach(el => { el.style.display = expanded ? 'none' : 'block'; });
        btn.dataset.expanded = expanded ? '0' : '1';
        btn.textContent = expanded ? `+${btn.dataset.count} more` : 'Show less';
        wireBlockClicks(cluster);
      });
    });
  }

  // ════════════════════════════════════════════════════════════
  // SEARCH RESULTS — LIST VIEW
  // ════════════════════════════════════════════════════════════
  function renderSearchResults() {
    const data = getFiltered().sort((a,b) => (a.date||'').localeCompare(b.date||'') || (a.startTime||'').localeCompare(b.startTime||''));
    const el = document.getElementById('search-results-body');
    if (!data.length) { el.innerHTML = `<div class="results-empty">No sessions match your search</div>`; return; }
    el.innerHTML = `<div class="results-table-wrap"><table class="results-table">
      <thead><tr>
        <th>Week</th><th>Date Range</th><th>Date</th><th>Day</th><th>Start</th><th>End</th>
        <th>Year</th><th>Course</th><th>Type</th><th>Topic</th><th>Room</th><th>Instructor(s)</th>
      </tr></thead>
      <tbody>${data.map(s => `<tr data-id="${s.id}">
        <td>${escapeHtml(String(s.week||''))}</td><td>${escapeHtml(s.dateRange||'')}</td><td>${escapeHtml(s.date||'')}</td>
        <td>${escapeHtml(s.day||'')}</td><td>${escapeHtml(s.startTime||'')}</td><td>${escapeHtml(s.endTime||'')}</td>
        <td>${escapeHtml(String(s.year||''))}</td><td>${escapeHtml(s.course||'')}</td><td>${escapeHtml(s.type||'')}</td>
        <td>${escapeHtml(s.topic||'')}</td><td>${escapeHtml(getRoom(s))}</td><td>${escapeHtml(getInstructorDisplay(s))}</td>
      </tr>`).join('')}</tbody>
    </table></div>`;
    el.querySelectorAll('tr[data-id]').forEach(row => {
      row.addEventListener('click', () => { const s = allSessions.find(x=>x.id===row.dataset.id); if (s) openDetail(s); });
    });
    syncSideColumnHeight();
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
  // SEARCH / RESET / CHIPS
  // ════════════════════════════════════════════════════════════
  document.getElementById('search-input').addEventListener('input', e => { filters.search = e.target.value; renderAll(); });
  document.getElementById('filter-type').addEventListener('change', e => { filters.type = e.target.value; renderAll(); });

  function resetFilters() {
    filters = { search:'', year:'all', month:'all', week:'all', course:'all', type:'all' };
    document.getElementById('search-input').value = '';
    document.getElementById('filter-month').value = 'all';
    document.getElementById('filter-type').value = 'all';
    document.querySelectorAll('#year-btn-row .pill-btn').forEach(b => b.classList.toggle('active', b.dataset.year==='all'));
    document.querySelectorAll('#week-btn-row .pill-btn').forEach(b => b.classList.toggle('active', b.dataset.week==='all'));
    populateCourseDropdown('all');
    renderAll();
  }
  document.getElementById('reset-filters').addEventListener('click', resetFilters);
  document.getElementById('chips-clear').addEventListener('click', resetFilters);

  function renderChips() {
    const active = [];
    if (filters.year   !== 'all') active.push({k:'year',  l:`Year ${filters.year}`});
    if (filters.week   !== 'all') active.push({k:'week',  l:`Week ${filters.week}`});
    if (filters.month  !== 'all') { const m = MONTH_SEQUENCE.find(x=>x.value===filters.month); active.push({k:'month', l:`Month: ${m?m.label:filters.month}`}); }
    if (filters.course !== 'all') { const c = CourseData.findCourse(filters.course); active.push({k:'course', l:`Course: ${filters.course}${c?' – '+c.name.slice(0,24):''}`}); }
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
        if (k === 'search') { filters.search=''; document.getElementById('search-input').value=''; }
        else if (k === 'month') { filters.month='all'; document.getElementById('filter-month').value='all'; }
        else if (k === 'type') { filters.type='all'; document.getElementById('filter-type').value='all'; }
        else if (k === 'course') { filters.course='all'; populateCourseDropdown(filters.year); }
        else if (k === 'year') { filters.year='all'; filters.course='all'; document.querySelectorAll('#year-btn-row .pill-btn').forEach(b=>b.classList.toggle('active',b.dataset.year==='all')); populateCourseDropdown('all'); }
        else if (k === 'week') { filters.week='all'; document.querySelectorAll('#week-btn-row .pill-btn').forEach(b=>b.classList.toggle('active',b.dataset.week==='all')); }
        renderAll();
      });
    });
  }

  // ════════════════════════════════════════════════════════════
  // READ-ONLY DETAIL POPUP (click any session block)
  // ════════════════════════════════════════════════════════════
  function openDetail(session) {
    const modal = document.getElementById('modal');
    const isLab = String(session.type||'').toUpperCase() === 'LAB';
    const instructorRows = isLab
      ? `<div class="detail-row"><span class="detail-label">Primary Instructor</span><span class="detail-value">${escapeHtml(session.primaryInstructor||'TBD')}</span></div>
         <div class="detail-row"><span class="detail-label">Secondary Instructor</span><span class="detail-value">${escapeHtml(session.secondaryInstructor||'—')}</span></div>`
      : `<div class="detail-row"><span class="detail-label">Instructor</span><span class="detail-value">${escapeHtml(session.finalizedInstructors||'TBD')}</span></div>`;

    modal.innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header">
          <div class="modal-title">${escapeHtml(session.course||'')} ${escapeHtml(session.type||'')}</div>
          <div class="modal-subtitle">${escapeHtml(session.day||'')}, ${escapeHtml(session.date||'')} · Week ${escapeHtml(String(session.week||''))}</div>
        </div>
        <div class="modal-body">
          <div class="detail-row"><span class="detail-label">Course</span><span class="detail-value">${escapeHtml(session.course||'')} – ${escapeHtml(session.courseName||'')}</span></div>
          <div class="detail-row"><span class="detail-label">Year</span><span class="detail-value">Year ${escapeHtml(String(session.year||''))}</span></div>
          <div class="detail-row"><span class="detail-label">Time</span><span class="detail-value">${escapeHtml(session.startTime||'')} – ${escapeHtml(session.endTime||'')}</span></div>
          <div class="detail-row"><span class="detail-label">Room</span><span class="detail-value">${escapeHtml(getRoom(session))}${isLab ? ` &nbsp;·&nbsp; <a class="detail-lab-link" href="${SPY_HILL_URL}" target="_blank" rel="noopener">View Spy Hill Lab Schedule ↗</a>` : ''}</span></div>
          <div class="detail-row"><span class="detail-label">Topic</span><span class="detail-value">${escapeHtml(session.topic||'—')}</span></div>
          ${instructorRows}
          ${session.notes ? `<div class="detail-row"><span class="detail-label">Notes</span><span class="detail-value">${escapeHtml(session.notes)}</span></div>` : ''}
        </div>
        <div class="modal-footer">
          <div></div>
          <div style="display:flex;gap:10px">
            <button class="btn btn-secondary" id="detail-close-btn">Close</button>
            ${isAdmin ? `<button class="btn btn-primary" id="detail-edit-btn">Edit Session</button>` : ''}
          </div>
        </div>
      </div>`;
    modal.classList.add('open');
    document.getElementById('modal-close').onclick = closeForm;
    document.getElementById('modal-backdrop').onclick = closeForm;
    document.getElementById('detail-close-btn').onclick = closeForm;
    if (isAdmin) document.getElementById('detail-edit-btn').onclick = () => openForm(session);
  }

  function closeForm() {
    const modal = document.getElementById('modal');
    modal.classList.remove('open'); modal.innerHTML = '';
  }

  // ════════════════════════════════════════════════════════════
  // ADMIN EDIT FORM (admin only — opened from the detail popup)
  // ════════════════════════════════════════════════════════════
  function buildCourseOptionsHtml(year, selectedCode) {
    if (!year) return `<option value="">Select Year first…</option>`;
    const list = CourseData.getCoursesForYear(year);
    return `<option value="">Select course…</option>` +
      list.map(c => `<option value="${c.code}" ${c.code===selectedCode?'selected':''}>${c.code} – ${c.name}</option>`).join('');
  }

  function openForm(session) {
    const modal = document.getElementById('modal');
    const sessionYear = session?.year || '';

    modal.innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header">
          <div class="modal-title">Edit Session</div>
          <div class="modal-subtitle">${escapeHtml(session.day||'')}, ${escapeHtml(session.date||'')} · Week ${escapeHtml(String(session.week||''))}</div>
        </div>
        <div class="modal-body">
          <form id="session-form">
            <div class="form-grid">
              <div class="form-field"><label class="form-label">Year</label>
                <select class="form-select" id="f-year">
                  <option value="1" ${sessionYear==='1'?'selected':''}>Year 1</option>
                  <option value="2" ${sessionYear==='2'?'selected':''}>Year 2</option>
                  <option value="3" ${sessionYear==='3'?'selected':''}>Year 3</option>
                </select>
              </div>
              <div class="form-field"><label class="form-label">Type</label>
                <select class="form-select" id="f-type">
                  ${['LEC','LAB','SRL','Quiz/Midterm','OSCE','Exam'].map(t => `<option value="${t}" ${session.type===t?'selected':''}>${t}</option>`).join('')}
                </select>
              </div>
              <div class="form-field full"><label class="form-label">Course</label>
                <select class="form-select" id="f-course">${buildCourseOptionsHtml(sessionYear, session.course)}</select>
              </div>
              <div class="form-field"><label class="form-label">Start Time</label><input type="time" class="form-input" id="f-start" value="${session.startTime||''}" /></div>
              <div class="form-field"><label class="form-label">End Time</label><input type="time" class="form-input" id="f-end" value="${session.endTime||''}" /></div>
              <div class="form-field full"><label class="form-label">Topic</label><input type="text" class="form-input" id="f-topic" value="${escapeHtml(session.topic||'')}" /></div>
              <div class="form-field"><label class="form-label">Primary Instructor</label><input type="text" class="form-input" id="f-primary" value="${escapeHtml(session.primaryInstructor||'')}" /></div>
              <div class="form-field"><label class="form-label">Secondary Instructor</label><input type="text" class="form-input" id="f-secondary" value="${escapeHtml(session.secondaryInstructor||'')}" /></div>
              <div class="form-field full"><label class="form-label">Finalized Instructor(s)</label><input type="text" class="form-input" id="f-finalized" value="${escapeHtml(session.finalizedInstructors||'')}" /></div>
              <div class="form-field full"><label class="form-label">Notes</label><textarea class="form-textarea" id="f-notes">${escapeHtml(session.notes||'')}</textarea></div>
            </div>
          </form>
          <div class="history-toggle" id="history-toggle">View version history</div><div class="history-panel" id="history-panel"></div>
        </div>
        <div class="modal-footer">
          <button class="btn-danger-text" id="delete-btn">Delete session</button>
          <div style="display:flex;align-items:center;gap:12px">
            <span class="save-status" id="save-status"></span>
            <button class="btn btn-secondary" id="cancel-btn">Cancel</button>
            <button class="btn btn-primary" id="save-btn">Save Changes</button>
          </div>
        </div>
      </div>`;
    modal.classList.add('open');
    document.getElementById('modal-close').onclick = closeForm;
    document.getElementById('modal-backdrop').onclick = closeForm;
    document.getElementById('cancel-btn').onclick = closeForm;
    document.getElementById('save-btn').onclick = () => saveSession(session);
    document.getElementById('delete-btn').onclick = () => deleteSession(session);
    document.getElementById('history-toggle').onclick = () => loadHistory(session.id);
    document.getElementById('f-year').addEventListener('change', e => {
      document.getElementById('f-course').innerHTML = buildCourseOptionsHtml(e.target.value, null);
    });
  }

  const FIELD_LABELS = {
    year: 'Year', startTime: 'Start Time', endTime: 'End Time', course: 'Course',
    courseName: 'Course Name', type: 'Type', topic: 'Topic',
    primaryInstructor: 'Primary Instructor', secondaryInstructor: 'Secondary Instructor',
    finalizedInstructors: 'Finalized Instructors', notes: 'Notes',
  };
  function detectChanges(oldData, newData) {
    const changes = [];
    Object.keys(FIELD_LABELS).forEach(key => {
      const oldVal = oldData?.[key] ?? '', newVal = newData?.[key] ?? '';
      if (String(oldVal) !== String(newVal)) changes.push({ field: key, fieldLabel: FIELD_LABELS[key], oldValue: String(oldVal), newValue: String(newVal) });
    });
    return changes;
  }
  // One grouped change_log doc per save (not one per field) so Latest Updates
  // can summarize "N items updated" and show Year | Course | Type | Start Time.
  async function logChangeGroup(session, changes) {
    if (!changes.length) return;
    await db.collection(CHANGELOG_COL).add({
      sessionId: session.id,
      course: `${session.course} - ${session.courseName||''}`,
      sessionYear: session.year, sessionType: session.type, sessionStartTime: session.startTime,
      sessionDate: session.date, sessionWeek: session.week,
      changedFields: changes.map(c => ({ fieldLabel: c.fieldLabel, oldValue: c.oldValue, newValue: c.newValue })),
      changedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  }

  async function saveSession(existing) {
    const statusEl = document.getElementById('save-status');
    const saveBtn = document.getElementById('save-btn');
    const courseCode = document.getElementById('f-course').value;
    const courseInfo = CourseData.findCourse(courseCode);

    const data = {
      ...existing,
      year: document.getElementById('f-year').value,
      type: document.getElementById('f-type').value,
      course: courseCode,
      courseName: courseInfo ? courseInfo.name : existing.courseName,
      courseDept: courseInfo ? courseInfo.dept : existing.courseDept,
      startTime: document.getElementById('f-start').value,
      endTime: document.getElementById('f-end').value,
      topic: document.getElementById('f-topic').value.trim(),
      primaryInstructor: document.getElementById('f-primary').value.trim(),
      secondaryInstructor: document.getElementById('f-secondary').value.trim(),
      finalizedInstructors: document.getElementById('f-finalized').value.trim(),
      notes: document.getElementById('f-notes').value.trim(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    delete data.id;

    saveBtn.disabled = true;
    statusEl.className = 'save-status saving'; statusEl.textContent = 'Saving…';
    try {
      await db.collection(SESSIONS_COL).doc(existing.id).set(data, { merge: true });
      await db.collection(HISTORY_COL).add({ sessionId: existing.id, ...data, savedAt: firebase.firestore.FieldValue.serverTimestamp() });
      const changes = detectChanges(existing, data);
      await logChangeGroup({ id: existing.id, ...data }, changes);
      statusEl.className = 'save-status success'; statusEl.textContent = 'Saved ✓';
      showToast('Session updated');
      setTimeout(closeForm, 500);
    } catch (err) {
      console.error('[Save error]', err);
      statusEl.className = 'save-status error'; statusEl.textContent = 'Failed to save — try again';
      saveBtn.disabled = false;
    }
  }

  async function deleteSession(session) {
    if (!confirm('Delete this session? This cannot be undone (history will still record it existed).')) return;
    try { await db.collection(SESSIONS_COL).doc(session.id).delete(); showToast('Session deleted'); closeForm(); }
    catch (err) { console.error('[Delete error]', err); showToast('Could not delete — try again', true); }
  }

  async function loadHistory(sessionId) {
    const panel = document.getElementById('history-panel');
    if (panel.classList.contains('open')) { panel.classList.remove('open'); return; }
    panel.innerHTML = '<div style="font-size:11px;color:var(--text-3)">Loading…</div>';
    panel.classList.add('open');
    try {
      const snap = await db.collection(HISTORY_COL).where('sessionId','==',sessionId).orderBy('savedAt','desc').limit(20).get();
      if (snap.empty) { panel.innerHTML = '<div style="font-size:11px;color:var(--text-3)">No history yet</div>'; return; }
      panel.innerHTML = snap.docs.map(doc => {
        const v = doc.data();
        const when = v.savedAt?.toDate ? v.savedAt.toDate().toLocaleString('en-CA',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}) : '—';
        return `<div class="history-item" data-vid="${doc.id}"><span>${when} — ${escapeHtml(v.topic||'no topic')}</span><span class="history-restore">Restore</span></div>`;
      }).join('');
      panel.querySelectorAll('.history-item').forEach(item => {
        item.addEventListener('click', async () => {
          const vDoc = await db.collection(HISTORY_COL).doc(item.dataset.vid).get();
          const v = vDoc.data(); if (!v) return;
          if (!confirm('Restore this version? This will overwrite the current session data.')) return;
          const { sessionId: sid, savedAt, ...patch } = v;
          await db.collection(SESSIONS_COL).doc(sid).set(patch, { merge: true });
          showToast('Version restored'); closeForm();
        });
      });
    } catch (err) { console.error('[History error]', err); panel.innerHTML = '<div style="font-size:11px;color:var(--danger)">Could not load history</div>'; }
  }

  // ════════════════════════════════════════════════════════════
  // ADMIN MODE (bottom bar text button)
  // ════════════════════════════════════════════════════════════
  const ADMIN_PASSWORD = 'Changes26'; // ← change this to update the admin password
  let isAdmin = sessionStorage.getItem('timetable_admin') === '1';

  function updateAdminUI() {
    const btn = document.getElementById('admin-toggle');
    btn.textContent = isAdmin ? 'Exit Admin Mode' : 'Administrator Login';
    btn.classList.toggle('is-admin', isAdmin);
    renderStatusBanner();
    renderAll();
  }
  document.getElementById('admin-toggle').addEventListener('click', () => {
    if (isAdmin) { isAdmin = false; sessionStorage.removeItem('timetable_admin'); showToast('Admin mode off'); updateAdminUI(); return; }
    const entered = prompt('Enter admin password:');
    if (entered === ADMIN_PASSWORD) { isAdmin = true; sessionStorage.setItem('timetable_admin', '1'); showToast('Admin mode on'); updateAdminUI(); }
    else if (entered !== null) showToast('Incorrect password', true);
  });

  function renderStatusBanner() {
    const existing = document.getElementById('admin-banner'); if (existing) existing.remove();
    if (!isAdmin) return;
    const banner = document.createElement('div');
    banner.id = 'admin-banner';
    banner.style.cssText = `display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 16px;border-radius:8px;margin-bottom:12px;font-size:12.5px;border:1px solid #BFDBFE;background:#EFF6FF;color:#1E40AF;`;
    banner.innerHTML = `<span>⚙ <strong>Admin mode active</strong> — click any session to view and edit it.</span>
      <button id="import-csv-btn" style="padding:4px 12px;font-size:11.5px;font-weight:600;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;white-space:nowrap">⬆ Import CSV</button>`;
    const col = document.querySelector('.cal-column');
    col.insertBefore(banner, col.firstChild);
    document.getElementById('import-csv-btn').addEventListener('click', openImportModal);
  }

  // ════════════════════════════════════════════════════════════
  // CSV BULK IMPORT (admin only)
  // ════════════════════════════════════════════════════════════
  const CSV_FIELD_ALIASES = {
    rowId: ['row id','rowid','row #','session id'], week: ['week','week #','week#'],
    dateRange: ['date range','daterange'], academicCycle: ['academic cycle','cycle'],
    date: ['date'], day: ['day'], year: ['year','program year'],
    startTime: ['start time','starttime'], endTime: ['end time','endtime'],
    course: ['course','course code','course #'], courseName: ['course name'], courseDept: ['department','dept'],
    type: ['type'], topic: ['topic'],
    numInstructors: ['# of instructors','num instructors','number of instructors'],
    instructorProposed: ['instructor proposed','proposed instructor'],
    primaryInstructor: ['primary instructor'], secondaryInstructor: ['secondary instructor'],
    finalizedInstructors: ['finalized instructors'], notes: ['notes'],
  };

  function parseCSV(text) {
    const rows = []; let row = [], field = '', inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i], next = text[i+1];
      if (inQuotes) { if (c === '"' && next === '"') { field += '"'; i++; } else if (c === '"') { inQuotes = false; } else { field += c; } }
      else { if (c === '"') inQuotes = true; else if (c === ',') { row.push(field); field=''; } else if (c==='\r') {} else if (c==='\n') { row.push(field); rows.push(row); row=[]; field=''; } else field += c; }
    }
    if (field.length || row.length) { row.push(field); rows.push(row); }
    return rows.filter(r => r.length > 1 || r[0] !== '');
  }

  function mapCsvToSessions(rows) {
    const headers = rows[0].map(h => h.trim().toLowerCase());
    const fieldForHeader = {};
    headers.forEach((h,i) => { for (const [f,aliases] of Object.entries(CSV_FIELD_ALIASES)) if (aliases.includes(h)) { fieldForHeader[i]=f; break; } });
    return rows.slice(1).map(cells => {
      const s = {};
      cells.forEach((val,i) => { const f = fieldForHeader[i]; if (f) s[f] = (val||'').trim(); });
      if (s.date) {
        const d = new Date(s.date);
        if (!isNaN(d.getTime()) && !/^\d{4}-\d{2}-\d{2}$/.test(s.date)) s.date = d.toISOString().slice(0,10);
      }
      if (s.date) {
        if (!s.day) s.day = calcDayName(s.date);
        if (!s.week) s.week = calcAcademicWeekNumber(s.date);
        if (!s.dateRange) s.dateRange = weekRangeLabel(calcAcademicWeekNumber(s.date));
        if (!s.academicCycle) s.academicCycle = getAcademicCycleLabel(s.date);
      }
      if (s.course) { const info = CourseData.findCourse(s.course); if (info) { s.courseName = info.name; s.courseDept = info.dept; } }
      if (s.numInstructors) s.numInstructors = parseInt(s.numInstructors) || null;
      if (s.week) s.week = parseInt(s.week) || null;
      return s;
    }).filter(s => s.course && s.date);
  }

  function openImportModal() {
    const modal = document.getElementById('modal');
    modal.innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box" style="width:min(720px,94vw)">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header"><div class="modal-title">⬆ Import Sessions from CSV</div>
          <div class="modal-subtitle">Upload a CSV — columns are matched automatically.</div></div>
        <div class="modal-body">
          <div class="form-field full"><input type="file" accept=".csv" id="csv-file-input" class="form-input" /></div>
          <div id="import-preview"></div>
        </div>
        <div class="modal-footer"><div></div>
          <div style="display:flex;align-items:center;gap:12px">
            <span class="save-status" id="import-status"></span>
            <button class="btn btn-secondary" id="import-cancel-btn">Cancel</button>
            <button class="btn btn-primary" id="import-confirm-btn" disabled>Import All</button>
          </div>
        </div>
      </div>`;
    modal.classList.add('open');
    document.getElementById('modal-close').onclick = closeForm;
    document.getElementById('modal-backdrop').onclick = closeForm;
    document.getElementById('import-cancel-btn').onclick = closeForm;

    let parsedSessions = [];
    document.getElementById('csv-file-input').addEventListener('change', e => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        parsedSessions = mapCsvToSessions(parseCSV(ev.target.result));
        renderImportPreview(parsedSessions);
        document.getElementById('import-confirm-btn').disabled = parsedSessions.length === 0;
      };
      reader.readAsText(file);
    });

    function renderImportPreview(sessions) {
      const el = document.getElementById('import-preview');
      if (!sessions.length) { el.innerHTML = `<div style="padding:14px;text-align:center;color:var(--danger);font-size:12.5px">No valid rows found.</div>`; return; }
      const preview = sessions.slice(0, 8);
      el.innerHTML = `<div style="font-size:12px;color:var(--text-3);margin:8px 0">Found <strong>${sessions.length}</strong> rows. Preview:</div>
        <div style="overflow-x:auto;max-height:280px;overflow-y:auto;border:1px solid var(--border);border-radius:6px">
          <table class="import-preview-table" style="width:100%;border-collapse:collapse">
            <thead><tr style="background:var(--surface-2)"><th>Week</th><th>Date</th><th>Course</th><th>Type</th><th>Topic</th></tr></thead>
            <tbody>${preview.map(s => `<tr style="border-top:1px solid var(--border)">
              <td>${escapeHtml(String(s.week||''))}</td><td>${escapeHtml(s.date||'')}</td><td>${escapeHtml(s.course||'')}</td>
              <td>${escapeHtml(s.type||'')}</td><td>${escapeHtml((s.topic||'').slice(0,30))}</td></tr>`).join('')}</tbody>
          </table></div>`;
    }

    document.getElementById('import-confirm-btn').onclick = async () => {
      const statusEl = document.getElementById('import-status');
      const btn = document.getElementById('import-confirm-btn');
      btn.disabled = true; statusEl.className = 'save-status saving';
      const BATCH_SIZE = 200; let imported = 0, failed = 0;
      for (let i = 0; i < parsedSessions.length; i += BATCH_SIZE) {
        const chunk = parsedSessions.slice(i, i + BATCH_SIZE);
        statusEl.textContent = `Importing ${Math.min(i+BATCH_SIZE, parsedSessions.length)} of ${parsedSessions.length}…`;
        const batch = db.batch();
        chunk.forEach(session => {
          const sessionRef = db.collection(SESSIONS_COL).doc();
          const data = { ...session, createdAt: firebase.firestore.FieldValue.serverTimestamp(), updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
          batch.set(sessionRef, data);
          const historyRef = db.collection(HISTORY_COL).doc();
          batch.set(historyRef, { sessionId: sessionRef.id, ...data, savedAt: firebase.firestore.FieldValue.serverTimestamp() });
        });
        try { await batch.commit(); imported += chunk.length; }
        catch (err) { console.error('[Batch import error]', err); failed += chunk.length; }
      }
      if (failed === 0) { statusEl.className='save-status success'; statusEl.textContent=`Imported ${imported} of ${parsedSessions.length} ✓`; showToast(`${imported} sessions imported`); setTimeout(closeForm, 1200); }
      else { statusEl.className='save-status error'; statusEl.textContent=`Imported ${imported}, ${failed} failed — check console`; showToast(`${failed} rows failed`, true); btn.disabled=false; }
    };
  }

  // ════════════════════════════════════════════════════════════
  // EXPORTS — Master (Excel/CSV/ICS) + Filtered (Excel/CSV/ICS/PDF)
  // ════════════════════════════════════════════════════════════
  const EXPORT_HEADERS = ['Week','Date Range','Date','Day','Year','Start Time','End Time','Course','Course Name','Type','Topic','Room','Primary Instructor','Secondary Instructor','Finalized Instructors','Notes'];
  function sessionToRow(s) {
    return [s.week||'', s.dateRange||'', s.date||'', s.day||'', s.year||'', s.startTime||'', s.endTime||'', s.course||'', s.courseName||'', s.type||'', s.topic||'', getRoom(s), s.primaryInstructor||'', s.secondaryInstructor||'', s.finalizedInstructors||'', s.notes||''];
  }
  function sortedRows(data) { return [...data].sort((a,b) => (a.date||'').localeCompare(b.date||'') || (a.startTime||'').localeCompare(b.startTime||'')); }

  function exportCSV(data, filename) {
    const rows = sortedRows(data).map(sessionToRow);
    const csv = [EXPORT_HEADERS, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    downloadBlob(csv, filename, 'text/csv');
  }
  function exportXLSX(data, filename) {
    const rows = sortedRows(data).map(sessionToRow);
    const ws = XLSX.utils.aoa_to_sheet([EXPORT_HEADERS, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Timetable');
    XLSX.writeFile(wb, filename);
  }
  function exportICS(data, filename) {
    const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//UCVM Timetable//EN'];
    sortedRows(data).forEach(s => {
      if (!s.date || !s.startTime) return;
      const dStart = s.date.replace(/-/g,'') + 'T' + s.startTime.replace(':','') + '00';
      const dEnd = s.date.replace(/-/g,'') + 'T' + (s.endTime||s.startTime).replace(':','') + '00';
      lines.push('BEGIN:VEVENT',
        `UID:${s.id||Math.random()}@ucvm-timetable`,
        `DTSTART:${dStart}`, `DTEND:${dEnd}`,
        `SUMMARY:${(s.course||'')} ${(s.type||'')} - ${(s.topic||'')}`.replace(/\r?\n/g,' '),
        `LOCATION:${getRoom(s)}`,
        `DESCRIPTION:${getInstructorDisplay(s)}`.replace(/\r?\n/g,' '),
        'END:VEVENT');
    });
    lines.push('END:VCALENDAR');
    downloadBlob(lines.join('\r\n'), filename, 'text/calendar');
  }
  function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  document.querySelectorAll('.export-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.export;
      const today = dateKey(new Date());
      if (kind === 'master-xlsx') exportXLSX(allSessions, `ucvm_timetable_master_${today}.xlsx`);
      if (kind === 'master-csv')  exportCSV(allSessions, `ucvm_timetable_master_${today}.csv`);
      if (kind === 'master-ics')  exportICS(allSessions, `ucvm_timetable_master_${today}.ics`);
      if (kind === 'filtered-xlsx') exportXLSX(getFiltered(), `ucvm_timetable_filtered_${today}.xlsx`);
      if (kind === 'filtered-csv')  exportCSV(getFiltered(), `ucvm_timetable_filtered_${today}.csv`);
      if (kind === 'filtered-ics')  exportICS(getFiltered(), `ucvm_timetable_filtered_${today}.ics`);
      if (kind === 'filtered-pdf') window.print(); // print CSS un-clips the compressed/fixed-height grid so nothing scrolled-off is cut
      if (kind !== 'filtered-pdf') showToast('Export downloaded');
    });
  });

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
    t.textContent = msg; t.className = 'toast show' + (isError ? ' error' : '');
    setTimeout(() => { t.className = 'toast' + (isError ? ' error' : ''); }, 2600);
  }

  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeForm(); });
  window.addEventListener('resize', syncSideColumnHeight);

  // Initial render
  populateCourseDropdown('all');
  updateAdminUI();
  renderCalendar();

})();
