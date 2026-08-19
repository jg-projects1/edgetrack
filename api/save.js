// v5 - safe split KV, robust legacy detection, timestamped bank merge
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
    const profiles = ['me', 'wife', 'bp', 'rq'];

    // Throws on genuine fetch failure instead of swallowing it — a failed
    // request must never be treated the same as "key doesn't exist".
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

    const kvSet = async (key, value) => {
      const r = await fetch(`${kvUrl}/set/${key}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(JSON.stringify(value))
      });
      if (!r.ok) throw new Error(`KV set error on ${key}: ${r.status}`);
    };

    const mergeBookies = (serverBk, incomingBk) => {
      const merged = { ...serverBk };
      Object.keys(incomingBk).forEach(k => {
        if (!merged[k]) {
          merged[k] = incomingBk[k];
        } else {
          const localTs = incomingBk[k].balUpdatedAt || 0;
          const serverTs = merged[k].balUpdatedAt || 0;
          const localWins = localTs > 0 && localTs > serverTs;
          merged[k] = Object.assign({}, merged[k], {
            bal: localWins ? incomingBk[k].bal : merged[k].bal,
            status: localWins ? (incomingBk[k].status || merged[k].status) : merged[k].status,
            notes: localWins ? (incomingBk[k].notes !== undefined ? incomingBk[k].notes : merged[k].notes) : merged[k].notes,
            verifiedAt: incomingBk[k].verifiedAt || merged[k].verifiedAt || null,
            balUpdatedAt: Math.max(localTs, serverTs)
          });
        }
      });
      return merged;
    };

    const mergeTxs = (serverTxs, incomingTxs, deletedIds) => {
      const serverMap = new Map(serverTxs.map(t => [String(t.id), t]));
      const incomingMap = new Map(incomingTxs.map(t => [String(t.id), t]));
      const allIds = new Set([...serverMap.keys(), ...incomingMap.keys()]);
      const merged = [];
      allIds.forEach(id => {
        if (deletedIds.has(id)) return;
        const srv = serverMap.get(id);
        const inc = incomingMap.get(id);
        if (inc && srv) {
          merged.push(srv.result !== 'Pending' && inc.result === 'Pending' ? srv : inc);
        } else if (inc) {
          merged.push(inc);
        } else if (srv) {
          merged.push(srv);
        }
      });
      return merged;
    };

    const mergeCasino = (serverSessions, incomingSessions, deletedIds) => {
      const serverMap = new Map((serverSessions || []).map(s => [String(s.id), s]));
      const incomingMap = new Map((incomingSessions || []).map(s => [String(s.id), s]));
      const allIds = new Set([...serverMap.keys(), ...incomingMap.keys()]);
      const merged = [];
      allIds.forEach(id => {
        if (deletedIds.has(id)) return;
        merged.push(incomingMap.get(id) || serverMap.get(id));
      });
      return merged;
    };

    // FIX: check ALL profiles for split-key data, not just 'me'. A single
    // profile's fetch quirk should never decide the format for everyone.
    // kvGet now throws on genuine failures, so if this Promise.all rejects
    // we abort the whole save (see catch block) rather than silently
    // falling back to legacy data.
    const splitCheck = await Promise.all(
      profiles.map(pr => kvGet(`edgetrack_${pr}`))
    );
    const useSplitKeys = splitCheck.some(
      d => d !== null && ((d.transactions?.length || 0) > 0 || Object.keys(d.bookies || {}).length > 0)
    );

    // If NONE of the profiles have split data, only then consider legacy —
    // and only as a one-time migration source, never as an ongoing fallback.
    let legacyData = null;
    if (!useSplitKeys) {
      legacyData = await kvGet('edgetrack_main');
    }

    const responseData = { exchanges: incoming.exchanges || {} };

    await Promise.all(profiles.map(async (pr, i) => {
      if (!incoming[pr]) return;

      const server = useSplitKeys
        ? (splitCheck[i] || { transactions: [], bank: 0, bookies: {}, freeBets: [], casino: [] })
        : (legacyData?.[pr] || { transactions: [], bank: 0, bookies: {}, freeBets: [], casino: [] });

      const deletedTxIds = new Set((incoming[pr].deletedIds || []).map(String));
      const deletedCasinoIds = new Set((incoming[pr].deletedCasinoIds || []).map(String));

      const mergedTxs = mergeTxs(server.transactions || [], incoming[pr].transactions || [], deletedTxIds);
      const mergedCasinoSessions = mergeCasino(server.casino || [], incoming[pr].casino || [], deletedCasinoIds);

      const fbMap = new Map();
      (server.freeBets || []).forEach(fb => fbMap.set(String(fb.id), fb));
      (incoming[pr].freeBets || []).forEach(fb => fbMap.set(String(fb.id), fb));

      const mergedBookies = mergeBookies(server.bookies || {}, incoming[pr].bookies || {});

      // FIX: bank now merges on a timestamp, same principle as bookies,
      // instead of unconditionally trusting whichever device saved last.
      const incomingBankTs = incoming[pr].bankUpdatedAt || 0;
      const serverBankTs = server.bankUpdatedAt || 0;
      const incomingBankWins =
        incoming[pr].bank !== undefined &&
        (incomingBankTs === 0 || incomingBankTs >= serverBankTs); // no timestamp = trust explicit user edit

      const merged = {
        bank: incomingBankWins ? incoming[pr].bank : (server.bank || 0),
        bankUpdatedAt: Math.max(incomingBankTs, serverBankTs) || Date.now(),
        bookies: mergedBookies,
        transactions: mergedTxs,
        freeBets: Array.from(fbMap.values()),
        casino: mergedCasinoSessions
      };

      await kvSet(`edgetrack_${pr}`, merged);
      responseData[pr] = merged;
    }));

    await kvSet('edgetrack_exchanges', incoming.exchanges || {});

    return res.status(200).json({ ok: true, data: responseData });
  } catch (e) {
    console.error('Save error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
