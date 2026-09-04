// save-sports.js — PARALLEL, NOT YET WIRED UP.
// Same merge logic as save.js for bank/bookies/transactions/freeBets,
// but this endpoint is deliberately sports-only:
//   - It never expects `casino` or `deletedCasinoIds` in the request body.
//   - It never sends `casino` back in the response.
// This is the write-side counterpart to load-sports.js: once index.html
// stops loading casino data upfront, it should also stop sending it back
// up on every save and stop receiving it back down in the confirmation —
// that round-trip was a large chunk of the Fast Origin Transfer usage.
//
// THE ONE THING THIS MUST NEVER DO: touch casino data in Upstash. This
// endpoint has no casino data to merge, so on every write it explicitly
// carries forward whatever's already stored for that profile, completely
// untouched. Getting this wrong would mean a routine bet settlement
// silently wipes out someone's entire casino history — see the
// conversation this was built in for why that risk gets taken this
// seriously here.
//
// Nothing in index.html points at this endpoint yet. save.js is
// untouched and keeps serving the live app exactly as before.
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

    // Same permanent bookie dedupe as save.js — unchanged.
    const BOOKIE_RENAMES = {
      'hot streak casino': 'Hot Streak',
      'gala': 'Gala Casino',
      'bet st george': 'BetStGeorge',
      'betstgeorge': 'BetStGeorge',
    };
    const dedupeBookies = (bk) => {
      if (!bk) return bk;
      const out = { ...bk };
      const mergeInto = (canonical, staleKey) => {
        if (!out[staleKey] || staleKey === canonical) return;
        if (!out[canonical]) out[canonical] = { bal: 0, status: 'Not Signed Up', notes: '' };
        out[canonical] = {
          ...out[canonical],
          bal: (out[canonical].bal || 0) + (out[staleKey].bal || 0),
          status: out[staleKey].status && out[staleKey].status !== 'Not Signed Up' ? out[staleKey].status : out[canonical].status,
          notes: out[staleKey].notes || out[canonical].notes,
          balUpdatedAt: Math.max(out[canonical].balUpdatedAt || 0, out[staleKey].balUpdatedAt || 0)
        };
        delete out[staleKey];
      };
      Object.keys(out).forEach(k => {
        const canonical = BOOKIE_RENAMES[k.toLowerCase()];
        if (canonical && canonical !== k) mergeInto(canonical, k);
      });
      const seenLower = {};
      Object.keys(out).forEach(k => {
        const lower = k.toLowerCase();
        if (seenLower[lower] && seenLower[lower] !== k) {
          mergeInto(seenLower[lower], k);
        } else {
          seenLower[lower] = k;
        }
      });
      return out;
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
          const srvTs = srv.txUpdatedAt || 0;
          const incTs = inc.txUpdatedAt || 0;
          if (incTs > srvTs) merged.push(inc);
          else if (srvTs > incTs) merged.push(srv);
          else merged.push(srv.result !== 'Pending' && inc.result === 'Pending' ? srv : inc);
        } else if (inc) {
          merged.push(inc);
        } else if (srv) {
          merged.push(srv);
        }
      });
      return merged;
    };

    const splitCheck = await Promise.all(
      profiles.map(pr => kvGet(`edgetrack_${pr}`))
    );
    const useSplitKeys = splitCheck.some(
      d => d !== null && ((d.transactions?.length || 0) > 0 || Object.keys(d.bookies || {}).length > 0)
    );

    let legacyMainData = null;
    if (!useSplitKeys) {
      legacyMainData = await kvGet('edgetrack_main');
    }

    const responseData = { exchanges: incoming.exchanges || {} };

    await Promise.all(profiles.map(async (pr, i) => {
      if (!incoming[pr]) return;

      let server = splitCheck[i];

      if (!server && LEGACY_KEY_SUFFIX[pr]) {
        server = await kvGet(`edgetrack_${LEGACY_KEY_SUFFIX[pr]}`);
      }
      if (!server && legacyMainData) {
        server = legacyMainData[pr] || legacyMainData[LEGACY_KEY_SUFFIX[pr]] || null;
      }
      if (!server) {
        server = { transactions: [], bank: 0, bankUpdatedAt: 0, bookies: {}, freeBets: [], casino: [] };
      }

      const deletedTxIds = new Set((incoming[pr].deletedIds || []).map(String));
      const persistedDeletedTxIds = new Set((server._deletedTxIds || []).map(String));
      deletedTxIds.forEach(id => persistedDeletedTxIds.add(id));

      const mergedTxs = mergeTxs(server.transactions || [], incoming[pr].transactions || [], persistedDeletedTxIds);

      const fbMap = new Map();
      (server.freeBets || []).forEach(fb => fbMap.set(String(fb.id), fb));
      (incoming[pr].freeBets || []).forEach(fb => fbMap.set(String(fb.id), fb));

      const mergedBookies = dedupeBookies(mergeBookies(dedupeBookies(server.bookies || {}), incoming[pr].bookies || {}));

      const incomingBankTs = incoming[pr].bankUpdatedAt || 0;
      const serverBankTs = server.bankUpdatedAt || 0;
      const incomingBankWins =
        incoming[pr].bank !== undefined &&
        (incomingBankTs === 0 || incomingBankTs >= serverBankTs);

      // CRITICAL: this endpoint has no casino data of its own — server.casino
      // and server._deletedCasinoIds are carried forward completely
      // untouched into the write. This is the one thing that must never
      // regress: a sports-only save must never be able to wipe casino data.
      const merged = {
        bank: incomingBankWins ? incoming[pr].bank : (server.bank || 0),
        bankUpdatedAt: Math.max(incomingBankTs, serverBankTs) || Date.now(),
        bookies: mergedBookies,
        transactions: mergedTxs,
        freeBets: Array.from(fbMap.values()),
        casino: server.casino || [],
        _deletedTxIds: Array.from(persistedDeletedTxIds),
        _deletedCasinoIds: server._deletedCasinoIds || []
      };

      await kvSet(`edgetrack_${pr}`, merged);

      // Response deliberately omits casino/_deletedCasinoIds — the client
      // doesn't need them back (see ensureCasinoLoaded() in index.html),
      // and sending them was the other half of the unnecessary transfer.
      const { casino, _deletedCasinoIds, ...sportsOnly } = merged;
      responseData[pr] = sportsOnly;
    }));

    await kvSet('edgetrack_exchanges', incoming.exchanges || {});

    return res.status(200).json({ ok: true, data: responseData });
  } catch (e) {
    console.error('Save-sports error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
