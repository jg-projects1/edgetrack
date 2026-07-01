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
    const [casinoLoadRes, sportsLoadRes] = await Promise.all([
      fetch(`${kvUrl}/get/edgetrack_casino`, { headers: { Authorization: `Bearer ${kvToken}` } }),
      fetch(`${kvUrl}/get/edgetrack_main`, { headers: { Authorization: `Bearer ${kvToken}` } })
    ]);

    let server = {};
    if (casinoLoadRes.ok) {
      const d = await casinoLoadRes.json();
      if (d.result) { let p = JSON.parse(d.result); if (typeof p === 'string') p = JSON.parse(p); server = p; }
    }

    let sportsServer = {};
    if (sportsLoadRes.ok) {
      const d = await sportsLoadRes.json();
      if (d.result) { let p = JSON.parse(d.result); if (typeof p === 'string') p = JSON.parse(p); sportsServer = p; }
    }

    const profiles = ['me', 'wife', 'bp', 'rq'];
    const mergedCasino = JSON.parse(JSON.stringify(server));
    const mergedSports = JSON.parse(JSON.stringify(sportsServer));

    profiles.forEach(pr => {
      if (!mergedCasino[pr]) mergedCasino[pr] = { casino: [] };
      if (!incoming[pr]) return;

      const serverSessions = server[pr]?.casino || [];
      const incomingSessions = incoming[pr]?.casino || [];
      const deletedIds = new Set((incoming[pr]?.deletedIds || []).map(String));

      // Find truly new sessions (not on server) to apply balance changes
      const serverIds = new Set(serverSessions.map(s => String(s.id)));
      const newSessions = incomingSessions.filter(s => !serverIds.has(String(s.id)));
      const deletedSessions = serverSessions.filter(s => deletedIds.has(String(s.id)));

      // Apply new session balance changes to sports/main state
      if (!mergedSports[pr]) mergedSports[pr] = { bank: 0, bookies: {}, transactions: [] };
      newSessions.forEach(s => {
        const casino = s.casino;
        const net = s.netProfit || 0;
        const deposit = s.deposit || 0;
        if (!mergedSports[pr].bookies[casino]) mergedSports[pr].bookies[casino] = { bal: 0, status: 'Active', notes: '' };
        if (deposit > 0) {
          mergedSports[pr].bank -= deposit;
          mergedSports[pr].bookies[casino].bal += deposit;
        }
        mergedSports[pr].bookies[casino].bal += net;
      });

      // Reverse deleted session balance changes
      deletedSessions.forEach(s => {
        const casino = s.casino;
        const net = s.netProfit || 0;
        const deposit = s.deposit || 0;
        if (!mergedSports[pr].bookies) mergedSports[pr].bookies = {};
        if (!mergedSports[pr].bookies[casino]) mergedSports[pr].bookies[casino] = { bal: 0, status: 'Active', notes: '' };
        if (deposit > 0) {
          mergedSports[pr].bank += deposit;
          mergedSports[pr].bookies[casino].bal -= deposit;
        }
        mergedSports[pr].bookies[casino].bal -= net;
      });

      // Additive merge for casino sessions
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
      mergedCasino[pr].casino = mergedSessions;
    });

    // Save both keys in parallel
    const [casinoSaveRes, sportsSaveRes] = await Promise.all([
      fetch(`${kvUrl}/set/edgetrack_casino`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(JSON.stringify(mergedCasino))
      }),
      fetch(`${kvUrl}/set/edgetrack_main`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(JSON.stringify(mergedSports))
      })
    ]);

    if (!casinoSaveRes.ok) throw new Error(`Casino KV save error: ${casinoSaveRes.status}`);
    if (!sportsSaveRes.ok) throw new Error(`Sports KV save error: ${sportsSaveRes.status}`);

    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Save casino error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
