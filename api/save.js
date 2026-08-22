// v6 - profile keys renamed (me->jg, wife->hg), robust legacy detection, timestamped bank merge
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
    // Old KV key suffix for each renamed profile — used ONLY as a
    // one-time read fallback if the new key has never been written yet.
    // bp/rq are unchanged so they don't need an entry.
    const LEGACY_KEY_SUFFIX = { jg: 'me', hg: 'wife' };

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

    // PERMANENT dedupe, run server-side on every save. Mirrors the
    // client's migrateLegacy() renames, but unlike that function (which
    // only cleans up the in-browser copy) this one actually removes the
    // stale key from what gets written back to Upstash — otherwise a
    // "cleaned up" duplicate just silently persists on the server forever
    // and reappears on next load, and balance edits only ever touch the
    // canonical key while the stale one keeps its own leftover balance.
    const BOOKIE_RENAMES = {
      'hot streak casino': 'Hot Streak',
      'gala': 'Gala Casino',
      'bet st george': 'BetStGeorge',
      'betstgeorge': 'BetStGeorge', // lowercase form only; exact-case dupes handled below
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
      // Explicit rename list (handles differently-spelled/spaced variants)
      Object.keys(out).forEach(k => {
        const canonical = BOOKIE_RENAMES[k.toLowerCase()];
        if (canonical && canonical !== k) mergeInto(canonical, k);
      });
      // Generic case-insensitive dedupe for anything else (e.g. 'betfred' vs 'Betfred')
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

    // Check ALL profiles (new key names) for split-key data, not just one.
    // kvGet throws on genuine failures, so if this Promise.all rejects we
    // abort the whole save (see catch block) rather than silently falling
    // back to legacy data.
    const splitCheck = await Promise.all(
      profiles.map(pr => kvGet(`edgetrack_${pr}`))
    );
    const useSplitKeys = splitCheck.some(
      d => d !== null && ((d.transactions?.length || 0) > 0 || Object.keys(d.bookies || {}).length > 0)
    );

    // If NONE of the new-named profiles have split data, only then
    // consider edgetrack_main as a one-time migration source.
    let legacyMainData = null;
    if (!useSplitKeys) {
      legacyMainData = await kvGet('edgetrack_main');
    }

    const responseData = { exchanges: incoming.exchanges || {} };

    await Promise.all(profiles.map(async (pr, i) => {
      if (!incoming[pr]) return;

      let server = splitCheck[i];

      // ONE-TIME MIGRATION: if this profile's new key has never been
      // written, but it's a renamed profile (jg/hg) with data still
      // sitting under its old key (me/wife), use that as the merge
      // baseline instead of starting from blank. This prevents the
      // rename from silently discarding pre-rename history on first save.
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
      const deletedCasinoIds = new Set((incoming[pr].deletedCasinoIds || []).map(String));

      const mergedTxs = mergeTxs(server.transactions || [], incoming[pr].transactions || [], deletedTxIds);
      const mergedCasinoSessions = mergeCasino(server.casino || [], incoming[pr].casino || [], deletedCasinoIds);

      const fbMap = new Map();
      (server.freeBets || []).forEach(fb => fbMap.set(String(fb.id), fb));
      (incoming[pr].freeBets || []).forEach(fb => fbMap.set(String(fb.id), fb));

      const mergedBookies = dedupeBookies(mergeBookies(dedupeBookies(server.bookies || {}), incoming[pr].bookies || {}));

      // Bank merges on a timestamp instead of unconditionally trusting
      // whichever device saved last.
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

      // Always write to the NEW key name. Old keys (edgetrack_me,
      // edgetrack_wife) are never written to again — they stay frozen as
      // a safety-net snapshot of pre-rename data.
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
