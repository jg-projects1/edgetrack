export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    const profiles = ['me', 'wife', 'bp', 'rq'];

    const fetchData = async () => {
      const response = await fetch(`${kvUrl}/get/edgetrack_main`, {
        headers: { Authorization: `Bearer ${kvToken}`, 'Cache-Control': 'no-cache' }
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

    const countTxs = (d) => d ? profiles.reduce((a, p) => a + (d[p]?.transactions?.length || 0), 0) : 0;

    // Read the count stamp to know what the latest save produced
    let expectedCounts = null;
    try {
      const stampRes = await fetch(`${kvUrl}/get/edgetrack_stamp`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      if (stampRes.ok) {
        const stampData = await stampRes.json();
        if (stampData.result) {
          let stamp = JSON.parse(stampData.result);
          if (typeof stamp === 'string') stamp = JSON.parse(stamp);
          expectedCounts = stamp.counts;
        }
      }
    } catch(e) {}

    const expectedTotal = expectedCounts ? profiles.reduce((a, p) => a + (expectedCounts[p] || 0), 0) : 0;

    // Retry until we get data matching the expected count, or max 5 attempts
    let best = null;
    const maxAttempts = 5;
    const delays = [0, 300, 500, 700, 1000];
    
    for (let i = 0; i < maxAttempts; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, delays[i]));
      const data = await fetchData();
      const total = countTxs(data);
      if (!best || total > countTxs(best)) best = data;
      // Stop retrying if we have the expected count
      if (expectedTotal > 0 && total >= expectedTotal) break;
    }

    if (best) {
      return res.status(200).json({ ok: true, data: best });
    } else {
      return res.status(200).json({ ok: true, data: null });
    }
  } catch (e) {
    console.error('Load error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
