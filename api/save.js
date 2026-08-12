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
    const profiles = ['me', 'wife', 'bp', 'rq'];

    // Use client-provided server state to avoid stale KV reads
    let server = {};
    if (incoming._serverState && typeof incoming._serverState === 'object' && Object.keys(incoming._serverState).length > 0) {
      server = incoming._serverState;
    } else {
      const loadRes = await fetch(`${kvUrl}/get/edgetrack_main`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      if (!loadRes.ok) throw new Error(`KV load error: ${loadRes.status}`);
      const loadData = await loadRes.json();
      if (loadData.result) {
        let parsed = JSON.parse(loadData.result);
        if (typeof parsed === 'string') parsed = JSON.parse(parsed);
        server = parsed;
      }
    }

    const merged = JSON.parse(JSON.stringify(server));

    profiles.forEach(pr => {
      if (!merged[pr]) merged[pr] = { transactions: [], bank: 0, bookies: {} };
      if (!incoming[pr]) return;

      // Merge transactions — union by ID, respect deletes, prefer settled over pending
      const serverTxs = server[pr]?.transactions || [];
      const incomingTxs = incoming[pr]?.transactions || [];
      const deletedIds = new Set((incoming[pr]?.deletedIds || []).map(String));
      const serverMap = new Map(serverTxs.map(t => [String(t.id), t]));
      const incomingMap = new Map(incomingTxs.map(t => [String(t.id), t]));
      const allIds = new Set([...serverMap.keys(), ...incomingMap.keys()]);
      const mergedTxs = [];

      allIds.forEach(id => {
        if (deletedIds.has(id)) return;
        const srv = serverMap.get(id);
        const inc = incomingMap.get(id);
        if (inc && srv) {
          // Prefer settled over pending; otherwise incoming wins
          mergedTxs.push(srv.result !== 'Pending' && inc.result === 'Pending' ? srv : inc);
        } else if (inc) {
          mergedTxs.push(inc);
        } else if (srv && !deletedIds.has(id)) {
          mergedTxs.push(srv);
        }
      });

      merged[pr].transactions = mergedTxs;
      if (incoming[pr].bank !== undefined) merged[pr].bank = incoming[pr].bank;

      // Merge freeBets
      const fbMap = new Map();
      (server[pr]?.freeBets || []).forEach(fb => fbMap.set(String(fb.id), fb));
      (incoming[pr]?.freeBets || []).forEach(fb => fbMap.set(String(fb.id), fb));
      merged[pr].freeBets = Array.from(fbMap.values());

      // Merge bookies — incoming wins
      if (incoming[pr].bookies && Object.keys(incoming[pr].bookies).length > 0) {
        merged[pr].bookies = { ...server[pr]?.bookies || {}, ...incoming[pr].bookies };
      }
    });

    if (incoming.exchanges) merged.exchanges = incoming.exchanges;

    // Save to KV
    const saveRes = await fetch(`${kvUrl}/set/edgetrack_main`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(JSON.stringify(merged))
    });
    if (!saveRes.ok) throw new Error(`KV save error: ${saveRes.status}`);

    return res.status(200).json({ ok: true, data: merged });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
