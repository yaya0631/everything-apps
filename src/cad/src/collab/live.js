/**
 * A live editing session for one server drawing (see cad-home/lib/live.js).
 *
 * The session owns the connection: hello and resume, the queue of local ops
 * waiting for the server, id leases, presence and reconnecting. The app
 * listens for events:
 *   snapshot(data, { reason })   load this drawing (first open, after a restart or restore)
 *   status(status)               'connecting' | 'live' | 'saving' | 'reconnecting' | 'closed'
 *   peers(list)                  other people in the drawing
 *   presence(peer)               someone moved their cursor or selection
 *   mode(mode)                   'edit' | 'view'
 *   saved({ seq })               the server wrote the file
 *   serverError({ code, message })
 *   closed(reason)               the server ended the session (deleted, revoked, access_removed, shutdown)
 *   failed(message)              could not join at all
 */
import { recordsToOps, opKeys, filterPending, orderDigest } from './ops.js';

const LOW_IDS = 1000;
const PRESENCE_MS = 50;
const MAX_BACKOFF = 10_000;

const randomId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export class LiveSession {
  /**
   * url: ws(s)://… endpoint. createSocket(url) defaults to new WebSocket(url).
   * name/color: shown to others (only used for link guests).
   */
  constructor({ url, name = null, color = null, createSocket = (u) => new WebSocket(u) }) {
    this.url = url;
    this.name = name;
    this.color = color;
    this.createSocket = createSocket;
    this.client = randomId();
    this.handlers = new Map();
    this.drawing = null;
    this.ws = null;
    this.instance = null;
    this.seq = 0;
    this.savedSeq = 0;
    this.cseq = 0;
    /** Local batches not yet written to disk by the server: { cseq, ops, seq } (seq once acked). */
    this.outbox = [];
    /** Unacknowledged local op keys → count. */
    this.pending = new Map();
    this.ranges = [];
    this.askedIds = false;
    this.usedMax = 0;
    this.peers = new Map();
    this.you = null;
    this.mode = 'edit';
    this.status = 'connecting';
    this.welcomed = false;
    this.everJoined = false;
    this.failures = 0;
    this.closedReason = null;
    this.saveError = false;
    this._presence = null;
    this._presenceTimer = null;
    this._retryTimer = null;
    this._discardLocal = false;
    this._forceSnapshot = false;
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
    return () => this.handlers.get(event)?.delete(fn);
  }

  emit(event, ...args) {
    for (const fn of this.handlers.get(event) || []) {
      try {
        fn(...args);
      } catch (err) {
        console.error(err);
      }
    }
  }

  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit('status', s);
  }

  /** Start following this drawing's local edits. */
  attach(drawing) {
    if (this.drawing && this.drawing !== drawing) this.detach();
    this.drawing = drawing;
    drawing.live = true;
    drawing.readOnly = this.mode === 'view';
    drawing.idSource = () => this.nextId();
    drawing.opsListener = (entries) => this.local(recordsToOps(entries));
  }

  detach() {
    const d = this.drawing;
    if (!d) return;
    d.opsListener = null;
    d.idSource = null;
    d.live = false;
    d.readOnly = false;
    this.drawing = null;
  }

  connect() {
    this.closedReason = null;
    clearTimeout(this._retryTimer);
    let ws;
    try {
      ws = this.createSocket(this.url);
    } catch (err) {
      return this.retry(err);
    }
    this.ws = ws;
    this.welcomed = false;
    ws.onopen = () => {
      const hello = { t: 'hello', client: this.client, usedMax: this.usedMax };
      if (this.name) hello.name = this.name;
      if (this.color) hello.color = this.color;
      if (this.instance && !this._discardLocal && !this._forceSnapshot) hello.resume = { instance: this.instance, seq: this.seq };
      this._forceSnapshot = false;
      ws.send(JSON.stringify(hello));
    };
    ws.onmessage = (e) => {
      let msg;
      try {
        msg = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data));
      } catch {
        return;
      }
      this.receive(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.welcomed = false;
      if (this.closedReason) return;
      this.retry();
    };
    ws.onerror = () => {};
  }

  retry() {
    if (this.closedReason) return;
    this.failures++;
    if (!this.everJoined && this.failures >= 3) {
      this.closedReason = 'failed';
      this.setStatus('closed');
      this.emit('failed', this._lastError || 'Could not open this drawing for live editing.');
      return;
    }
    this.setStatus('reconnecting');
    const delay = Math.min(MAX_BACKOFF, 500 * 2 ** Math.min(this.failures - 1, 5));
    this._retryTimer = setTimeout(() => this.connect(), delay);
  }

  /** Leave for good. */
  close() {
    this.closedReason = 'left';
    clearTimeout(this._retryTimer);
    clearTimeout(this._presenceTimer);
    const ws = this.ws;
    this.ws = null;
    try {
      ws?.close(1000, 'left');
    } catch {
      /* already closed */
    }
    this.detach();
    this.setStatus('closed');
  }

  send(msg) {
    if (this.ws && this.welcomed && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  // Local edits ---------------------------------------------------------------------

  local(ops) {
    if (!ops.length) return;
    for (const op of ops) if (op.k === 'ent' && op.id > this.usedMax) this.usedMax = op.id;
    const batch = { cseq: ++this.cseq, ops, seq: null };
    this.outbox.push(batch);
    this.addPending(ops);
    this.send({ t: 'ops', cseq: batch.cseq, ops });
    this.updateStatus();
  }

  addPending(ops) {
    for (const op of ops) for (const k of opKeys(op)) this.pending.set(k, (this.pending.get(k) || 0) + 1);
  }

  removePending(ops) {
    for (const op of ops)
      for (const k of opKeys(op)) {
        const n = (this.pending.get(k) || 1) - 1;
        if (n > 0) this.pending.set(k, n);
        else this.pending.delete(k);
      }
  }

  /** Ask the server to write the file now. */
  flush() {
    this.send({ t: 'flush' });
  }

  /** Throttled to 20 updates a second. */
  presence(cursor, sel) {
    this._presence = { t: 'presence', cursor: cursor ? { x: cursor.x, y: cursor.y } : null, sel: (sel || []).slice(0, 500) };
    if (this._presenceTimer) return;
    this._presenceTimer = setTimeout(() => {
      this._presenceTimer = null;
      if (this._presence) this.send(this._presence);
      this._presence = null;
    }, PRESENCE_MS);
  }

  nextId() {
    while (this.ranges.length && this.ranges[0][0] >= this.ranges[0][1]) this.ranges.shift();
    const left = this.ranges.reduce((n, r) => n + (r[1] - r[0]), 0);
    if (left < LOW_IDS && !this.askedIds && this.send({ t: 'ids' })) this.askedIds = true;
    if (!this.ranges.length) {
      // Out of leased ids (a huge paste while offline): ids this far up never collide in practice.
      const id = 2 ** 40 + Math.floor(Math.random() * 2 ** 40);
      this.usedMax = Math.max(this.usedMax, id);
      return id;
    }
    const id = this.ranges[0][0]++;
    if (id > this.usedMax) this.usedMax = id;
    return id;
  }

  get unsaved() {
    return this.outbox.length > 0;
  }

  updateStatus() {
    if (this.closedReason) return;
    if (!this.welcomed) return this.setStatus(this.everJoined ? 'reconnecting' : 'connecting');
    this.setStatus(this.outbox.length ? 'saving' : 'live');
  }

  // Server messages ---------------------------------------------------------------------

  receive(msg) {
    switch (msg.t) {
      case 'welcome':
        return this.onWelcome(msg);
      case 'ack': {
        const b = this.outbox.find((x) => x.cseq === msg.cseq && x.seq === null);
        if (b) {
          b.seq = msg.seq;
          this.removePending(b.ops);
        }
        this.seq = msg.seq;
        return this.updateStatus();
      }
      case 'remote':
        this.seq = msg.seq;
        return this.applyRemote(msg.ops);
      case 'saved': {
        this.savedSeq = Math.max(this.savedSeq, msg.seq);
        this.outbox = this.outbox.filter((b) => b.seq === null || b.seq > this.savedSeq);
        if (this.saveError) {
          this.saveError = false;
          this.emit('serverError', { code: 'save_ok' });
        }
        if (!this.pending.size && !this.outbox.some((b) => b.seq === null) && msg.seq === this.seq && this.drawing && orderDigest([...this.drawing.entities.keys()]) !== msg.orderDigest) {
          this.send({ t: 'getOrder' });
        }
        this.updateStatus();
        return this.emit('saved', { seq: msg.seq });
      }
      case 'order':
        if (msg.seq === this.seq && !this.pending.size && this.drawing) this.drawing.setOrder(msg.ids);
        return;
      case 'idRange':
        this.askedIds = false;
        this.ranges.push(msg.range);
        return;
      case 'presence': {
        const p = this.peers.get(msg.cid);
        if (!p) return;
        p.cursor = msg.cursor;
        p.sel = msg.sel;
        return this.emit('presence', p);
      }
      case 'join':
        this.peers.set(msg.peer.cid, msg.peer);
        return this.emit('peers', [...this.peers.values()]);
      case 'leave':
        this.peers.delete(msg.cid);
        return this.emit('peers', [...this.peers.values()]);
      case 'mode':
        this.mode = msg.mode;
        if (this.drawing) this.drawing.readOnly = msg.mode === 'view';
        return this.emit('mode', msg.mode);
      case 'denied':
      case 'reject':
        return this.dropBatch(msg.cseq, msg.t === 'denied' ? msg.message || 'This drawing is view-only for you.' : 'The server could not use a change.');
      case 'error':
        if (msg.code === 'save_failed') {
          this.saveError = true;
          return this.emit('serverError', msg);
        }
        if (msg.code === 'save_ok') {
          this.saveError = false;
          return this.emit('serverError', msg);
        }
        this._lastError = msg.message;
        if (!this.everJoined) {
          this.closedReason = 'failed';
          this.setStatus('closed');
          try {
            this.ws?.close();
          } catch {
            /* ignore */
          }
          return this.emit('failed', msg.message || 'Could not open this drawing for live editing.');
        }
        return this.emit('serverError', msg);
      case 'closed':
        if (msg.reason === 'restored') {
          // Someone restored an earlier version: start again from it.
          this._discardLocal = true;
          return;
        }
        this.closedReason = msg.reason;
        this.setStatus('closed');
        return this.emit('closed', msg.reason);
    }
  }

  onWelcome(msg) {
    const first = !this.everJoined;
    const sameInstance = this.instance === msg.instance;
    this.welcomed = true;
    this.everJoined = true;
    this.failures = 0;
    this.you = msg.you;
    this.mode = msg.you.mode;
    this.ranges = [msg.idRange];
    this.askedIds = false;
    this.peers = new Map(msg.peers.map((p) => [p.cid, p]));
    this.instance = msg.instance;
    const reason = this._discardLocal ? 'restored' : first ? 'open' : 'resync';
    if (this._discardLocal) {
      this.outbox = [];
      this.pending.clear();
      this._discardLocal = false;
    }
    if (msg.snapshot) {
      // Same server instance: everything it acknowledged is in the snapshot.
      // A restarted server only has what it wrote to disk, and batches it
      // confirmed writing were already dropped on 'saved', so resend the rest.
      if (sameInstance) this.outbox = this.outbox.filter((b) => b.seq === null);
      if (this.mode === 'view') this.outbox = [];
      this.seq = msg.seq;
      this.savedSeq = msg.savedSeq ?? 0;
      this.pending.clear();
      this.emit('snapshot', msg.snapshot, { reason });
      if (this.drawing) this.drawing.readOnly = this.mode === 'view';
      for (const b of this.outbox) {
        b.seq = null;
        this.drawing?.applyRemote(b.ops);
        this.addPending(b.ops);
      }
    } else {
      for (const b of msg.replay || []) {
        this.seq = b.seq;
        if (b.client === this.client) {
          const mine = this.outbox.find((x) => x.cseq === b.cseq && x.seq === null);
          if (mine) {
            mine.seq = b.seq;
            this.removePending(mine.ops);
          }
          continue;
        }
        this.applyRemote(b.ops);
      }
      this.seq = msg.seq;
    }
    for (const b of this.outbox) if (b.seq === null) this.ws.send(JSON.stringify({ t: 'ops', cseq: b.cseq, ops: b.ops }));
    this.emit('mode', this.mode);
    this.emit('peers', [...this.peers.values()]);
    this.updateStatus();
  }

  applyRemote(ops) {
    if (!this.drawing) return;
    const use = filterPending(ops, this.pending);
    if (use.length) this.drawing.applyRemote(use);
  }

  dropBatch(cseq, message) {
    const i = this.outbox.findIndex((b) => b.cseq === cseq);
    if (i >= 0) {
      this.removePending(this.outbox[i].ops);
      this.outbox.splice(i, 1);
    }
    this.emit('serverError', { code: 'denied', message });
    // That change exists only here: reload the server's copy so this drawing matches everyone else's.
    this._forceSnapshot = true;
    try {
      this.ws?.close(4000, 'resync');
    } catch {
      /* ignore */
    }
  }
}
