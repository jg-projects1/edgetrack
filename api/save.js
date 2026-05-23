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

    // Step 1: Load current server state
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

    // Step 2: Server-side merge — server state is base, apply incoming changes
    const profiles = ['me', 'wife', 'bp', 'rq'];
    const merged = JSON.parse(JSON.stringify(server));

    profiles.forEach(pr => {
      if (!merged[pr]) merged[pr] = { transactions: [], casino: [], bank: 0, bookies: {} };
      if (!incoming[pr]) return; // no changes for this profile

      const serverTxMap = new Map((server[pr]?.transactions || []).map(t => [t.id, t]));
      const incomingTxMap = new Map((incoming[pr]?.transactions || []).map(t => [t.id, t]));
      const incomingHasTxs = (incoming[pr]?.transactions || []).length > 0;
      const serverHasTxs = (server[pr]?.transactions || []).length > 0;

      if (incomingHasTxs || !serverHasTxs) {
        // Merge transactions: server is base
        const allTxIds = new Set([...serverTxMap.keys(), ...incomingTxMap.keys()]);
        const mergedTxs = [];
        allTxIds.forEach(id => {
          const serverTx = serverTxMap.get(id);
          const incomingTx = incomingTxMap.get(id);
          if (!incomingTx) {
            // On server but not incoming — only drop if incoming has data (explicit delete)
            // If incoming has no txs at all, keep server tx
            if (incomingHasTxs) return; // was deleted locally
            mergedTxs.push(serverTx); // keep server tx
          } else if (!serverTx) {
            mergedTxs.push(incomingTx); // new local tx
          } else {
            // Both have it — prefer settled over pending
            if (incomingTx.result !== 'Pending' && serverTx.result === 'Pending') {
              mergedTxs.push(incomingTx); // incoming settled it
            } else if (serverTx.result !== 'Pending' && incomingTx.result === 'Pending') {
              mergedTxs.push(serverTx); // server already settled, keep it
            } else {
              mergedTxs.push(incomingTx); // default: incoming wins
            }
          }
        });
        merged[pr].transactions = mergedTxs;
      }
      // If incoming has NO transactions but server does — keep server transactions untouched

      // Casino sessions: same logic
      const serverCasinoMap = new Map((server[pr]?.casino || []).map(s => [s.id, s]));
      const incomingCasinoMap = new Map((incoming[pr]?.casino || []).map(s => [s.id, s]));
      const incomingHasCasino = (incoming[pr]?.casino || []).length > 0;
      const serverHasCasino = (server[pr]?.casino || []).length > 0;

      if (incomingHasCasino || !serverHasCasino) {
        const allCasinoIds = new Set([...serverCasinoMap.keys(), ...incomingCasinoMap.keys()]);
        const mergedCasino = [];
        allCasinoIds.forEach(id => {
          const serverS = serverCasinoMap.get(id);
          const incomingS = incomingCasinoMap.get(id);
          if (!incomingS) {
            if (incomingHasCasino) return; // deleted locally
            mergedCasino.push(serverS);
          } else if (!serverS) {
            mergedCasino.push(incomingS); // new
          } else {
            mergedCasino.push(incomingS); // incoming wins
          }
        });
        merged[pr].casino = mergedCasino;
      }

      // Balances: only update if incoming has data for this profile
      merged[pr].bank = incoming[pr].bank ?? server[pr]?.bank ?? 0;
      merged[pr].bookies = incoming[pr].bookies || server[pr]?.bookies || {};
    });

    // Exchanges
    if (incoming.exchanges) merged.exchanges = incoming.exchanges;

    // Step 3: Save merged state
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
