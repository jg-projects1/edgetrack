// v6 - profile keys renamed (me->jg, wife->hg), safe split KV, no silent failures
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    const profiles = ['jg', 'hg', 'bp', 'rq'];
    // Old KV key suffix for each renamed profile. bp/rq are unchanged so
    // they don't need an entry here.
    const LEGACY_KEY_SUFFIX = { jg: 'me', hg: 'wife' };

    // Throws on a genuine fetch/HTTP failure so callers can tell
    // "key doesn't exist" apart from "request failed".
    const kvGet = async (key) => {
      const r = await fetch(`${kvUrl}/get/${key}`, {
        headers: { Authorization: `Bearer ${kvToken}`, 'Cache-Control': 'no-cache' }
      });
      if (!r.ok) throw new Error(`KV fetch failed for ${key}: ${r.status}`);
      const d = await r.json();
      if (!d.result) return null; // genuinely empty key — fine
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

    // Same permanent dedupe as save.js — applied on read too, so a
    // duplicate that's still sitting in Upstash (e.g. from before this
    // fix was deployed) gets cleaned up and written back on the very
    // first load, not just hidden until the next save.
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

    // Load all profiles in parallel under their NEW key names first.
    const [profileData, exchanges] = await Promise.all([
      Promise.all(profiles.map(async pr => {
        const data = await kvGet(`edgetrack_${pr}`);
        return { pr, data };
      })),
      kvGet('edgetrack_exchanges')
    ]);

    // ONE-TIME MIGRATION: for any renamed profile whose new key is still
    // empty, check the old key (edgetrack_me / edgetrack_wife). If it has
    // data, adopt it as this profile's data AND write it to the new key
    // so future loads hit the new key directly. The old key is left
    // exactly as-is — nothing is deleted, so it stays as a safety net.
    for (const entry of profileData) {
      const legacySuffix = LEGACY_KEY_SUFFIX[entry.pr];
      if (!legacySuffix) continue; // bp/rq — no migration needed
      if (entry.data !== null) continue; // new key already has data
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
          result[pr] = { transactions: [], bank: 0, bankUpdatedAt: 0, bookies: {}, freeBets: [], casino: [] };
          return;
        }
        const { bookies, changed } = dedupeBookies(data.bookies || {});
        const cleaned = { ...data, bookies };
        result[pr] = cleaned;
        if (changed) {
          // Persist the cleanup so it's actually fixed in Upstash, not
          // just cleaned up for this one response.
          await kvSet(`edgetrack_${pr}`, cleaned);
        }
      }));
      return res.status(200).json({ ok: true, data: result });
    }

    // Fall back to legacy single key ONLY if every split key (new AND old
    // profile names) was genuinely empty.
    const legacy = await kvGet('edgetrack_main');
    if (legacy) {
      // edgetrack_main predates the profile split entirely, so it still
      // uses 'me'/'wife' as its top-level keys — remap those too.
      const remapped = { ...legacy };
      Object.entries(LEGACY_KEY_SUFFIX).forEach(([newKey, oldKey]) => {
        if (!remapped[newKey] && remapped[oldKey]) remapped[newKey] = remapped[oldKey];
      });
      return res.status(200).json({ ok: true, data: remapped });
    }
    return res.status(200).json({ ok: true, data: null });
  } catch (e) {
    console.error('Load error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
