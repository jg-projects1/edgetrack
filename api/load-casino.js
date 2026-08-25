// Casino data lives inside each profile's split key.
// v2 - profile keys renamed (me->jg, wife->hg) to match the main app,
// plus one-time reconciliation of sessions logged into the OLD keys
// (edgetrack_me/edgetrack_wife) after the rename deployed but before this
// file was updated to match. Those sessions were invisible to the main
// app and to anyone else viewing this page from post-rename data — this
// folds them in and makes the merge permanent so it only has to happen once.
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

    const profileData = await Promise.all(
      profiles.map(async pr => {
        const data = await kvGet(`edgetrack_${pr}`);
        const legacySuffix = LEGACY_KEY_SUFFIX[pr];

        if (!legacySuffix) {
          // bp/rq — no legacy key, nothing to reconcile
          return { pr, casino: data?.casino || [] };
        }

        const legacyData = await kvGet(`edgetrack_${legacySuffix}`);
        const newCasino = data?.casino || [];
        const legacyCasino = legacyData?.casino || [];

        const newIds = new Set(newCasino.map(s => String(s.id)));
        const strayFromLegacy = legacyCasino.filter(s => !newIds.has(String(s.id)));

        if (strayFromLegacy.length === 0) {
          // Already fully reconciled — nothing stray sitting in the old key
          return { pr, casino: newCasino };
        }

        // Found sessions that only exist under the old key (logged via this
        // page before it was updated). Fold them into the new key — both
        // the session list AND the bookie balance delta they represent,
        // since that balance update only ever landed on the OLD key's
        // bookies object and the new key never saw it.
        const reconciled = [...newCasino, ...strayFromLegacy];
        const updatedProfile = { ...(data || { bank: 0, bookies: {}, transactions: [], freeBets: [] }), casino: reconciled };
        if (!updatedProfile.bookies) updatedProfile.bookies = {};
        strayFromLegacy.forEach(s => {
          const net = (s.startBal !== undefined && s.endBal !== undefined)
            ? (s.endBal - s.startBal)
            : (s.netProfit || 0);
          if (!updatedProfile.bookies[s.casino]) updatedProfile.bookies[s.casino] = { bal: 0, status: 'Active', notes: '' };
          updatedProfile.bookies[s.casino].bal = (updatedProfile.bookies[s.casino].bal || 0) + net;
          updatedProfile.bookies[s.casino].balUpdatedAt = Date.now();
        });
        await kvSet(`edgetrack_${pr}`, updatedProfile);

        return { pr, casino: reconciled };
      })
    );

    const result = {};
    profileData.forEach(({ pr, casino }) => {
      result[pr] = { casino };
    });

    return res.status(200).json({ ok: true, data: result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
