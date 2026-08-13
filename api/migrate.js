// ONE-TIME migration: splits edgetrack_main + edgetrack_casino into per-profile keys
// Call once via GET /api/migrate — safe to call multiple times (idempotent)
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
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

    // Check if already migrated
    const alreadyMigrated = await kvGet('edgetrack_me');
    if (alreadyMigrated && (alreadyMigrated.transactions?.length || 0) > 0) {
      return res.status(200).json({
        ok: true,
        message: 'Already migrated',
        me: { transactions: alreadyMigrated.transactions?.length, casino: alreadyMigrated.casino?.length }
      });
    }

    // Load both legacy keys
    const [legacy, casinoLegacy] = await Promise.all([
      kvGet('edgetrack_main'),
      kvGet('edgetrack_casino')
    ]);

    if (!legacy) {
      return res.status(200).json({ ok: false, message: 'No legacy data found' });
    }

    const report = {};
    const errors = [];

    await Promise.all(profiles.map(async pr => {
      const sportData = legacy[pr];
      const casinoData = casinoLegacy?.[pr];

      try {
        const payload = {
          bank: sportData?.bank || 0,
          bookies: sportData?.bookies || {},
          transactions: sportData?.transactions || [],
          freeBets: sportData?.freeBets || [],
          casino: casinoData?.casino || sportData?.casino || []
        };
        await kvSet(`edgetrack_${pr}`, payload);
        report[pr] = {
          status: 'migrated',
          transactions: payload.transactions.length,
          casino: payload.casino.length,
          bookies: Object.keys(payload.bookies).length
        };
      } catch (e) {
        errors.push(`${pr}: ${e.message}`);
        report[pr] = { status: 'error', error: e.message };
      }
    }));

    // Migrate exchanges
    if (legacy.exchanges) {
      await kvSet('edgetrack_exchanges', legacy.exchanges);
      report.exchanges = 'migrated';
    }

    return res.status(200).json({
      ok: errors.length === 0,
      message: errors.length === 0 ? 'Migration complete' : 'Migration completed with errors',
      report,
      errors
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
