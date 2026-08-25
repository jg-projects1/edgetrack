// v2 - profile keys renamed (me->jg, wife->hg) to match the main app.
// Also brings this endpoint's merge logic up to the same standard as the
// main app's save.js: timestamp-based conflict resolution instead of
// "whoever saves last wins", and a persistent deletion tombstone so a
// stale device can't silently resurrect something already deleted.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    const incoming = req.body;
    const profiles = ['jg', 'hg', 'bp', 'rq'];
    const LEGACY_KEY_SUFFIX = { jg: 'me', hg: 'wife' };

    const kvGet = async (key) => {
      const r = await fetch(`${kvUrl}/get/${key}`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      if (!r.ok) return null;
      const d = await r.json();
      if (!d.result) return null;
      let parsed = JSON.parse(d.result);
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
      return parsed;
    };

    const kvSet = async (key, value) => {
      const r = await fetch(`${kvUrl}/set/${key}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(JSON.stringify(value))
      });
      if (!r.ok) throw new Error(`KV set error on ${key}: ${r.status}`);
    };

    await Promise.all(profiles.map(async pr => {
      if (!incoming[pr]) return;

      const sportKey = `edgetrack_${pr}`;
      let sportsData = await kvGet(sportKey) || { bank: 0, bookies: {}, transactions: [], freeBets: [], casino: [] };

      // SAFETY NET: fold in any stray sessions still sitting under the old
      // key (edgetrack_me/edgetrack_wife) that load-casino.js hasn't
      // reconciled yet — covers a device that saves before ever loading.
      const legacySuffix = LEGACY_KEY_SUFFIX[pr];
      if (legacySuffix) {
        const legacyData = await kvGet(`edgetrack_${legacySuffix}`);
        const legacyCasino = legacyData?.casino || [];
        const knownIds = new Set((sportsData.casino || []).map(s => String(s.id)));
        const strayFromLegacy = legacyCasino.filter(s => !knownIds.has(String(s.id)));
        if (strayFromLegacy.length > 0) {
          sportsData.casino = [...(sportsData.casino || []), ...strayFromLegacy];
          if (!sportsData.bookies) sportsData.bookies = {};
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
      const incomingSessions = incoming[pr]?.casino || [];
      const requestDeletedIds = new Set((incoming[pr]?.deletedIds || []).map(String));

      // PERSISTENT TOMBSTONE: same principle as the main app's save.js —
      // a deletion sent in one request must be remembered permanently, or
      // a device that never saw the delete can resurrect the session on
      // its next save just by including its own stale copy.
      const persistedDeletedIds = new Set((sportsData._deletedIds || []).map(String));
      requestDeletedIds.forEach(id => persistedDeletedIds.add(id));

      const serverIds = new Set(serverSessions.map(s => String(s.id)));
      const newSessions = incomingSessions.filter(s => !serverIds.has(String(s.id)));
      const deletedSessions = serverSessions.filter(s => requestDeletedIds.has(String(s.id)));

      newSessions.forEach(s => {
        const casino = s.casino;
        const net = (s.startBal !== undefined && s.endBal !== undefined)
          ? (s.endBal - s.startBal)
          : (s.netProfit || 0);
        if (!sportsData.bookies[casino]) sportsData.bookies[casino] = { bal: 0, status: 'Active', notes: '' };
        sportsData.bookies[casino].bal = (sportsData.bookies[casino].bal || 0) + net;
        sportsData.bookies[casino].balUpdatedAt = Date.now();
      });

      deletedSessions.forEach(s => {
        const casino = s.casino;
        const net = (s.startBal !== undefined && s.endBal !== undefined)
          ? (s.endBal - s.startBal)
          : (s.netProfit || 0);
        if (!sportsData.bookies[casino]) sportsData.bookies[casino] = { bal: 0, status: 'Active', notes: '' };
        sportsData.bookies[casino].bal = (sportsData.bookies[casino].bal || 0) - net;
        sportsData.bookies[casino].balUpdatedAt = Date.now();
      });

      // Timestamp-based merge (matches main save.js) instead of unconditional
      // "incoming wins" — protects against a stale device's cached copy
      // silently overwriting a session someone else already touched.
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

      await kvSet(sportKey, sportsData);
    }));

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
