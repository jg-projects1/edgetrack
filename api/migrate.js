// Migration: splits edgetrack_main + edgetrack_casino into per-profile keys
// Force re-run by adding ?force=1 to the URL
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    const profiles = ['me', 'wife', 'bp', 'rq'];
    const force = req.query?.force === '1';

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

    // Check existing split data
    const existing = await kvGet('edgetrack_me');
    const existingCasino = existing?.casino?.length || 0;

    if (existing && !force) {
      return res.status(200).json({
        ok: true,
        message: 'Already migrated — add ?force=1 to re-run',
        me: { transactions: existing.transactions?.length || 0, casino: existingCasino }
      });
    }

    // Load both legacy keys
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
        // Start with existing split data if available
        const existingData = await kvGet(`edgetrack_${pr}`);
        const sportData = legacy?.[pr] || existingData || {};
        const casinoData = casinoLegacy?.[pr];

        // Merge casino: prefer legacy casino key, fall back to existing split data
        const casinoSessions = casinoData?.casino?.length
          ? casinoData.casino
          : (existingData?.casino || sportData?.casino || []);

        const payload = {
          bank: existingData?.bank ?? sportData?.bank ?? 0,
          bookies: existingData?.bookies || sportData?.bookies || {},
          transactions: existingData?.transactions || sportData?.transactions || [],
          freeBets: existingData?.freeBets || sportData?.freeBets || [],
          casino: casinoSessions
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
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
