/* Звездобой: вход через Google (Firebase Auth) и рейтинг (Firestore). */
(function () {
  'use strict';
  if (!window.firebase || !firebase.initializeApp) return;
  var cfg = {
    apiKey: 'AIzaSyBvyrH5qpLb2U0Fkq-Twk9R7gB9LmEhftU',
    authDomain: 'zvezdoboy-e0868.firebaseapp.com',
    projectId: 'zvezdoboy-e0868',
    storageBucket: 'zvezdoboy-e0868.firebasestorage.app',
    messagingSenderId: '941680230340',
    appId: '1:941680230340:web:5af0a7fb73210bff582e91',
    measurementId: 'G-9MF27LLHNQ'
  };
  var ADMIN = 'andrzejd572@gmail.com';
  var auth, db;
  try { firebase.initializeApp(cfg); auth = firebase.auth(); db = firebase.firestore(); } catch (e) { return; }
  try { auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL); } catch (e) {}
  var cbs = [], cur = null, ready = false;
  function wrap(u) {
    if (!u) return null;
    var em = String(u.email || '').toLowerCase();
    return { uid: u.uid, name: u.displayName || '', email: u.email || '', admin: em === ADMIN && u.emailVerified === true };
  }
  auth.onAuthStateChanged(function (u) {
    cur = wrap(u); ready = true;
    cbs.forEach(function (f) { try { f(cur); } catch (e) { console.error(e); } });
  });
  auth.getRedirectResult().catch(function () {});
  function provider() { var p = new firebase.auth.GoogleAuthProvider(); p.setCustomParameters({ prompt: 'select_account' }); return p; }
  var TS = function () { return firebase.firestore.FieldValue.serverTimestamp(); };
  window.ZBFB = {
    onUser: function (f) { cbs.push(f); if (ready) setTimeout(function () { f(cur); }, 0); },
    user: function () { return cur; },
    signIn: function () {
      var p = provider();
      return auth.signInWithPopup(p).catch(function (e) {
        var c = e && e.code;
        if (c === 'auth/popup-blocked' || c === 'auth/operation-not-supported-in-this-environment') return auth.signInWithRedirect(p);
        throw e;
      });
    },
    signOut: function () { return auth.signOut(); },
    load: function () {
      if (!cur) return Promise.resolve(null);
      return db.collection('users').doc(cur.uid).get().then(function (d) { return d.exists ? d.data() : null; });
    },
    save: function (data, runs) {
      if (!cur) return Promise.resolve(false);
      return db.collection('users').doc(cur.uid).set({ data: String(data), runs: runs | 0, t: TS() }).then(function () { return true; });
    },
    submit: function (name, best, world) {
      if (!cur) return Promise.resolve(false);
      best = Math.max(0, Math.min(99999999, Math.round(best) | 0)); world = Math.max(1, Math.min(100, world | 0));
      var ref = db.collection('scores').doc(cur.uid);
      return ref.get().then(function (d) {
        if (d.exists && (d.data().best | 0) > best) best = d.data().best | 0;
        if (d.exists && (d.data().best | 0) === best && d.data().name === name && (d.data().world | 0) === world) return false;
        return ref.set({ name: String(name).slice(0, 16) || 'Pilot', best: best, world: world, t: TS() }).then(function () { return true; });
      });
    },
    top: function (n) {
      return db.collection('scores').orderBy('best', 'desc').limit(n || 50).get().then(function (q) {
        var out = []; q.forEach(function (d) { var x = d.data(); out.push({ uid: d.id, name: x.name, best: x.best, world: x.world }); }); return out;
      });
    },
    rank: function () {
      if (!cur) return Promise.resolve(null);
      return db.collection('scores').doc(cur.uid).get().then(function (d) {
        if (!d.exists) return null; var x = d.data();
        return db.collection('scores').where('best', '>', x.best | 0).limit(5000).get().then(function (q) {
          return { uid: cur.uid, name: x.name, best: x.best, world: x.world, place: q.size + 1 };
        });
      });
    },

    /* ---------- чат ---------- */
    heartbeat: function (name, best, world) {
      if (!cur) return Promise.resolve(false);
      return db.collection('profiles').doc(cur.uid).set({ name: String(name || 'Pilot').slice(0, 16) || 'Pilot', best: Math.max(0, Math.min(99999999, Math.round(best) | 0)), world: Math.max(1, Math.min(100, world | 0)), seen: TS() }, { merge: true }).then(function () { return true; });
    },
    players: function (n) {
      return db.collection('profiles').orderBy('seen', 'desc').limit(n || 100).get().then(function (q) {
        var out = []; q.forEach(function (d) { var x = d.data(); out.push({ uid: d.id, name: x.name, best: x.best | 0, world: x.world | 0, seen: x.seen && x.seen.toMillis ? x.seen.toMillis() : 0 }); }); return out;
      });
    },
    myBlocked: function () {
      if (!cur) return Promise.resolve([]);
      return db.collection('profiles').doc(cur.uid).get().then(function (d) { return d.exists && Array.isArray(d.data().blocked) ? d.data().blocked : []; });
    },
    block: function (uid, on) {
      if (!cur) return Promise.resolve(false);
      var F = firebase.firestore.FieldValue;
      return db.collection('profiles').doc(cur.uid).set({ blocked: on === false ? F.arrayRemove(uid) : F.arrayUnion(uid) }, { merge: true });
    },
    chatId: function (a, b) { return a < b ? a + '_' + b : b + '_' + a; },
    listenChats: function (cb) {
      if (!cur) return function () {};
      return db.collection('chats').where('members', 'array-contains', cur.uid).onSnapshot(function (q) {
        var out = []; q.forEach(function (d) { var x = d.data(); out.push({ id: d.id, members: x.members || [], names: x.names || {}, last: x.last || '', lastFrom: x.lastFrom || '', lastAt: x.lastAt && x.lastAt.toMillis ? x.lastAt.toMillis() : Date.now(), unread: (x.unread && x.unread[cur.uid]) | 0 }); });
        out.sort(function (a, b) { return b.lastAt - a.lastAt; }); cb(out);
      }, function () { cb(null); });
    },
    openChat: function (other, otherName, myName) {
      if (!cur || other === cur.uid) return Promise.reject(new Error('self'));
      var id = window.ZBFB.chatId(cur.uid, other), ref = db.collection('chats').doc(id);
      return ref.get().then(function (d) {
        if (d.exists) return id;
        var names = {}; names[cur.uid] = String(myName || 'Pilot').slice(0, 16); names[other] = String(otherName || 'Pilot').slice(0, 16);
        var unread = {}; unread[cur.uid] = 0; unread[other] = 0;
        return ref.set({ members: [cur.uid, other].sort(), names: names, last: '', lastFrom: '', lastAt: TS(), unread: unread }).then(function () { return id; });
      }).catch(function (e) { if (e && e.code === 'permission-denied') return id; throw e; });
    },
    listenMsgs: function (id, cb) {
      return db.collection('chats').doc(id).collection('msgs').orderBy('at').limitToLast(100).onSnapshot(function (q) {
        var out = []; q.forEach(function (d) { var x = d.data(); out.push({ id: d.id, from: x.from, text: x.text, rt: x.rt || '', rf: x.rf || '', inv: x.inv || '', at: x.at && x.at.toMillis ? x.at.toMillis() : Date.now() }); }); cb(out);
      }, function () { cb(null); });
    },
    send: function (id, to, text, reply, inv) {
      if (!cur) return Promise.reject(new Error('auth'));
      text = String(text).slice(0, 300);
      var ch = db.collection('chats').doc(id), b = db.batch(), upd = { last: text.slice(0, 80), lastFrom: cur.uid, lastAt: TS() };
      upd['unread.' + to] = firebase.firestore.FieldValue.increment(1);
      var m = { from: cur.uid, to: to, text: text, at: TS() };
      if (reply && reply.text) { m.rt = String(reply.text).slice(0, 100); m.rf = String(reply.from || ''); }
      if (inv) m.inv = String(inv).slice(0, 20);
      b.set(ch.collection('msgs').doc(), m);
      b.update(ch, upd);
      return b.commit();
    },
    delMsg: function (id, mid) { return db.collection('chats').doc(id).collection('msgs').doc(mid).delete(); },
    markRead: function (id) {
      if (!cur) return Promise.resolve();
      var u = {}; u['unread.' + cur.uid] = 0;
      return db.collection('chats').doc(id).update(u).catch(function () {});
    },
    report: function (about, id, text, kind) {
      if (!cur) return Promise.reject(new Error('auth'));
      return db.collection('reports').add({ from: cur.uid, about: String(about), chat: String(id || ''), text: String(text || '').slice(0, 1500), kind: String(kind || 'user').slice(0, 20), at: TS() });
    },
    reports: function () {
      return db.collection('reports').orderBy('at', 'desc').limit(50).get().then(function (q) { var out = []; q.forEach(function (d) { var x = d.data(); out.push({ id: d.id, from: x.from, about: x.about, chat: x.chat, text: x.text, kind: x.kind || 'user', at: x.at && x.at.toMillis ? x.at.toMillis() : 0 }); }); return out; });
    },
    listenReports: function (cb) {
      return db.collection('reports').orderBy('at', 'desc').limit(50).onSnapshot(function (q) { var out = []; q.forEach(function (d) { var x = d.data(); out.push({ id: d.id, from: x.from, about: x.about, chat: x.chat, text: x.text, kind: x.kind || 'user', at: x.at && x.at.toMillis ? x.at.toMillis() : Date.now() }); }); cb(out); }, function () { cb(null); });
    },
    delReport: function (id) { return db.collection('reports').doc(id).delete(); },
    ban: function (uid, on) { var r = db.collection('bans').doc(uid); return on === false ? r.delete() : r.set({ at: TS() }); },
    isBanned: function (uid) { return db.collection('bans').doc(uid || (cur && cur.uid)).get().then(function (d) { return d.exists; }).catch(function () { return false; }); },
    del: function (uid) { return db.collection('scores').doc(uid).delete(); }
  };
})();
