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

      // ADDITIVE MERGE: never lose a session that exists on the server,
      // regardless of operator or staleness. Union by ID.
      // - Sessions on server but not in incoming: KEEP (could be from another device/operator)
      // - Sessions in incoming but not on server: ADD (new session)
      // - Sessions in both: incoming wins (handles edits like "add bonus")
      // - True deletes are handled by an explicit deletedIds list from the client (see below)

      const serverMap = new Map(serverSessions.map(s => [String(s.id), s]));
      const incomingMap = new Map(incomingSessions.map(s => [String(s.id), s]));
      const deletedIds = new Set((incoming[pr]?.deletedIds || []).map(String));

      const allIds = new Set([...serverMap.keys(), ...incomingMap.keys()]);
      const mergedSessions = [];

      allIds.forEach(id => {
        if (deletedIds.has(id)) return; // explicitly deleted — drop from both
        const ss = serverMap.get(id);
        const is = incomingMap.get(id);
        if (is) {
          mergedSessions.push(is); // incoming version wins (new or edited)
        } else if (ss) {
          mergedSessions.push(ss); // only on server — keep it (don't lose it)
        }
      });

      merged[pr].casino = mergedSessions;
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
