// v4 - balance fixes.
//   * A new session with start/end balances now SETS the bookie balance to
//     its end balance (the real figure the operator read off the site),
//     provided nothing newer has touched that bookie. Previously only the
//     difference (end - start) was added, so any existing error carried on
//     forever. Sessions without balances still add their net result.
//   * Deleting a session no longer changes the bookie balance. Subtracting
//     it after the balance had been corrected is what produced the
//     "random -£200" style negatives. Verify the bookie if a deleted
//     session had wrong numbers.
//   * A session that was already deleted and gets re-sent by another
//     device is ignored completely (it used to add its result again).
//   * Each profile is locked while being read-modified-written, so this and
//     a sports save landing together can't overwrite each other.
// v3 notes:
// v3 - bandwidth diet + safer reads. Merge, tombstone and bookie-balance
// logic is unchanged from v2. What's different:
//   * kvGet now THROWS on a failed request. v2 returned null, which this
//     file then treated as "profile doesn't exist" and wrote back a blank
//     profile with only the incoming sessions in it - i.e. one failed read
//     (e.g. Upstash rejecting requests once the monthly bandwidth cap is hit)
//     could silently wipe a profile's bets and bookies. A failed read now
//     aborts the save with a 500 and nothing is written.
//   * Only profiles that actually carry sessions or deletions are read and
//     processed (the client can now send just the new session instead of
//     every session for every profile).
//   * A profile is only written back if the merge actually changed it.
//   * The edgetrack_me / edgetrack_wife safety-net read is skipped while
//     edgetrack_legacy_ok is fresh (it's refreshed daily by load-casino.js).
//   * Bumps edgetrack_rev_casino / edgetrack_rev_sports after a write so
//     load-casino.js / load-sports.js can answer "304 Not Modified".
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  
  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    const incoming = req.body || {};
    const profiles = ['jg', 'hg', 'bp', 'rq', 'wa'];
    const LEGACY_KEY_SUFFIX = { jg: 'me', hg: 'wife' };
    const LEGACY_RECHECK_MS = 24 * 60 * 60 * 1000;

    // Throws on a genuine failure so "request failed" is never mistaken for
    // "key doesn't exist".
    const kvGet = async (key) => {
      const r = await fetch(`${kvUrl}/get/${key}`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      if (!r.ok) throw new Error(`KV fetch failed for ${key}: ${r.status}`);
      const d = await r.json();
      if (!d.result) return null;
      let parsed = JSON.parse(d.result);
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
      return parsed;
    };

    // Same storage format as before (double-stringified) so every other
    // reader keeps working exactly as it does today.
    const kvSet = async (key, value) => {
      const r = await fetch(`${kvUrl}/set/${key}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(JSON.stringify(value))
      });
      if (!r.ok) throw new Error(`KV set error on ${key}: ${r.status}`);
    };
    // Tiny plain-number keys (rev counters, legacy flag).
    const kvSetNumber = async (key, n) => {
      const r = await fetch(`${kvUrl}/set/${key}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(n)
      });
      if (!r.ok) throw new Error(`KV set error on ${key}: ${r.status}`);
    };

    // ---- Per-profile write lock (Upstash SET NX PX) ----------------------
    const LOCK_TTL_MS = 8000;
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    const acquireLock = async (key) => {
      const token = Math.random().toString(36).slice(2);
      for (let i = 0; i < 40; i++) {
        try {
          const r = await fetch(`${kvUrl}/set/${key}/${token}/NX/PX/${LOCK_TTL_MS}`, {
            headers: { Authorization: `Bearer ${kvToken}` }
          });
          if (!r.ok) return null;
          const d = await r.json();
          if (d.result === 'OK') return key;
        } catch (e) { return null; }
        await sleep(100 + Math.random() * 150);
      }
      console.warn('lock wait timed out', key);
      return null;
    };
    const releaseLock = async (key) => {
      if (!key) return;
      try { await fetch(`${kvUrl}/del/${key}`, { headers: { Authorization: `Bearer ${kvToken}` } }); } catch (e) {}
    };
    const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

    const CASINO_NAME_RENAMES = {
      'hot streak casino': 'Hot Streak',
      'gala': 'Gala Casino',
      'bet st george': 'BetStGeorge',
      'betstgeorge': 'BetStGeorge',
      'grosvenor casinos': 'Grosvenor',
      'planet sports': 'Planet Sport Bet',
    };
    const normalizeCasinoField = (s) => {
      if (!s.casino) return s;
      const canonical = CASINO_NAME_RENAMES[s.casino.toLowerCase()];
      return canonical && canonical !== s.casino ? { ...s, casino: canonical } : s;
    };

    const legacyCheckedAt = await kvGet('edgetrack_legacy_ok');
    const legacyFresh = typeof legacyCheckedAt === 'number' &&
      (Date.now() - legacyCheckedAt) >= 0 && (Date.now() - legacyCheckedAt) < LEGACY_RECHECK_MS;

    const work = profiles.filter(pr =>
      incoming[pr] &&
      ((incoming[pr].casino || []).length > 0 || (incoming[pr].deletedIds || []).length > 0)
    );

    let anyWritten = false;

    await Promise.all(work.map(async pr => {
      const sportKey = `edgetrack_${pr}`;
      const lock = await acquireLock(`edgetrack_lock_${pr}`);
      try {
      const existing = await kvGet(sportKey);
      let sportsData = existing || { bank: 0, bookies: {}, transactions: [], freeBets: [], casino: [] };
      if (!sportsData.bookies) sportsData.bookies = {};
      const original = JSON.stringify(sportsData);
      if (sportsData.casino) sportsData.casino = sportsData.casino.map(normalizeCasinoField);

      // SAFETY NET: fold in any stray sessions still sitting under the old
      // key (edgetrack_me/edgetrack_wife). Skipped while the daily
      // reconciliation flag is fresh.
      const legacySuffix = LEGACY_KEY_SUFFIX[pr];
      if (legacySuffix && !legacyFresh) {
        const legacyData = await kvGet(`edgetrack_${legacySuffix}`);
        const legacyCasino = legacyData?.casino || [];
        const knownIds = new Set((sportsData.casino || []).map(s => String(s.id)));
        const tomb = new Set((sportsData._deletedIds || []).map(String));
        const strayFromLegacy = legacyCasino.filter(s => !knownIds.has(String(s.id)) && !tomb.has(String(s.id))).map(normalizeCasinoField);
        if (strayFromLegacy.length > 0) {
          sportsData.casino = [...(sportsData.casino || []), ...strayFromLegacy];
          strayFromLegacy.forEach(s => {
            const net = (s.startBal !== undefined && s.endBal !== undefined)
              ? (s.endBal - s.startBal)
              : (s.netProfit || 0);
            if (!sportsData.bookies[s.casino]) sportsData.bookies[s.casino] = { bal: 0, status: 'Active', notes: '' };
            sportsData.bookies[s.casino].bal = (sportsData.bookies[s.casino].bal || 0) + net;
            sportsData.bookies[s.casino].balUpdatedAt = Date.now();
          });
        }
      }

      const serverSessions = sportsData.casino || [];
      const incomingSessions = (incoming[pr]?.casino || []).map(normalizeCasinoField);
      const requestDeletedIds = new Set((incoming[pr]?.deletedIds || []).map(String));

      // PERSISTENT TOMBSTONE (unchanged).
      const persistedDeletedIds = new Set((sportsData._deletedIds || []).map(String));
      requestDeletedIds.forEach(id => persistedDeletedIds.add(id));

      const serverIds = new Set(serverSessions.map(s => String(s.id)));
      // Ignore anything already deleted (a stale device re-sending it).
      const newSessions = incomingSessions
        .filter(s => !serverIds.has(String(s.id)) && !persistedDeletedIds.has(String(s.id)))
        .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0));

      const findBookie = (name) => {
        if (sportsData.bookies[name]) return name;
        const lower = String(name || '').toLowerCase();
        return Object.keys(sportsData.bookies).find(k => k.toLowerCase() === lower) || name;
      };
      newSessions.forEach(s => {
        const key = findBookie(s.casino);
        if (!sportsData.bookies[key]) sportsData.bookies[key] = { bal: 0, status: 'Active', notes: '' };
        const b = sportsData.bookies[key];
        const hasBalances = typeof s.startBal === 'number' && typeof s.endBal === 'number' &&
          isFinite(s.startBal) && isFinite(s.endBal) && !(s.startBal === 0 && s.endBal === 0);
        const net = hasBalances ? (s.endBal - s.startBal) : (s.netProfit || 0);
        const sid = Number(s.id) || 0;
        if (hasBalances && sid >= (b.balUpdatedAt || 0) && sid >= (b.setAt || 0)) {
          // Nothing newer has touched this bookie: the session's end
          // balance is the real balance.
          b.bal = r2(s.endBal);
          b.setAt = sid;
        } else {
          b.bal = r2((b.bal || 0) + net);
        }
        b.balUpdatedAt = Date.now();
      });
      // Deleted sessions: removed from the list below, balance untouched.

      const serverMap = new Map(serverSessions.map(s => [String(s.id), s]));
      const incomingMap = new Map(incomingSessions.map(s => [String(s.id), s]));
      const allIds = new Set([...serverMap.keys(), ...incomingMap.keys()]);
      const mergedSessions = [];
      allIds.forEach(id => {
        if (persistedDeletedIds.has(id)) return;
        const ss = serverMap.get(id);
        const is = incomingMap.get(id);
        if (ss && is) {
          const ssTs = ss.csUpdatedAt || 0;
          const isTs = is.csUpdatedAt || 0;
          mergedSessions.push(isTs >= ssTs ? is : ss);
        } else {
          mergedSessions.push(is || ss);
        }
      });

      sportsData.casino = mergedSessions;
      sportsData._deletedIds = Array.from(persistedDeletedIds);

      // Only write if the merge actually changed something.
      if (JSON.stringify(sportsData) !== original) {
        await kvSet(sportKey, sportsData);
        anyWritten = true;
      }
      } finally {
        await releaseLock(lock);
      }
    }));

    // Casino changes also change bookie balances (sports data), so both
    // revision counters move. Written AFTER the data so a loader that sees
    // the new revision is guaranteed to see the new data.
    if (anyWritten) {
      const now = Date.now();
      await Promise.all([
        kvSetNumber('edgetrack_rev_casino', now),
        kvSetNumber('edgetrack_rev_sports', now)
      ]);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Save-casino error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
