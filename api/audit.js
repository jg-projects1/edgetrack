export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    const response = await fetch(`${kvUrl}/get/edgetrack_audit`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    if (!response.ok) throw new Error(`KV error: ${response.status}`);
    const data = await response.json();
    if (data.result) {
      let parsed = JSON.parse(data.result);
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
      // Show in reverse chronological order
      return res.status(200).json({ ok: true, entries: parsed.reverse() });
    }
    return res.status(200).json({ ok: true, entries: [] });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
