// load-sports.js v3 - conditional loads. Data, migration and dedupe logic is
// unchanged from the previous version; the only addition is that the
// endpoint reads a tiny revision key first and answers 304 Not Modified when
// nothing has changed since the browser's last load (the browser sends
// If-None-Match automatically, as long as the client doesn't add a
// cache-busting ?t= to the URL or use cache:'no-store').
//
// The ETag also rolls over every 15 minutes, so even if some other endpoint
// ever changes data without bumping edgetrack_rev_sports, a stale copy can
// only survive for 15 minutes.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    const profiles = ['jg', 'hg', 'bp', 'rq', 'wa'];
    const LEGACY_KEY_SUFFIX = { jg: 'me', hg: 'wife' };
    const ETAG_BUCKET_MS = 15 * 60 * 1000;

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
    const kvSetNumber = async (key, n) => {
      const r = await fetch(`${kvUrl}/set/${key}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(n)
      });
      if (!r.ok) throw new Error(`KV set error on ${key}: ${r.status}`);
    };

    const makeEtag = (rev) => `W/"${rev}-${Math.floor(Date.now() / ETAG_BUCKET_MS)}"`;

    // ---- Cheap change check ------------------------------------------------
    let rev = await kvGet('edgetrack_rev_sports');
    if (typeof rev !== 'number') {
      rev = Date.now();
      await kvSetNumber('edgetrack_rev_sports', rev);
    }
    res.setHeader('Cache-Control', 'no-cache'); // cacheable, but always revalidate
    res.setHeader('ETag', makeEtag(rev));
    if (req.headers['if-none-match'] === makeEtag(rev)) {
      return res.status(304).end();
    }

    let anyWritten = false;

    const BOOKIE_RENAMES = {
      'hot streak casino': 'Hot Streak',
      'gala': 'Gala Casino',
      'bet st george': 'BetStGeorge',
      'betstgeorge': 'BetStGeorge',
      'grosvenor casinos': 'Grosvenor',
      'planet sports': 'Planet Sport Bet',
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

    const [profileData, exchanges, betBuilderLibrary] = await Promise.all([
      Promise.all(profiles.map(async pr => {
        const data = await kvGet(`edgetrack_${pr}`);
        return { pr, data };
      })),
      kvGet('edgetrack_exchanges'),
      kvGet('edgetrack_bet_builder_library')
    ]);

    for (const entry of profileData) {
      const legacySuffix = LEGACY_KEY_SUFFIX[entry.pr];
      if (!legacySuffix) continue;
      if (entry.data !== null) continue;
      const legacyData = await kvGet(`edgetrack_${legacySuffix}`);
      if (legacyData !== null) {
        entry.data = legacyData;
        await kvSet(`edgetrack_${entry.pr}`, legacyData);
        anyWritten = true;
      }
    }

    const finish = async () => {
      if (anyWritten) {
        const now = Date.now();
        await kvSetNumber('edgetrack_rev_sports', now);
        res.setHeader('ETag', makeEtag(now));
      }
    };

    const hasSplitData = profileData.some(p => p.data !== null);
    if (hasSplitData) {
      const result = { exchanges: exchanges || {}, betBuilderLibrary: betBuilderLibrary || [] };
      await Promise.all(profileData.map(async ({ pr, data }) => {
        if (!data) {
          // No `casino` key at all: the client treats a missing field as
          // "not loaded", never as "empty".
          result[pr] = { transactions: [], bank: 0, bankUpdatedAt: 0, bookies: {}, freeBets: [] };
          return;
        }
        const { bookies, changed } = dedupeBookies(data.bookies || {});
        const { casino, ...withoutCasino } = { ...data, bookies };
        result[pr] = withoutCasino;
        if (changed) {
          // Persist the cleanup against the FULL record (casino intact).
          await kvSet(`edgetrack_${pr}`, { ...data, bookies });
          anyWritten = true;
        }
      }));
      await finish();
      return res.status(200).json({ ok: true, data: result });
    }

    const legacy = await kvGet('edgetrack_main');
    if (legacy) {
      const remapped = { ...legacy };
      Object.entries(LEGACY_KEY_SUFFIX).forEach(([newKey, oldKey]) => {
        if (!remapped[newKey] && remapped[oldKey]) remapped[newKey] = remapped[oldKey];
      });
      profiles.forEach(pr => {
        if (remapped[pr]) {
          const { casino, ...withoutCasino } = remapped[pr];
          remapped[pr] = withoutCasino;
        }
      });
      await finish();
      return res.status(200).json({ ok: true, data: remapped });
    }
    await finish();
    return res.status(200).json({ ok: true, data: null });
  } catch (e) {
    console.error('Load-sports error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
