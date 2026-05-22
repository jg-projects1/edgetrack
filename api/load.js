export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    const response = await fetch(`${kvUrl}/get/edgetrack_main`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    if (!response.ok) throw new Error(`KV error: ${response.status}`);
    const data = await response.json();
    if (data.result) {
      let parsed = JSON.parse(data.result);
      // Handle double-encoded data (string inside string)
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
      return res.status(200).json({ ok: true, data: parsed });
    } else {
      return res.status(200).json({ ok: true, data: null });
    }
  } catch (e) {
    console.error('Load error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
