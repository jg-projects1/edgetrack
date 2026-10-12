// save-sports.js v3 - bandwidth diet. Merge logic (bank / bookies /
// transactions / freeBets / tombstones) is unchanged from the previous
// version. What's different:
//   * Only the profiles the client actually sent are read from Upstash
//     (the old version read all four on every save).
//   * A profile is only written back if the merge actually changed it.
//   * exchanges / betBuilderLibrary are only written if they changed.
//   * Bumps edgetrack_rev_sports after any write so load-sports.js can
//     answer 304 Not Modified.
//   * The write now starts from the stored record and overrides only the
//     sports fields, so everything casino-related that is stored with the
//     profile (casino sessions AND the _deletedIds tombstone list that
//     save-casino.js keeps) is carried forward untouched. The previous
//     version rebuilt the record from scratch and dropped `_deletedIds`,
//     so every sports save quietly erased save-casino.js's tombstones.
//
// THE ONE THING THIS MUST NEVER DO: touch casino data in Upstash.
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
    const kvSetNumber = async (key, n) => {
      const r = await fetch(`${kvUrl}/set/${key}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(n)
      });
      if (!r.ok) throw new Error(`KV set error on ${key}: ${r.status}`);
    };

    const BOOKIE_RENAMES = {
      'hot streak casino': 'Hot Streak',
      'gala': 'Gala Casino',
      'bet st george': 'BetStGeorge',
      'betstgeorge': 'BetStGeorge',
      'grosvenor casinos': 'Grosvenor',
      'planet sports': 'Planet Sport Bet',
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

    // Only read what this request actually touches.
    const sentProfiles = profiles.filter(pr => incoming[pr]);
    const existing = {};
    await Promise.all(sentProfiles.map(async pr => {
      existing[pr] = await kvGet(`edgetrack_${pr}`);
    }));

    // edgetrack_main is only a one-time migration source - fetched lazily,
    // and only if a sent profile has no data under its own key.
    let legacyMainLoaded = false;
    let legacyMainData = null;
    const getLegacyMain = async () => {
      if (!legacyMainLoaded) { legacyMainData = await kvGet('edgetrack_main'); legacyMainLoaded = true; }
      return legacyMainData;
    };

    const responseData = { exchanges: incoming.exchanges || {} };
    let anyWritten = false;

    await Promise.all(sentProfiles.map(async (pr) => {
      const fromNewKey = existing[pr] !== null;
      let server = existing[pr];

      if (!server && LEGACY_KEY_SUFFIX[pr]) {
        server = await kvGet(`edgetrack_${LEGACY_KEY_SUFFIX[pr]}`);
      }
      if (!server) {
        const lm = await getLegacyMain();
        if (lm) server = lm[pr] || lm[LEGACY_KEY_SUFFIX[pr]] || null;
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

      // Start from the stored record so casino sessions, _deletedCasinoIds,
      // _deletedIds and anything else casino-side is carried forward
      // untouched; override only the sports fields.
      const merged = {
        ...server,
        bank: incomingBankWins ? incoming[pr].bank : (server.bank || 0),
        bankUpdatedAt: Math.max(incomingBankTs, serverBankTs) || Date.now(),
        bookies: mergedBookies,
        transactions: mergedTxs,
        freeBets: Array.from(fbMap.values()),
        casino: server.casino || [],
        _deletedTxIds: Array.from(persistedDeletedTxIds),
        _deletedCasinoIds: server._deletedCasinoIds || []
      };

      // Skip the write when nothing changed (and the record already lives
      // under its own key).
      const unchanged = fromNewKey && JSON.stringify(merged) === JSON.stringify(server);
      if (!unchanged) {
        await kvSet(`edgetrack_${pr}`, merged);
        anyWritten = true;
      }

      // Response deliberately omits casino-side fields.
      const { casino, _deletedCasinoIds, _deletedIds, ...sportsOnly } = merged;
      responseData[pr] = sportsOnly;
    }));

    // exchanges / library: only write when they differ from what's stored
    // (both are small, so reading them is far cheaper than rewriting).
    const exchangesToSave = incoming.exchanges || {};
    const storedExchanges = await kvGet('edgetrack_exchanges');
    if (JSON.stringify(storedExchanges) !== JSON.stringify(exchangesToSave)) {
      await kvSet('edgetrack_exchanges', exchangesToSave);
      anyWritten = true;
    }

    if (Array.isArray(incoming.betBuilderLibrary)) {
      const storedLibrary = await kvGet('edgetrack_bet_builder_library');
      if (JSON.stringify(storedLibrary) !== JSON.stringify(incoming.betBuilderLibrary)) {
        await kvSet('edgetrack_bet_builder_library', incoming.betBuilderLibrary);
        anyWritten = true;
      }
      responseData.betBuilderLibrary = incoming.betBuilderLibrary;
    } else {
      responseData.betBuilderLibrary = await kvGet('edgetrack_bet_builder_library') || [];
    }

    // Written AFTER the data so a loader that sees the new revision is
    // guaranteed to see the new data.
    if (anyWritten) await kvSetNumber('edgetrack_rev_sports', Date.now());

    return res.status(200).json({ ok: true, data: responseData });
  } catch (e) {
    console.error('Save-sports error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
