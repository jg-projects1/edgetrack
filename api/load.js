// v5 - safe split KV, no silent failures
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    const profiles = ['me', 'wife', 'bp', 'rq'];

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

    // Load all profiles in parallel. If ANY fetch throws, Promise.all
    // rejects and we fall into the catch block below with a proper 500 —
    // we never silently substitute a blank profile for a failed fetch.
    const [profileData, exchanges] = await Promise.all([
      Promise.all(profiles.map(async pr => {
        const data = await kvGet(`edgetrack_${pr}`);
        return { pr, data };
      })),
      kvGet('edgetrack_exchanges')
    ]);

    const hasSplitData = profileData.some(p => p.data !== null);
    if (hasSplitData) {
      const result = { exchanges: exchanges || {} };
      profileData.forEach(({ pr, data }) => {
        result[pr] = data || { transactions: [], bank: 0, bookies: {}, freeBets: [], casino: [] };
      });
      return res.status(200).json({ ok: true, data: result });
    }

    // Fall back to legacy single key ONLY if every split key was
    // genuinely empty (not a fetch failure — those already threw above).
    const legacy = await kvGet('edgetrack_main');
    if (legacy) {
      return res.status(200).json({ ok: true, data: legacy });
    }
    return res.status(200).json({ ok: true, data: null });
  } catch (e) {
    console.error('Load error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
