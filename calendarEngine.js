// calendarEngine.js — Calendar Rendering & Academic Week Calculation

const CalendarEngine = (() => {

  const DOW7 = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];

  function dateKey(d) { return d.toISOString().slice(0,10); }
  function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate()+n); return r; }

  function isToday(d) {
    const t = new Date();
    return d.getFullYear()===t.getFullYear() && d.getMonth()===t.getMonth() && d.getDate()===t.getDate();
  }

  // ── Month grid ────────────────────────────────────────────────
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

  // ── Week days (Mon-Sun) ──────────────────────────────────────
  function buildWeekDays(refDate) {
    const dow = (refDate.getDay()+6)%7;
    const mon = new Date(refDate); mon.setDate(refDate.getDate()-dow);
    return Array.from({length:7}, (_,i) => new Date(mon.getFullYear(),mon.getMonth(),mon.getDate()+i));
  }

  // ── Academic Week Number ─────────────────────────────────────
  // Week 1 = the Monday of the LAST week of August that falls in August
  // (i.e. the latest Monday on or before Aug 31).
  // Example: Aug 31, 2026 is a Monday → Week 1 starts Aug 31, 2026.
  function getWeek1Start(calYear) {
    // Find the latest Monday on or before Aug 31 of calYear
    const aug31 = new Date(calYear, 7, 31); // month 7 = August
    const dow = aug31.getDay(); // 0=Sun..6=Sat
    const daysSinceMonday = (dow + 6) % 7; // Mon=0
    const week1 = new Date(calYear, 7, 31 - daysSinceMonday);
    week1.setHours(0,0,0,0);
    return week1;
  }

  function calcAcademicWeekNumber(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    d.setHours(0,0,0,0);

    // Determine which academic cycle this date belongs to.
    // Cycle "calYear" runs from Week1Start(calYear) through the day before Week1Start(calYear+1).
    let calYear = d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1;
    let cycleStart = getWeek1Start(calYear);

    // Edge case: very early August dates might fall BEFORE this year's Week 1 —
    // they then belong to the previous cycle.
    if (d < cycleStart) {
      calYear -= 1;
      cycleStart = getWeek1Start(calYear);
    }

    const diffDays = Math.floor((d - cycleStart) / (1000*60*60*24));
    return Math.floor(diffDays / 7) + 1;
  }

  function getAcademicCycleLabel(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    const startYear = d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1;
    return `${startYear}-${startYear+1}`;
  }

  function calcDayName(dateStr) {
    return new Date(dateStr + 'T12:00:00').toLocaleDateString('en-CA', { weekday: 'long' });
  }

  // ── Date Range for the academic week (Mon-Fri) containing this date ──
  // Example: "Jun 19 - Jun 23"
  function calcDateRange(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    const dow = (d.getDay() + 6) % 7; // Mon=0
    const monday = new Date(d); monday.setDate(d.getDate() - dow);
    const friday = new Date(monday); friday.setDate(monday.getDate() + 4);
    const fmt = dt => dt.toLocaleDateString('en-CA', { month: 'short', day: 'numeric' });
    return `${fmt(monday)} - ${fmt(friday)}`;
  }

  function monthLabel(date) {
    return date.toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
  }
  function weekLabel(days) {
    return `${days[0].toLocaleDateString('en-CA',{month:'short',day:'numeric'})} – ${days[6].toLocaleDateString('en-CA',{month:'short',day:'numeric',year:'numeric'})}`;
  }

  return {
    DOW7, dateKey, addDays, isToday,
    buildMonthGrid, buildWeekDays,
    calcAcademicWeekNumber, getAcademicCycleLabel, calcDayName, calcDateRange,
    monthLabel, weekLabel,
  };
})();

window.CalendarEngine = CalendarEngine;
