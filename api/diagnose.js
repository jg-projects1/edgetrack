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

    // By operator (JG vs JP) within the LIVE split keys — this is the
    // piece the plain per-profile counts above can't show. Sessions
    // with no operator field at all default to JG (matches how the
    // rest of the app treats missing operator data).
    report.by_operator = {};
    profiles.forEach((pr, i) => {
      const sessions = splitKeys[i]?.casino || [];
      const jgSessions = sessions.filter(s => !s.operator || s.operator === 'JG');
      const jpSessions = sessions.filter(s => s.operator === 'JP');
      report.by_operator[pr] = {
        JG: analyseSessions(jgSessions),
        JP: analyseSessions(jpSessions)
      };
    });

    // Daily breakdown by operator, LIVE split keys only — reads jg/hg
    // directly rather than the frozen edgetrack_me/edgetrack_wife keys,
    // so this is accurate for all four profiles, not just bp/rq.
    // Filterable by month via ?month=09&year=2026 (defaults to current
    // month if not specified).
    const now = new Date();
    const targetMonth = String(req.query?.month || (now.getMonth() + 1)).padStart(2, '0');
    const targetYear = String(req.query?.year || now.getFullYear());
    report.daily_by_operator = {};
    profiles.forEach((pr, i) => {
      const sessions = splitKeys[i]?.casino || [];
      const daily = {};
      sessions.forEach(s => {
        const parts = (s.date || '').split('/');
        if (parts.length !== 3) return;
        const [dd, mm, yyyy] = parts;
        if (mm !== targetMonth || yyyy !== targetYear) return;
        const op = s.operator === 'JP' ? 'JP' : 'JG';
        if (!daily[s.date]) daily[s.date] = { JG: { count: 0, pnl: 0 }, JP: { count: 0, pnl: 0 } };
        daily[s.date][op].count += 1;
        daily[s.date][op].pnl += sessionPnl(s);
      });
      // Round and sort chronologically by day-of-month
      const sortedDays = Object.keys(daily).sort((a, b) => parseInt(a.split('/')[0]) - parseInt(b.split('/')[0]));
      const dailyRounded = {};
      sortedDays.forEach(d => {
        dailyRounded[d] = {
          JG: { count: daily[d].JG.count, pnl: Math.round(daily[d].JG.pnl * 100) / 100 },
          JP: { count: daily[d].JP.count, pnl: Math.round(daily[d].JP.pnl * 100) / 100 }
        };
      });
      report.daily_by_operator[pr] = dailyRounded;
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
