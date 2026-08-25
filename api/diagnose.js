// Diagnostic endpoint - reads all casino data and returns counts + P&L
// GET /api/diagnose
// v2 - fixed analyseessions/analysesessions naming mismatch (was throwing
// on every call), and renamed profile keys (me->jg, wife->hg) to match
// the main app so this actually inspects live data, not frozen old keys.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    const profiles = ['jg', 'hg', 'bp', 'rq'];

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

    const analyseSessions = (sessions) => {
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

    // Read all keys — both new (jg/hg/bp/rq) split keys AND the old
    // frozen edgetrack_casino/edgetrack_main keys, for comparison.
    const [casinoKey, mainKey, ...splitKeys] = await Promise.all([
      kvGet('edgetrack_casino'),
      kvGet('edgetrack_main'),
      ...profiles.map(pr => kvGet(`edgetrack_${pr}`))
    ]);

    const report = {};

    // edgetrack_casino — this legacy key still uses old me/wife naming
    // internally (it predates the rename entirely), so we read it via
    // the OLD key names here specifically for this comparison.
    report.edgetrack_casino = {};
    const LEGACY_PROFILE_KEYS = { jg: 'me', hg: 'wife', bp: 'bp', rq: 'rq' };
    profiles.forEach(pr => {
      const legacyKey = LEGACY_PROFILE_KEYS[pr];
      const sessions = casinoKey?.[legacyKey]?.casino || [];
      report.edgetrack_casino[pr] = analyseSessions(sessions);
    });

    // edgetrack_main — same story, predates the rename
    report.edgetrack_main = {};
    profiles.forEach(pr => {
      const legacyKey = LEGACY_PROFILE_KEYS[pr];
      const sessions = mainKey?.[legacyKey]?.casino || [];
      report.edgetrack_main[pr] = analyseSessions(sessions);
    });

    // split keys — these are the LIVE keys the main app actually reads
    report.split_keys = {};
    profiles.forEach((pr, i) => {
      const sessions = splitKeys[i]?.casino || [];
      report.split_keys[pr] = analyseSessions(sessions);
    });

    // Sample first session from each source for JG
    const sampleCasino = casinoKey?.me?.casino?.[0];
    const sampleSplit = splitKeys[0]?.casino?.[0];

    return res.status(200).json({
      ok: true,
      report,
      samples: {
        casinoKey_jg_first: sampleCasino,
        splitKey_jg_first: sampleSplit
      }
    });
  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
