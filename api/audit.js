export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;

    const [sportsRes, casinoRes] = await Promise.all([
      fetch(`${kvUrl}/get/edgetrack_audit`, { headers: { Authorization: `Bearer ${kvToken}` } }),
      fetch(`${kvUrl}/get/edgetrack_casino_audit`, { headers: { Authorization: `Bearer ${kvToken}` } })
    ]);

    let sportsAudit = [];
    let casinoAudit = [];

    if (sportsRes.ok) {
      const d = await sportsRes.json();
      if (d.result) { let p = JSON.parse(d.result); if (typeof p === 'string') p = JSON.parse(p); sportsAudit = p; }
    }
    if (casinoRes.ok) {
      const d = await casinoRes.json();
      if (d.result) { let p = JSON.parse(d.result); if (typeof p === 'string') p = JSON.parse(p); casinoAudit = p; }
    }

    // Merge and sort by timestamp descending
    const merged = [
      ...sportsAudit.map(e => ({ ...e, type: 'sports' })),
      ...casinoAudit.map(e => ({ ...e, type: 'casino' }))
    ].sort((a, b) => new Date(b.ts) - new Date(a.ts)).slice(0, 100);

    return res.status(200).json({ ok: true, entries: merged });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
