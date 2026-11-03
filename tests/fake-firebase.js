/* A tiny in-memory stand-in for the Firebase compat SDK (app, auth, database), used only by
   tests/smoke.cjs so the app can be opened in a test browser without the real database.
   Set window.__FAKE = { user, data } before the page loads. Only what the app uses is here. */
(function () {
  'use strict';
  const F = window.__FAKE || {};
  const root = { v: JSON.parse(JSON.stringify(F.data || {})) };
  const TIMESTAMP = { '.sv': 'timestamp' };
  const parts = (p) => String(p || '').split('/').filter(Boolean);
  const clone = (v) => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
  function get(path) { let n = root.v; for (const k of parts(path)) { if (n == null || typeof n !== 'object') return null; n = n[k]; } return n === undefined ? null : n; }
  const fill = (v) => (v && typeof v === 'object' ? (v['.sv'] === 'timestamp' ? Date.now() : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))) : v);
  function put(path, value) {
    const ks = parts(path);
    if (!ks.length) { root.v = fill(value) || {}; return; }
    let n = root.v;
    ks.slice(0, -1).forEach((k) => { if (n[k] == null || typeof n[k] !== 'object') n[k] = {}; n = n[k]; });
    const last = ks[ks.length - 1];
    if (value === null || value === undefined) delete n[last]; else n[last] = fill(value);
  }
  const listeners = new Set();
  const notify = () => setTimeout(() => listeners.forEach((l) => l.fire()), 0);
  let pushN = 0;
  const pushId = () => `-fake${Date.now().toString(36)}${(pushN++).toString(36).padStart(4, '0')}`;
  function snap(key, v) { return { key, val: () => clone(v), exists: () => v != null }; }
  class Ref {
    constructor(path, q) { this.path = parts(path).join('/'); this.q = q || {}; this.key = parts(path).slice(-1)[0] || null; }
    child(p) { return new Ref(`${this.path}/${p}`); }
    orderByChild(c) { return new Ref(this.path, Object.assign({}, this.q, { by: c })); }
    equalTo(v) { return new Ref(this.path, Object.assign({}, this.q, { eq: v })); }
    startAt(v) { return new Ref(this.path, Object.assign({}, this.q, { start: v })); }
    endAt(v) { return new Ref(this.path, Object.assign({}, this.q, { end: v })); }
    limitToLast(n) { return new Ref(this.path, Object.assign({}, this.q, { last: n })); }
    value() {
      let v = get(this.path);
      const q = this.q;
      if (!q.by || v == null || typeof v !== 'object') return v;
      let rows = Object.entries(v).filter(([, r]) => {
        const x = r && r[q.by];
        if ('eq' in q && x !== q.eq) return false;
        if ('start' in q && !(x != null && x >= q.start)) return false;
        if ('end' in q && !(x != null && x <= q.end)) return false;
        return x != null || !('start' in q || 'end' in q);
      });
      rows.sort((a, b) => (a[1][q.by] > b[1][q.by] ? 1 : -1));
      if (q.last) rows = rows.slice(-q.last);
      return rows.length ? Object.fromEntries(rows) : null;
    }
    on(ev, cb) {
      const l = { cb, ref: this, fire: () => cb(snap(this.key, this.value())) };
      listeners.add(l); setTimeout(l.fire, 0); return cb;
    }
    off(ev, cb) { listeners.forEach((l) => { if (l.ref.path === this.path && (!cb || l.cb === cb)) listeners.delete(l); }); }
    // __FAKE.hangReads: reads never answer, like a phone with no signal
    once() { return F.hangReads ? new Promise(() => {}) : new Promise((res) => setTimeout(() => res(snap(this.key, this.value())), 5)); }
    set(v) { put(this.path, v); notify(); return Promise.resolve(); }
    update(o) { Object.entries(o).forEach(([k, v]) => put(`${this.path}/${k}`, v)); notify(); return Promise.resolve(); }
    remove() { return this.set(null); }
    push(v) { const r = this.child(pushId()); const p = v === undefined ? Promise.resolve() : r.set(v); r.then = p.then.bind(p); return r; }
    transaction(fn) { const next = fn(clone(get(this.path))); put(this.path, next); notify(); return Promise.resolve({ committed: true, snapshot: snap(this.key, get(this.path)) }); }
  }
  // .info/connected is always true
  put('.info/connected', true);
  const db = { ref: (p) => new Ref(p) };
  const authListeners = [];
  let current = null;
  const makeUser = (u) => u && Object.assign({ emailVerified: true, phoneNumber: null, displayName: '', providerData: [{ providerId: 'password' }], metadata: { lastSignInTime: new Date(0).toUTCString() } }, u, {
    getIdToken: () => Promise.resolve('fake-token'), reload: () => Promise.resolve()
  });
  const auth = {
    get currentUser() { return current; },
    onAuthStateChanged(cb) { authListeners.push(cb); setTimeout(() => cb(current), 0); return () => {}; },
    signInWithEmailAndPassword: () => Promise.reject(Object.assign(new Error('wrong'), { code: 'auth/invalid-credential' })),
    createUserWithEmailAndPassword: () => Promise.reject(Object.assign(new Error('no'), { code: 'auth/operation-not-allowed' })),
    signInWithPopup: () => Promise.reject(Object.assign(new Error('closed'), { code: 'auth/popup-closed-by-user' })),
    signInWithRedirect: () => Promise.resolve(), getRedirectResult: () => Promise.resolve(null),
    sendPasswordResetEmail: () => Promise.resolve(),
    signOut() { current = null; authListeners.forEach((cb) => cb(null)); return Promise.resolve(); }
  };
  current = makeUser(F.user);
  function GoogleAuthProvider() {} GoogleAuthProvider.prototype.setCustomParameters = function () {};
  function RecaptchaVerifier() {} RecaptchaVerifier.prototype.clear = function () {};
  const authFn = () => auth; authFn.GoogleAuthProvider = GoogleAuthProvider; authFn.RecaptchaVerifier = RecaptchaVerifier;
  const dbFn = () => db; dbFn.ServerValue = { TIMESTAMP };
  window.firebase = { initializeApp: () => ({}), auth: authFn, database: dbFn };
  window.__fakeDb = { get, put: (p, v) => { put(p, v); notify(); } };
}());
