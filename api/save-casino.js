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

    const kvGet = async (key) => {
      const r = await fetch(`${kvUrl}/get/${key}`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      if (!r.ok) return null;
      const d = await r.json();
      if (!d.result) return null;
      let parsed = JSON.parse(d.result);
      if (typeof parsed === 'string') parsed = JSON.parse(parsed);
      return parsed;
    };

    const kvSet = async (key, value) => {
      const r = await fetch(`${kvUrl}/set/${key}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(JSON.stringify(value))
      });
      if (!r.ok) throw new Error(`KV set error on ${key}: ${r.status}`);
    };

    // Process each profile independently using split keys
    await Promise.all(profiles.map(async pr => {
      if (!incoming[pr]) return;

      // Load this profile's sports data from split key
      const sportKey = `edgetrack_${pr}`;
      const sportsData = await kvGet(sportKey) || { bank: 0, bookies: {}, transactions: [], freeBets: [] };

      const serverSessions = sportsData.casino || [];
      const incomingSessions = incoming[pr]?.casino || [];
      const deletedIds = new Set((incoming[pr]?.deletedIds || []).map(String));

      // Find new sessions to apply balance changes
      const serverIds = new Set(serverSessions.map(s => String(s.id)));
      const newSessions = incomingSessions.filter(s => !serverIds.has(String(s.id)));
      const deletedSessions = serverSessions.filter(s => deletedIds.has(String(s.id)));

      // Apply new session balance changes to bookie balances
      newSessions.forEach(s => {
        const casino = s.casino;
        const net = (s.startBal !== undefined && s.endBal !== undefined)
          ? (s.endBal - s.startBal)
          : (s.netProfit || 0);
        if (!sportsData.bookies[casino]) sportsData.bookies[casino] = { bal: 0, status: 'Active', notes: '' };
        sportsData.bookies[casino].bal = (sportsData.bookies[casino].bal || 0) + net;
        sportsData.bookies[casino].balUpdatedAt = Date.now();
      });

      // Reverse deleted session balance changes
      deletedSessions.forEach(s => {
        const casino = s.casino;
        const net = (s.startBal !== undefined && s.endBal !== undefined)
          ? (s.endBal - s.startBal)
          : (s.netProfit || 0);
        if (!sportsData.bookies[casino]) sportsData.bookies[casino] = { bal: 0, status: 'Active', notes: '' };
        sportsData.bookies[casino].bal = (sportsData.bookies[casino].bal || 0) - net;
        sportsData.bookies[casino].balUpdatedAt = Date.now();
      });

      // Merge casino sessions
      const serverMap = new Map(serverSessions.map(s => [String(s.id), s]));
      const incomingMap = new Map(incomingSessions.map(s => [String(s.id), s]));
      const allIds = new Set([...serverMap.keys(), ...incomingMap.keys()]);
      const mergedSessions = [];
      allIds.forEach(id => {
        if (deletedIds.has(id)) return;
        const ss = serverMap.get(id);
        const is = incomingMap.get(id);
        mergedSessions.push(is || ss);
      });

      sportsData.casino = mergedSessions;

      // Save updated profile back to its split key
      await kvSet(sportKey, sportsData);
    }));

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
