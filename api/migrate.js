// Migration + Casino Recovery
// GET /api/migrate         — normal migration
// GET /api/migrate?force=1 — re-run migration
// GET /api/migrate?recover=1 — merge casino from edgetrack_main into split keys
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    const profiles = ['me', 'wife', 'bp', 'rq'];
    const force = req.query?.force === '1';
    const recover = req.query?.recover === '1';

    const kvGet = async (key) => {
      try {
        const r = await fetch(`${kvUrl}/get/${key}`, { headers: { Authorization: `Bearer ${kvToken}` } });
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

    // CASINO RECOVERY MODE
    if (recover) {
      const [legacy, casinoLegacy] = await Promise.all([
        kvGet('edgetrack_main'),
        kvGet('edgetrack_casino')
      ]);

      const report = {};

      await Promise.all(profiles.map(async pr => {
        try {
          const splitData = await kvGet(`edgetrack_${pr}`);
          if (!splitData) {
            report[pr] = { status: 'no split data' };
            return;
          }

          // Get casino from all possible sources
          const splitSessions = splitData.casino || [];
          const legacySessions = legacy?.[pr]?.casino || [];
          const casinoKeySessions = casinoLegacy?.[pr]?.casino || [];

          // Union all sessions by ID — keep all unique
          const sessionMap = new Map();
          [...splitSessions, ...legacySessions, ...casinoKeySessions].forEach(s => {
            if (!s || !s.id) return;
            const existing = sessionMap.get(String(s.id));
            if (!existing) {
              sessionMap.set(String(s.id), s);
            } else {
              // Keep whichever has better data
              const betterPnl = (s.netProfit || 0) !== 0 ? s : existing;
              sessionMap.set(String(s.id), betterPnl);
            }
          });

          const mergedSessions = Array.from(sessionMap.values());

          report[pr] = {
            status: 'recovered',
            split: splitSessions.length,
            legacy: legacySessions.length,
            casinoKey: casinoKeySessions.length,
            merged: mergedSessions.length,
            gained: mergedSessions.length - splitSessions.length
          };

          if (mergedSessions.length > splitSessions.length) {
            splitData.casino = mergedSessions;
            await kvSet(`edgetrack_${pr}`, splitData);
          }
        } catch(e) {
          report[pr] = { status: 'error', error: e.message };
        }
      }));

      return res.status(200).json({
        ok: true,
        message: 'Casino recovery complete',
        report
      });
    }

    // NORMAL MIGRATION
    const existing = await kvGet('edgetrack_me');
    const existingCasino = existing?.casino?.length || 0;

    if (existing && !force) {
      return res.status(200).json({
        ok: true,
        message: 'Already migrated — add ?force=1 to re-run or ?recover=1 to recover casino',
        me: { transactions: existing.transactions?.length || 0, casino: existingCasino }
      });
    }

    const [legacy, casinoLegacy] = await Promise.all([
      kvGet('edgetrack_main'),
      kvGet('edgetrack_casino')
    ]);

    if (!legacy && !existing) {
      return res.status(200).json({ ok: false, message: 'No legacy data found' });
    }

    const report = {};
    const errors = [];

    await Promise.all(profiles.map(async pr => {
      try {
        const existingData = await kvGet(`edgetrack_${pr}`);
        const sportData = legacy?.[pr] || existingData || {};
        const casinoData = casinoLegacy?.[pr];

        // Union all casino sources
        const sessionMap = new Map();
        [...(existingData?.casino || []),
         ...(sportData?.casino || []),
         ...(casinoData?.casino || [])
        ].forEach(s => {
          if (s?.id) sessionMap.set(String(s.id), s);
        });

        const payload = {
          bank: existingData?.bank ?? sportData?.bank ?? 0,
          bookies: existingData?.bookies || sportData?.bookies || {},
          transactions: existingData?.transactions || sportData?.transactions || [],
          freeBets: existingData?.freeBets || sportData?.freeBets || [],
          casino: Array.from(sessionMap.values())
        };

        await kvSet(`edgetrack_${pr}`, payload);
        report[pr] = {
          status: 'migrated',
          transactions: payload.transactions.length,
          casino: payload.casino.length,
          bookies: Object.keys(payload.bookies).length
        };
      } catch(e) {
        errors.push(`${pr}: ${e.message}`);
        report[pr] = { status: 'error', error: e.message };
      }
    }));

    if (legacy?.exchanges) {
      await kvSet('edgetrack_exchanges', legacy.exchanges);
      report.exchanges = 'migrated';
    }

    return res.status(200).json({
      ok: errors.length === 0,
      message: errors.length === 0 ? 'Migration complete' : 'Migration completed with errors',
      report,
      errors
    });
  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
