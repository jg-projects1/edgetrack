export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;

    const fetchData = async () => {
      const response = await fetch(`${kvUrl}/get/edgetrack_main`, {
        headers: { Authorization: `Bearer ${kvToken}`, 'Cache-Control': 'no-cache, no-store' }
      });
      if (!response.ok) throw new Error(`KV error: ${response.status}`);
      const data = await response.json();
      if (data.result) {
        let parsed = JSON.parse(data.result);
        if (typeof parsed === 'string') parsed = JSON.parse(parsed);
        return parsed;
      }
      return null;
    };

    // First read
    let parsed = await fetchData();

    // If we got data, do a second read after 300ms to get fresher replica data
    // This helps with Upstash eventual consistency lag
    await new Promise(r => setTimeout(r, 300));
    const parsed2 = await fetchData();

    // Use whichever has more transactions (fresher data)
    if (parsed2) {
      const profiles = ['me', 'wife', 'bp', 'rq'];
      const count1 = parsed ? profiles.reduce((a, p) => a + (parsed[p]?.transactions?.length || 0), 0) : 0;
      const count2 = profiles.reduce((a, p) => a + (parsed2[p]?.transactions?.length || 0), 0);
      if (count2 >= count1) parsed = parsed2;
    }

    if (parsed) {
      return res.status(200).json({ ok: true, data: parsed });
    } else {
      return res.status(200).json({ ok: true, data: null });
    }
  } catch (e) {
    console.error('Load error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
