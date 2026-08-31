// load-sports.js — PARALLEL, NOT YET WIRED UP.
// Identical to load.js in every way (same migration, same dedupe, same
// profile keys) EXCEPT the response strips out each profile's `casino`
// array before sending. Casino sessions are roughly half of the total
// payload weight, and index.html currently pulls them on every single
// load even when the Casino tab is never opened that session — that's
// the main driver behind the Fast Origin Transfer usage warning.
//
// Nothing in index.html points at this endpoint yet. load.js is
// untouched and keeps serving the live app exactly as before. This file
// exists purely so it can be tested against real data with zero risk to
// what's currently running — see the conversation this was built in for
// the plan on cutting over once it's verified.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    const profiles = ['jg', 'hg', 'bp', 'rq'];
    const LEGACY_KEY_SUFFIX = { jg: 'me', hg: 'wife' };

    const kvGet = async (key) => {
      const r = await fetch(`${kvUrl}/get/${key}`, {
        headers: { Authorization: `Bearer ${kvToken}`, 'Cache-Control': 'no-cache' }
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

    // Same permanent bookie dedupe as load.js — unchanged.
    const BOOKIE_RENAMES = {
      'hot streak casino': 'Hot Streak',
      'gala': 'Gala Casino',
      'bet st george': 'BetStGeorge',
      'betstgeorge': 'BetStGeorge',
    };
    const dedupeBookies = (bk) => {
      if (!bk) return { bookies: bk, changed: false };
      const out = { ...bk };
      let changed = false;
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
        changed = true;
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
      return { bookies: out, changed };
    };

    const [profileData, exchanges] = await Promise.all([
      Promise.all(profiles.map(async pr => {
        const data = await kvGet(`edgetrack_${pr}`);
        return { pr, data };
      })),
      kvGet('edgetrack_exchanges')
    ]);

    // Same one-time me/wife -> jg/hg migration as load.js — unchanged.
    for (const entry of profileData) {
      const legacySuffix = LEGACY_KEY_SUFFIX[entry.pr];
      if (!legacySuffix) continue;
      if (entry.data !== null) continue;
      const legacyData = await kvGet(`edgetrack_${legacySuffix}`);
      if (legacyData !== null) {
        entry.data = legacyData;
        await kvSet(`edgetrack_${entry.pr}`, legacyData);
      }
    }

    const hasSplitData = profileData.some(p => p.data !== null);
    if (hasSplitData) {
      const result = { exchanges: exchanges || {} };
      await Promise.all(profileData.map(async ({ pr, data }) => {
        if (!data) {
          // NOTE: no `casino` key here at all — deliberately, this is a
          // sports-only response. The client must treat a missing
          // `casino` field as "not loaded", never as "empty/deleted".
          result[pr] = { transactions: [], bank: 0, bankUpdatedAt: 0, bookies: {}, freeBets: [] };
          return;
        }
        const { bookies, changed } = dedupeBookies(data.bookies || {});
        // Strip casino out of the response — everything else identical
        // to what load.js would return for this profile.
        const { casino, ...withoutCasino } = { ...data, bookies };
        result[pr] = withoutCasino;
        if (changed) {
          // Persist the bookie cleanup against the FULL record (with
          // casino intact) — we must never write the trimmed version
          // back to Upstash, only ever read a trimmed copy for response.
          await kvSet(`edgetrack_${pr}`, { ...data, bookies });
        }
      }));
      return res.status(200).json({ ok: true, data: result });
    }

    const legacy = await kvGet('edgetrack_main');
    if (legacy) {
      const remapped = { ...legacy };
      Object.entries(LEGACY_KEY_SUFFIX).forEach(([newKey, oldKey]) => {
        if (!remapped[newKey] && remapped[oldKey]) remapped[newKey] = remapped[oldKey];
      });
      // Strip casino here too, for consistency with the split-key path.
      profiles.forEach(pr => {
        if (remapped[pr]) {
          const { casino, ...withoutCasino } = remapped[pr];
          remapped[pr] = withoutCasino;
        }
      });
      return res.status(200).json({ ok: true, data: remapped });
    }
    return res.status(200).json({ ok: true, data: null });
  } catch (e) {
    console.error('Load-sports error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
