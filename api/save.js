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

    // Load current server state
    const loadRes = await fetch(`${kvUrl}/get/edgetrack_main`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    if (!loadRes.ok) throw new Error(`KV load error: ${loadRes.status}`);
    const loadData = await loadRes.json();

    let server = {};
    if (loadData.result) {
      let parsed = JSON.parse(loadData.result);
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
      server = parsed;
    }

    const profiles = ['me', 'wife', 'bp', 'rq'];
    const merged = JSON.parse(JSON.stringify(server));

    profiles.forEach(pr => {
      if (!merged[pr]) merged[pr] = { transactions: [], bank: 0, bookies: {} };
      if (!incoming[pr]) return;

      const serverTxs = server[pr]?.transactions || [];
      const incomingTxs = incoming[pr]?.transactions || [];

      // SAFETY: if incoming has far fewer transactions than server, 
      // it's a stale client — keep all server transactions and only add new ones
      const serverCount = serverTxs.length;
      const incomingCount = incomingTxs.length;
      const isStaleDrop = serverCount > 10 && incomingCount < serverCount * 0.5;

      if (isStaleDrop) {
        // Only add genuinely new transactions from incoming
        const serverTxIds = new Set(serverTxs.map(t => t.id));
        const newTxs = incomingTxs.filter(t => !serverTxIds.has(t.id));
        // Apply updates to existing txs (settlements)
        merged[pr].transactions = serverTxs.map(serverTx => {
          const incomingTx = incomingTxs.find(t => t.id === serverTx.id);
          if (incomingTx && incomingTx.result !== 'Pending' && serverTx.result === 'Pending') {
            return incomingTx; // apply settlement
          }
          return serverTx;
        }).concat(newTxs);
      } else if (incomingCount === 0 && serverCount > 0) {
        // Incoming has no transactions but server does — keep server untouched
        merged[pr].transactions = serverTxs;
      } else {
        // Normal merge: server is base, apply incoming changes
        const serverTxMap = new Map(serverTxs.map(t => [t.id, t]));
        const incomingTxMap = new Map(incomingTxs.map(t => [t.id, t]));
        const allIds = new Set([...serverTxMap.keys(), ...incomingTxMap.keys()]);
        const mergedTxs = [];
        allIds.forEach(id => {
          const serverTx = serverTxMap.get(id);
          const incomingTx = incomingTxMap.get(id);
          if (!incomingTx) {
            // On server, not in incoming — keep unless incoming has data (explicit delete)
            if (incomingCount > 0) return; // deleted locally
            mergedTxs.push(serverTx);
          } else if (!serverTx) {
            mergedTxs.push(incomingTx); // new
          } else {
            // Prefer settled over pending
            if (incomingTx.result !== 'Pending' && serverTx.result === 'Pending') {
              mergedTxs.push(incomingTx);
            } else if (serverTx.result !== 'Pending' && incomingTx.result === 'Pending') {
              mergedTxs.push(serverTx); // server already settled, keep it
            } else {
              mergedTxs.push(incomingTx);
            }
          }
        });
        merged[pr].transactions = mergedTxs;
      }

      // Balances: only update if incoming has meaningful data
      if (incoming[pr].bank !== undefined) merged[pr].bank = incoming[pr].bank;
      if (incoming[pr].bookies && Object.keys(incoming[pr].bookies).length > 0) {
        merged[pr].bookies = incoming[pr].bookies;
      }
    });

    if (incoming.exchanges) merged.exchanges = incoming.exchanges;

    const jsonString = JSON.stringify(merged);
    const saveRes = await fetch(`${kvUrl}/set/edgetrack_main`, {
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
    console.error('Save error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
