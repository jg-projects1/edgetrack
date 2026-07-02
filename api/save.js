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
      const serverCount = serverTxs.length;
      const incomingCount = incomingTxs.length;

      // Safety: if incoming has far fewer transactions than server,
      // treat as stale client — only add new, apply settlements, never drop
      const isStaleDrop = serverCount > 10 && incomingCount < serverCount * 0.5;

      if (isStaleDrop || incomingCount === 0) {
        // Keep all server transactions, only add new ones and apply settlements
        const incomingMap = new Map(incomingTxs.map(t => [String(t.id), t]));
        merged[pr].transactions = serverTxs.map(serverTx => {
          const incomingTx = incomingMap.get(String(serverTx.id));
          if (incomingTx && incomingTx.result !== 'Pending' && serverTx.result === 'Pending') {
            return incomingTx;
          }
          if (incomingTx && incomingTx.pnl !== serverTx.pnl) {
            return incomingTx; // pnl edit
          }
          return serverTx;
        });
        // Add brand new transactions not on server
        const serverIds = new Set(serverTxs.map(t => String(t.id)));
        const newTxs = incomingTxs.filter(t => !serverIds.has(String(t.id)));
        merged[pr].transactions = [...merged[pr].transactions, ...newTxs];
      } else {
        // Normal merge — additive by ID, explicit deletes via deletedIds
        const deletedIds = new Set((incoming[pr]?.deletedIds || []).map(String));
        const serverMap = new Map(serverTxs.map(t => [String(t.id), t]));
        const incomingMap = new Map(incomingTxs.map(t => [String(t.id), t]));
        const allIds = new Set([...serverMap.keys(), ...incomingMap.keys()]);
        const mergedTxs = [];
        allIds.forEach(id => {
          if (deletedIds.has(id)) return;
          const serverTx = serverMap.get(id);
          const incomingTx = incomingMap.get(id);
          if (incomingTx) {
            // Prefer settled over pending
            if (serverTx && serverTx.result !== 'Pending' && incomingTx.result === 'Pending') {
              mergedTxs.push(serverTx);
            } else {
              mergedTxs.push(incomingTx);
            }
          } else if (serverTx) {
            mergedTxs.push(serverTx);
          }
        });
        merged[pr].transactions = mergedTxs;
      }

      // Balances: always use incoming regardless of stale check
      // Bank and bookies reflect the most recent action on this device
      if (incoming[pr].bank !== undefined) merged[pr].bank = incoming[pr].bank;
      if (incoming[pr].bookies && Object.keys(incoming[pr].bookies).length > 0) {
        // Merge bookies: keep server bookies not in incoming, update ones that are
        const serverBookies = server[pr]?.bookies || {};
        const incomingBookies = incoming[pr].bookies;
        const mergedBookies = { ...serverBookies };
        Object.keys(incomingBookies).forEach(bk => {
          mergedBookies[bk] = incomingBookies[bk];
        });
        merged[pr].bookies = mergedBookies;
      }
    });

    if (incoming.exchanges) merged.exchanges = incoming.exchanges;

    // Log save audit entry
    const auditEntry = {
      ts: new Date().toISOString(),
      counts: Object.fromEntries(profiles.map(pr => [pr, merged[pr]?.transactions?.length || 0]))
    };
    // Keep last 50 audit entries
    let audit = [];
    try {
      const auditRes = await fetch(`${kvUrl}/get/edgetrack_audit`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      if (auditRes.ok) {
        const auditData = await auditRes.json();
        if (auditData.result) audit = JSON.parse(auditData.result);
        if (typeof audit === 'string') audit = JSON.parse(audit);
      }
    } catch(e) {}
    audit.push(auditEntry);
    if (audit.length > 50) audit = audit.slice(-50);

    const jsonString = JSON.stringify(merged);
    const [saveRes] = await Promise.all([
      fetch(`${kvUrl}/set/edgetrack_main`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(jsonString)
      }),
      fetch(`${kvUrl}/set/edgetrack_audit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(JSON.stringify(audit))
      })
    ]);

    if (!saveRes.ok) throw new Error(`KV save error: ${saveRes.status}`);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Save error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
