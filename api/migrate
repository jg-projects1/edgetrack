// ONE-TIME migration: splits edgetrack_main into per-profile keys
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
      return true;
    };

    // Check if already migrated
    const alreadyMigrated = await kvGet('edgetrack_me');
    if (alreadyMigrated) {
      return res.status(200).json({
        ok: true,
        message: 'Already migrated',
        txCounts: profiles.reduce((a, pr) => ({
          ...a,
          [pr]: alreadyMigrated.transactions?.length || 0
        }), {})
      });
    }

    // Load legacy data
    const legacy = await kvGet('edgetrack_main');
    if (!legacy) {
      return res.status(200).json({ ok: false, message: 'No legacy data found' });
    }

    const report = {};
    const errors = [];

    // Write each profile to its own key
    await Promise.all(profiles.map(async pr => {
      const profileData = legacy[pr];
      if (!profileData) {
        report[pr] = { status: 'skipped', reason: 'no data' };
        return;
      }
      try {
        const payload = {
          bank: profileData.bank || 0,
          bookies: profileData.bookies || {},
          transactions: profileData.transactions || [],
          freeBets: profileData.freeBets || [],
          casino: profileData.casino || []
        };
        await kvSet(`edgetrack_${pr}`, payload);
        report[pr] = {
          status: 'migrated',
          transactions: payload.transactions.length,
          bookies: Object.keys(payload.bookies).length,
          casino: payload.casino.length
        };
      } catch (e) {
        errors.push(`${pr}: ${e.message}`);
        report[pr] = { status: 'error', error: e.message };
      }
    }));

    // Write exchanges
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
