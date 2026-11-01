// save-sports.js v4 - balance changes, not balances.
//   * Bookie balances are no longer overwritten with whatever balance a
//     device happens to hold. Current clients send "batches" of balance
//     operations ({add: -5} for a stake, {set: 123.45, setAt} for a
//     verified/amended balance) and the server applies them to its own
//     current figure, so a device with an out-of-date copy can no longer
//     wipe out someone else's update (e.g. Operator A's casino sessions).
//     Each batch has an id and is applied at most once, so a retried save
//     can't double-count. Requests without batches (an old copy of the
//     page still open somewhere) fall back to the previous timestamp merge.
//   * Each profile is locked while it's read-modified-written, so a casino
//     save and a sports save landing at the same moment can't overwrite
//     each other.
// v3 notes:
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
    const profiles = ['jg', 'hg', 'bp', 'rq', 'wa'];
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
          if (!r.ok) return null;            // can't lock: carry on unlocked
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

    // ---- Batched balance operations (current clients) ---------------------
    const r2 = (x) => Math.round((Number(x) || 0) * 100) / 100;
    const MAX_APPLIED = 300;
    const resolveName = (bk, name) => {
      if (bk[name]) return name;
      const canonical = BOOKIE_RENAMES[String(name).toLowerCase()];
      if (canonical && bk[canonical]) return canonical;
      const lower = String(name).toLowerCase();
      const hit = Object.keys(bk).find(k => k.toLowerCase() === lower);
      return hit || canonical || name;
    };
    const mergeBookieMeta = (serverBk, incomingBk) => {
      // Status / notes / verifiedAt still merge on timestamp; the balance
      // itself is NEVER taken from the incoming copy on this path.
      const merged = { ...serverBk };
      Object.keys(incomingBk || {}).forEach(k => {
        const inc = incomingBk[k] || {};
        if (!merged[k]) {
          merged[k] = { bal: 0, status: inc.status || 'Not Signed Up', notes: inc.notes || '', verifiedAt: inc.verifiedAt || null, balUpdatedAt: inc.balUpdatedAt || 0 };
          return;
        }
        const localTs = inc.balUpdatedAt || 0;
        const serverTs = merged[k].balUpdatedAt || 0;
        const localWins = localTs > 0 && localTs > serverTs;
        merged[k] = Object.assign({}, merged[k], {
          status: localWins ? (inc.status || merged[k].status) : merged[k].status,
          notes: localWins ? (inc.notes !== undefined ? inc.notes : merged[k].notes) : merged[k].notes,
          verifiedAt: inc.verifiedAt || merged[k].verifiedAt || null,
          balUpdatedAt: Math.max(localTs, serverTs)
        });
      });
      return merged;
    };
    const applyBatches = (bk, batches, appliedIds) => {
      const seen = new Set(appliedIds);
      const now = Date.now();
      (batches || []).forEach(batch => {
        if (!batch || !batch.id || seen.has(batch.id)) return;
        Object.entries(batch.ops || {}).forEach(([rawName, op]) => {
          if (!op) return;
          const name = resolveName(bk, rawName);
          if (!bk[name]) bk[name] = { bal: 0, status: 'Active', notes: '' };
          const b = bk[name];
          if (typeof op.set === 'number' && isFinite(op.set) && (op.setAt || 0) >= (b.setAt || 0)) {
            b.bal = r2(op.set);
            b.setAt = op.setAt || now;
          }
          if (typeof op.add === 'number' && isFinite(op.add)) b.bal = r2((b.bal || 0) + op.add);
          b.balUpdatedAt = now;
        });
        seen.add(batch.id);
        appliedIds.push(batch.id);
      });
      while (appliedIds.length > MAX_APPLIED) appliedIds.shift();
    };

    // Only read what this request actually touches.
    const sentProfiles = profiles.filter(pr => incoming[pr]);
    const locks = [];
    try {
    for (const pr of [...sentProfiles].sort()) locks.push(await acquireLock(`edgetrack_lock_${pr}`));
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

      const usesOps = Array.isArray(incoming[pr].batches);
      const appliedIds = Array.isArray(server._appliedBatches) ? [...server._appliedBatches] : [];
      let mergedBookies;
      if (usesOps) {
        const bk = mergeBookieMeta(dedupeBookies(server.bookies || {}), incoming[pr].bookies || {});
        applyBatches(bk, incoming[pr].batches, appliedIds);
        mergedBookies = dedupeBookies(bk);
      } else {
        // Old copy of the page: previous timestamp merge.
        mergedBookies = dedupeBookies(mergeBookies(dedupeBookies(server.bookies || {}), incoming[pr].bookies || {}));
      }

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
        _deletedCasinoIds: server._deletedCasinoIds || [],
        _appliedBatches: appliedIds
      };

      // Skip the write when nothing changed (and the record already lives
      // under its own key).
      const unchanged = fromNewKey && JSON.stringify(merged) === JSON.stringify(server);
      if (!unchanged) {
        await kvSet(`edgetrack_${pr}`, merged);
        anyWritten = true;
      }

      // Response deliberately omits casino-side fields.
      const { casino, _deletedCasinoIds, _deletedIds, _appliedBatches, ...sportsOnly } = merged;
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
    } finally {
      await Promise.all(locks.map(releaseLock));
    }
  } catch (e) {
    console.error('Save-sports error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
