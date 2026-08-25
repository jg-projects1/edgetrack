// Casino restore endpoint
// POST /api/restore with casino session data
// Merges uploaded sessions with existing KV data
// v2 - profile keys renamed (me->jg, wife->hg) to match the main app
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    const profiles = ['jg', 'hg', 'bp', 'rq'];
    const incoming = req.body; // { jg: [...sessions], hg: [...], bp: [...], rq: [...] }

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

    const kvSet = async (key, value) => {
      const r = await fetch(`${kvUrl}/set/${key}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(JSON.stringify(value))
      });
      if (!r.ok) throw new Error(`KV set error on ${key}: ${r.status}`);
    };

    const report = {};

    await Promise.all(profiles.map(async pr => {
      const incomingSessions = incoming[pr] || [];
      if (!incomingSessions.length) {
        report[pr] = { status: 'skipped', reason: 'no incoming sessions' };
        return;
      }

      // Load existing split key
      const existing = await kvGet(`edgetrack_${pr}`);
      if (!existing) {
        report[pr] = { status: 'error', reason: 'no existing split key' };
        return;
      }

      // Union existing + incoming by ID
      const sessionMap = new Map();
      (existing.casino || []).forEach(s => {
        if (s?.id) sessionMap.set(String(s.id), s);
      });
      incomingSessions.forEach(s => {
        if (s?.id) sessionMap.set(String(s.id), s);
      });

      const merged = Array.from(sessionMap.values());
      const gained = merged.length - (existing.casino || []).length;

      existing.casino = merged;
      await kvSet(`edgetrack_${pr}`, existing);

      const pnl = merged.reduce((a, s) => {
        if (s.startBal !== undefined && s.endBal !== undefined && (s.startBal !== 0 || s.endBal !== 0)) {
          return a + (s.endBal - s.startBal);
        }
        return a + (s.netProfit || 0);
      }, 0);

      report[pr] = {
        status: 'restored',
        before: (existing.casino || []).length - gained,
        after: merged.length,
        gained,
        pnl: Math.round(pnl * 100) / 100
      };
    }));

    return res.status(200).json({ ok: true, report });
  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
