// Casino data now lives inside each profile's split key
// This endpoint reads casino sessions from edgetrack_{pr} keys
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

    // Load casino sessions from each profile's split key
    const profileData = await Promise.all(
      profiles.map(async pr => {
        const data = await kvGet(`edgetrack_${pr}`);
        return { pr, casino: data?.casino || [] };
      })
    );

    // Build response in same format app expects
    const result = {};
    profileData.forEach(({ pr, casino }) => {
      result[pr] = { casino };
    });

    return res.status(200).json({ ok: true, data: result });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
