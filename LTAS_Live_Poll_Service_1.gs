/**
 * LTAS Workshop — live poll service
 * Dr Zouhaier Slimi · NU / International Maritime College Oman
 *
 * WHAT THIS IS
 * A tiny web service that holds the votes for the workshop deck. Attendees tap an
 * answer on their phone, this script records it, and the presenter's screen reads
 * the totals back every 1.6 seconds. It runs inside your own Google account — no
 * third-party service, no cost, nothing to maintain afterwards.
 *
 * SET IT UP (about five minutes, once)
 *   1. Go to  https://script.google.com  and click  New project.
 *   2. Delete whatever is in the editor and paste this whole file in.
 *   3. Click the project name (top left) and rename it, e.g. "LTAS Live Poll".
 *   4. Click  Deploy  ▸  New deployment.
 *   5. Click the gear next to "Select type" and choose  Web app.
 *   6. Set:   Execute as        →  Me (your address)
 *             Who has access    →  Anyone
 *      ("Anyone" is required — attendees are not signed in to your account.)
 *   7. Click  Deploy, then  Authorize access  and allow it. Google will warn that
 *      the app is not verified: choose  Advanced  ▸  Go to LTAS Live Poll (unsafe).
 *      That warning is normal for your own scripts.
 *   8. Copy the  Web app URL. It ends in  /exec.
 *
 * USE IT IN THE DECK
 *   Open the deck, press  L  (or click the "Local" chip in the bottom bar),
 *   paste the /exec URL, set a room code (e.g. C104) and press  Go live.
 *   The chip turns green, and the QR codes on the first and last slides now carry
 *   both the deck link and the poll room — one scan and attendees are voting.
 *
 * BEFORE THE SESSION
 *   Press  L  ▸  Go live, then clear each question with its Clear button so you
 *   start the room at zero.
 *
 * PRIVACY
 *   Only counts are stored: a room code, a question id, and a per-device random id
 *   used solely to stop double-voting. No names, no emails, no IP addresses, no
 *   answers tied to a person. Delete the deployment after the workshop and the
 *   data goes with it.
 *
 * IF YOU EDIT THIS FILE LATER
 *   Deploy ▸ Manage deployments ▸ pencil ▸ Version: New version ▸ Deploy.
 *   Editing without re-deploying changes nothing.
 *
 * WHY VOTES MAY HAVE VANISHED BEFORE
 *   The first version of this file listed the deck's questions by name and threw
 *   away anything it did not recognise. If the deck gained a question and the
 *   script was not re-deployed, those votes were silently dropped. This version
 *   accepts whatever the deck sends, so that cannot happen again.
 */

// This service is deliberately schema-free: it accepts ANY question id the deck
// sends (letters, digits and underscore, up to 12 characters) with option numbers
// 0-9. That means you never have to re-deploy when the deck's questions change —
// the earlier version rejected unknown ids, which silently dropped votes.
var ID_RE = /^[A-Za-z0-9_]{1,12}$/;
var MAX_OPTIONS = 10;

// Keep the voter list from growing without bound during a long session.
var MAX_VOTERS = 4000;

function doGet(e) {
  var p = (e && e.parameter) || {};
  var callback = p.callback || 'callback';
  var out;
  try {
    out = handle(p);
  } catch (err) {
    out = { ok: 0, error: String(err) };
  }
  return ContentService
    .createTextOutput(callback + '(' + JSON.stringify(out) + ');')
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

// Some networks send a preflight-free POST; accept it the same way.
function doPost(e) {
  return doGet(e);
}

function handle(p) {
  var room = String(p.r || 'C104').toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 24) || 'C104';
  var action = String(p.a || 'poll');

  // 'poll' is by far the most frequent call and never writes — keep it lock-free.
  if (action === 'poll') {
    var snap = readRoom(room);
    return { ok: 1, cur: snap.cur, c: snap.c };
  }

  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(8000);
  } catch (err) {
    return { ok: 0, error: 'busy' };
  }

  try {
    var data = readRoom(room);

    if (action === 'vote') {
      var q = String(p.q || '');
      var o = parseInt(p.o, 10);
      var voter = String(p.v || '').slice(0, 40);
      if (!ID_RE.test(q)) return { ok: 0, error: 'bad question id' };
      if (!(o >= 0 && o < MAX_OPTIONS)) return { ok: 0, error: 'bad option' };
      if (!data.c[q]) data.c[q] = zeros(MAX_OPTIONS);

      var key = voter + '|' + q;
      if (voter && data.v[key]) {
        // Already answered this question on this device — ignore silently.
        return { ok: 1, duplicate: 1, cur: data.cur, c: data.c };
      }
      data.c[q][o] = (data.c[q][o] || 0) + 1;
      if (voter) {
        var ids = Object.keys(data.v);
        if (ids.length >= MAX_VOTERS) delete data.v[ids[0]];
        data.v[key] = 1;
      }
      writeRoom(room, data);
      return { ok: 1, recorded: 1, cur: data.cur, c: data.c };
    }

    if (action === 'state') {
      var cur = String(p.q || '');
      data.cur = ID_RE.test(cur) ? cur : null;
      writeRoom(room, data);
      return { ok: 1, cur: data.cur, c: data.c };
    }

    if (action === 'reset') {
      var rq = String(p.q || '');
      if (ID_RE.test(rq)) {
        data.c[rq] = zeros(MAX_OPTIONS);
        Object.keys(data.v).forEach(function (k) {
          if (k.slice(-(rq.length + 1)) === '|' + rq) delete data.v[k];
        });
        writeRoom(room, data);
      }
      return { ok: 1, cur: data.cur, c: data.c };
    }

    if (action === 'clearall') {
      var fresh = emptyRoom();
      fresh.cur = data.cur;
      writeRoom(room, fresh);
      return { ok: 1, cur: fresh.cur, c: fresh.c };
    }

    return { ok: 0, error: 'unknown action' };
  } finally {
    lock.releaseLock();
  }
}

function zeros(n) {
  var a = [];
  for (var i = 0; i < n; i++) a.push(0);
  return a;
}

function emptyRoom() {
  return { cur: null, c: {}, v: {} };
}

function readRoom(room) {
  var raw = PropertiesService.getScriptProperties().getProperty('ltas_' + room);
  if (!raw) return emptyRoom();
  var data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return emptyRoom();
  }
  data.c = data.c || {};
  Object.keys(data.c).forEach(function (q) {
    if (!Array.isArray(data.c[q])) data.c[q] = zeros(MAX_OPTIONS);
  });
  data.v = data.v || {};
  if (typeof data.cur === 'undefined') data.cur = null;
  return data;
}

function writeRoom(room, data) {
  PropertiesService.getScriptProperties()
    .setProperty('ltas_' + room, JSON.stringify(data));
}

/**
 * Run this from the editor (Run ▸ exportResults) to print every count for a room,
 * including the five evaluation questions, so you can paste them into a report.
 */
function exportResults() {
  var room = 'C104';
  var d = readRoom(room);
  Object.keys(d.c).sort().forEach(function (q) {
    var c = d.c[q], n = 0, sum = 0;
    c.forEach(function (v, i) { n += v; sum += v * (i + 1); });
    Logger.log(q + '  counts=' + c.join(',') + '  n=' + n +
      (q.charAt(0) === 'e' && n ? ('  mean=' + (sum / n).toFixed(2)) : ''));
  });
}

/** Run this from the editor (Run ▸ resetEverything) to wipe a room by hand. */
function resetEverything() {
  var room = 'C104';
  writeRoom(room, emptyRoom());
  Logger.log('Room ' + room + ' cleared.');
}
