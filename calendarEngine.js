// calendarEngine.js — Calendar Rendering & Academic Week Calculation
// 2026-2027 UCVM Timetable

const CalendarEngine = (() => {

  const DOW7 = ['Mon','Tue','Wed','Thu','Fri'];

  function dateKey(d) { return d.toISOString().slice(0,10); }
  function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate()+n); return r; }

  function isToday(d) {
    const t = new Date();
    return d.getFullYear()===t.getFullYear() && d.getMonth()===t.getMonth() && d.getDate()===t.getDate();
  }

  // ── Month grid (still used for the Month view) ────────────────
  function buildMonthGrid(year, month) {
    const firstDay = new Date(year, month, 1);
    const lastDay  = new Date(year, month + 1, 0);
    const startDow = (firstDay.getDay() + 6) % 7; // Mon=0
    const cells = [];
    for (let i = 0; i < startDow; i++) cells.push({ date: new Date(year, month, 1-(startDow-i)), current: false });
    for (let d = 1; d <= lastDay.getDate(); d++) cells.push({ date: new Date(year, month, d), current: true });
    while (cells.length % 7 !== 0) {
      const last = cells[cells.length-1].date;
      cells.push({ date: new Date(last.getTime()+86400000), current: false });
    }
    return cells;
  }

  // ── Week days (Mon-Fri) ────────────────────────────────────────
  function buildWeekDays(refDate) {
    const dow = (refDate.getDay()+6)%7;
    const mon = new Date(refDate); mon.setDate(refDate.getDate()-dow);
    return Array.from({length:5}, (_,i) => new Date(mon.getFullYear(),mon.getMonth(),mon.getDate()+i));
  }

  // ════════════════════════════════════════════════════════════
  // ACADEMIC WEEK NUMBERING — 2026-2027 CYCLE
  // Week 1 = Monday Aug 24, 2026. Every week after is a consecutive
  // Mon-Fri block. Week 17 = Dec 14-18, 2026 (per spec). Numbering
  // continues past 17 for the winter term so all imported data
  // (through April 2027) still has a valid week number — the UI
  // just only shows "Week 1-17" buttons by default per the current ask.
  // ════════════════════════════════════════════════════════════
  const WEEK1_START = new Date(2026, 7, 24); // Aug 24, 2026 (month is 0-indexed)
  WEEK1_START.setHours(0,0,0,0);

  function weekMonday(weekNum) {
    const d = new Date(WEEK1_START);
    d.setDate(d.getDate() + (weekNum - 1) * 7);
    return d;
  }

  function calcAcademicWeekNumber(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    d.setHours(0,0,0,0);
    const diffDays = Math.floor((d - WEEK1_START) / 86400000);
    return Math.floor(diffDays / 7) + 1;
  }

  function fmtMonthDay(d) { return d.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }); }

  // "Aug 24-28" (same month) or "Nov 30 - Dec 4" (crosses a month boundary)
  function weekRangeLabel(weekNum) {
    const mon = weekMonday(weekNum);
    const fri = new Date(mon); fri.setDate(mon.getDate() + 4);
    if (mon.getMonth() === fri.getMonth()) {
      return `${mon.toLocaleDateString('en-CA',{month:'short'})} ${mon.getDate()}-${fri.getDate()}`;
    }
    return `${fmtMonthDay(mon)} - ${fmtMonthDay(fri)}`;
  }

  // "Week 1 (Aug 24-28)" — the button label format
  function weekButtonLabel(weekNum) {
    return `Week ${weekNum} (${weekRangeLabel(weekNum)})`;
  }

  function calcDateRange(dateStr) {
    return weekRangeLabel(calcAcademicWeekNumber(dateStr));
  }

  function getAcademicCycleLabel(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    const startYear = d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1;
    return `${startYear}-${startYear+1}`;
  }

  function calcDayName(dateStr) {
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-CA', { weekday: 'long' });
  }

  function monthLabel(date) {
    return date.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
  }

  // "Week X : Sep 21-25, 2026" header, built from the days array
  function weekHeaderLabel(days, weekNum) {
    const first = days[0], last = days[days.length-1];
    const year = last.getFullYear();
    return `Week ${weekNum} : ${fmtMonthDay(first)} – ${fmtMonthDay(last)}, ${year}`;
  }

  // ── Month dropdown order: Aug 2026 → Apr 2027 ──────────────────
  // Each entry: { value: '2026-08', label: 'August 2026', month: 7 (0-idx), year: 2026 }
  const MONTH_SEQUENCE = (() => {
    const names = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    const seq = [];
    // Aug(7) 2026 .. Dec(11) 2026, then Jan(0) 2027 .. Apr(3) 2027
    for (let m = 7; m <= 11; m++) seq.push({ value: `2026-${String(m+1).padStart(2,'0')}`, label: `${names[m]} 2026`, month: m, year: 2026 });
    for (let m = 0; m <= 3; m++)  seq.push({ value: `2027-${String(m+1).padStart(2,'0')}`, label: `${names[m]} 2027`, month: m, year: 2027 });
    return seq;
  })();

  // ════════════════════════════════════════════════════════════
  // TIME-GRID MATH (variable-duration proportional blocks)
  // Day runs 8:30am–4:30pm = 480 minutes, on a 5-minute backend grid.
  // ════════════════════════════════════════════════════════════
  const DAY_START_MIN = 8*60 + 30;  // 510
  const DAY_END_MIN   = 16*60 + 30; // 990
  const DAY_SPAN_MIN  = DAY_END_MIN - DAY_START_MIN; // 480

  function timeToMinutes(hhmm) {
    if (!hhmm) return null;
    const [h,m] = hhmm.split(':').map(Number);
    return h*60 + m;
  }

  // Returns { topPct, heightPct } for positioning a block absolutely within
  // the day column (0-100 scale), clamped to the visible day window.
  function blockPosition(startTime, endTime) {
    let startMin = timeToMinutes(startTime);
    let endMin = timeToMinutes(endTime) ?? (startMin + 50); // default 50min if no end given
    startMin = Math.max(startMin, DAY_START_MIN);
    endMin = Math.min(endMin, DAY_END_MIN);
    if (endMin <= startMin) endMin = startMin + 5;
    const topPct = ((startMin - DAY_START_MIN) / DAY_SPAN_MIN) * 100;
    const heightPct = ((endMin - startMin) / DAY_SPAN_MIN) * 100;
    return { topPct, heightPct };
  }

  // Hour gridlines for the background reference (8:30 → 4:30, hourly)
  function hourGridlines() {
    const lines = [];
    for (let min = DAY_START_MIN; min <= DAY_END_MIN; min += 60) {
      const h24 = Math.floor(min/60), m = min%60;
      const h12 = ((h24 + 11) % 12) + 1;
      const label = `${h12}:${String(m).padStart(2,'0')}${h24 < 12 ? 'am' : 'pm'}`;
      lines.push({ topPct: ((min - DAY_START_MIN) / DAY_SPAN_MIN) * 100, label });
    }
    return lines;
  }

  return {
    DOW7, dateKey, addDays, isToday,
    buildMonthGrid, buildWeekDays,
    calcAcademicWeekNumber, getAcademicCycleLabel, calcDayName, calcDateRange,
    monthLabel, weekHeaderLabel, weekRangeLabel, weekButtonLabel, weekMonday,
    MONTH_SEQUENCE,
    DAY_START_MIN, DAY_END_MIN, DAY_SPAN_MIN,
    timeToMinutes, blockPosition, hourGridlines,
  };
})();

window.CalendarEngine = CalendarEngine;
