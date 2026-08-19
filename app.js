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
          MONTH_SEQUENCE, monthLabel, timeToMinutes, DAY_START_MIN, DAY_END_MIN,
          weekMondaySem, weekRangeLabelSem, weekButtonLabelSem, calcSemesterWeek, weekHeaderLabelSem,
          FALL_WEEKS_COUNT, WINTER_WEEKS_COUNT } = CalendarEngine;

  function escapeHtml(str) {
    const div = document.createElement('div'); div.textContent = str || ''; return div.innerHTML;
  }

  // ════════════════════════════════════════════════════════════
  // STATE
  // ════════════════════════════════════════════════════════════
  let calView     = 'week';
  let calDate     = new Date();
  let allSessions = [];
  let currentSemester = 'fall'; // 'fall' | 'winter' — drives which set of Week buttons is shown
  let filters = { search: '', year: 'all', month: 'all', week: 'all', weekSemester: 'fall', course: 'all', type: 'all' };
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
    if (weekSel.options.length <= 1) {
      weekSel.innerHTML = '<option value="all">All Weeks</option>' +
        Array.from({length: 18}, (_,i) => i+1).map(w => `<option value="${w}">Week ${w}</option>`).join('');
    }
  }

  function fmtTime12(hhmm) {
    if (!hhmm) return '';
    const [h,m] = hhmm.split(':').map(Number);
    const h12 = ((h + 11) % 12) + 1;
    return `${h12}:${String(m).padStart(2,'0')}${h < 12 ? 'am' : 'pm'}`;
  }
  function fmtShortDate(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
  }
  function describeChangedFields(fields) {
    if (!fields || !fields.length) return 'Updated';
    if (fields.length === 1 && fields[0].fieldLabel === '__CREATED__') return 'New session created';
    const labels = fields.map(f => f.fieldLabel);
    if (labels.length === 1) return `${labels[0]} updated`;
    return `${labels.slice(0,-1).join(', ')}, and ${labels[labels.length-1]} updated`;
  }

  function renderLatestUpdates() {
    const el = document.getElementById('latest-updates-body');
    const yf = document.getElementById('updates-filter-year').value;
    const cf = document.getElementById('updates-filter-course').value;
    const wf = document.getElementById('updates-filter-week').value;

    let updates = latestChanges;
    if (yf !== 'all') updates = updates.filter(u => String(u.sessionYear) === yf);
    if (cf !== 'all') updates = updates.filter(u => (u.course||'').split(' - ')[0].trim() === cf);
    if (wf !== 'all') updates = updates.filter(u => u.sessionDate && String(calcSemesterWeek(u.sessionDate).week) === wf);
    updates = updates.slice(0, 25);

    if (!updates.length) {
      el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-3);font-size:12px">No updates match this filter</div>`;
      return;
    }
    el.innerHTML = updates.map((u, i) => {
      const when = u.changedAt?.toDate ? u.changedAt.toDate() : null;
      const whenStr = when ? when.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }) + ' at ' + when.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit' }) : '—';
      const line2 = `Changes on ${u.sessionYear ? 'Year '+u.sessionYear+' | ' : ''}${fmtShortDate(u.sessionDate)} - ${fmtTime12(u.sessionStartTime)} session recorded`;
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
  function getRoom(s) { return s.room || CourseData.getRoom(s); }

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

  // ── Group colors (exact hex from the source Group Colors reference) ────
  const GROUP_LETTER_COLORS = { A:'#FF6666', B:'#FAD16B', C:'#85CDB9', D:'#00B0F0', E:'#C59FE2', F:'#FF00FF' };
  const GROUP_NAMED_COLORS  = { Blue:'#CFE4F4', Green:'#D6EEE8', Orange:'#FDF0CE', Purple:'#ECDFF5', Yellow:'#FFFFCC' };
  const GROUP_DIGIT_COLORS  = { '1':'#B3E5FC', '2':'#FFCCBC', '3':'#C8E6C9' };
  function colorForGroupToken(token) {
    const t = token.trim();
    if (!t) return null;
    if (/^[A-Fa-f]$/.test(t)) return GROUP_LETTER_COLORS[t.toUpperCase()];
    if (GROUP_DIGIT_COLORS[t]) return GROUP_DIGIT_COLORS[t];
    const named = Object.keys(GROUP_NAMED_COLORS).find(n => t.toLowerCase().includes(n.toLowerCase()));
    if (named) return GROUP_NAMED_COLORS[named];
    return null; // unrecognized (e.g. "All", "See D2L") — no defined color
  }
  // A session's `group` field can hold multiple tokens ("A, B" / "D, E, F").
  // Renders one pill per token; multi-token groups show as a hard-edged
  // split-color pill (each band = one token's color) rather than a single
  // averaged color, so each represented group stays visually distinct.
  function renderGroupBadge(groupStr) {
    if (!groupStr) return '';
    const tokens = groupStr.split(',').map(t => t.trim()).filter(Boolean);
    const colors = tokens.map(t => colorForGroupToken(t) || '#D8DCE3');
    let bg;
    if (colors.length === 1) bg = colors[0];
    else {
      const step = 100 / colors.length;
      const stops = colors.map((c,i) => `${c} ${i*step}%, ${c} ${(i+1)*step}%`).join(', ');
      bg = `linear-gradient(to right, ${stops})`;
    }
    const textColor = colors.length === 1 && ['#FF00FF','#00B0F0'].includes(colors[0]) ? '#fff' : '#1a1a1a';
    return `<span class="group-badge" style="background:${bg};color:${textColor}" title="Group ${escapeHtml(groupStr)}">${escapeHtml(tokens.join(','))}</span>`;
  }

  // ── Group Roster (UCID only — no student names, since this repo is public) ──
  // Source: "Year X UCID & Name" rosters cross-matched against each year's
  // published group-assignment tables. Course → roster-year mapping:
  //   Year 1 labs (200,204,206,213,217) → year1 (6-group + 5-group schemes)
  //   Year 2 labs (304,306,308,315,317,319) → year2 (4-group scheme)
  //   Year 3 / 505 → year3 (3-group + 2-group schemes)
  const ROSTER_COURSE_YEAR = {
    '200':'year1','204':'year1','206':'year1','213':'year1','217':'year1',
    '304':'year2','306':'year2','308':'year2','315':'year2','317':'year2','319':'year2',
    '505':'year3',
  };
  const ROSTER_DATA = {"year1": [{"ucid": "30179903", "group6": "B", "group5": "Yellow"}, {"ucid": "30287757", "group6": "F", "group5": "Purple"}, {"ucid": "30318860", "group6": "B", "group5": "Blue"}, {"ucid": "30062331", "group6": "A", "group5": "Green"}, {"ucid": "30281265", "group6": "D", "group5": "Yellow"}, {"ucid": "30321639", "group6": "B", "group5": "Blue"}, {"ucid": "10188944", "group6": "F", "group5": "Yellow"}, {"ucid": "30119692", "group6": "A", "group5": "Yellow"}, {"ucid": "30145416", "group6": "B", "group5": "Blue"}, {"ucid": "30321911", "group6": "B", "group5": "Orange"}, {"ucid": "30287668", "group6": "C", "group5": "Blue"}, {"ucid": "30225456", "group6": "B", "group5": "Green"}, {"ucid": "30321256", "group6": "D", "group5": "Yellow"}, {"ucid": "30175238", "group6": "A", "group5": "Blue"}, {"ucid": "30138383", "group6": "D", "group5": "Yellow"}, {"ucid": "30321193", "group6": "B", "group5": "Blue"}, {"ucid": "30164310", "group6": "C", "group5": "Blue"}, {"ucid": "30321017", "group6": "B", "group5": "Orange"}, {"ucid": "30171152", "group6": "D", "group5": "Orange"}, {"ucid": "30214252", "group6": "C", "group5": "Green"}, {"ucid": "30179520", "group6": "C", "group5": "Orange"}, {"ucid": "30114052", "group6": "E", "group5": "Yellow"}, {"ucid": "30321231", "group6": "E", "group5": "Green"}, {"ucid": "30286902", "group6": "A", "group5": "Blue"}, {"ucid": "30320084", "group6": "F", "group5": "Purple"}, {"ucid": "30287618", "group6": "F", "group5": "Yellow"}, {"ucid": "30320999", "group6": "A", "group5": "Green"}, {"ucid": "30092671", "group6": "F", "group5": "Purple"}, {"ucid": "30320723", "group6": "C", "group5": "Green"}, {"ucid": "30321700", "group6": "F", "group5": "Blue"}, {"ucid": "10075381", "group6": "C", "group5": "Yellow"}, {"ucid": "30141531", "group6": "D", "group5": "Orange"}, {"ucid": "10149488", "group6": "C", "group5": "Purple"}, {"ucid": "30200205", "group6": "C", "group5": "Green"}, {"ucid": "30195944", "group6": "D", "group5": "Green"}, {"ucid": "30094469", "group6": "C", "group5": "Orange"}, {"ucid": "30070080", "group6": "B", "group5": "Yellow"}, {"ucid": "30032968", "group6": "E", "group5": "Yellow"}, {"ucid": "30285254", "group6": "B", "group5": "Blue"}, {"ucid": "30287675", "group6": "D", "group5": "Blue"}, {"ucid": "30095831", "group6": "E", "group5": "Orange"}, {"ucid": "30114827", "group6": "D", "group5": "Purple"}, {"ucid": "30112908", "group6": "D", "group5": "Blue"}, {"ucid": "30122752", "group6": "E", "group5": "Green"}, {"ucid": "30120517", "group6": "E", "group5": "Green"}, {"ucid": "30173245", "group6": "A", "group5": "Green"}, {"ucid": "30317170", "group6": "C", "group5": "Purple"}, {"ucid": "30175846", "group6": "E", "group5": "Orange"}, {"ucid": "30204184", "group6": "B", "group5": "Yellow"}, {"ucid": "30154040", "group6": "F", "group5": "Orange"}, {"ucid": "30321520", "group6": "A", "group5": "Blue"}, {"ucid": "30171085", "group6": "E", "group5": "Purple"}, {"ucid": "30320043", "group6": "E", "group5": "Purple"}, {"ucid": "30168825", "group6": "A", "group5": "Orange"}, {"ucid": "30280588", "group6": "F", "group5": "Purple"}, {"ucid": "30321514", "group6": "A", "group5": "Yellow"}, {"ucid": "30113602", "group6": "E", "group5": "Purple"}, {"ucid": "30119820", "group6": "A", "group5": "Yellow"}, {"ucid": "30321775", "group6": "E", "group5": "Green"}, {"ucid": "30033906", "group6": "D", "group5": "Purple"}, {"ucid": "30321807", "group6": "D", "group5": "Purple"}, {"ucid": "30097160", "group6": "F", "group5": "Blue"}, {"ucid": "30321559", "group6": "A", "group5": "Green"}, {"ucid": "30089354", "group6": "D", "group5": "Orange"}, {"ucid": "30287385", "group6": "B", "group5": "Green"}, {"ucid": "30245222", "group6": "E", "group5": "Yellow"}, {"ucid": "30315981", "group6": "A", "group5": "Green"}, {"ucid": "30088777", "group6": "C", "group5": "Purple"}, {"ucid": "30173540", "group6": "C", "group5": "Orange"}, {"ucid": "30101923", "group6": "C", "group5": "Blue"}, {"ucid": "30097693", "group6": "F", "group5": "Yellow"}, {"ucid": "30140919", "group6": "C", "group5": "Orange"}, {"ucid": "30321303", "group6": "B", "group5": "Purple"}, {"ucid": "30178963", "group6": "B", "group5": "Purple"}, {"ucid": "30321409", "group6": "F", "group5": "Orange"}, {"ucid": "30067163", "group6": "B", "group5": "Purple"}, {"ucid": "30321406", "group6": "A", "group5": "Orange"}, {"ucid": "30321119", "group6": "D", "group5": "Blue"}, {"ucid": "30321893", "group6": "F", "group5": "Orange"}, {"ucid": "30287820", "group6": "B", "group5": "Green"}, {"ucid": "10190834", "group6": "F", "group5": "Purple"}, {"ucid": "30062424", "group6": "C", "group5": "Green"}, {"ucid": "30252931", "group6": "E", "group5": "Green"}, {"ucid": "30145919", "group6": "F", "group5": "Yellow"}, {"ucid": "30321613", "group6": "E", "group5": "Purple"}, {"ucid": "30160866", "group6": "C", "group5": "Purple"}, {"ucid": "30320472", "group6": "F", "group5": "Blue"}, {"ucid": "30185042", "group6": "C", "group5": "Yellow"}, {"ucid": "30287673", "group6": "B", "group5": "Orange"}, {"ucid": "30253376", "group6": "F", "group5": "Blue"}, {"ucid": "30321455", "group6": "A", "group5": "Yellow"}, {"ucid": "30067583", "group6": "E", "group5": "Orange"}, {"ucid": "30287266", "group6": "E", "group5": "Orange"}, {"ucid": "30116429", "group6": "D", "group5": "Orange"}, {"ucid": "30321647", "group6": "A", "group5": "Green"}, {"ucid": "30172149", "group6": "A", "group5": "Blue"}, {"ucid": "30234798", "group6": "A", "group5": "Purple"}, {"ucid": "30176760", "group6": "D", "group5": "Blue"}, {"ucid": "30206562", "group6": "E", "group5": "Yellow"}, {"ucid": "30245501", "group6": "D", "group5": "Green"}], "year2": [{"ucid": "30140406", "group4": "A"}, {"ucid": "30287856", "group4": "A"}, {"ucid": "30116541", "group4": "A"}, {"ucid": "30287566", "group4": "A"}, {"ucid": "30252742", "group4": "A"}, {"ucid": "30287559", "group4": "A"}, {"ucid": "30252853", "group4": "A"}, {"ucid": "30286781", "group4": "A"}, {"ucid": "30142094", "group4": "A"}, {"ucid": "30120299", "group4": "A"}, {"ucid": "30253275", "group4": "A"}, {"ucid": "30285917", "group4": "A"}, {"ucid": "30287887", "group4": "A"}, {"ucid": "30139859", "group4": "A"}, {"ucid": "30106744", "group4": "A"}, {"ucid": "30242810", "group4": "A"}, {"ucid": "30160476", "group4": "A"}, {"ucid": "30174097", "group4": "A"}, {"ucid": "30287687", "group4": "A"}, {"ucid": "30170187", "group4": "A"}, {"ucid": "30115218", "group4": "A"}, {"ucid": "00960627", "group4": "A"}, {"ucid": "30286962", "group4": "A"}, {"ucid": "30174902", "group4": "A"}, {"ucid": "30094449", "group4": "A"}, {"ucid": "30086440", "group4": "B"}, {"ucid": "30287187", "group4": "B"}, {"ucid": "10125150", "group4": "B"}, {"ucid": "30166497", "group4": "B"}, {"ucid": "30286850", "group4": "B"}, {"ucid": "30139458", "group4": "B"}, {"ucid": "30142909", "group4": "B"}, {"ucid": "30030609", "group4": "B"}, {"ucid": "30287222", "group4": "B"}, {"ucid": "30215293", "group4": "B"}, {"ucid": "30286715", "group4": "B"}, {"ucid": "30150536", "group4": "B"}, {"ucid": "30286074", "group4": "B"}, {"ucid": "30286999", "group4": "B"}, {"ucid": "30170899", "group4": "B"}, {"ucid": "30287910", "group4": "B"}, {"ucid": "30085791", "group4": "B"}, {"ucid": "30251625", "group4": "B"}, {"ucid": "30066891", "group4": "B"}, {"ucid": "30146901", "group4": "B"}, {"ucid": "30150319", "group4": "B"}, {"ucid": "10063737", "group4": "B"}, {"ucid": "30040845", "group4": "B"}, {"ucid": "30140843", "group4": "B"}, {"ucid": "30142509", "group4": "B"}, {"ucid": "30164664", "group4": "C"}, {"ucid": "30284853", "group4": "C"}, {"ucid": "30287544", "group4": "C"}, {"ucid": "30090830", "group4": "C"}, {"ucid": "10132764", "group4": "C"}, {"ucid": "30120016", "group4": "C"}, {"ucid": "30070123", "group4": "C"}, {"ucid": "30140953", "group4": "C"}, {"ucid": "30286842", "group4": "C"}, {"ucid": "30287473", "group4": "C"}, {"ucid": "30286790", "group4": "C"}, {"ucid": "30287574", "group4": "C"}, {"ucid": "30287437", "group4": "C"}, {"ucid": "30134840", "group4": "C"}, {"ucid": "30281692", "group4": "C"}, {"ucid": "30022739", "group4": "C"}, {"ucid": "30117050", "group4": "C"}, {"ucid": "30150159", "group4": "C"}, {"ucid": "30122879", "group4": "C"}, {"ucid": "30284822", "group4": "C"}, {"ucid": "30111963", "group4": "C"}, {"ucid": "30142731", "group4": "C"}, {"ucid": "00306568", "group4": "C"}, {"ucid": "30229424", "group4": "C"}, {"ucid": "30145477", "group4": "C"}, {"ucid": "30119732", "group4": "D"}, {"ucid": "30118105", "group4": "D"}, {"ucid": "30205951", "group4": "D"}, {"ucid": "30089245", "group4": "D"}, {"ucid": "30171598", "group4": "D"}, {"ucid": "30096210", "group4": "D"}, {"ucid": "30252324", "group4": "D"}, {"ucid": "30070528", "group4": "D"}, {"ucid": "30287384", "group4": "D"}, {"ucid": "30115754", "group4": "D"}, {"ucid": "30287472", "group4": "D"}, {"ucid": "10196727", "group4": "D"}, {"ucid": "30095321", "group4": "D"}, {"ucid": "30112667", "group4": "D"}, {"ucid": "30032833", "group4": "D"}, {"ucid": "30286663", "group4": "D"}, {"ucid": "30215723", "group4": "D"}, {"ucid": "30253331", "group4": "D"}, {"ucid": "30033111", "group4": "D"}, {"ucid": "10162131", "group4": "D"}, {"ucid": "30037791", "group4": "D"}, {"ucid": "30103052", "group4": "D"}, {"ucid": "30271655", "group4": "D"}, {"ucid": "30248192", "group4": "D"}, {"ucid": "30048478", "group4": "D"}], "year3": [{"ucid": "30150616", "group3": "3", "group2": "2"}, {"ucid": "30145215", "group3": "1", "group2": "1"}, {"ucid": "30253234", "group3": "2", "group2": "2"}, {"ucid": "30122878", "group3": "1", "group2": "1"}, {"ucid": "30128571", "group3": "2", "group2": "2"}, {"ucid": "30094127", "group3": "2", "group2": "2"}, {"ucid": "10149440", "group3": "3", "group2": "1"}, {"ucid": "30252560", "group3": "1", "group2": "2"}, {"ucid": "30048177", "group3": "1", "group2": "1"}, {"ucid": "30150500", "group3": "3", "group2": "2"}, {"ucid": "30117349", "group3": "3", "group2": "2"}, {"ucid": "30253258", "group3": "3", "group2": "2"}, {"ucid": "30252767", "group3": "1", "group2": "1"}, {"ucid": "30044270", "group3": "3", "group2": "2"}, {"ucid": "30072399", "group3": "3", "group2": "1"}, {"ucid": "30252365", "group3": "1", "group2": "2"}, {"ucid": "30018553", "group3": "1", "group2": "1"}, {"ucid": "30139324", "group3": "3", "group2": "1"}, {"ucid": "30095990", "group3": "3", "group2": "1"}, {"ucid": "30180755", "group3": "2", "group2": "1"}, {"ucid": "30114815", "group3": "3", "group2": "2"}, {"ucid": "30252881", "group3": "2", "group2": "2"}, {"ucid": "30253047", "group3": "3", "group2": "1"}, {"ucid": "30180902", "group3": "1", "group2": "1"}, {"ucid": "30069329", "group3": "1", "group2": "1"}, {"ucid": "30068117", "group3": "3", "group2": "2"}, {"ucid": "30116661", "group3": "2", "group2": "1"}, {"ucid": "30252799", "group3": "2", "group2": "1"}, {"ucid": "30061615", "group3": "1", "group2": "2"}, {"ucid": "30251526", "group3": "3", "group2": "2"}, {"ucid": "10084665", "group3": "1", "group2": "2"}, {"ucid": "30102569", "group3": "2", "group2": "1"}, {"ucid": "30041483", "group3": "1", "group2": "2"}, {"ucid": "30252923", "group3": "2", "group2": "2"}, {"ucid": "30148198", "group3": "3", "group2": "1"}, {"ucid": "30250832", "group3": "1", "group2": "2"}, {"ucid": "30131854", "group3": "2", "group2": "1"}, {"ucid": "30252928", "group3": "1", "group2": "1"}, {"ucid": "30096287", "group3": "2", "group2": "2"}, {"ucid": "30073743", "group3": "2", "group2": "1"}, {"ucid": "30039414", "group3": "1", "group2": "2"}, {"ucid": "30024831", "group3": "2", "group2": "2"}, {"ucid": "30131475", "group3": "1", "group2": "2"}, {"ucid": "30250015", "group3": "2", "group2": "1"}, {"ucid": "30253252", "group3": "3", "group2": "2"}, {"ucid": "30117828", "group3": "1", "group2": "1"}, {"ucid": "30114585", "group3": "3", "group2": "1"}, {"ucid": "30140351", "group3": "1", "group2": "2"}, {"ucid": "30119169", "group3": "3", "group2": "2"}, {"ucid": "30115375", "group3": "2", "group2": "2"}, {"ucid": "30252754", "group3": "1", "group2": "2"}, {"ucid": "30252342", "group3": "1", "group2": "1"}, {"ucid": "30213109", "group3": "2", "group2": "1"}, {"ucid": "30103436", "group3": "2", "group2": "1"}, {"ucid": "30251858", "group3": "2", "group2": "2"}, {"ucid": "30073662", "group3": "3", "group2": "1"}, {"ucid": "30204476", "group3": "3", "group2": "1"}]};

  function openGroupRoster(rosterYear) {
    const modal = document.getElementById('modal');
    const students = ROSTER_DATA[rosterYear] || [];
    let title, headerCols, bodyRows;
    if (rosterYear === 'year1') {
      title = 'Year 1 Lab Groups';
      headerCols = ['UCID', '6-Group Scheme', '5-Group Scheme'];
      bodyRows = students.map(s => `<tr><td>${escapeHtml(s.ucid)}</td><td>${renderGroupBadge(s.group6)}</td><td>${renderGroupBadge(s.group5)}</td></tr>`);
    } else if (rosterYear === 'year2') {
      title = 'Year 2 Lab Groups';
      headerCols = ['UCID', 'Group'];
      bodyRows = students.map(s => `<tr><td>${escapeHtml(s.ucid)}</td><td>${renderGroupBadge(s.group4)}</td></tr>`);
    } else {
      title = 'Year 3 (505) Lab Groups';
      headerCols = ['UCID', '3-Group Scheme', '2-Group Scheme'];
      bodyRows = students.map(s => `<tr><td>${escapeHtml(s.ucid)}</td><td>${renderGroupBadge(s.group3)}</td><td>${renderGroupBadge(s.group2)}</td></tr>`);
    }

    modal.innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box" style="width:min(600px,94vw)">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header">
          <div class="modal-title">🧑‍🤝‍🧑 ${escapeHtml(title)}</div>
          <div class="modal-subtitle">Look up your group by UCID. Names aren't shown here since this page is public — cross-reference your UCID against the roster your program shared with you.</div>
        </div>
        <div class="modal-body">
          <div class="lab-matrix-wrap" style="max-height:60vh;overflow-y:auto">
            <table class="lab-matrix-table">
              <thead><tr>${headerCols.map(h=>`<th>${escapeHtml(h)}</th>`).join('')}</tr></thead>
              <tbody>${bodyRows.join('')}</tbody>
            </table>
          </div>
        </div>
        <div class="modal-footer">
          <div></div>
          <button class="btn btn-secondary" id="detail-close-btn">Close</button>
        </div>
      </div>`;
    modal.classList.add('open');
    document.getElementById('modal-close').onclick = closeForm;
    document.getElementById('modal-backdrop').onclick = closeForm;
    document.getElementById('detail-close-btn').onclick = closeForm;
  }

  // Prefer the stored last-name-only display field (new lab data); fall back
  // to deriving one from the full name for older sessions that don't have it.
  function shortInstructorName(full, display) {
    if (display) return display;
    if (!full) return '';
    const parts = full.trim().split(/\s+/);
    return parts[parts.length - 1];
  }
  function tileInstructorNames(s) {
    const names = [shortInstructorName(s.primaryInstructor, s.primaryInstructorDisplay), shortInstructorName(s.secondaryInstructor, s.secondaryInstructorDisplay)].filter(Boolean);
    return names.join(', ');
  }

  // ════════════════════════════════════════════════════════════
  // FILTERING
  // ════════════════════════════════════════════════════════════
  function getFiltered() {
    let data = [...allSessions];
    if (filters.year   !== 'all') data = data.filter(s => String(s.year) === String(filters.year));
    if (filters.week   !== 'all') data = data.filter(s => {
      if (!s.date) return false;
      const sw = calcSemesterWeek(s.date);
      return sw.semester === filters.weekSemester && String(sw.week) === String(filters.week);
    });
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

  let searchViewMode = 'list'; // 'list' | 'calendar' — only relevant while a search is active
  function renderAll() {
    const searchActive = !!filters.search;
    document.getElementById('search-view-toggle').classList.toggle('hidden', !searchActive);
    const showList = searchActive && searchViewMode === 'list';
    document.getElementById('search-results-card').classList.toggle('hidden', !showList);
    document.getElementById('cal-card').classList.toggle('hidden', showList);
    if (showList) renderSearchResults(); else renderCalendar();
    renderChips();
    populateCourseDropdown(filters.year);
  }
  document.getElementById('search-view-list').addEventListener('click', () => {
    searchViewMode = 'list';
    document.getElementById('search-view-list').classList.add('active');
    document.getElementById('search-view-cal').classList.remove('active');
    renderAll();
  });
  document.getElementById('search-view-cal').addEventListener('click', () => {
    searchViewMode = 'calendar';
    document.getElementById('search-view-cal').classList.add('active');
    document.getElementById('search-view-list').classList.remove('active');
    renderAll();
  });

  // ── Custom Course dropdown (supports wrapped option text) ──────
  function populateCourseDropdown(year) {
    // Build the list from real session data (course + its actual stored year)
    // rather than the hardcoded courseData mapping — a course can legitimately
    // carry a different Year than courseData's default grouping (e.g. some
    // 505 lab sessions are tagged Year 1 even though 505's lecture component
    // is a Year 3 course), and the filter should reflect what's really there.
    const seen = new Map(); // code -> {code, name, years:Set}
    allSessions.forEach(s => {
      if (!s.course) return;
      if (!seen.has(s.course)) {
        const known = CourseData.findCourse(s.course);
        seen.set(s.course, { code: s.course, name: s.courseName || (known ? known.name : ''), years: new Set() });
      }
      if (s.year != null) seen.get(s.course).years.add(String(s.year));
    });
    let list = [...seen.values()];
    if (year !== 'all') list = list.filter(c => c.years.has(String(year)));
    list.sort((a,b) => a.code.localeCompare(b.code, undefined, {numeric:true}));

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
  document.getElementById('filter-month').addEventListener('change', e => {
    filters.month = e.target.value;
    if (filters.month !== 'all') {
      const m = MONTH_SEQUENCE.find(x => x.value === filters.month);
      if (m) {
        calDate = new Date(m.year, m.month, 1);
        const wantSemester = m.month >= 7 ? 'fall' : 'winter'; // Aug-Dec = fall, Jan-Apr = winter
        if (wantSemester !== currentSemester) {
          currentSemester = wantSemester;
          document.querySelectorAll('#semester-btn-row .pill-btn').forEach(b => b.classList.toggle('active', b.dataset.semester===wantSemester));
        }
        filters.week = 'all'; filters.weekSemester = currentSemester;
        populateWeekButtons();
      }
    }
    renderAll();
  });

  // ════════════════════════════════════════════════════════════
  // YEAR + WEEK BUTTON NAVIGATION
  // ════════════════════════════════════════════════════════════
  // ════════════════════════════════════════════════════════════
  // YEAR + SEMESTER + WEEK BUTTON NAVIGATION
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

  document.getElementById('semester-btn-row').addEventListener('click', e => {
    const btn = e.target.closest('.pill-btn'); if (!btn) return;
    document.querySelectorAll('#semester-btn-row .pill-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentSemester = btn.dataset.semester;
    filters.week = 'all'; filters.weekSemester = currentSemester;
    populateWeekButtons();
    calDate = weekMondaySem(currentSemester, 1);
    renderAll();
  });

  function populateWeekButtons() {
    const row1 = document.getElementById('week-btn-row-1');
    const row2 = document.getElementById('week-btn-row-2');
    const count = currentSemester === 'winter' ? WINTER_WEEKS_COUNT : FALL_WEEKS_COUNT;

    row1.innerHTML = `<button class="pill-btn ${filters.week==='all'?'active':''}" data-week="all">All Weeks</button>` +
      Array.from({length: 8}, (_,i) => i+1).map(w =>
        `<button class="pill-btn ${String(filters.week)===String(w)?'active':''}" data-week="${w}">${weekButtonLabelSem(currentSemester, w)}</button>`).join('');
    row2.innerHTML = Array.from({length: Math.max(count-8,0)}, (_,i) => i+9).map(w =>
      `<button class="pill-btn ${String(filters.week)===String(w)?'active':''}" data-week="${w}">${weekButtonLabelSem(currentSemester, w)}</button>`).join('');

    // Mobile dropdown mirrors the same options
    const mobileSel = document.getElementById('week-mobile-select');
    mobileSel.innerHTML = `<option value="all">All Weeks</option>` +
      Array.from({length: count}, (_,i) => i+1).map(w => `<option value="${w}">${weekButtonLabelSem(currentSemester, w)}</option>`).join('');
    mobileSel.value = filters.week;
  }
  document.getElementById('week-mobile-select').addEventListener('change', e => {
    document.querySelectorAll('#week-btn-row-1 .pill-btn, #week-btn-row-2 .pill-btn').forEach(b => b.classList.toggle('active', b.dataset.week===e.target.value));
    filters.week = e.target.value;
    filters.weekSemester = currentSemester;
    if (e.target.value !== 'all') {
      calDate = weekMondaySem(currentSemester, parseInt(e.target.value));
      calView = 'week';
      document.getElementById('cal-week-btn').classList.add('active');
      document.getElementById('cal-month-btn').classList.remove('active');
    }
    renderAll();
  });
  function wireWeekButtonRow(rowId) {
    document.getElementById(rowId).addEventListener('click', e => {
      const btn = e.target.closest('.pill-btn'); if (!btn) return;
      document.querySelectorAll('#week-btn-row-1 .pill-btn, #week-btn-row-2 .pill-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filters.week = btn.dataset.week;
      filters.weekSemester = currentSemester;
      document.getElementById('week-mobile-select').value = btn.dataset.week;
      if (btn.dataset.week !== 'all') {
        calDate = weekMondaySem(currentSemester, parseInt(btn.dataset.week));
        calView = 'week';
        document.getElementById('cal-week-btn').classList.add('active');
        document.getElementById('cal-month-btn').classList.remove('active');
      }
      renderAll();
    });
  }
  wireWeekButtonRow('week-btn-row-1');
  wireWeekButtonRow('week-btn-row-2');

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
  document.getElementById('add-session-btn').addEventListener('click', () => {
    if (!isAdmin) return;
    openForm(null, dateKey(calDate));
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
      const sw = calcSemesterWeek(dateKey(days[0]));
      labelEl.textContent = weekHeaderLabelSem(days, sw.semester, sw.week);
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
      const dayRows = data.filter(s => s.date === dk).map(s => {
        let st = Math.max(timeToMinutes(s.startTime), DAY_START_MIN);
        let en = Math.min(timeToMinutes(s.endTime) ?? st+50, DAY_END_MIN);
        if (en <= st) en = st + 5;
        return { ...s, _start: st, _end: en };
      });
      // Merge lab-day rows into tiles (same grouping as week view) so a
      // multi-row lab program shows as one chip, not one chip per row.
      const labTiles = buildLabTiles(dayRows);
      const plain = dayRows.filter(s => !s.labGroupId);
      const events = [...labTiles, ...plain].sort((a,b) => (a.start ?? a._start) - (b.start ?? b._start));

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
    wireLabTileClicks(container);
  }

  function renderMonthChip(s, hidden) {
    if (s.isLabTile) {
      // Merged lab tile — same grouped content as the week view, condensed
      // to fit a month cell: course/type + a short topic summary.
      const topicSummary = s.wholeClassTopics.concat(s.rotationStations.map(r=>r.topic)).filter(Boolean);
      const summaryText = topicSummary.length ? topicSummary[0] + (topicSummary.length > 1 || s.srlList.length ? ' +more' : '') : (s.srlList[0]?.topic || '');
      return `<div class="cal-event tg-lab-tile ${hidden?'cal-event-hidden':''}" data-ids="${s.items.map(i=>i.id).join(',')}">
        <span class="cal-event-l1">${escapeHtml(s.course||'—')} ${escapeHtml(s.type||'')}</span>
        <span class="cal-event-l2">${escapeHtml(summaryText)}</span>
      </div>`;
    }
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

  // Group same-day sessions by their EXACT start time (not general interval
  // overlap — overlap-based merging was chaining unrelated later sessions
  // into one runaway 8:30 cluster whenever an earlier session's span was long).
  // Each distinct start-time value becomes its own slot; a slot with 2+
  // sessions renders as a Month-view-style stacked mini-list with "+N more".
  function bucketEventsByStartTime(events) {
    const groups = new Map();
    events.forEach(ev => {
      const key = ev.startTime || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(ev);
    });
    return [...groups.values()]
      .map(items => ({ start: Math.min(...items.map(i=>i._start)), end: Math.max(...items.map(i=>i._end)), items }))
      .sort((a,b) => a.start - b.start);
  }

  // Different start-time buckets can still genuinely overlap in real time
  // (e.g. a Year 2 session 10:30–11:30 and a Year 3 session 10:45–12:15,
  // especially common in the "All Years" view). Give each such bucket its
  // own side-by-side lane instead of letting them paint on top of each other.
  // Each cluster/lab-tile's items[0] carries the real session's Year — use it
  // as a stable rank so the same course level always lands on the same side.
  function laneRank(item) {
    const yr = parseInt(item.items?.[0]?.year, 10);
    return Number.isFinite(yr) ? yr : 99; // unknown years sort last (rightmost)
  }

  function assignLanes(clusters) {
    const groups = [];
    let current = null;
    clusters.forEach(c => {
      if (current && c.start < current.maxEnd) { current.items.push(c); current.maxEnd = Math.max(current.maxEnd, c.end); }
      else { current = { items: [c], maxEnd: c.end }; groups.push(current); }
    });
    groups.forEach(g => {
      // Within this overlap group, process items in Year order (1, 2, 3, …)
      // so lower years always claim the lower (left) lane numbers, regardless
      // of which items happen to start earliest or be processed first.
      const byRank = new Map();
      g.items.forEach(c => {
        const r = laneRank(c);
        if (!byRank.has(r)) byRank.set(r, []);
        byRank.get(r).push(c);
      });
      const ranks = [...byRank.keys()].sort((a,b) => a-b);
      let laneOffset = 0;
      ranks.forEach(r => {
        const items = byRank.get(r).sort((a,b) => a.start - b.start);
        const laneEnds = [];
        items.forEach(c => {
          let lane = laneEnds.findIndex(end => end <= c.start);
          if (lane === -1) { lane = laneEnds.length; laneEnds.push(c.end); } else { laneEnds[lane] = c.end; }
          c.lane = laneOffset + lane;
        });
        laneOffset += laneEnds.length;
      });
      const laneCount = laneOffset;
      g.items.forEach(c => c.laneCount = laneCount);
    });
    return clusters;
  }

  // Group same-day, same-course sessions that carry a labGroupId into
  // compact tiles. Rather than matching an exact labGroupId+column string
  // (different sections of one lab day — whole-class intro, color rotation,
  // SRL — can carry different labGroupId suffixes), this groups by course
  // first, then splits into separate tiles only where a real time gap
  // exists (e.g. a lunch break) — so continuous/overlapping content from
  // any labGroupId variant merges into one tile, while genuinely separate
  // time blocks (like a Block Week's AM vs PM session) stay apart.
  function buildLabTiles(events) {
    const byCourse = new Map();
    events.filter(ev => ev.labGroupId).forEach(ev => {
      if (!byCourse.has(ev.course)) byCourse.set(ev.course, []);
      byCourse.get(ev.course).push(ev);
    });

    const NOON_MIN = 12 * 60;
    const tiles = [];
    byCourse.forEach(items => {
      // "Block Week" style days (labGroupId prefixed BlockWeek) explicitly
      // split into a morning and afternoon session; every other lab course
      // merges its entire day into one tile regardless of internal gaps
      // (e.g. a lunch break inside a rotation should NOT split the tile).
      const isBlockWeek = items.some(i => String(i.labGroupId||'').startsWith('BlockWeek'));
      if (isBlockWeek) {
        const am = items.filter(i => i._start < NOON_MIN);
        const pm = items.filter(i => i._start >= NOON_MIN);
        [am, pm].forEach(group => {
          if (!group.length) return;
          tiles.push({ start: Math.min(...group.map(i=>i._start)), end: Math.max(...group.map(i=>i._end)), items: group });
        });
      } else {
        tiles.push({ start: Math.min(...items.map(i=>i._start)), end: Math.max(...items.map(i=>i._end)), items });
      }
    });

    return tiles.map(t => summarizeLabTile(t));
  }

  function isWholeClass(s) { return String(s.group||'').trim().toLowerCase() === 'all'; }

  function summarizeLabTile(t) {
    const items = t.items;
    const hasLab = items.some(i => i.type === 'LAB');
    const labelType = hasLab ? 'LAB' : items[0].type;

    const wholeClass = items.filter(i => i.type !== 'SRL' && isWholeClass(i)).sort((a,b) => a._start - b._start);
    const rotationRaw = items.filter(i => i.type !== 'SRL' && !isWholeClass(i));
    // Preserve the true source-file topic order via an explicit sortOrder
    // field when present (set during import) — Firestore doesn't guarantee
    // document order, so without this, station order can appear arbitrary.
    const hasSortOrder = rotationRaw.length && rotationRaw.every(i => i.sortOrder != null && i.sortOrder !== '');
    const rotation = hasSortOrder ? [...rotationRaw].sort((a,b) => Number(a.sortOrder) - Number(b.sortOrder)) : rotationRaw;
    const srl = items.filter(i => i.type === 'SRL').sort((a,b) => a._start - b._start);

    const wholeClassInstructors = [...new Set(wholeClass.flatMap(i => [shortInstructorName(i.primaryInstructor,i.primaryInstructorDisplay), shortInstructorName(i.secondaryInstructor,i.secondaryInstructorDisplay)]).filter(Boolean))];

    const stationOrder = []; const seenStation = new Set();
    rotation.forEach(i => { if (!seenStation.has(i.topic)) { seenStation.add(i.topic); stationOrder.push(i.topic); } });
    const rotationStations = stationOrder.map(topic => {
      const row = rotation.find(i => i.topic === topic);
      const primary = shortInstructorName(row.primaryInstructor, row.primaryInstructorDisplay);
      const secondary = shortInstructorName(row.secondaryInstructor, row.secondaryInstructorDisplay);
      return { topic, instructor: [primary, secondary ? `(${secondary})` : ''].filter(Boolean).join(' ') };
    });

    const srlSeen = new Set();
    const srlList = [];
    srl.forEach(i => { if (!srlSeen.has(i.topic)) { srlSeen.add(i.topic); srlList.push({ topic: i.topic, instructor: shortInstructorName(i.primaryInstructor, i.primaryInstructorDisplay) }); } });

    return {
      start: t.start, end: t.end, isLabTile: true,
      course: items[0].course, type: labelType,
      wholeClassTopics: wholeClass.map(i => i.topic), wholeClassInstructors,
      rotationStations, srlList, items,
    };
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

      const labTiles = buildLabTiles(events);
      const plainEvents = events.filter(ev => !ev.labGroupId);
      const clusters = bucketEventsByStartTime(plainEvents);
      const renderItems = assignLanes([...labTiles, ...clusters].sort((a,b) => a.start - b.start));

      html += `<div class="tg-day-col ${isTd?'today-col':''}"><div class="tg-track">`;
      html += timeline.hourMarks.map(m => `<div class="tg-gridline" style="top:${timeline.toPct(m)}%"></div>`).join('');

      renderItems.forEach(cluster => {
        const topPct = timeline.toPct(cluster.start), heightPct = Math.max(timeline.toPct(cluster.end) - topPct, 2);
        const laneCount = cluster.laneCount || 1, lane = cluster.lane || 0;
        const laneWidth = 100 / laneCount;
        const posStyle = `top:${topPct}%;height:${heightPct}%;left:calc(${lane*laneWidth}% + 2px);width:calc(${laneWidth}% - 4px)`;

        if (cluster.isLabTile) {
          if (cluster.items.length === 1) {
            // A tile that ended up with just one row (e.g. a standalone
            // whole-class session with nothing else nearby in time) reads
            // better as a plain simple block, same as any LEC/SRL card.
            const s = cluster.items[0];
            const color = colorsOn ? getCourseColor(s.course) : null;
            const style = colorsOn ? `${posStyle};background:${color.bg};border-left-color:${color.border}` : posStyle;
            const instrText = s.finalizedInstructors || tileInstructorNames(s) || s.primaryInstructor || '';
            html += `<div class="tg-block ${colorsOn?'':'colors-off'}" style="${style}" data-id="${s.id}">
              <div class="tg-block-l1">${escapeHtml(s.course||'—')} ${escapeHtml(s.type||'')}</div>
              <div class="tg-block-l2">${escapeHtml(s.topic||'')}</div>
              ${instrText ? `<div class="tg-block-l3">${escapeHtml(instrText)}</div>` : ''}
            </div>`;
          } else {
            const ids = cluster.items.map(i => i.id).join(',');
            let inner = '';
            if (cluster.wholeClassTopics.length) {
              inner += `<div class="tg-lab-section">` +
                cluster.wholeClassTopics.map(t => `<div class="tg-lab-line-bold">${escapeHtml(t)}</div>`).join('') +
                (cluster.wholeClassInstructors.length ? `<div class="tg-lab-line">${escapeHtml(cluster.wholeClassInstructors.join(', '))}</div>` : '') +
                `</div>`;
            }
            cluster.rotationStations.forEach(st => {
              inner += `<div class="tg-lab-section">
                <div class="tg-lab-line-bold">${escapeHtml(st.topic)}</div>
                ${st.instructor ? `<div class="tg-lab-line">${escapeHtml(st.instructor)}</div>` : ''}
              </div>`;
            });
            cluster.srlList.forEach(s => {
              inner += `<div class="tg-lab-section">
                <div class="tg-lab-line-bold">SRL: ${escapeHtml(s.topic)}</div>
                ${s.instructor ? `<div class="tg-lab-line">${escapeHtml(s.instructor)}</div>` : ''}
              </div>`;
            });
            html += `<div class="tg-block tg-lab-tile ${colorsOn?'':'colors-off'}" style="${posStyle}" data-ids="${escapeHtml(ids)}">
              <div class="tg-block-l1">${escapeHtml(cluster.course||'')} ${escapeHtml(cluster.type||'')}</div>
              <div class="tg-lab-tile-body">${inner}</div>
            </div>`;
          }
        } else if (cluster.items.length === 1) {
          const s = cluster.items[0];
          const color = colorsOn ? getCourseColor(s.course) : null;
          const style = colorsOn
            ? `${posStyle};background:${color.bg};border-left-color:${color.border}`
            : posStyle;
          const instrText = s.finalizedInstructors || tileInstructorNames(s) || s.primaryInstructor || 'TBD';
          html += `<div class="tg-block ${colorsOn?'':'colors-off'}" style="${style}" data-id="${s.id}">
            <div class="tg-block-l1">${escapeHtml(s.course||'—')} ${escapeHtml(s.type||'')}</div>
            <div class="tg-block-l2">${escapeHtml(s.topic||'')}</div>
            <div class="tg-block-l3">${escapeHtml(instrText)}</div>
          </div>`;
        } else {
          const MAX = 3;
          const shown = cluster.items.slice(0, MAX), overflow = cluster.items.slice(MAX);
          html += `<div class="tg-cluster" style="${posStyle}">`;
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
    wireLabTileClicks(container);
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
  function wireLabTileClicks(container) {
    container.querySelectorAll('.tg-lab-tile').forEach(el => {
      el.addEventListener('click', e => {
        e.stopPropagation();
        openLabMatrixDetail(el.dataset.ids.split(','));
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
  // When a specific Week filter is active, keep it in sync with whatever
  // week the calendar is actually showing — otherwise navigating with the
  // arrows leaves the filter pointing at the old week and the view goes
  // blank (nothing matches the stale week number anymore).
  function syncWeekFilterToCalDate() {
    if (calView !== 'week' || filters.week === 'all') return;
    const days = buildWeekDays(calDate);
    const sw = calcSemesterWeek(dateKey(days[0]));
    if (sw.semester !== currentSemester) {
      currentSemester = sw.semester;
      document.querySelectorAll('#semester-btn-row .pill-btn').forEach(b => b.classList.toggle('active', b.dataset.semester===sw.semester));
    }
    filters.week = String(sw.week);
    filters.weekSemester = sw.semester;
    populateWeekButtons();
  }

  document.getElementById('cal-prev').addEventListener('click', () => {
    calDate = calView==='month' ? new Date(calDate.getFullYear(),calDate.getMonth()-1,1) : addDays(calDate,-7);
    syncWeekFilterToCalDate();
    renderCalendar();
  });
  document.getElementById('cal-next').addEventListener('click', () => {
    calDate = calView==='month' ? new Date(calDate.getFullYear(),calDate.getMonth()+1,1) : addDays(calDate,7);
    syncWeekFilterToCalDate();
    renderCalendar();
  });
  document.getElementById('cal-today').addEventListener('click', () => { calDate = new Date(); syncWeekFilterToCalDate(); renderCalendar(); });
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
    filters = { search:'', year:'all', month:'all', week:'all', weekSemester:'fall', course:'all', type:'all' };
    currentSemester = 'fall';
    document.getElementById('search-input').value = '';
    document.getElementById('filter-month').value = 'all';
    document.getElementById('filter-type').value = 'all';
    document.querySelectorAll('#year-btn-row .pill-btn').forEach(b => b.classList.toggle('active', b.dataset.year==='all'));
    document.querySelectorAll('#semester-btn-row .pill-btn').forEach(b => b.classList.toggle('active', b.dataset.semester==='fall'));
    populateWeekButtons();
    populateCourseDropdown('all');
    renderAll();
  }
  document.getElementById('reset-filters').addEventListener('click', resetFilters);
  document.getElementById('chips-clear').addEventListener('click', resetFilters);

  function renderChips() {
    const active = [];
    if (filters.year   !== 'all') active.push({k:'year',  l:`Year ${filters.year}`});
    if (filters.week   !== 'all') active.push({k:'week',  l:`${filters.weekSemester==='winter'?'Winter':'Fall'} Week ${filters.week}`});
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
        else if (k === 'week') { filters.week='all'; document.querySelectorAll('#week-btn-row-1 .pill-btn, #week-btn-row-2 .pill-btn').forEach(b=>b.classList.toggle('active',b.dataset.week==='all')); }
        renderAll();
      });
    });
  }

  // ════════════════════════════════════════════════════════════
  // READ-ONLY DETAIL POPUP (click any session block)
  // ════════════════════════════════════════════════════════════
  function fmtDetailDate(dateStr) {
    if (!dateStr) return '';
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-CA', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function openDetail(session) {
    const modal = document.getElementById('modal');
    const isLab = String(session.type||'').toUpperCase() === 'LAB';
    const showSpyHillLink = isLab && !['202','302'].includes(String(session.course));
    const sw = session.date ? calcSemesterWeek(session.date) : null;
    const semWeekLabel = sw ? `${sw.semester==='winter'?'Winter':'Fall'} Week ${sw.week}` : '';
    const instructorRows = isLab
      ? `<div class="detail-row"><span class="detail-label">👤 Primary Instructor</span><span class="detail-value">${escapeHtml(session.primaryInstructor||'TBD')}</span></div>
         <div class="detail-row"><span class="detail-label">👥 Secondary Instructor</span><span class="detail-value">${escapeHtml(session.secondaryInstructor||'—')}</span></div>`
      : `<div class="detail-row"><span class="detail-label">👤 Instructor</span><span class="detail-value">${escapeHtml(session.finalizedInstructors||'TBD')}</span></div>`;

    modal.innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header">
          <div class="modal-title">${escapeHtml(session.course||'')} ${escapeHtml(session.type||'')}</div>
          <div class="modal-subtitle">${escapeHtml(session.day||'')}, ${fmtDetailDate(session.date)} · ${escapeHtml(semWeekLabel)}</div>
        </div>
        <div class="modal-body">
          <div class="detail-row"><span class="detail-label">📘 Course</span><span class="detail-value">${escapeHtml(session.course||'')} – ${escapeHtml(session.courseName||'')}</span></div>
          <div class="detail-row"><span class="detail-label">🏷️ Type</span><span class="detail-value">${escapeHtml(session.type||'')}</span></div>
          <div class="detail-row"><span class="detail-label">🎓 Year</span><span class="detail-value">Year ${escapeHtml(String(session.year||''))}</span></div>
          <div class="detail-row"><span class="detail-label">🕐 Time</span><span class="detail-value">${escapeHtml(session.startTime||'')} – ${escapeHtml(session.endTime||'')}</span></div>
          <div class="detail-row"><span class="detail-label">📍 Room</span><span class="detail-value">${escapeHtml(getRoom(session))}${showSpyHillLink ? ` &nbsp;·&nbsp; <a class="detail-lab-link" href="${SPY_HILL_URL}" target="_blank" rel="noopener">View Spy Hill Lab Schedule ↗</a>` : ''}</span></div>
          <div class="detail-row"><span class="detail-label">📝 Topic</span><span class="detail-value">${escapeHtml(session.topic||'—')}</span></div>
          ${session.group ? `<div class="detail-row"><span class="detail-label">🧩 Group</span><span class="detail-value">${escapeHtml(session.group)}</span></div>` : ''}
          ${instructorRows}
          ${session.notes ? `<div class="detail-row"><span class="detail-label">🗒️ Notes</span><span class="detail-value">${escapeHtml(session.notes)}</span></div>` : ''}
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
  // LAB ROTATION MATRIX POPUP — reconstructs the "Second Year Lab / 505 Lab"
  // style table from all sessions sharing one labGroupId(+column).
  // ════════════════════════════════════════════════════════════
  function buildMatrixTable(rowsIn, { withTimeColumns }) {
    if (!rowsIn.length) return '';
    const hasSortOrder = rowsIn.every(s => s.sortOrder != null && s.sortOrder !== '');
    const rows = hasSortOrder ? [...rowsIn].sort((a,b) => Number(a.sortOrder) - Number(b.sortOrder)) : rowsIn;
    const stationMap = new Map();
    rows.forEach(s => {
      const key = `${s.topic}||${s.primaryInstructor||''}||${s.secondaryInstructor||''}`;
      if (!stationMap.has(key)) {
        stationMap.set(key, {
          topic: s.topic, room: getRoom(s), firstRow: s,
          instructorLabel: [s.primaryInstructor, s.secondaryInstructor ? `(${s.secondaryInstructor})` : ''].filter(Boolean).join(' '),
          cellsBySlot: new Map(),
        });
      }
      const st = stationMap.get(key);
      const slotKey = `${s.startTime}|${s.endTime}`;
      if (!st.cellsBySlot.has(slotKey)) st.cellsBySlot.set(slotKey, []);
      st.cellsBySlot.get(slotKey).push(s);
    });
    const stations = [...stationMap.values()];
    const editableClass = isAdmin ? 'lab-matrix-editable' : '';

    if (!withTimeColumns) {
      // SRL section — no time columns, students can take it anytime that day
      const bodyRows = stations.map(st => `<tr class="${editableClass}" data-edit-id="${st.firstRow.id}">
        <td class="lab-matrix-station">${escapeHtml(st.topic||'')}<div class="lab-matrix-instructor">${escapeHtml(st.instructorLabel||'')}</div></td>
        <td class="lab-matrix-room">${escapeHtml(st.room||'')}</td>
      </tr>`).join('');
      return `<table class="lab-matrix-table">
        <thead><tr><th>SRL</th><th>Room</th></tr></thead>
        <tbody>${bodyRows}</tbody>
      </table>`;
    }

    // Preserve slot order as first-encountered in the row data (matches source order)
    const slotOrderMap = new Map();
    rows.forEach(s => { const k = `${s.startTime}|${s.endTime}`; if (!slotOrderMap.has(k)) slotOrderMap.set(k, { start: s.startTime, end: s.endTime }); });
    const slots = [...slotOrderMap.values()].sort((a,b) => (a.start||'').localeCompare(b.start||''));

    const headerCells = slots.map(sl => `<th>${escapeHtml(sl.start)}-${escapeHtml(sl.end)}</th>`).join('');
    const bodyRows = stations.map(st => {
      const cells = slots.map(sl => {
        const key = `${sl.start}|${sl.end}`;
        const matches = st.cellsBySlot.get(key) || [];
        if (!matches.length) return `<td class="lab-matrix-empty"></td>`;
        return `<td>${matches.map(m => `<span class="${editableClass}" data-edit-id="${m.id}">${renderGroupBadge(m.group)}</span>`).join(' ')}</td>`;
      }).join('');
      return `<tr>
        <td class="lab-matrix-station">${escapeHtml(st.topic||'')}<div class="lab-matrix-instructor">${escapeHtml(st.instructorLabel||'')}</div></td>
        <td class="lab-matrix-room">${escapeHtml(st.room||'')}</td>
        ${cells}
      </tr>`;
    }).join('');
    return `<table class="lab-matrix-table">
      <thead><tr><th>Station / Instructor</th><th>Room</th>${headerCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>`;
  }

  function openLabMatrixDetail(ids) {
    const idSet = new Set(ids);
    const rows = allSessions.filter(s => idSet.has(s.id));
    if (!rows.length) return;
    const modal = document.getElementById('modal');

    // Split into three sections, in source order:
    // 1) whole-class sessions (group === "All") — the morning lab intro / anatomy content
    // 2) color-grouped rotation stations
    // 3) SRL — no time columns, students can complete anytime that day
    const wholeClassRows = rows.filter(s => s.type !== 'SRL' && String(s.group||'').trim().toLowerCase() === 'all');
    const rotationRows   = rows.filter(s => s.type !== 'SRL' && String(s.group||'').trim().toLowerCase() !== 'all');
    const srlRows        = rows.filter(s => s.type === 'SRL');

    const sample = rows[0];
    const courses = [...new Set(rows.map(s => `${s.course} - ${s.courseName||''}`))];
    const sw = sample.date ? calcSemesterWeek(sample.date) : null;
    const semWeekLabel = sw ? `${sw.semester==='winter'?'Winter':'Fall'} Week ${sw.week}` : '';
    const rosterYear = ROSTER_COURSE_YEAR[String(sample.course)];

    const sections = [
      buildMatrixTable(wholeClassRows, { withTimeColumns: true }),
      buildMatrixTable(rotationRows, { withTimeColumns: true }),
      buildMatrixTable(srlRows, { withTimeColumns: false }),
    ].filter(Boolean).map(t => `<div class="lab-matrix-wrap">${t}</div>`).join('');

    modal.innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box" style="width:min(1100px,96vw)">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header">
          <div class="modal-title">🧪 ${escapeHtml(courses.join(' / '))}</div>
          <div class="modal-subtitle">${escapeHtml(sample.day||'')}, ${fmtDetailDate(sample.date)} · ${escapeHtml(semWeekLabel)}${isAdmin ? ' · <span style="color:var(--accent);font-weight:600">Admin: click any cell or row to edit it</span>' : ''}</div>
        </div>
        <div class="modal-body">
          ${sections}
        </div>
        <div class="modal-footer">
          <div>${rosterYear ? `<button class="btn btn-secondary" id="view-roster-btn">🧑‍🤝‍🧑 View Group Roster ↗</button>` : ''}</div>
          <div style="display:flex;gap:10px">
            <button class="btn btn-secondary" id="detail-close-btn">Close</button>
          </div>
        </div>
      </div>`;
    modal.classList.add('open');
    if (rosterYear) document.getElementById('view-roster-btn').onclick = () => openGroupRoster(rosterYear);
    document.getElementById('modal-close').onclick = closeForm;
    document.getElementById('modal-backdrop').onclick = closeForm;
    document.getElementById('detail-close-btn').onclick = closeForm;
    if (isAdmin) {
      modal.querySelectorAll('.lab-matrix-editable').forEach(el => {
        el.addEventListener('click', e => {
          e.stopPropagation();
          const target = allSessions.find(s => s.id === el.dataset.editId);
          if (target) openForm(target);
        });
      });
    }
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

  function openForm(session, presetDate) {
    const isNew = !session;
    const s = session || { date: presetDate || dateKey(calDate) };
    const modal = document.getElementById('modal');
    const sessionYear = s.year || '';
    const sw = s.date ? calcSemesterWeek(s.date) : null;

    modal.innerHTML = `
      <div class="modal-backdrop" id="modal-backdrop"></div>
      <div class="modal-box">
        <div class="modal-strip"></div>
        <button class="modal-close" id="modal-close">✕</button>
        <div class="modal-header">
          <div class="modal-title">${isNew ? 'Add Session' : 'Edit Session'}</div>
          <div class="modal-subtitle" id="form-subtitle">${s.date ? `${calcDayName(s.date)}, ${s.date} · ${sw?(sw.semester==='winter'?'Winter':'Fall'):''} Week ${sw?sw.week:''}` : ''}</div>
        </div>
        <div class="modal-body">
          <form id="session-form">
            <div class="form-grid">
              <div class="form-field"><label class="form-label">Date</label><input type="date" class="form-input" id="f-date" value="${s.date||''}" /></div>
              <div class="form-field"><label class="form-label">Year</label>
                <select class="form-select" id="f-year">
                  <option value="1" ${sessionYear==='1'?'selected':''}>Year 1</option>
                  <option value="2" ${sessionYear==='2'?'selected':''}>Year 2</option>
                  <option value="3" ${sessionYear==='3'?'selected':''}>Year 3</option>
                </select>
              </div>
              <div class="form-field"><label class="form-label">Type</label>
                <select class="form-select" id="f-type">
                  ${['LEC','LAB','SRL','Quiz/Midterm','OSCE','Exam'].map(t => `<option value="${t}" ${s.type===t?'selected':''}>${t}</option>`).join('')}
                </select>
              </div>
              <div class="form-field full"><label class="form-label">Course</label>
                <select class="form-select" id="f-course">${buildCourseOptionsHtml(sessionYear, s.course)}</select>
              </div>
              <div class="form-field"><label class="form-label">Start Time</label><input type="time" class="form-input" id="f-start" value="${s.startTime||''}" /></div>
              <div class="form-field"><label class="form-label">End Time</label><input type="time" class="form-input" id="f-end" value="${s.endTime||''}" /></div>
              <div class="form-field"><label class="form-label">Room</label><input type="text" class="form-input" id="f-room" value="${escapeHtml(s.room||'')}" placeholder="e.g. CSB Wards" /></div>
              <div class="form-field"><label class="form-label">Group</label><input type="text" class="form-input" id="f-group" value="${escapeHtml(s.group||'')}" placeholder="e.g. A, B or All" /></div>
              <div class="form-field full"><label class="form-label">Topic</label><input type="text" class="form-input" id="f-topic" value="${escapeHtml(s.topic||'')}" /></div>
              <div class="form-field"><label class="form-label">Primary Instructor</label><input type="text" class="form-input" id="f-primary" value="${escapeHtml(s.primaryInstructor||'')}" /></div>
              <div class="form-field"><label class="form-label">Secondary Instructor</label><input type="text" class="form-input" id="f-secondary" value="${escapeHtml(s.secondaryInstructor||'')}" /></div>
              <div class="form-field full"><label class="form-label">Finalized Instructor(s)</label><input type="text" class="form-input" id="f-finalized" value="${escapeHtml(s.finalizedInstructors||'')}" /></div>
              <div class="form-field full"><label class="form-label">Notes</label><textarea class="form-textarea" id="f-notes">${escapeHtml(s.notes||'')}</textarea></div>
            </div>
          </form>
          ${isNew ? '' : `<div class="history-toggle" id="history-toggle">View version history</div><div class="history-panel" id="history-panel"></div>`}
        </div>
        <div class="modal-footer">
          ${isNew ? '<div></div>' : '<button class="btn-danger-text" id="delete-btn">Delete session</button>'}
          <div style="display:flex;align-items:center;gap:12px">
            <span class="save-status" id="save-status"></span>
            <button class="btn btn-secondary" id="cancel-btn">Cancel</button>
            <button class="btn btn-primary" id="save-btn">${isNew ? 'Create Session' : 'Save Changes'}</button>
          </div>
        </div>
      </div>`;
    modal.classList.add('open');
    document.getElementById('modal-close').onclick = closeForm;
    document.getElementById('modal-backdrop').onclick = closeForm;
    document.getElementById('cancel-btn').onclick = closeForm;
    document.getElementById('save-btn').onclick = () => saveSession(isNew ? null : session);
    if (!isNew) {
      document.getElementById('delete-btn').onclick = () => deleteSession(session);
      document.getElementById('history-toggle').onclick = () => loadHistory(session.id);
    }
    document.getElementById('f-year').addEventListener('change', e => {
      document.getElementById('f-course').innerHTML = buildCourseOptionsHtml(e.target.value, null);
    });
    document.getElementById('f-date').addEventListener('change', e => {
      const d = e.target.value;
      const w = d ? calcSemesterWeek(d) : null;
      document.getElementById('form-subtitle').textContent = d ? `${calcDayName(d)}, ${d} · ${w?(w.semester==='winter'?'Winter':'Fall'):''} Week ${w?w.week:''}` : '';
    });
  }

  const FIELD_LABELS = {
    year: 'Year', startTime: 'Start Time', endTime: 'End Time', course: 'Course',
    courseName: 'Course Name', type: 'Type', topic: 'Topic', room: 'Room', group: 'Group',
    labGroupId: 'Lab Group ID', column: 'Column',
    primaryInstructor: 'Primary Instructor', secondaryInstructor: 'Secondary Instructor',
    primaryInstructorDisplay: 'Primary Instructor Display', secondaryInstructorDisplay: 'Secondary Instructor Display',
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
    const dateField = document.getElementById('f-date');
    const date = dateField ? dateField.value : existing?.date;
    const sw = date ? calcSemesterWeek(date) : null;

    const data = {
      ...(existing || {}),
      date, day: date ? calcDayName(date) : (existing?.day || ''),
      week: sw ? sw.week : (existing?.week || null),
      dateRange: sw ? weekRangeLabelSem(sw.semester, sw.week) : (existing?.dateRange || ''),
      academicCycle: existing?.academicCycle || '2026-2027',
      year: document.getElementById('f-year').value,
      type: document.getElementById('f-type').value,
      course: courseCode,
      courseName: courseInfo ? courseInfo.name : existing?.courseName,
      courseDept: courseInfo ? courseInfo.dept : existing?.courseDept,
      startTime: document.getElementById('f-start').value,
      endTime: document.getElementById('f-end').value,
      topic: document.getElementById('f-topic').value.trim(),
      primaryInstructor: document.getElementById('f-primary').value.trim(),
      secondaryInstructor: document.getElementById('f-secondary').value.trim(),
      finalizedInstructors: document.getElementById('f-finalized').value.trim(),
      notes: document.getElementById('f-notes').value.trim(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    };
    const roomField = document.getElementById('f-room'), groupField = document.getElementById('f-group');
    if (roomField) data.room = roomField.value.trim();
    if (groupField) data.group = groupField.value.trim();
    delete data.id;

    if (!data.course || !data.date || !data.startTime) {
      statusEl.className = 'save-status error'; statusEl.textContent = 'Course, Date, and Start Time are required';
      return;
    }

    saveBtn.disabled = true;
    statusEl.className = 'save-status saving'; statusEl.textContent = 'Saving…';
    try {
      if (existing) {
        await db.collection(SESSIONS_COL).doc(existing.id).set(data, { merge: true });
        await db.collection(HISTORY_COL).add({ sessionId: existing.id, ...data, savedAt: firebase.firestore.FieldValue.serverTimestamp() });
        const changes = detectChanges(existing, data);
        await logChangeGroup({ id: existing.id, ...data }, changes);
      } else {
        const ref = db.collection(SESSIONS_COL).doc();
        const createData = { ...data, createdAt: firebase.firestore.FieldValue.serverTimestamp() };
        await ref.set(createData);
        await db.collection(HISTORY_COL).add({ sessionId: ref.id, ...createData, savedAt: firebase.firestore.FieldValue.serverTimestamp() });
        await logChangeGroup({ id: ref.id, ...data }, [{ fieldLabel: '__CREATED__', oldValue: '', newValue: '' }]);
      }
      statusEl.className = 'save-status success'; statusEl.textContent = 'Saved ✓';
      showToast(existing ? 'Session updated' : 'Session created');
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
  const ADMIN_PASSWORD = 'dvmprogram'; // ← change this to update the admin password
  let isAdmin = sessionStorage.getItem('timetable_admin') === '1';

  function updateAdminUI() {
    const btn = document.getElementById('admin-toggle');
    btn.textContent = isAdmin ? 'Exit Admin Mode' : 'Administrator Login';
    btn.classList.toggle('is-admin', isAdmin);
    document.getElementById('add-session-btn').classList.toggle('hidden', !isAdmin);
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
      <span style="display:flex;gap:8px">
        <button id="remove-stale-200-btn" style="padding:4px 12px;font-size:11.5px;font-weight:600;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;white-space:nowrap">🧹 Remove Stale 200 Rows</button>
        <button id="year2-diagnostic-btn" style="padding:4px 12px;font-size:11.5px;font-weight:600;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;white-space:nowrap">📊 Export Year 2 Lab Diagnostic</button>
        <button id="year2-rebuild-btn" style="padding:4px 12px;font-size:11.5px;font-weight:600;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;white-space:nowrap">🔨 Delete Year 2 LAB Rows (for rebuild)</button>
        <button id="fix-lab-years-btn" style="padding:4px 12px;font-size:11.5px;font-weight:600;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;white-space:nowrap">🔍 Fix Lab Year Duplicates</button>
        <button id="aug17-updates-btn" style="padding:4px 12px;font-size:11.5px;font-weight:600;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;white-space:nowrap">📋 Apply Aug 17 Lab Updates</button>
        <button id="import-csv-btn" style="padding:4px 12px;font-size:11.5px;font-weight:600;border-radius:6px;border:1px solid currentColor;background:transparent;color:inherit;cursor:pointer;white-space:nowrap">⬆ Import CSV</button>
      </span>`;
    const col = document.querySelector('.cal-column');
    col.insertBefore(banner, col.firstChild);
    document.getElementById('import-csv-btn').addEventListener('click', openImportModal);
    document.getElementById('remove-stale-200-btn').addEventListener('click', removeStale200Rows);
    document.getElementById('year2-diagnostic-btn').addEventListener('click', exportYear2LabDiagnostic);
    document.getElementById('year2-rebuild-btn').addEventListener('click', deleteYear2LabRowsForRebuild);
    document.getElementById('fix-lab-years-btn').addEventListener('click', diagnoseAndFixLabYears);
    document.getElementById('aug17-updates-btn').addEventListener('click', applyAug17LabUpdates);
  }

  // One-time cleanup: the *correct* SRL data is the original 1-hour entries
  // from Phase 1. A later lab import added duplicate SRL rows using a wide
  // display-only time range (e.g. 09:15-16:15) meant only as a visual "any
  // time this day" indicator — those wide rows should never have been
  // written as literal session times. This removes exactly those 44
  // wide-range duplicates, identified by (course, date, start time),
  // leaving the correct 1-hour originals untouched.
  const WIDE_SRL_DUPLICATE_KEYS = [["206","2026-09-04","09:15"],["206","2026-09-04","09:15"],["206","2026-09-11","09:15"],["206","2026-09-11","09:15"],["206","2026-09-18","09:15"],["206","2026-09-18","09:15"],["206","2026-09-25","09:15"],["206","2026-09-25","09:15"],["206","2026-10-02","09:15"],["206","2026-10-02","09:15"],["206","2026-10-09","09:15"],["206","2026-10-09","09:15"],["206","2026-10-16","09:15"],["206","2026-10-23","09:15"],["206","2026-10-23","09:15"],["206","2026-10-30","09:15"],["206","2026-10-30","09:15"],["206","2026-11-06","09:15"],["206","2026-11-20","09:00"],["206","2026-11-20","09:00"],["206","2026-11-27","09:00"],["206","2026-11-27","09:00"],["217","2027-01-08","09:15"],["217","2027-01-08","09:15"],["217","2027-01-22","09:15"],["217","2027-01-22","09:15"],["217","2027-01-29","09:15"],["217","2027-02-05","09:15"],["217","2027-02-05","09:15"],["217","2027-02-26","09:15"],["217","2027-02-26","09:15"],["217","2027-03-05","09:15"],["217","2027-03-05","09:15"],["217","2027-03-12","09:15"],["217","2027-03-12","09:15"],["217","2027-03-19","09:15"],["217","2027-03-19","09:15"],["217","2027-04-02","08:30"],["217","2027-04-02","08:30"],["217","2027-04-09","08:30"],["217","2027-04-09","08:30"],["308","2026-08-31","13:30"],["308","2026-09-21","08:30"],["308","2026-09-21","10:05"]];
  async function cleanupWideSrlDuplicates() {
    const keySet = new Set(WIDE_SRL_DUPLICATE_KEYS.map(k => k.join('|')));
    const matches = allSessions.filter(s => s.type === 'SRL' && keySet.has(`${s.course}|${s.date}|${s.startTime}`));
    if (!matches.length) { showToast('No matching wide-range duplicate rows found — nothing to clean up'); return; }
    if (!confirm(`Found ${matches.length} wide-range display-only SRL duplicates. Delete them? (The correct 1-hour original entries will remain untouched.)`)) return;
    const BATCH_SIZE = 200; let done = 0;
    for (let i = 0; i < matches.length; i += BATCH_SIZE) {
      const chunk = matches.slice(i, i + BATCH_SIZE);
      const batch = db.batch();
      chunk.forEach(s => batch.delete(db.collection(SESSIONS_COL).doc(s.id)));
      try { await batch.commit(); done += chunk.length; } catch (err) { console.error('[Wide SRL cleanup error]', err); }
    }
    showToast(`Removed ${done} wide-range duplicate SRL rows`);
  }

  // One-time fix: some earlier CSV year-corrections apparently failed to
  // match an existing row and created a new one instead of updating it,
  // leaving both the old (wrong-Year) and new (correct-Year) copy of the
  // same real session in the database. This scans live data for exactly
  // that pattern — 2+ sessions sharing (course, type, date, start time) —
  // keeps the one with the correct target Year, and removes the rest. It
  // also catches the simpler case (single row, never got updated at all).
  const LAB_TARGET_YEAR = { '505': '3', '304': '2', '306': '2', '308': '2', '315': '2', '317': '2', '319': '2' };
  async function diagnoseAndFixLabYears() {
    const relevant = allSessions.filter(s => LAB_TARGET_YEAR[String(s.course)] && s.type === 'LAB');
    const groups = new Map();
    relevant.forEach(s => {
      const key = `${s.course}|${s.type}|${s.date}|${s.startTime}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    });

    const toDelete = [], toUpdate = [];
    let duplicateGroups = 0;
    groups.forEach(rows => {
      const targetYear = LAB_TARGET_YEAR[String(rows[0].course)];
      if (rows.length > 1) {
        duplicateGroups++;
        const correct = rows.find(r => String(r.year) === targetYear);
        const keep = correct || rows[0];
        rows.forEach(r => { if (r.id !== keep.id) toDelete.push(r); });
        if (!correct || String(keep.year) !== targetYear) toUpdate.push(keep);
      } else if (String(rows[0].year) !== targetYear) {
        toUpdate.push(rows[0]);
      }
    });

    if (!toDelete.length && !toUpdate.length) { showToast('No lab-year issues found — everything looks correct'); return; }
    const summary = `Found ${duplicateGroups} duplicated session(s) (${toDelete.length} extra rows to remove) and ${toUpdate.length} row(s) with the wrong Year to correct. Proceed?`;
    if (!confirm(summary)) return;

    const BATCH_SIZE = 150; let deleted = 0, updated = 0;
    for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
      const chunk = toDelete.slice(i, i + BATCH_SIZE);
      const batch = db.batch();
      chunk.forEach(s => batch.delete(db.collection(SESSIONS_COL).doc(s.id)));
      try { await batch.commit(); deleted += chunk.length; } catch (err) { console.error('[Lab year dedupe error]', err); }
    }
    for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
      const chunk = toUpdate.slice(i, i + BATCH_SIZE);
      const batch = db.batch();
      chunk.forEach(s => batch.set(db.collection(SESSIONS_COL).doc(s.id), { year: LAB_TARGET_YEAR[String(s.course)], updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true }));
      try { await batch.commit(); updated += chunk.length; } catch (err) { console.error('[Lab year fix error]', err); }
    }
    showToast(`Removed ${deleted} duplicate rows, corrected ${updated} Year values`);
  }

  // One-time reset: 211 and 311 (practicum block weeks) were imported as
  // hour-by-hour placeholder blocks ("TBD" repeated all day, every day).
  // This deletes every 211/311 session entirely and replaces them with one
  // clean full-day (8:30-16:30) entry per weekday for their actual block week.
  async function resetPracticumCourses() {
    const existing = allSessions.filter(s => ['211','311'].includes(String(s.course)));
    const newRows = [
      ...['2027-02-08','2027-02-09','2027-02-10','2027-02-11','2027-02-12'].map(date => ({
        course: '211', courseName: 'Practical Work Experience I', courseDept: 'VTMD', year: '1', type: 'LEC',
        date, day: calcDayName(date), startTime: '08:30', endTime: '16:30',
        topic: 'Practical Work Experience I', primaryInstructor: 'TBD', finalizedInstructors: 'TBD',
        week: calcSemesterWeek(date).week, dateRange: weekRangeLabelSem('winter', calcSemesterWeek(date).week),
        academicCycle: '2026-2027',
      })),
      ...['2027-02-22','2027-02-23','2027-02-24','2027-02-25','2027-02-26'].map(date => ({
        course: '311', courseName: 'Practical Work Experience II', courseDept: 'VTMD', year: '2', type: 'LEC',
        date, day: calcDayName(date), startTime: '08:30', endTime: '16:30',
        topic: 'Practical Work Experience II', primaryInstructor: 'TBD', finalizedInstructors: 'TBD',
        week: calcSemesterWeek(date).week, dateRange: weekRangeLabelSem('winter', calcSemesterWeek(date).week),
        academicCycle: '2026-2027',
      })),
    ];
    if (!confirm(`This will delete all ${existing.length} existing 211/311 sessions and replace them with 10 clean full-day entries (5 for 211, Feb 8-12; 5 for 311, Feb 22-26). Proceed?`)) return;

    const BATCH_SIZE = 150; let deleted = 0;
    for (let i = 0; i < existing.length; i += BATCH_SIZE) {
      const chunk = existing.slice(i, i + BATCH_SIZE);
      const batch = db.batch();
      chunk.forEach(s => batch.delete(db.collection(SESSIONS_COL).doc(s.id)));
      try { await batch.commit(); deleted += chunk.length; } catch (err) { console.error('[Practicum reset delete error]', err); }
    }
    const batch = db.batch();
    newRows.forEach(row => {
      const ref = db.collection(SESSIONS_COL).doc();
      const data = { ...row, createdAt: firebase.firestore.FieldValue.serverTimestamp(), updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
      batch.set(ref, data);
      batch.set(db.collection(HISTORY_COL).doc(), { sessionId: ref.id, ...data, savedAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
    try { await batch.commit(); showToast(`Removed ${deleted} old rows, created ${newRows.length} clean entries`); }
    catch (err) { console.error('[Practicum reset create error]', err); showToast('Failed to create replacement rows — check console', true); }
  }

  // One-time fix: a single 200-course row on Aug 28 has a malformed start
  // time (literally the text "Afternoon" with no end time), left over from
  // the source data. Matched by topic text since the broken time value
  // itself can't serve as a reliable match key once corrected.
  async function fixMalformedAug28Row() {
    const row = allSessions.find(s => String(s.course)==='200' && s.date==='2026-08-28' && s.topic==='Prep for White Coat Ceremony');
    if (!row) { showToast('Malformed Aug 28 row not found — may already be fixed'); return; }
    if (row.startTime === '13:15' && row.endTime === '16:30') { showToast('Already correct — nothing to fix'); return; }
    if (!confirm(`Found the malformed row (startTime="${row.startTime}"). Set it to 13:15–16:30?`)) return;
    try {
      await db.collection(SESSIONS_COL).doc(row.id).set({ startTime: '13:15', endTime: '16:30', updatedAt: firebase.firestore.FieldValue.serverTimestamp() }, { merge: true });
      showToast('Fixed Aug 28 session time');
    } catch (err) { console.error('[Aug28 fix error]', err); showToast('Failed to fix — check console', true); }
  }

  // General-purpose exact-duplicate finder — broader than the earlier
  // Year-specific tool. Some CSV imports over the past several rounds
  // occasionally failed to match an existing row and created a new one
  // instead, leaving true duplicates scattered across various courses
  // (not just the ones already checked). Groups by (course, type, date,
  // start time, topic, primary instructor) — including topic/instructor
  // avoids false positives on legitimate same-time multi-station rotations
  // — and keeps only the earliest-created copy of each exact duplicate.
  async function findAndFixExactDuplicates() {
    const groups = new Map();
    allSessions.forEach(s => {
      const key = [s.course, s.type, s.date, s.startTime, s.topic, s.primaryInstructor||''].join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    });
    const toDelete = [];
    let dupGroups = 0;
    groups.forEach(rows => {
      if (rows.length < 2) return;
      dupGroups++;
      const sorted = [...rows].sort((a,b) => {
        const at = a.createdAt?.toMillis ? a.createdAt.toMillis() : Infinity;
        const bt = b.createdAt?.toMillis ? b.createdAt.toMillis() : Infinity;
        return at - bt;
      });
      sorted.slice(1).forEach(r => toDelete.push(r));
    });

    if (!toDelete.length) { showToast('No exact duplicate sessions found'); return; }
    if (!confirm(`Found ${dupGroups} duplicated session(s) — ${toDelete.length} extra row(s) will be removed, keeping the earliest copy of each. Proceed?`)) return;

    const BATCH_SIZE = 150; let deleted = 0;
    for (let i = 0; i < toDelete.length; i += BATCH_SIZE) {
      const chunk = toDelete.slice(i, i + BATCH_SIZE);
      const batch = db.batch();
      chunk.forEach(s => batch.delete(db.collection(SESSIONS_COL).doc(s.id)));
      try { await batch.commit(); deleted += chunk.length; } catch (err) { console.error('[Exact dedupe error]', err); }
    }
    showToast(`Removed ${deleted} exact duplicate rows`);
  }

  // One-time consolidation: 200 (Aug 24-26) was imported as fragmented
  // hourly-block placeholder rows (a leftover of the original master-list
  // format). Replaces them with clean, correctly-spanning entries.
  async function fixAug24to26Course200() {
    const targets = allSessions.filter(s => String(s.course)==='200' && ['2026-08-24','2026-08-25','2026-08-26'].includes(s.date));
    if (!targets.length) { showToast('No matching Aug 24-26 rows found — may already be fixed'); return; }

    const camp = 'Nanci Bond, Crystal Makwana, Tracie Unrau, Alexandre Ellis';
    const newRows = [
      { date: '2026-08-24', startTime: '08:30', endTime: '16:30', type: 'LAB', topic: 'Sundre Orientation Camp (Full Day)', primaryInstructor: camp, finalizedInstructors: camp },
      { date: '2026-08-25', startTime: '08:30', endTime: '16:30', type: 'LAB', topic: 'Sundre Orientation Camp (Full Day)', primaryInstructor: camp, finalizedInstructors: camp },
      { date: '2026-08-26', startTime: '08:30', endTime: '11:30', type: 'LEC', topic: 'Welcome to your Academic Journey (Multiple Sessions, Full Day)', primaryInstructor: 'John Remnant', finalizedInstructors: 'John Remnant' },
      { date: '2026-08-26', startTime: '13:30', endTime: '14:30', type: 'LEC', topic: 'Welcome to your Academic Journey (Multiple Sessions, Full Day)', primaryInstructor: 'Tessa Baker', finalizedInstructors: 'Tessa Baker' },
      { date: '2026-08-26', startTime: '14:30', endTime: '16:30', type: 'LEC', topic: 'Welcome to your Academic Journey (Multiple Sessions, Full Day)', primaryInstructor: '', finalizedInstructors: '' },
    ].map(r => ({
      ...r, course: '200', courseName: 'Introduction to Veterinary Medicine', courseDept: 'VTMD', year: '1',
      day: calcDayName(r.date), week: calcSemesterWeek(r.date).week,
      dateRange: weekRangeLabelSem('fall', calcSemesterWeek(r.date).week), academicCycle: '2026-2027',
    }));

    if (!confirm(`This will delete ${targets.length} existing Aug 24-26 (course 200) rows and replace them with ${newRows.length} clean consolidated entries. Proceed?`)) return;

    const batch1 = db.batch();
    targets.forEach(s => batch1.delete(db.collection(SESSIONS_COL).doc(s.id)));
    try { await batch1.commit(); } catch (err) { console.error('[Aug24-26 delete error]', err); showToast('Failed during delete — check console', true); return; }

    const batch2 = db.batch();
    newRows.forEach(row => {
      const ref = db.collection(SESSIONS_COL).doc();
      const data = { ...row, createdAt: firebase.firestore.FieldValue.serverTimestamp(), updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
      batch2.set(ref, data);
      batch2.set(db.collection(HISTORY_COL).doc(), { sessionId: ref.id, ...data, savedAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
    try { await batch2.commit(); showToast(`Replaced ${targets.length} rows with ${newRows.length} clean entries`); }
    catch (err) { console.error('[Aug24-26 create error]', err); showToast('Failed during create — check console', true); }
  }

  // One-time cleanup: course 200 wasn't on the Phase-1 lab-exclusion list
  // (unlike 206, 217, etc.), so its original generic placeholder rows for
  // Aug 27-28 ("Biosecurity SRL & Surgical Instrument Handling", "Classroom
  // session & Lab Sessions", "OFF - Prep for White Coat Ceremony") never
  // got removed once the real, detailed lab schedule was imported for those
  // same two dates — the two data sets sit side by side instead of the old
  // one being replaced. Removes exactly the stale rows, identified by their
  // distinctive leftover topic text, leaving the correct lab data untouched.
  const STALE_200_TOPICS = ['Biosecurity SRL & Surgical Instrument Handling', 'Classroom session & Lab Sessions', 'OFF - Prep for White Coat Ceremony'];
  // Diagnostic: exports every live Year 2 lab session (304/306/308/315/317/319)
  // as a CSV, sorted by course/date/startTime, with every relevant field —
  // used to compare the actual database state against the source schedule
  // when something looks wrong on the calendar.
  function exportYear2LabDiagnostic() {
    const courses = ['304','306','308','315','317','319'];
    const rows = allSessions.filter(s => courses.includes(String(s.course))).sort((a,b) =>
      String(a.course).localeCompare(String(b.course)) || (a.date||'').localeCompare(b.date||'') || (a.startTime||'').localeCompare(b.startTime||''));
    const headers = ['docId','course','type','date','day','startTime','endTime','topic','group','primaryInstructor','secondaryInstructor','finalizedInstructors','labGroupId','column','room','year'];
    const csvRows = rows.map(s => headers.map(h => h==='docId' ? s.id : (s[h]||'')));
    const csv = [headers, ...csvRows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
    downloadBlob(csv, `year2_lab_diagnostic_${dateKey(new Date())}.csv`, 'text/csv');
    showToast(`Exported ${rows.length} Year 2 lab session rows`);
  }

  // One-time: deletes only the LAB-type rows for the 6 Year 2 lab courses.
  // Diagnostic confirmed roughly half of each rotation's LAB rows never made
  // it into the database in the original import, and a few dates ended up
  // with duplicate/stale-time copies from the Aug 17 correction pass. SRL
  // and LEC rows are untouched — those are already confirmed correct. After
  // running this, use the existing Import CSV button with
  // year2_lab_rebuild.csv to insert the complete, verified 179-row set.
  async function deleteYear2LabRowsForRebuild() {
    const courses = ['304','306','308','315','317','319'];
    const matches = allSessions.filter(s => courses.includes(String(s.course)) && s.type === 'LAB');
    if (!matches.length) { showToast('No Year 2 LAB rows found — may already be cleared'); return; }
    if (!confirm(`This will delete ${matches.length} LAB-type rows across courses 304/306/308/315/317/319 (SRL and LEC rows are untouched). After this, import year2_lab_rebuild.csv via Import CSV to restore the complete, correct set. Proceed?`)) return;
    const BATCH_SIZE = 150; let deleted = 0;
    for (let i = 0; i < matches.length; i += BATCH_SIZE) {
      const chunk = matches.slice(i, i + BATCH_SIZE);
      const batch = db.batch();
      chunk.forEach(s => batch.delete(db.collection(SESSIONS_COL).doc(s.id)));
      try { await batch.commit(); deleted += chunk.length; } catch (err) { console.error('[Year2 LAB delete error]', err); }
    }
    showToast(`Deleted ${deleted} LAB rows — now import year2_lab_rebuild.csv via Import CSV`);
  }

  async function removeStale200Rows() {
    const matches = allSessions.filter(s => String(s.course)==='200' && ['2026-08-27','2026-08-28'].includes(s.date) && STALE_200_TOPICS.includes(s.topic));
    if (!matches.length) { showToast('No stale Aug 27/28 rows found — may already be fixed'); return; }
    if (!confirm(`Found ${matches.length} stale leftover rows from the original import on Aug 27/28. Remove them? (The correct, detailed lab data for those days stays untouched.)`)) return;
    const batch = db.batch();
    matches.forEach(s => batch.delete(db.collection(SESSIONS_COL).doc(s.id)));
    try { await batch.commit(); showToast(`Removed ${matches.length} stale rows`); }
    catch (err) { console.error('[Stale 200 cleanup error]', err); showToast('Failed — check console', true); }
  }

  // One-time: applies the Aug 17 source-file corrections (27 targeted
  // changes across 200/204/304/306/308/315/317/319/505 — instructor
  // additions/corrections, 3 time-block fixes for 306, an Aug 31 time fix
  // for 308 matching the earlier Sep 10 fix, and a room-name cleanup).
  // Matched by (course, date, topic) rather than exact start time, since
  // these are scattered text corrections, not structural changes — safer
  // than guessing 27 individual start times. Also creates the two brand-new
  // 505 rows for Jan 12, 2027, which didn't exist in the database before.
  const AUG17_CHANGES = [{"course": "200", "date": "2026-08-27", "type": "SRL", "topic": "Biosafety SRL", "room": "Classroom"}, {"course": "204", "date": "2026-11-18", "topic": "Small Mammals", "primaryInstructor": "Vaasjo", "finalizedInstructors": "Vaasjo"}, {"course": "204", "date": "2026-11-25", "topic": "Small Mammals II", "primaryInstructor": "Arthur (Uni Vet)", "finalizedInstructors": "Arthur (Uni Vet)"}, {"course": "304", "date": "2026-10-08", "topic": null, "primaryInstructorContains": "Knight", "primaryInstructor": "Knight (Mauldin, Ricard)", "finalizedInstructors": "Knight (Mauldin, Ricard)"}, {"course": "306", "date": "2026-10-22", "oldStart": "08:30", "newStart": "09:30", "newEnd": "10:30"}, {"course": "306", "date": "2026-10-22", "oldStart": "10:05", "newStart": "10:30", "newEnd": "11:30"}, {"course": "306", "date": "2026-11-19", "oldStart": "08:30", "newStart": "09:30", "newEnd": "10:30"}, {"course": "306", "date": "2026-11-19", "oldStart": "10:05", "newStart": "10:30", "newEnd": "11:30"}, {"course": "306", "date": "2026-11-26", "oldStart": "08:30", "newStart": "09:30", "newEnd": "10:30"}, {"course": "306", "date": "2026-11-26", "oldStart": "10:05", "newStart": "10:30", "newEnd": "11:30"}, {"course": "306", "date": "2026-12-03", "topic": "Production animal case", "primaryInstructor": "Remnant (Dias)", "finalizedInstructors": "Remnant (Dias)"}, {"course": "308", "date": "2026-08-31", "newStart": "08:30", "newEnd": "11:30"}, {"course": "308", "date": "2026-09-10", "type": "LAB", "topic": "Clin Path RBC", "group": "C, D"}, {"course": "308", "date": "2026-09-10", "type": "SRL", "topic": "Clin Path SRL", "group": "A, B"}, {"course": "315", "date": "2027-01-07", "topic": "SA Dentistry (S+P, regional anest, dental rads)", "primaryInstructor": "Palmer (Jackson, Pawlak)", "finalizedInstructors": "Palmer (Jackson, Pawlak)"}, {"course": "315", "date": "2027-01-14", "topic": "SA Dentistry (S+P, regional anest, dental rads)", "primaryInstructor": "Palmer (Jackson, Pawlak)", "finalizedInstructors": "Palmer (Jackson, Pawlak)"}, {"course": "317", "date": "2027-02-04", "topic": "Bovine Palp", "primaryInstructor": "Stover (Hernandez, Camargo, Wennekamp, B. Garcia)", "finalizedInstructors": "Stover (Hernandez, Camargo, Wennekamp, B. Garcia)"}, {"course": "317", "date": "2027-02-11", "topic": "Bovine Palp", "primaryInstructor": "Stover (Hernandez, Camargo, Wennekamp, B. Garcia)", "finalizedInstructors": "Stover (Hernandez, Camargo, Wennekamp, B. Garcia)"}, {"course": "319", "date": "2027-03-18", "topic": "Reptiles", "primaryInstructor": "Whiteside (Vaasjo)", "finalizedInstructors": "Whiteside (Vaasjo)"}, {"course": "319", "date": "2027-03-25", "topic": "Reptiles", "primaryInstructor": "Whiteside (Vaasjo)", "finalizedInstructors": "Whiteside (Vaasjo)"}, {"course": "505", "date": "2026-10-20", "topic": "LA Casting", "primaryInstructor": "Zantingh,  (Remnant, Dias, Wennekamp)", "finalizedInstructors": "Zantingh,  (Remnant, Dias, Wennekamp)"}, {"course": "505", "date": "2026-10-27", "topic": "Soft Tissue Surgery", "primaryInstructor": "Fierheller (Zantingh)", "finalizedInstructors": "Fierheller (Zantingh)"}, {"course": "505", "date": "2027-02-02", "topic": "Bovine Local Anesthesia", "primaryInstructor": "Bradley (Dias, Stover, Camargo, Pinho)", "finalizedInstructors": "Bradley (Dias, Stover, Camargo, Pinho)"}, {"course": "505", "date": "2027-02-09", "topic": "Bovine Local Anesthesia", "primaryInstructor": "Bradley (Dias, Stover, Camargo, Pinho)", "finalizedInstructors": "Bradley (Dias, Stover, Camargo, Pinho)"}, {"course": "505", "date": "2027-02-09", "topic": "SA U/S", "primaryInstructor": "Boysen (Palmer, Osborne, Pawlak, Unrau)", "finalizedInstructors": "Boysen (Palmer, Osborne, Pawlak, Unrau)"}, {"course": "505", "date": "2027-03-23", "primaryInstructorContains": "Romero", "primaryInstructor": "Romero (Zantingh, Scott, Pang, Pinho)", "finalizedInstructors": "Romero (Zantingh, Scott, Pang, Pinho)"}, {"course": "319", "date": "2027-04-08", "primaryInstructorContains": "Whiteside", "primaryInstructor": "1a Wagg(Whitehead),   1b Romero,   1c Vaasjo", "finalizedInstructors": "1a Wagg(Whitehead),   1b Romero,   1c Vaasjo"}];

  async function applyAug17LabUpdates() {
    const toUpdate = [];
    AUG17_CHANGES.forEach(chg => {
      let matches = allSessions.filter(s => String(s.course) === chg.course && s.date === chg.date);
      if (chg.type) matches = matches.filter(s => s.type === chg.type);
      if (chg.topic) matches = matches.filter(s => s.topic === chg.topic);
      if (chg.primaryInstructorContains) matches = matches.filter(s => (s.primaryInstructor||'').includes(chg.primaryInstructorContains));
      if (chg.oldStart) matches = matches.filter(s => s.startTime === chg.oldStart);
      matches.forEach(s => toUpdate.push({ session: s, chg }));
    });

    if (!toUpdate.length) { showToast('No matching rows found for the Aug 17 update set — may already be applied'); return; }
    if (!confirm(`Found ${toUpdate.length} rows matching the Aug 17 source-file changes (out of ${AUG17_CHANGES.length} expected). Apply updates and create the 2 new 505 Jan 12 rows? Review the checklist first if you haven't already.`)) return;

    const BATCH_SIZE = 100; let updated = 0;
    for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
      const chunk = toUpdate.slice(i, i + BATCH_SIZE);
      const batch = db.batch();
      chunk.forEach(({ session, chg }) => {
        const patch = { updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
        ['startTime','endTime','room','group','primaryInstructor','finalizedInstructors'].forEach(k => {
          const srcKey = k === 'startTime' ? 'newStart' : k === 'endTime' ? 'newEnd' : k;
          if (chg[srcKey] !== undefined) patch[k] = chg[srcKey];
        });
        batch.set(db.collection(SESSIONS_COL).doc(session.id), patch, { merge: true });
      });
      try { await batch.commit(); updated += chunk.length; } catch (err) { console.error('[Aug17 update error]', err); }
    }

    // Create the two new 505 rows for Jan 12, 2027 (didn't exist before)
    const labGroupId = '505Schedule_2027-01-12_A';
    const newRows = [
      { topic: 'Surgery Review', slots: [['08:30','10:30','1'],['11:00','13:00','2'],['14:30','16:30','3']], primaryInstructor: 'Fierheller', secondaryInstructor: 'Zantingh, Atilla' },
      { topic: 'Bovine Advanced PE', slots: [['08:30','10:30','3'],['11:00','13:00','1'],['14:30','16:30','2']], primaryInstructor: 'Bradley', secondaryInstructor: 'Olchow, Dias' },
    ];
    const batch2 = db.batch();
    let created = 0;
    newRows.forEach(row => {
      row.slots.forEach(([start,end,group]) => {
        const ref = db.collection(SESSIONS_COL).doc();
        const data = {
          course: '505', courseName: 'Clinical Skills III', courseDept: 'VETM', year: '3', type: 'LAB',
          date: '2027-01-12', day: 'Tuesday', startTime: start, endTime: end, topic: row.topic,
          primaryInstructor: row.primaryInstructor, secondaryInstructor: row.secondaryInstructor,
          group, labGroupId, column: 'A',
          week: calcSemesterWeek('2027-01-12').week, dateRange: weekRangeLabelSem('winter', calcSemesterWeek('2027-01-12').week),
          academicCycle: '2026-2027', createdAt: firebase.firestore.FieldValue.serverTimestamp(), updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        };
        batch2.set(ref, data);
        batch2.set(db.collection(HISTORY_COL).doc(), { sessionId: ref.id, ...data, savedAt: firebase.firestore.FieldValue.serverTimestamp() });
        created++;
      });
    });
    try { await batch2.commit(); } catch (err) { console.error('[Jan12 create error]', err); }
    showToast(`Updated ${updated} rows, created ${created} new Jan 12 rows`);
  }

  // ════════════════════════════════════════════════════════════
  // CSV BULK IMPORT (admin only)
  // ════════════════════════════════════════════════════════════
  const CSV_FIELD_ALIASES = {
    rowId: ['row id','rowid','row #','session id'], sortOrder: ['sort order','sortorder'], week: ['week','week #','week#'],
    dateRange: ['date range','daterange'], academicCycle: ['academic cycle','cycle'],
    date: ['date'], day: ['day'], year: ['year','program year'],
    startTime: ['start time','starttime'], endTime: ['end time','endtime'],
    course: ['course','course code','course #'], courseName: ['course name'], courseDept: ['department','dept'],
    type: ['type'], topic: ['topic'], room: ['room'], group: ['group'],
    labGroupId: ['lab group id', 'labgroupid'], column: ['column'],
    primaryInstructorDisplay: ['primary instructor display'],
    secondaryInstructorDisplay: ['secondary instructor display'],
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
      const existingByKey = new Set(allSessions.map(s => `${s.course}|${s.type}|${s.date}|${s.startTime}`));
      const willUpdate = sessions.filter(s => existingByKey.has(`${s.course}|${s.type}|${s.date}|${s.startTime}`)).length;
      const willCreate = sessions.length - willUpdate;
      const preview = sessions.slice(0, 8);
      el.innerHTML = `<div style="font-size:12px;color:var(--text-3);margin:8px 0">Found <strong>${sessions.length}</strong> rows — <strong>${willCreate}</strong> will be created as new, <strong>${willUpdate}</strong> match existing sessions and will be updated in place. Preview:</div>
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

      // Build a lookup of existing sessions by course+type+date+startTime so
      // a row that matches something already in the database updates that
      // session in place instead of creating a visible duplicate.
      const existingByKey = new Map();
      allSessions.forEach(s => existingByKey.set(`${s.course}|${s.type}|${s.date}|${s.startTime}`, s));

      const toCreate = [], toUpdate = [];
      parsedSessions.forEach(session => {
        const key = `${session.course}|${session.type}|${session.date}|${session.startTime}`;
        const existing = existingByKey.get(key);
        if (existing) toUpdate.push({ existing, incoming: session }); else toCreate.push(session);
      });

      const BATCH_SIZE = 150; let created = 0, updated = 0, failed = 0;

      for (let i = 0; i < toCreate.length; i += BATCH_SIZE) {
        const chunk = toCreate.slice(i, i + BATCH_SIZE);
        statusEl.textContent = `Creating ${Math.min(i+BATCH_SIZE, toCreate.length)} of ${toCreate.length} new…`;
        const batch = db.batch();
        chunk.forEach(session => {
          const sessionRef = db.collection(SESSIONS_COL).doc();
          const data = { ...session, createdAt: firebase.firestore.FieldValue.serverTimestamp(), updatedAt: firebase.firestore.FieldValue.serverTimestamp() };
          batch.set(sessionRef, data);
          batch.set(db.collection(HISTORY_COL).doc(), { sessionId: sessionRef.id, ...data, savedAt: firebase.firestore.FieldValue.serverTimestamp() });
        });
        try { await batch.commit(); created += chunk.length; }
        catch (err) { console.error('[Batch import create error]', err); failed += chunk.length; }
      }

      for (let i = 0; i < toUpdate.length; i += BATCH_SIZE) {
        const chunk = toUpdate.slice(i, i + BATCH_SIZE);
        statusEl.textContent = `Updating ${Math.min(i+BATCH_SIZE, toUpdate.length)} of ${toUpdate.length} existing…`;
        const batch = db.batch();
        chunk.forEach(({ existing, incoming }) => {
          // Only overwrite fields the incoming row actually has a value for —
          // blank cells shouldn't erase better existing data.
          const merged = { ...existing };
          Object.entries(incoming).forEach(([k,v]) => { if (v !== '' && v != null) merged[k] = v; });
          merged.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
          const patch = { ...merged }; delete patch.id;
          batch.set(db.collection(SESSIONS_COL).doc(existing.id), patch, { merge: true });
          batch.set(db.collection(HISTORY_COL).doc(), { sessionId: existing.id, ...patch, savedAt: firebase.firestore.FieldValue.serverTimestamp() });
          const changes = detectChanges(existing, merged);
          if (changes.length) {
            batch.set(db.collection(CHANGELOG_COL).doc(), {
              sessionId: existing.id, course: `${merged.course} - ${merged.courseName||''}`,
              sessionYear: merged.year, sessionType: merged.type, sessionStartTime: merged.startTime,
              sessionDate: merged.date, sessionWeek: merged.week,
              changedFields: changes.map(c => ({ fieldLabel: c.fieldLabel, oldValue: c.oldValue, newValue: c.newValue })),
              changedAt: firebase.firestore.FieldValue.serverTimestamp(),
            });
          }
        });
        try { await batch.commit(); updated += chunk.length; }
        catch (err) { console.error('[Batch import update error]', err); failed += chunk.length; }
      }

      if (failed === 0) {
        statusEl.className='save-status success';
        statusEl.textContent = `${created} created, ${updated} updated ✓`;
        showToast(`${created} new sessions, ${updated} enriched`);
        setTimeout(closeForm, 1400);
      } else {
        statusEl.className='save-status error';
        statusEl.textContent = `${created} created, ${updated} updated, ${failed} failed — check console`;
        showToast(`${failed} rows failed`, true);
        btn.disabled = false;
      }
    };
  }

  // ════════════════════════════════════════════════════════════
  // EXPORTS — Master (Excel/CSV/ICS) + Filtered (Excel/CSV/ICS/PDF)
  // ════════════════════════════════════════════════════════════
  const EXPORT_HEADERS = ['Week','Date Range','Date','Day','Year','Start Time','End Time','Course','Course Name','Type','Group','Topic','Room','Primary Instructor','Secondary Instructor','Finalized Instructors','Notes'];
  function sessionToRow(s) {
    return [s.week||'', s.dateRange||'', s.date||'', s.day||'', s.year||'', s.startTime||'', s.endTime||'', s.course||'', s.courseName||'', s.type||'', s.group||'', s.topic||'', getRoom(s), s.primaryInstructor||'', s.secondaryInstructor||'', s.finalizedInstructors||'', s.notes||''];
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
  // MOBILE FILTER PANEL COLLAPSE
  // ════════════════════════════════════════════════════════════
  document.getElementById('filter-toggle-btn').addEventListener('click', () => {
    const wrap = document.getElementById('filter-bar-wrap');
    const expanded = wrap.classList.toggle('expanded');
    document.getElementById('filter-toggle-btn').textContent = expanded ? 'Filters ▴' : 'Filters ▾';
  });

  // ════════════════════════════════════════════════════════════
  // SIDE PANEL (Latest Updates / Data Export) COLLAPSE TOGGLE
  // ════════════════════════════════════════════════════════════
  let sideCollapsed = JSON.parse(localStorage.getItem('timetable_side_collapsed') || 'false');
  function updateSideToggleBtn() {
    document.getElementById('main-view').classList.toggle('side-collapsed', sideCollapsed);
    const btn = document.getElementById('side-toggle-btn');
    const arrow = sideCollapsed ? '‹' : '›';
    btn.innerHTML = sideCollapsed ? `${arrow}<span class="toggle-label">&nbsp;Updates</span>` : `<span class="toggle-label">Updates&nbsp;</span>${arrow}`;
    btn.title = sideCollapsed ? 'Show Latest Updates / Data Export panel' : 'Hide Latest Updates / Data Export panel';
  }
  updateSideToggleBtn();
  document.getElementById('side-toggle-btn').addEventListener('click', () => {
    sideCollapsed = !sideCollapsed;
    localStorage.setItem('timetable_side_collapsed', JSON.stringify(sideCollapsed));
    updateSideToggleBtn();
    syncSideColumnHeight();
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
  populateWeekButtons();
  populateCourseDropdown('all');
  updateAdminUI();
  renderCalendar();

})();
