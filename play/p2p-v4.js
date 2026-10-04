/* Zvezdoboy P2P room: the same calls the game uses from claude.ai `room`
   (presence, peers, onPeers, join, leave), built on WebRTC via PeerJS.
   Star topology: the first player in a room becomes its hub and relays
   presence to everyone; if the hub leaves, someone else takes over. */
(function () {
  'use strict';
  var PREFIX = 'zvezdoboy-v1-';
  function cfg() {
    var c = window.ZB_P2P || {};
    var o = { debug: 0, config: { iceServers: c.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:global.stun.twilio.com:3478' }, { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp'], username: 'openrelayproject', credential: 'openrelayproject' }] } };
    if (c.host) { o.host = c.host; o.port = c.port; o.path = c.path || '/'; o.secure = !!c.secure; o.key = c.key || 'peerjs'; }
    return o;
  }
  function rid() { return PREFIX + 'p-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); }
  function freeze(o) { try { return Object.freeze(o); } catch (e) { return o; } }

  function Room(name) {
    this.name = name; this.hubId = PREFIX + name.replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
    this.me = null; this.myId = null; this.hubPeer = null; this.isHub = false;
    this.conns = {};        // hub: peerId -> DataConnection
    this.toHub = null;      // client: DataConnection to hub
    this.state = {};        // id -> {presence, updatedAt}
    this.myPresence = {};
    this.snap = freeze([]); this.prevMap = {};
    this.listeners = []; this.msgL = []; this.voiceL = []; this._vstream = null; this._calls = []; this.closed = false; this.dirty = false;
  }
  Room.prototype._emitPeers = function () {
    var self = this, ids = Object.keys(this.state), list = [], map = {}, joined = [], left = [], updated = [];
    ids.forEach(function (id) {
      var s = self.state[id], prev = self.prevMap[id];
      var p = prev && prev.presence === s.presence ? prev : freeze({ peer: id, by: null, isMe: id === self.myId, sameTab: id === self.myId, kind: 'viewer', guest: false, presence: s.presence, updatedAt: s.updatedAt });
      list.push(p); map[id] = p;
      if (!prev) joined.push(p); else if (prev !== p) updated.push(p);
    });
    Object.keys(this.prevMap).forEach(function (id) { if (!map[id]) left.push(self.prevMap[id]); });
    this.prevMap = map; this.snap = freeze(list);
    if (!joined.length && !left.length && !updated.length) return;
    var ch = { peers: this.snap, joined: joined, left: left, updated: updated };
    this.listeners.slice().forEach(function (l) { try { l.cb(ch); } catch (e) { console.error(e); } });
  };
  Room.prototype._setState = function (all) {
    var now = Date.now(), self = this, next = {};
    Object.keys(all).forEach(function (id) {
      var old = self.state[id], pres = all[id];
      if (old && JSON.stringify(old.presence) === JSON.stringify(pres)) next[id] = old;
      else next[id] = { presence: freeze(pres || {}), updatedAt: now };
    });
    this.state = next; this._emitPeers();
  };
  // ---------- hub side
  Room.prototype._msg = function (d, from) { this.msgL.slice().forEach(function (f) { try { f(d, from); } catch (e) { console.error(e); } }); };
  Room.prototype._hubBroadcast = function () {
    var self = this; if (this._bcT) return;
    this._bcT = setTimeout(function () {
      self._bcT = null; var all = {};
      Object.keys(self.state).forEach(function (id) { all[id] = self.state[id].presence; });
      var msg = { t: 'all', all: all, hub: self.myId };
      Object.keys(self.conns).forEach(function (id) { var c = self.conns[id]; if (c.open) try { c.send(msg); } catch (e) {} });
    }, 33);
  };
  Room.prototype._hubSet = function (id, pres) {
    var cur = {}; var s = this.state; var all = {};
    Object.keys(s).forEach(function (k) { all[k] = s[k].presence; });
    if (pres === null) delete all[id]; else all[id] = pres;
    this._setState(all); this._hubBroadcast();
  };
  Room.prototype._becomeHub = function () {
    var self = this;
    return new Promise(function (res, rej) {
      var hp = new Peer(self.hubId, cfg()), done = false;
      hp.on('open', function () {
        done = true; self.hubPeer = hp; self.isHub = true; self.state = {};
        // Hub keeps its own player entry under its player id.
        self._hubSet(self.myId, self.myPresence);
        hp.on('connection', function (c) {
          c.on('open', function () { self.conns[c.peer] = c; c.send({ t: 'hello', you: c.peer }); self._hubBroadcast(); });
          c.on('data', function (d) {
            if (!d || typeof d !== 'object') return;
            if (d.t === 'bye') { if (self.conns[c.peer] === c) { delete self.conns[c.peer]; self._hubSet(c.peer, null); } try { c.close(); } catch (e) {} return; }
            if (d.t === 'm') { self._msg(d.d, c.peer); var fw = { t: 'm', f: c.peer, d: d.d }; Object.keys(self.conns).forEach(function (id) { var o = self.conns[id]; if (o !== c && o.open) try { o.send(fw); } catch (e) {} }); return; }
            if (d.t === 'p' && d.p && typeof d.p === 'object') { var js = JSON.stringify(d.p); if (js.length < 6000) self._hubSet(c.peer, d.p); }
          });
          var gone = function () { if (self.conns[c.peer] === c) { delete self.conns[c.peer]; self._hubSet(c.peer, null); } };
          c.on('close', gone); c.on('error', gone);
        });
        hp.on('call', function (c) { self._takeCall(c, true); });
        hp.on('disconnected', function () { try { hp.reconnect(); } catch (e) {} });
        self._ka = setInterval(function () { self._hubBroadcast(); }, 1000);
        res(true);
      });
      hp.on('error', function (e) { if (!done) { done = true; try { hp.destroy(); } catch (x) {} rej(e); } });
    });
  };
  // ---------- client side
  Room.prototype._connectHub = function () {
    var self = this;
    return new Promise(function (res, rej) {
      var c = self.me.connect(self.hubId, { reliable: true, serialization: 'json' }), done = false;
      var to = setTimeout(function () { if (!done) { done = true; try { c.close(); } catch (e) {} rej(new Error('timeout')); } }, 3500);
      c.on('open', function () { done = true; clearTimeout(to); self.toHub = c; self.isHub = false; self._last = Date.now(); c.send({ t: 'p', p: self.myPresence });
        if (!self._wd) self._wd = setInterval(function () { if (self.closed) return; if (self.toHub && Date.now() - (self._last || 0) > 4000) { var old = self.toHub; self.toHub = null; try { old.close(); } catch (e) {} self._dropHub(); self._recover(); } }, 1000);
        res(true); });
      c.on('data', function (d) { self._last = Date.now(); if (d && d.t === 'm') { self._msg(d.d, d.f); return; } if (d && d.t === 'all' && d.all) { self.hubPlayer = d.hub; self._setState(d.all); } else if (d && d.t === 'byehub') { try { c.close(); } catch (e) {} lost(); } });
      var lost = function () { if (self.toHub === c) { self.toHub = null; self._dropHub(); if (!self.closed) self._recover(); } };
      c.on('close', lost); c.on('error', function (e) { if (!done) { done = true; clearTimeout(to); rej(e); } else lost(); });
      self._peerErr = function (e) { if (!done && e && e.type === 'peer-unavailable') { done = true; clearTimeout(to); rej(e); } };
    });
  };
  Room.prototype._link = function () {
    var self = this;
    // Try to join an existing hub, otherwise become the hub. Retry on races.
    var attempt = function (n) {
      return self._connectHub().catch(function () {
        return self._becomeHub().catch(function (e) {
          if (n > 3) throw e;
          return new Promise(function (r) { setTimeout(r, 300 + Math.random() * 700); }).then(function () { return attempt(n + 1); });
        });
      });
    };
    return attempt(0);
  };
  Room.prototype._clientLink = function () {
    var self = this;
    var attempt = function (n) {
      return self._connectHub().catch(function (e) {
        if (n >= 1) { var er = new Error('host-unreachable'); er.type = (e && e.type) || 'host-unreachable'; throw er; }
        return new Promise(function (r) { setTimeout(r, 700); }).then(function () { return attempt(n + 1); });
      });
    };
    return attempt(0);
  };
  Room.prototype._takeCall = function (c, answer) {
    var self = this; self._calls.push(c);
    if (answer) { try { c.answer(self._vstream || undefined); } catch (e) {} }
    c.on('stream', function (st) { self.voiceL.slice().forEach(function (f) { try { f(st, c.peer); } catch (e) {} }); });
    var gone = function () { var i = self._calls.indexOf(c); if (i >= 0) self._calls.splice(i, 1); };
    c.on('close', gone); c.on('error', gone);
  };
  Room.prototype._dropHub = function () {
    var h = this.hubPlayer; if (!h || h === this.myId || !this.state[h]) return;
    var a = {}, s = this.state; Object.keys(s).forEach(function (k) { if (k !== h) a[k] = s[k].presence; }); this._setState(a);
  };
  Room.prototype._recover = function () {
    var self = this; if (this._rec) return; this._rec = true;
    // Drop the old hub from the list, then relink after a random pause.
    setTimeout(function () {
      self._link().then(function () { self._rec = false; }).catch(function () { self._rec = false; self._fail('disconnected'); });
    }, 200 + Math.random() * 900);
  };
  Room.prototype._fail = function (code) {
    this.listeners.slice().forEach(function (l) { if (l.err) try { l.err({ code: code, message: code }); } catch (e) {} });
  };
  Room.prototype.open = function (hubFirst) {
    var self = this;
    return new Promise(function (res, rej) {
      if (typeof Peer !== 'function') { rej(new Error('no peerjs')); return; }
      var me = new Peer(rid(), cfg()), ok = false;
      var t = setTimeout(function () { if (!ok) { try { me.destroy(); } catch (e) {} rej(new Error('signal timeout')); } }, 9000);
      me.on('open', function (id) {
        ok = true; clearTimeout(t); self.me = me; self.myId = id;
        self._setState((function () { var a = {}; a[id] = self.myPresence; return a; })());
        (hubFirst === 'client' ? self._clientLink() : hubFirst ? self._becomeHub().catch(function () { return self._link(); }) : self._link()).then(function () { res(self.api()); }).catch(rej);
      });
      me.on('error', function (e) { if (self._peerErr) self._peerErr(e); if (!ok) { ok = true; clearTimeout(t); rej(e); } });
      me.on('disconnected', function () { try { me.reconnect(); } catch (e) {} });
    });
  };
  Room.prototype.api = function () {
    var self = this;
    return {
      presence: function (patch) {
        var m = {}; Object.keys(self.myPresence).forEach(function (k) { m[k] = self.myPresence[k]; });
        Object.keys(patch || {}).forEach(function (k) { if (patch[k] === null) delete m[k]; else m[k] = patch[k]; });
        self.myPresence = m;
        if (self.isHub) self._hubSet(self.myId, m);
        else {
          var a = {}; Object.keys(self.state).forEach(function (k) { a[k] = self.state[k].presence; }); a[self.myId] = m; self._setState(a);
          if (!self._sendT) self._sendT = setTimeout(function () { self._sendT = null; if (self.toHub && self.toHub.open) try { self.toHub.send({ t: 'p', p: self.myPresence }); } catch (e) {} }, 30);
        }
        return Promise.resolve();
      },
      peers: function () { return self.snap; },
      onPeers: function (cb, err) {
        var l = { cb: cb, err: err }; self.listeners.push(l);
        Promise.resolve().then(function () { try { cb({ peers: self.snap, joined: self.snap, left: [], updated: [] }); } catch (e) {} });
        return function () { var i = self.listeners.indexOf(l); if (i >= 0) self.listeners.splice(i, 1); };
      },
      emit: function () { return Promise.resolve(); },
      send: function (d) {
        if (self.isHub) { var m = { t: 'm', f: self.myId, d: d }; Object.keys(self.conns).forEach(function (id) { var c = self.conns[id]; if (c.open) try { c.send(m); } catch (e) {} }); }
        else if (self.toHub && self.toHub.open) { try { self.toHub.send({ t: 'm', d: d }); } catch (e) {} }
      },
      voice: function (stream) {
        self._vstream = stream;
        if (!self.isHub && self.me && !self._calls.length) { try { var c = self.me.call(self.hubId, stream); if (c) self._takeCall(c, false); } catch (e) {} }
        return true;
      },
      voiceTrack: function (track) {
        self._calls.forEach(function (c) { try { var pc = c.peerConnection; if (!pc) return; pc.getSenders().forEach(function (sd) { if (sd.track && sd.track.kind === 'audio' || !sd.track) { try { sd.replaceTrack(track); } catch (e) {} } }); } catch (e) {} });
      },
      onVoice: function (cb) { self.voiceL.push(cb); return function () { var i = self.voiceL.indexOf(cb); if (i >= 0) self.voiceL.splice(i, 1); }; },
      voiceStop: function () { self._calls.slice().forEach(function (c) { try { c.close(); } catch (e) {} }); self._calls = []; self._vstream = null; },
      onMsg: function (cb) { self.msgL.push(cb); return function () { var i = self.msgL.indexOf(cb); if (i >= 0) self.msgL.splice(i, 1); }; },
      on: function () { return function () {}; },
      connected: function () { return !!(self.isHub || (self.toHub && self.toHub.open)); },
      join: function (name) { return new Room(String(name)).open(); },
      leave: function () {
        self.closed = true; clearInterval(self._ka); clearInterval(self._wd);
        try { if (self.toHub && self.toHub.open) self.toHub.send({ t: 'bye' }); } catch (e) {}
        Object.keys(self.conns).forEach(function (k) { try { self.conns[k].send({ t: 'byehub' }); } catch (e) {} });
        return new Promise(function (r) { setTimeout(r, 120); }).then(function () {
        try { if (self.toHub) self.toHub.close(); } catch (e) {}
        Object.keys(self.conns).forEach(function (k) { try { self.conns[k].close(); } catch (e) {} });
        self._calls.forEach(function (c) { try { c.close(); } catch (e) {} }); self._calls = [];
        try { if (self.hubPeer) self.hubPeer.destroy(); } catch (e) {}
        try { if (self.me) self.me.destroy(); } catch (e) {}
        self.listeners = [];
        });
      }
    };
  };
  window.ZBP2P = { lobby: function () { return new Room('lobby').open(); }, join: function (n) { return new Room(String(n)).open(); }, connect: function (n) { return new Room(String(n)).open('client'); }, create: function (n) { return new Room(String(n)).open(true); } };
})();
