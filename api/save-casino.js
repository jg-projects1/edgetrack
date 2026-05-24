export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    const incoming = req.body;

    // Load current casino state
    const loadRes = await fetch(`${kvUrl}/get/edgetrack_casino`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    let server = {};
    if (loadRes.ok) {
      const loadData = await loadRes.json();
      if (loadData.result) {
        let parsed = JSON.parse(loadData.result);
        if (typeof parsed === 'string') parsed = JSON.parse(parsed);
        server = parsed;
      }
    }

    // Server-side merge of casino sessions only
    const profiles = ['me', 'wife', 'bp', 'rq'];
    const merged = JSON.parse(JSON.stringify(server));

    profiles.forEach(pr => {
      if (!merged[pr]) merged[pr] = { casino: [] };
      if (!incoming[pr]) return;

      const serverCasinoMap = new Map((server[pr]?.casino || []).map(s => [s.id, s]));
      const incomingCasinoMap = new Map((incoming[pr]?.casino || []).map(s => [s.id, s]));
      const incomingHasCasino = (incoming[pr]?.casino || []).length > 0;

      if (incomingHasCasino) {
        const allIds = new Set([...serverCasinoMap.keys(), ...incomingCasinoMap.keys()]);
        const mergedCasino = [];
        allIds.forEach(id => {
          const serverS = serverCasinoMap.get(id);
          const incomingS = incomingCasinoMap.get(id);
          if (!incomingS) {
            if (incomingHasCasino) return; // deleted locally
            mergedCasino.push(serverS);
          } else if (!serverS) {
            mergedCasino.push(incomingS); // new session
          } else {
            mergedCasino.push(incomingS); // incoming wins
          }
        });
        merged[pr].casino = mergedCasino;
      }
      // If incoming has no casino sessions, keep server sessions untouched
    });

    const jsonString = JSON.stringify(merged);
    const saveRes = await fetch(`${kvUrl}/set/edgetrack_casino`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${kvToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(jsonString)
    });
    if (!saveRes.ok) throw new Error(`KV save error: ${saveRes.status}`);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Save casino error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
