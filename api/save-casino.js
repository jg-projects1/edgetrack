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

    const profiles = ['me', 'wife', 'bp', 'rq'];
    const merged = JSON.parse(JSON.stringify(server));

    profiles.forEach(pr => {
      if (!merged[pr]) merged[pr] = { casino: [] };
      if (!incoming[pr]) return;

      const serverSessions = server[pr]?.casino || [];
      const incomingSessions = incoming[pr]?.casino || [];

      // Split server sessions by operator
      const serverJG = serverSessions.filter(s => s.operator === 'JG');
      const serverJP = serverSessions.filter(s => s.operator === 'JP');
      const incomingJG = incomingSessions.filter(s => s.operator === 'JG');
      const incomingJP = incomingSessions.filter(s => s.operator === 'JP');

      // Determine which operator this client is working with
      const hasIncomingJG = incomingJG.length > 0;
      const hasIncomingJP = incomingJP.length > 0;
      const hasServerJG = serverJG.length > 0;
      const hasServerJP = serverJP.length > 0;

      // Merge each operator's sessions independently
      // If incoming has sessions for an operator, merge them
      // If incoming has NO sessions for an operator but server does, keep server's
      let mergedJG, mergedJP;

      if (hasIncomingJG || !hasServerJG) {
        // Merge JG sessions
        const serverMap = new Map(serverJG.map(s => [s.id, s]));
        const incomingMap = new Map(incomingJG.map(s => [s.id, s]));
        const allIds = new Set([...serverMap.keys(), ...incomingMap.keys()]);
        mergedJG = [];
        allIds.forEach(id => {
          const ss = serverMap.get(id);
          const is = incomingMap.get(id);
          if (!is) {
            // Only drop if this client had JG sessions (explicit delete)
            if (hasIncomingJG) return;
            mergedJG.push(ss);
          } else if (!ss) {
            mergedJG.push(is);
          } else {
            mergedJG.push(is);
          }
        });
      } else {
        // Keep all server JG sessions untouched
        mergedJG = serverJG;
      }

      if (hasIncomingJP || !hasServerJP) {
        // Merge JP sessions
        const serverMap = new Map(serverJP.map(s => [s.id, s]));
        const incomingMap = new Map(incomingJP.map(s => [s.id, s]));
        const allIds = new Set([...serverMap.keys(), ...incomingMap.keys()]);
        mergedJP = [];
        allIds.forEach(id => {
          const ss = serverMap.get(id);
          const is = incomingMap.get(id);
          if (!is) {
            if (hasIncomingJP) return;
            mergedJP.push(ss);
          } else if (!ss) {
            mergedJP.push(is);
          } else {
            mergedJP.push(is);
          }
        });
      } else {
        // Keep all server JP sessions untouched
        mergedJP = serverJP;
      }

      merged[pr].casino = [...mergedJG, ...mergedJP];
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
