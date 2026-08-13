// Diagnostic endpoint - reads all casino data and returns counts + P&L
// GET /api/diagnose
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    const profiles = ['me', 'wife', 'bp', 'rq'];

    const kvGet = async (key) => {
      try {
        const r = await fetch(`${kvUrl}/get/${key}`, {
          headers: { Authorization: `Bearer ${kvToken}` }
        });
        if (!r.ok) return null;
        const d = await r.json();
        if (!d.result) return null;
        let parsed = JSON.parse(d.result);
        if (typeof parsed === 'string') parsed = JSON.parse(parsed);
        return parsed;
      } catch(e) { return null; }
    };

    const sessionPnl = (s) => {
      if (s.startBal !== undefined && s.endBal !== undefined && (s.startBal !== 0 || s.endBal !== 0)) {
        return s.endBal - s.startBal;
      }
      return s.netProfit || 0;
    };

    const analysesessions = (sessions) => {
      if (!sessions || !sessions.length) return { count: 0, pnl: 0, withNetProfit: 0, withBalances: 0, zeroPnl: 0 };
      let pnl = 0, withNetProfit = 0, withBalances = 0, zeroPnl = 0;
      sessions.forEach(s => {
        const p = sessionPnl(s);
        pnl += p;
        if (p === 0) zeroPnl++;
        if (s.netProfit !== undefined) withNetProfit++;
        if (s.startBal !== undefined) withBalances++;
      });
      return { count: sessions.length, pnl: Math.round(pnl*100)/100, withNetProfit, withBalances, zeroPnl };
    };

    // Read all keys
    const [casinoKey, mainKey, ...splitKeys] = await Promise.all([
      kvGet('edgetrack_casino'),
      kvGet('edgetrack_main'),
      ...profiles.map(pr => kvGet(`edgetrack_${pr}`))
    ]);

    const report = {};

    // edgetrack_casino
    report.edgetrack_casino = {};
    profiles.forEach(pr => {
      const sessions = casinoKey?.[pr]?.casino || [];
      report.edgetrack_casino[pr] = analyseessions(sessions);
    });

    // edgetrack_main
    report.edgetrack_main = {};
    profiles.forEach(pr => {
      const sessions = mainKey?.[pr]?.casino || [];
      report.edgetrack_main[pr] = analyseessions(sessions);
    });

    // split keys
    report.split_keys = {};
    profiles.forEach((pr, i) => {
      const sessions = splitKeys[i]?.casino || [];
      report.split_keys[pr] = analyseessions(sessions);
    });

    // Sample first session from each source for JG
    const sampleCasino = casinoKey?.me?.casino?.[0];
    const sampleSplit = splitKeys[0]?.casino?.[0];

    return res.status(200).json({
      ok: true,
      report,
      samples: {
        casinoKey_me_first: sampleCasino,
        splitKey_me_first: sampleSplit
      }
    });
  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}

function analyseessions(sessions) {
  if (!sessions || !sessions.length) return { count: 0, pnl: 0, withNetProfit: 0, withBalances: 0, zeroPnl: 0 };
  const sessionPnl = (s) => {
    if (s.startBal !== undefined && s.endBal !== undefined && (s.startBal !== 0 || s.endBal !== 0)) {
      return s.endBal - s.startBal;
    }
    return s.netProfit || 0;
  };
  let pnl = 0, withNetProfit = 0, withBalances = 0, zeroPnl = 0;
  sessions.forEach(s => {
    const p = sessionPnl(s);
    pnl += p;
    if (p === 0) zeroPnl++;
    if (s.netProfit !== undefined) withNetProfit++;
    if (s.startBal !== undefined) withBalances++;
  });
  return { count: sessions.length, pnl: Math.round(pnl*100)/100, withNetProfit, withBalances, zeroPnl };
}
