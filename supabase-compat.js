// supabase-compat.js — provides the slice of the Firebase compat SDK this app
// uses (window.firebase: firestore() and auth()) on top of Supabase, so app.js,
// auth-roles.js, change-requests.js and approvals.js run unchanged against the
// relational schema in supabase/migrations.
//
// Every document maps to a table row through COLLECTIONS below. A value that
// fits its typed column is stored there; anything else goes in the row's
// `extra` JSON under its original field name and is restored on read, so a
// document always comes back exactly as it was written. Anything the app
// doesn't use throws rather than quietly doing nothing.
(function (root, factory) {
  const api = factory();
  root.SupabaseCompat = api;
  if (typeof document === 'undefined') return; // Node: the operations scripts build their own client.
  const env = root.TIMETABLE_ENVIRONMENT;
  if (!env || !env.supabase || !env.supabase.url || !env.supabase.publishableKey) {
    throw new Error('Missing Supabase settings in environment.js.');
  }
  const client = root.supabase.createClient(env.supabase.url, env.supabase.publishableKey);
  root.firebase = api.createFirebase(client, { storage: root.localStorage, cachePrefix: `timetable:${env.name}:` });
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  // Replaced with the database's now() inside apply_writes, so one commit
  // shares one timestamp, like a Firestore batch.
  const SERVER_TS = '__SUPABASE_COMPAT_SERVER_TS__';
  const SERVER_TS_SENTINEL = Object.freeze({ __serverTimestamp: true });
  const PAGE_SIZE = 1000;
  const POLL_MS = 60000;
  const REFRESH_DEBOUNCE_MS = 200;

  class Timestamp {
    constructor(ms) { this.ms = ms; }
    static fromIso(iso) { return new Timestamp(new Date(iso).getTime()); }
    toDate() { return new Date(this.ms); }
    toMillis() { return this.ms; }
    get seconds() { return Math.floor(this.ms / 1000); }
    get nanoseconds() { return (this.ms % 1000) * 1e6; }
    toISOString() { return new Date(this.ms).toISOString(); }
  }

  function compatError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  }
  function toFirestoreError(err) {
    if (err && err.code === '42501') return compatError('permission-denied', 'Missing or insufficient permissions.');
    if (err && err.code === 'P0002') return compatError('not-found', err.message);
    return compatError('unknown', (err && err.message) || 'Database request failed');
  }

  // Duck-typed so firebase-admin Timestamps work too (scripts/refresh-staging.mjs).
  const isTimestamp = v => !!v && typeof v === 'object' && typeof v.toMillis === 'function';
  const isoOf = v => new Date(v.toMillis()).toISOString();

  // ── JSON values (extra, history snapshots, summaries) ─────────────────
  function encodeJson(value, path) {
    if (value === undefined) throw compatError('invalid-argument', `Unsupported field value: undefined (found in field ${path})`);
    if (value === SERVER_TS_SENTINEL) return { __ts: SERVER_TS };
    if (isTimestamp(value)) return { __ts: isoOf(value) };
    if (value instanceof Date) return { __ts: value.toISOString() };
    if (Array.isArray(value)) return value.map((v, i) => encodeJson(v, `${path}[${i}]`));
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, encodeJson(v, `${path}.${k}`)]));
    }
    return value;
  }
  function decodeJson(value) {
    if (Array.isArray(value)) return value.map(decodeJson);
    if (value && typeof value === 'object') {
      const keys = Object.keys(value);
      if (keys.length === 1 && keys[0] === '__ts') return Timestamp.fromIso(value.__ts);
      return Object.fromEntries(keys.map(k => [k, decodeJson(value[k])]));
    }
    return value;
  }

  // ── Column types: fits / encode for writing, decode for reading ───────
  const isClockTime = v => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  const isCalendarDate = v => {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const d = new Date(`${v}T00:00:00Z`);
    return !isNaN(d) && d.toISOString().slice(0, 10) === v;
  };
  const oneOf = (...values) => ({ fits: v => values.includes(v), encode: v => v, decode: v => v });
  const TEXT = { fits: v => typeof v === 'string', encode: v => v, decode: v => v };
  const INT = { fits: v => Number.isInteger(v) && Math.abs(v) < 2147483648, encode: v => v, decode: v => v };
  const BOOL = { fits: v => typeof v === 'boolean', encode: v => v, decode: v => v };
  const DATE = { fits: isCalendarDate, encode: v => v, decode: v => v };
  const TIME = { fits: isClockTime, encode: v => v, decode: v => v.slice(0, 5) };
  const YEAR = { fits: v => ['1', '2', '3'].includes(v), encode: v => Number(v), decode: v => String(v) };
  const TS = {
    fits: v => v === SERVER_TS_SENTINEL || isTimestamp(v),
    encode: v => (v === SERVER_TS_SENTINEL ? SERVER_TS : isoOf(v)),
    decode: v => Timestamp.fromIso(v),
  };
  const JSONB = { fits: () => true, encode: (v, field) => encodeJson(v, field), decode: decodeJson };
  const ROLE = oneOf('cc', 'instructor', 'adfad', 'dvm_office', 'adc');

  // Objects flattened across columns: requestedBy, reviewedBy, checklist.
  function flattened(prefix, keys) {
    return { keys, columns: Object.fromEntries(keys.map(([field, column]) => [field, `${prefix}${column}`])) };
  }
  const PERSON = [['uid', 'uid'], ['email', 'email'], ['name', 'name'], ['role', 'role']];
  const REVIEW_STAGES = { facultyBReview: 'faculty_b', adfadReview: 'adfad', dvmReview: 'dvm_office', adcReview: 'adc' };

  const COLLECTIONS = {
    sessions: {
      fields: {
        date: ['date', DATE], day: ['day', TEXT], week: ['week', INT], dateRange: ['date_range', TEXT],
        academicCycle: ['academic_cycle', TEXT], startTime: ['start_time', TIME], endTime: ['end_time', TIME],
        year: ['year', YEAR], type: ['type', oneOf('LEC', 'LAB', 'SRL', 'Quiz/Midterm', 'OSCE', 'Exam', 'Holiday', 'Event')],
        course: ['course', TEXT], courseName: ['course_name', TEXT], courseDept: ['course_dept', TEXT], topic: ['topic', TEXT],
        room: ['room', TEXT], group: ['group', TEXT], labGroupId: ['lab_group_id', TEXT], column: ['lab_column', TEXT],
        primaryInstructor: ['primary_instructor', TEXT], secondaryInstructor: ['secondary_instructor', TEXT],
        primaryInstructorDisplay: ['primary_instructor_display', TEXT], secondaryInstructorDisplay: ['secondary_instructor_display', TEXT],
        finalizedInstructors: ['finalized_instructors', TEXT], instructorProposed: ['instructor_proposed', TEXT],
        numInstructors: ['num_instructors', INT], notes: ['notes', TEXT], rowId: ['row_id', TEXT], sortOrder: ['sort_order', TEXT],
        createdAt: ['created_at', TS], updatedAt: ['updated_at', TS],
      },
    },
    sessions_history: {
      fields: { sessionId: ['session_id', TEXT], savedAt: ['saved_at', TS] },
      snapshot: true,
    },
    change_log: {
      fields: {
        sessionId: ['session_id', TEXT], course: ['course_label', TEXT], sessionTopic: ['session_topic', TEXT],
        sessionYear: ['session_year', TEXT], sessionType: ['session_type', TEXT], sessionStartTime: ['session_start_time', TEXT],
        sessionDate: ['session_date', TEXT], sessionWeek: ['session_week', INT], changedAt: ['changed_at', TS],
      },
      select: '*,change_log_fields(*)',
      changedFields: true,
    },
    roster: {
      fields: {
        year: ['year', oneOf('year1', 'year2', 'year3')], ucid: ['ucid', TEXT], group6: ['group6', TEXT], group5: ['group5', TEXT],
        group4: ['group4', TEXT], group3: ['group3', TEXT], group2: ['group2', TEXT],
      },
    },
    settings: { fields: { text: ['value', TEXT], updatedAt: ['updated_at', TS] } },
    authorized_users: {
      fields: { email: ['email', TEXT], name: ['name', TEXT], role: ['role', ROLE], importedAt: ['imported_at', TS] },
    },
    users: {
      fields: {
        email: ['email', TEXT], name: ['name', TEXT], nameLower: ['name_lower', TEXT], role: ['role', ROLE],
        requestedRole: ['requested_role', ROLE], status: ['status', oneOf('pending', 'active', 'rejected', 'revoked')],
        createdAt: ['created_at', TS], reviewedBy: ['reviewed_by', TEXT], reviewedAt: ['reviewed_at', TS],
        revokedBy: ['revoked_by', TEXT], revokedAt: ['revoked_at', TS],
      },
    },
    access_requests: {
      fields: {
        name: ['name', TEXT], email: ['email', TEXT], claimedRole: ['claimed_role', ROLE], note: ['note', TEXT],
        status: ['status', oneOf('pending', 'fulfilled', 'rejected')], createdAt: ['created_at', TS],
        reviewedBy: ['reviewed_by', TEXT], reviewedAt: ['reviewed_at', TS],
      },
    },
    change_requests: {
      fields: {
        requestType: ['request_type', oneOf('topic', 'type_change', 'swap')],
        status: ['status', oneOf('pending_faculty_b', 'pending', 'pending_dvm', 'approved', 'rejected')],
        sessionId: ['session_id', TEXT], sessionSummary: ['session_summary', JSONB],
        sessionAId: ['session_a_id', TEXT], sessionASummary: ['session_a_summary', JSONB],
        sessionBId: ['session_b_id', TEXT], sessionBSummary: ['session_b_summary', JSONB],
        oldTopic: ['old_topic', TEXT], newTopic: ['new_topic', TEXT], oldType: ['old_type', TEXT], newType: ['new_type', TEXT],
        swapFields: ['swap_fields', JSONB], swapFieldLabels: ['swap_field_labels', JSONB],
        facultyBName: ['faculty_b_name', TEXT], facultyBNameLower: ['faculty_b_name_lower', TEXT], reason: ['reason', TEXT],
        createdAt: ['created_at', TS], rejectedStage: ['rejected_stage', TEXT], reviewNote: ['review_note', TEXT],
        reviewedAt: ['reviewed_at', TS],
      },
      flattened: {
        requestedBy: flattened('requested_by_', PERSON),
        reviewedBy: flattened('reviewed_by_', PERSON),
      },
      checklist: {
        inviteUpdate: 'checklist_invite_update', dvmHubUpdate: 'checklist_dvm_hub_update', d2lUpdate: 'checklist_d2l_update',
      },
      where: { 'requestedBy.uid': 'requested_by_uid' },
      select: '*,change_request_reviews(*)',
      reviews: true,
    },
    admin_audit_log: {
      fields: { type: ['type', TEXT], summary: ['summary', TEXT], detail: ['detail', JSONB], at: ['at', TS] },
      flattened: { actor: flattened('actor_', [['uid', 'uid'], ['email', 'email']]) },
    },
  };

  function specFor(collection) {
    const spec = COLLECTIONS[collection];
    if (!spec) throw compatError('invalid-argument', `Unknown collection: ${collection}`);
    return spec;
  }

  const isPlainObject = v => !!v && typeof v === 'object' && !Array.isArray(v) && !isTimestamp(v) && v !== SERVER_TS_SENTINEL;

  // ── Document → row ────────────────────────────────────────────────────
  // Returns the column changes plus any child-table operations. Clearing the
  // other home of each value matters: a merge can move a field from its column
  // to `extra` or back, and a stale copy must not survive.
  function toRowChange(collection, id, data) {
    const spec = specFor(collection);
    const change = { cols: {}, extraSet: {}, extraDel: [], children: [] };

    if (spec.snapshot) {
      const snapshot = {};
      for (const [field, value] of Object.entries(data)) {
        if (spec.fields[field]) change.cols[spec.fields[field][0]] = spec.fields[field][1].encode(value);
        else snapshot[field] = encodeJson(value, field);
      }
      change.cols.snapshot = snapshot;
      return change;
    }

    const toExtra = (field, value, columns) => {
      columns.forEach(c => { change.cols[c] = null; });
      change.extraSet[field] = encodeJson(value, field);
    };
    const toColumns = (field, values) => {
      Object.assign(change.cols, values);
      change.extraDel.push(field);
    };

    for (const [field, value] of Object.entries(data)) {
      if (value === undefined) throw compatError('invalid-argument', `Unsupported field value: undefined (found in field ${field})`);

      if (spec.fields[field]) {
        const [column, type] = spec.fields[field];
        if (value !== null && type.fits(value)) toColumns(field, { [column]: type.encode(value, field) });
        else toExtra(field, value, [column]);
        continue;
      }

      const flat = spec.flattened && spec.flattened[field];
      if (flat) {
        const columns = Object.values(flat.columns);
        const fits = isPlainObject(value) && Object.entries(value).every(([k, v]) => flat.columns[k] && (v === null || typeof v === 'string'));
        if (fits) toColumns(field, Object.fromEntries(Object.entries(flat.columns).map(([k, c]) => [c, value[k] ?? null])));
        else toExtra(field, value, columns);
        continue;
      }

      if (spec.checklist && field === 'checklist') {
        const columns = Object.values(spec.checklist);
        const fits = isPlainObject(value) && Object.entries(value).every(([k, v]) => spec.checklist[k] && typeof v === 'boolean');
        if (fits) toColumns(field, Object.fromEntries(Object.entries(spec.checklist).map(([k, c]) => [c, value[k] ?? null])));
        else toExtra(field, value, columns);
        continue;
      }
      if (spec.checklist && field.startsWith('checklist.')) {
        const column = spec.checklist[field.slice('checklist.'.length)];
        if (!column || typeof value !== 'boolean') throw compatError('invalid-argument', `Unsupported update: ${field}`);
        change.cols[column] = value;
        continue;
      }

      if (spec.reviews && REVIEW_STAGES[field]) {
        const stage = REVIEW_STAGES[field];
        const key = { request_id: id, stage };
        const by = isPlainObject(value) ? value.by : null;
        const person = isPlainObject(by) && PERSON.every(([k]) => by[k] === undefined || by[k] === null || typeof by[k] === 'string');
        const known = isPlainObject(value) && person && Object.keys(value).every(k => ['by', 'at', 'note'].includes(k))
          && TS.fits(value.at) && typeof value.note === 'string';
        change.children.push({ op: 'delete', table: 'change_request_reviews', key });
        if (known) {
          change.extraDel.push(field);
          change.children.push({
            op: 'create', table: 'change_request_reviews', key,
            cols: {
              decision: stage === 'faculty_b' && data.status === 'rejected' ? 'rejected' : 'approved',
              reviewer_uid: by.uid ?? null, reviewer_email: by.email ?? null, reviewer_name: by.name ?? null, reviewer_role: by.role ?? null,
              note: value.note, reviewed_at: TS.encode(value.at),
            },
          });
        } else {
          change.extraSet[field] = encodeJson(value, field);
        }
        continue;
      }

      if (spec.changedFields && field === 'changedFields') {
        const rows = Array.isArray(value) && value.length && value.every(f => isPlainObject(f)
          && Object.keys(f).every(k => ['fieldLabel', 'oldValue', 'newValue'].includes(k))
          && [f.fieldLabel, f.oldValue, f.newValue].every(v => typeof v === 'string'));
        change.children.push({ op: 'delete', table: 'change_log_fields', key: { change_log_id: id } });
        if (rows) {
          change.extraDel.push(field);
          value.forEach((f, position) => change.children.push({
            op: 'create', table: 'change_log_fields', key: { change_log_id: id, position },
            cols: { field_label: f.fieldLabel, old_value: f.oldValue, new_value: f.newValue },
          }));
        } else {
          change.extraSet[field] = encodeJson(value, field);
        }
        continue;
      }

      change.extraSet[field] = encodeJson(value, field);
    }
    return change;
  }

  // ── Row → document ────────────────────────────────────────────────────
  function fromRow(collection, row) {
    const spec = specFor(collection);
    const doc = {};
    for (const [field, [column, type]] of Object.entries(spec.fields)) {
      if (row[column] !== null && row[column] !== undefined) doc[field] = type.decode(row[column]);
    }
    if (spec.snapshot) return Object.assign(doc, decodeJson(row.snapshot || {}));

    for (const [field, flat] of Object.entries(spec.flattened || {})) {
      const value = {};
      for (const [key, column] of Object.entries(flat.columns)) {
        if (row[column] !== null && row[column] !== undefined) value[key] = row[column];
      }
      if (Object.keys(value).length) doc[field] = value;
    }
    if (spec.checklist) {
      const value = {};
      for (const [key, column] of Object.entries(spec.checklist)) {
        if (row[column] !== null && row[column] !== undefined) value[key] = row[column];
      }
      if (Object.keys(value).length) doc.checklist = value;
    }
    if (spec.reviews) {
      const fieldOf = Object.fromEntries(Object.entries(REVIEW_STAGES).map(([field, stage]) => [stage, field]));
      for (const r of row.change_request_reviews || []) {
        const by = {};
        if (r.reviewer_uid !== null) by.uid = r.reviewer_uid;
        if (r.reviewer_email !== null) by.email = r.reviewer_email;
        if (r.reviewer_name !== null) by.name = r.reviewer_name;
        if (r.reviewer_role !== null) by.role = r.reviewer_role;
        doc[fieldOf[r.stage]] = { by, at: Timestamp.fromIso(r.reviewed_at), note: r.note };
      }
    }
    if (spec.changedFields && (row.change_log_fields || []).length) {
      doc.changedFields = row.change_log_fields.slice().sort((a, b) => a.position - b.position)
        .map(f => ({ fieldLabel: f.field_label, oldValue: f.old_value, newValue: f.new_value }));
    }
    return Object.assign(doc, decodeJson(row.extra || {}));
  }

  function writeOps(kind, collection, id, data) {
    const change = toRowChange(collection, id, data);
    return [
      { op: kind, table: collection, key: { id }, cols: change.cols, extra_set: change.extraSet, extra_del: change.extraDel },
      ...change.children,
    ];
  }

  // ── Firebase surface ──────────────────────────────────────────────────
  class DocumentSnapshot {
    constructor(ref, data) { this.ref = ref; this.id = ref.id; this._data = data; this.exists = data !== undefined; }
    data() { return this._data; }
  }
  class QuerySnapshot {
    constructor(docs, fromCache) {
      this.docs = docs; this.size = docs.length; this.empty = docs.length === 0;
      this.metadata = { fromCache };
    }
    forEach(callback) { this.docs.forEach(callback); }
  }

  function autoId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(20);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, b => chars[b % chars.length]).join('');
  }

  function createFirestore(client, options) {
    const storage = options.storage || null;
    const cachePrefix = options.cachePrefix || 'timetable:';

    const cacheKey = (collection, queryKey) => `${cachePrefix}${collection}:${queryKey}`;
    function readCache(collection, queryKey) {
      try {
        const text = storage && storage.getItem(cacheKey(collection, queryKey));
        return text ? JSON.parse(text) : null;
      } catch { return null; }
    }
    function writeCache(collection, queryKey, rows) {
      try { if (storage) storage.setItem(cacheKey(collection, queryKey), JSON.stringify(rows)); }
      catch { /* Quota exceeded: reads simply go to the server next time. */ }
    }
    function clearCache(collection) {
      try {
        if (!storage) return;
        const prefix = `${cachePrefix}${collection}:`;
        const keys = [];
        for (let i = 0; i < storage.length; i++) { const k = storage.key(i); if (k && k.startsWith(prefix)) keys.push(k); }
        keys.forEach(k => storage.removeItem(k));
      } catch { /* Nothing cached to clear. */ }
    }

    async function applyWrites(ops) {
      const { error } = await client.rpc('apply_writes', { ops });
      if (error) throw toFirestoreError(error);
      new Set(ops.map(o => o.table)).forEach(clearCache);
    }

    class DocumentReference {
      constructor(collection, id, isNew) { this.collection = collection; this.id = id; this.isNew = !!isNew; }
      get path() { return `${this.collection}/${this.id}`; }
      async get() {
        const spec = specFor(this.collection);
        const { data, error } = await client.from(this.collection).select(spec.select || '*').eq('id', this.id).maybeSingle();
        if (error) throw toFirestoreError(error);
        return new DocumentSnapshot(this, data ? fromRow(this.collection, data) : undefined);
      }
      async set(data, setOptions) {
        const batch = new WriteBatch();
        batch.set(this, data, setOptions);
        await batch.commit();
      }
      async update(data) {
        const batch = new WriteBatch();
        batch.update(this, data);
        await batch.commit();
      }
      async delete() {
        const batch = new WriteBatch();
        batch.delete(this);
        await batch.commit();
      }
      onSnapshot(next, onError) {
        return live.subscribe(this.collection, async () => next(await this.get()), onError);
      }
    }

    class Query {
      constructor(collection, filters, orders, max) {
        this.collection = collection; this.filters = filters || []; this.orders = orders || []; this.max = max;
      }
      columnFor(field) {
        const spec = specFor(this.collection);
        const column = (spec.fields[field] && spec.fields[field][0]) || (spec.where && spec.where[field]);
        if (!column) throw compatError('invalid-argument', `Unsupported query field: ${this.collection}.${field}`);
        return column;
      }
      where(field, op, value) {
        if (!['==', '<', '>='].includes(op)) throw compatError('invalid-argument', `Unsupported query operator: ${op}`);
        return new Query(this.collection, [...this.filters, { column: this.columnFor(field), op, value }], this.orders, this.max);
      }
      orderBy(field, direction) {
        return new Query(this.collection, this.filters, [...this.orders, { column: this.columnFor(field), ascending: direction !== 'desc' }], this.max);
      }
      limit(max) { return new Query(this.collection, this.filters, this.orders, max); }
      get queryKey() { return JSON.stringify([this.filters, this.orders, this.max]); }

      // Firestore's order: inequality field first, then document id in the
      // direction of the last sort.
      effectiveOrders() {
        const orders = this.orders.slice();
        const inequality = this.filters.find(f => f.op !== '==');
        if (inequality && !orders.some(o => o.column === inequality.column)) orders.unshift({ column: inequality.column, ascending: true });
        orders.push({ column: 'id', ascending: orders.length ? orders[orders.length - 1].ascending : true });
        return orders;
      }

      async fetchRows() {
        const spec = specFor(this.collection);
        const rows = [];
        // The API caps rows per response, and the cap can be below PAGE_SIZE, so
        // only an empty page means the end.
        for (;;) {
          const want = this.max === undefined ? PAGE_SIZE : Math.min(PAGE_SIZE, this.max - rows.length);
          if (want <= 0) break;
          let request = client.from(this.collection).select(spec.select || '*');
          for (const f of this.filters) {
            request = f.op === '==' ? request.eq(f.column, f.value) : f.op === '<' ? request.lt(f.column, f.value) : request.gte(f.column, f.value);
          }
          for (const o of this.effectiveOrders()) request = request.order(o.column, { ascending: o.ascending });
          const { data, error } = await request.range(rows.length, rows.length + want - 1);
          if (error) throw toFirestoreError(error);
          if (!data.length) break;
          rows.push(...data);
        }
        return rows;
      }

      toSnapshot(rows, fromCache) {
        const docs = rows.map(row => new DocumentSnapshot(new DocumentReference(this.collection, String(row.id)), fromRow(this.collection, row)));
        return new QuerySnapshot(docs, fromCache);
      }

      async get(getOptions) {
        if (getOptions && getOptions.source === 'cache') {
          const cached = readCache(this.collection, this.queryKey);
          if (!cached) throw compatError('unavailable', 'Failed to get documents from cache.');
          return this.toSnapshot(cached, true);
        }
        const rows = await this.fetchRows();
        writeCache(this.collection, this.queryKey, rows);
        return this.toSnapshot(rows, false);
      }

      onSnapshot(next, onError) {
        return live.subscribe(this.collection, async () => next(await this.get({ source: 'server' })), onError);
      }
    }

    class CollectionReference extends Query {
      doc(id) { return id === undefined ? new DocumentReference(this.collection, autoId(), true) : new DocumentReference(this.collection, String(id)); }
      async add(data) {
        const ref = this.doc();
        await ref.set(data);
        return ref;
      }
    }

    class WriteBatch {
      constructor() { this.ops = []; }
      set(ref, data, setOptions) {
        const kind = setOptions && setOptions.merge ? 'merge' : ref.isNew ? 'create' : 'replace';
        this.ops.push(...writeOps(kind, ref.collection, ref.id, data));
        return this;
      }
      update(ref, data) { this.ops.push(...writeOps('update', ref.collection, ref.id, data)); return this; }
      delete(ref) { this.ops.push({ op: 'delete', table: ref.collection, key: { id: ref.id } }); return this; }
      async commit() { if (this.ops.length) await applyWrites(this.ops); }
    }

    // ── Live updates: one channel, re-reads on change ─────────────────────
    // A listener always fires once at the start, then after each change and
    // reconnect. If Realtime is unavailable, polling keeps the feeds moving.
    const live = {
      listeners: new Map(),
      channel: null,
      joined: false,
      everJoined: false,
      pollTimer: null,
      timers: new Map(),
      fire(listener) {
        Promise.resolve().then(listener.run).catch(err => { if (listener.onError) listener.onError(toFirestoreError(err)); });
      },
      fireTable(table) {
        clearTimeout(this.timers.get(table));
        this.timers.set(table, setTimeout(() => {
          for (const listener of this.listeners.values()) if (listener.table === table) this.fire(listener);
        }, REFRESH_DEBOUNCE_MS));
      },
      fireAll() { for (const listener of this.listeners.values()) this.fire(listener); },
      startPolling() { if (!this.pollTimer) this.pollTimer = setInterval(() => this.fireAll(), POLL_MS); },
      stopPolling() { clearInterval(this.pollTimer); this.pollTimer = null; },
      connect() {
        if (this.channel || !client.channel) return;
        let channel = client.channel('timetable-live');
        for (const table of ['settings', 'change_log', 'roster']) {
          channel = channel.on('postgres_changes', { event: '*', schema: 'public', table }, () => { clearCache(table); this.fireTable(table); });
        }
        this.channel = channel.subscribe(status => {
          if (status === 'SUBSCRIBED') {
            this.joined = true;
            this.stopPolling();
            if (this.everJoined) this.fireAll();
            this.everJoined = true;
          } else {
            this.joined = false;
            this.startPolling();
          }
        });
      },
      subscribe(table, run, onError) {
        const token = {};
        this.listeners.set(token, { table, run, onError });
        this.connect();
        this.fire(this.listeners.get(token));
        return () => { this.listeners.delete(token); };
      },
    };

    return {
      collection: name => { specFor(name); return new CollectionReference(name); },
      batch: () => new WriteBatch(),
      enablePersistence: () => Promise.resolve(),
      // Used only by scripts/refresh-staging.mjs, which has a single operator.
      // Reads then writes without isolation, unlike a Firestore transaction.
      runTransaction: async callback => {
        const batch = new WriteBatch();
        const result = await callback({ get: ref => ref.get(), set: (ref, data, o) => batch.set(ref, data, o) });
        await batch.commit();
        return result;
      },
    };
  }

  // ── Auth ──────────────────────────────────────────────────────────────
  const AUTH_ERROR_CODES = {
    invalid_credentials: 'auth/invalid-credential',
    user_already_exists: 'auth/email-already-in-use',
    email_exists: 'auth/email-already-in-use',
    email_address_invalid: 'auth/invalid-email',
    validation_failed: 'auth/invalid-email',
    weak_password: 'auth/weak-password',
  };
  function toAuthError(err) {
    const message = (err && err.message) || 'Authentication failed';
    if (/already registered/i.test(message)) return compatError('auth/email-already-in-use', message);
    if (/invalid login credentials/i.test(message)) return compatError('auth/invalid-credential', message);
    return compatError(AUTH_ERROR_CODES[err && err.code] || 'auth/internal-error', message);
  }

  function createAuth(client, options) {
    const resetRedirect = options.resetRedirect;
    const listeners = [];
    let current = null;
    let settled = false;

    function wrapUser(user) {
      if (!user) return null;
      return {
        uid: user.id,
        email: user.email,
        async delete() {
          const { error } = await client.rpc('delete_my_account');
          if (error) throw toAuthError(error);
          await client.auth.signOut({ scope: 'local' });
          setUser(null);
        },
      };
    }
    // Supabase also reports token refreshes and tab refocuses; Firebase's
    // listener only fires when the signed-in user actually changes.
    function setUser(user) {
      const next = wrapUser(user);
      const changed = !settled || (current && current.uid) !== (next && next.uid);
      if (!changed) return;
      current = next;
      settled = true;
      listeners.slice().forEach(cb => cb(current));
    }

    // Deferred: calling back into Supabase from inside this callback can
    // deadlock, and the app's listeners read the profile straight away.
    client.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY') return;
      setTimeout(() => setUser(session ? session.user : null), 0);
    });

    return {
      get currentUser() { return current; },
      onAuthStateChanged(callback) {
        listeners.push(callback);
        if (settled) setTimeout(() => callback(current), 0);
        return () => { const i = listeners.indexOf(callback); if (i >= 0) listeners.splice(i, 1); };
      },
      async signInWithEmailAndPassword(email, password) {
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        if (error) throw toAuthError(error);
        setUser(data.user);
        return { user: current };
      },
      async createUserWithEmailAndPassword(email, password) {
        const { data, error } = await client.auth.signUp({ email, password });
        if (error) throw toAuthError(error);
        if (!data.session) throw compatError('auth/operation-not-allowed', 'Turn off "Confirm email" in Supabase Auth settings.');
        setUser(data.user);
        return { user: current };
      },
      async signOut() {
        const { error } = await client.auth.signOut({ scope: 'local' });
        if (error) throw toAuthError(error);
        setUser(null);
      },
      async sendPasswordResetEmail(email) {
        const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: resetRedirect() });
        if (error) throw toAuthError(error);
      },
    };
  }

  function createFirebase(client, options = {}) {
    const firestoreInstance = createFirestore(client, options);
    const authInstance = createAuth(client, {
      resetRedirect: options.resetRedirect || (() => new URL('reset-password.html', globalThis.location.href).href),
    });
    const firestore = () => firestoreInstance;
    firestore.FieldValue = { serverTimestamp: () => SERVER_TS_SENTINEL };
    return { initializeApp() {}, firestore, auth: () => authInstance };
  }

  return { createFirebase, createFirestore, toRowChange, fromRow, writeOps, COLLECTIONS, Timestamp, SERVER_TS_SENTINEL, encodeJson, decodeJson };
});
