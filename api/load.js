// v2 - split KV
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    const profiles = ['me', 'wife', 'bp', 'rq'];

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

    // Load all profiles in parallel
    const [profileData, exchanges] = await Promise.all([
      Promise.all(profiles.map(async pr => {
        const data = await kvGet(`edgetrack_${pr}`);
        return { pr, data };
      })),
      kvGet('edgetrack_exchanges')
    ]);

    // Check if split keys exist
    const hasSplitData = profileData.some(p => p.data !== null);

    if (hasSplitData) {
      // New split format
      const result = { exchanges: exchanges || {} };
      profileData.forEach(({ pr, data }) => {
        result[pr] = data || { transactions: [], bank: 0, bookies: {}, freeBets: [] };
      });
      return res.status(200).json({ ok: true, data: result });
    }

    // Fall back to legacy single key
    const legacy = await kvGet('edgetrack_main');
    if (legacy) {
      return res.status(200).json({ ok: true, data: legacy });
    }

    return res.status(200).json({ ok: true, data: null });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
