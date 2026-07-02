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

    // Use client-provided server state if available (avoids stale replica reads)
    // Otherwise fall back to reading from KV
    let server = {};
    if (incoming._serverState && typeof incoming._serverState === 'object') {
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

    const profiles = ['me', 'wife', 'bp', 'rq'];
    const merged = JSON.parse(JSON.stringify(server));

    profiles.forEach(pr => {
      if (!merged[pr]) merged[pr] = { transactions: [], bank: 0, bookies: {} };
      if (!incoming[pr]) return;

      const serverTxs = server[pr]?.transactions || [];
      const incomingTxs = incoming[pr]?.transactions || [];
      // Simple additive merge — client provides lastServerState so no stale reads
      // Union of server + incoming by ID, with explicit deletes honoured
      const deletedIds = new Set((incoming[pr]?.deletedIds || []).map(String));
      const serverMap = new Map(serverTxs.map(t => [String(t.id), t]));
      const incomingMap = new Map(incomingTxs.map(t => [String(t.id), t]));
      const allIds = new Set([...serverMap.keys(), ...incomingMap.keys()]);
      const mergedTxs = [];
      allIds.forEach(id => {
        if (deletedIds.has(id)) return;
        const serverTx = serverMap.get(id);
        const incomingTx = incomingMap.get(id);
        if (incomingTx && serverTx) {
          // Both have it — prefer settled over pending
          if (serverTx.result !== 'Pending' && incomingTx.result === 'Pending') {
            mergedTxs.push(serverTx);
          } else {
            mergedTxs.push(incomingTx);
          }
        } else if (incomingTx) {
          mergedTxs.push(incomingTx); // new transaction
        } else if (serverTx) {
          mergedTxs.push(serverTx); // only on server — keep it
        }
      });
      merged[pr].transactions = mergedTxs;

      // Always apply incoming balances
      if (incoming[pr].bank !== undefined) merged[pr].bank = incoming[pr].bank;
      if (incoming[pr].bookies && Object.keys(incoming[pr].bookies).length > 0) {
        const serverBookies = server[pr]?.bookies || {};
        const mergedBookies = { ...serverBookies, ...incoming[pr].bookies };
        merged[pr].bookies = mergedBookies;
      }
    });

    if (incoming.exchanges) merged.exchanges = incoming.exchanges;

    // Save to KV
    const jsonString = JSON.stringify(merged);
    const saveRes = await fetch(`${kvUrl}/set/edgetrack_main`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(jsonString)
    });
    if (!saveRes.ok) throw new Error(`KV save error: ${saveRes.status}`);

    // Read back to verify what was actually saved
    const verifyRes = await fetch(`${kvUrl}/get/edgetrack_main`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    let verifiedBanks = {};
    let verifiedCounts = {};
    if (verifyRes.ok) {
      const vd = await verifyRes.json();
      if (vd.result) {
        let vp = JSON.parse(vd.result);
        if (typeof vp === 'string') vp = JSON.parse(vp);
        verifiedBanks = Object.fromEntries(profiles.map(pr => [pr, vp[pr]?.bank || 0]));
        verifiedCounts = Object.fromEntries(profiles.map(pr => [pr, vp[pr]?.transactions?.length || 0]));
      }
    }

    // Log audit AFTER verified save
    const auditEntry = {
      ts: new Date().toISOString(),
      source: incoming._source || 'unknown',
      counts: verifiedCounts,
      banks: verifiedBanks,
      intended_counts: Object.fromEntries(profiles.map(pr => [pr, merged[pr]?.transactions?.length || 0])),
      intended_banks: Object.fromEntries(profiles.map(pr => [pr, merged[pr]?.bank || 0])),
      incoming_counts: Object.fromEntries(profiles.map(pr => [pr, incoming[pr]?.transactions?.length || 0])),
      incoming_banks: Object.fromEntries(profiles.map(pr => [pr, incoming[pr]?.bank]))
    };

    let audit = [];
    try {
      const auditRes = await fetch(`${kvUrl}/get/edgetrack_audit`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      if (auditRes.ok) {
        const auditData = await auditRes.json();
        if (auditData.result) {
          audit = JSON.parse(auditData.result);
          if (typeof audit === 'string') audit = JSON.parse(audit);
        }
      }
    } catch(e) {}
    audit.push(auditEntry);
    if (audit.length > 100) audit = audit.slice(-100);
    await fetch(`${kvUrl}/set/edgetrack_audit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(JSON.stringify(audit))
    });

    return res.status(200).json({ ok: true, data: merged });
  } catch (e) {
    console.error('Save error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
