export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    const body = req.body;
    const response = await fetch(`${kvUrl}/set/edgetrack_main`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${kvToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(JSON.stringify(body))
    });
    if (!response.ok) throw new Error(`KV error: ${response.status}`);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Save error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
