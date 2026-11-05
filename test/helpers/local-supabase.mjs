// A stand-in for a Supabase project: real Postgres (PGlite) running the real
// migration, with Supabase's roles, and a small client that speaks the part of
// the supabase-js API supabase-compat.js uses. Each request runs as the current
// identity, so row-level security is really enforced.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

const MIGRATIONS = path.resolve('supabase/migrations');

const BOOTSTRAP = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.jwt() returns jsonb language sql stable as
    $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on all functions in schema auth to anon, authenticated, service_role;
`;

export async function startLocalSupabase({ maxRows = 1000 } = {}) {
  const pg = new PGlite();
  await pg.exec(BOOTSTRAP);
  for (const file of readdirSync(MIGRATIONS).sort()) await pg.exec(readFileSync(path.join(MIGRATIONS, file), 'utf8'));

  async function asIdentity(identity, work) {
    return pg.transaction(async tx => {
      const claims = identity.uid ? JSON.stringify({ sub: identity.uid, email: identity.email }) : '';
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
      await tx.exec(`set local role ${identity.role}`);
      return work(tx);
    });
  }
  const failure = err => ({ code: err.code, message: err.message });

  class Select {
    constructor(identity, table, select) {
      Object.assign(this, { identity, table, select, filters: [], orders: [], window: null, single: false });
    }
    eq(c, v) { this.filters.push([c, '=', v]); return this; }
    lt(c, v) { this.filters.push([c, '<', v]); return this; }
    gte(c, v) { this.filters.push([c, '>=', v]); return this; }
    order(c, { ascending }) { this.orders.push(`"${c}" ${ascending ? 'asc' : 'desc'}`); return this; }
    range(from, to) { this.window = [from, to]; return this; }
    maybeSingle() { this.single = true; return this; }
    async run() {
      const where = this.filters.map(([c, op], i) => `"${c}" ${op} $${i + 1}`).join(' and ');
      let sql = `select * from public."${this.table}"${where ? ` where ${where}` : ''}`;
      if (this.orders.length) sql += ` order by ${this.orders.join(', ')}`;
      if (this.window) sql += ` limit ${Math.min(this.window[1] - this.window[0] + 1, maxRows)} offset ${this.window[0]}`;
      const child = /(\w+)\(\*\)/.exec(this.select || '');
      return asIdentity(this.identity, async tx => {
        const { rows } = await tx.query(sql, this.filters.map(f => f[2]));
        if (child) {
          const fk = child[1] === 'change_log_fields' ? 'change_log_id' : 'request_id';
          for (const row of rows) {
            row[child[1]] = (await tx.query(`select * from public."${child[1]}" where ${fk} = $1`, [row.id])).rows;
          }
        }
        return rows.map(normalizeRow);
      });
    }
    then(resolve, reject) {
      return this.run().then(rows => ({ data: this.single ? rows[0] ?? null : rows, error: null }), err => ({ data: null, error: failure(err) })).then(resolve, reject);
    }
  }

  // Stands in for Supabase Auth and Realtime: passwords are not checked beyond
  // "the account exists", and committed writes notify channel subscribers.
  const accounts = new Map();
  const authListeners = [];
  const realtime = [];
  function emitAuth(event, identity) {
    const session = identity.uid ? { user: { id: identity.uid, email: identity.email } } : null;
    authListeners.forEach(cb => cb(event, session));
  }

  function client(identityRef) {
    const signIn = identity => { identityRef.current = identity; emitAuth('SIGNED_IN', identity); return { id: identity.uid, email: identity.email }; };
    return {
      from: table => ({ select: select => new Select(identityRef.current, table, select) }),
      rpc: async (name, args) => {
        try {
          await asIdentity(identityRef.current, tx => (name === 'apply_writes'
            ? tx.query('select public.apply_writes($1::jsonb)', [JSON.stringify(args.ops)])
            : tx.query(`select public.${name}()`)));
          if (name === 'apply_writes') {
            for (const table of new Set(args.ops.map(o => o.table))) realtime.filter(r => r.table === table).forEach(r => r.callback({}));
          }
          return { error: null };
        } catch (err) { return { error: failure(err) }; }
      },
      channel() {
        const channel = {
          on(_kind, { table }, callback) { realtime.push({ table, callback }); return channel; },
          subscribe(status) { status('SUBSCRIBED'); return channel; },
        };
        return channel;
      },
      auth: {
        onAuthStateChange(callback) {
          authListeners.push(callback);
          setTimeout(() => callback('INITIAL_SESSION', identityRef.current.uid ? { user: { id: identityRef.current.uid, email: identityRef.current.email } } : null), 0);
          return { data: { subscription: { unsubscribe() {} } } };
        },
        async signInWithPassword({ email }) {
          const identity = accounts.get(email.toLowerCase());
          if (!identity) return { data: {}, error: { code: 'invalid_credentials', message: 'Invalid login credentials' } };
          return { data: { user: signIn(identity) }, error: null };
        },
        async signUp({ email }) {
          if (accounts.has(email.toLowerCase())) return { data: {}, error: { code: 'user_already_exists', message: 'User already registered' } };
          const user = signIn(await createUser({ email: email.toLowerCase() }));
          return { data: { user, session: {} }, error: null };
        },
        async signOut() { identityRef.current = { role: 'anon' }; emitAuth('SIGNED_OUT', identityRef.current); return { error: null }; },
        async resetPasswordForEmail() { return { error: null }; },
      },
    };
  }

  // Mirrors what the app's signup does: a login, then a users row.
  async function createUser({ email, name, nameLower, role, status = 'active' }) {
    const uid = randomUUID();
    await pg.query('insert into auth.users (id, email) values ($1, $2)', [uid, email]);
    if (role) {
      await pg.query('insert into public.users (id, email, name, name_lower, role, status) values ($1,$2,$3,$4,$5,$6)',
        [uid, email, name, nameLower, role, status]);
    }
    const identity = { role: 'authenticated', uid, email };
    accounts.set(email, identity);
    return identity;
  }

  const ref = { current: { role: 'anon' } };
  return {
    pg,
    client: client(ref),
    actAs(identity) { ref.current = identity; },
    anon: { role: 'anon' },
    service: { role: 'service_role' },
    createUser,
  };
}

// The real API returns JSON: dates and times as strings, in Postgres's format.
function normalizeRow(row) {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => {
    if (v instanceof Date) return [k, k === 'date' ? v.toISOString().slice(0, 10) : v.toISOString()];
    return [k, v];
  }));
}
