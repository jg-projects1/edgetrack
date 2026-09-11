// Server-side full backup — reads directly from KV, always complete
// GET /api/backup
// v2 - was reading the frozen edgetrack_me/edgetrack_wife keys, which
// stopped being written to after the profile rename — meaning every
// backup pulled since then was silently missing everything for two of
// the four profiles. Now reads the live jg/hg/bp/rq keys instead.
// Also now captures bankUpdatedAt and the deletion tombstones
// (_deletedTxIds/_deletedCasinoIds), so a restore from this backup
// wouldn't lose the merge-safety data those fields provide.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
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

    // Read everything from KV in parallel
    const [exchanges, ...profileData] = await Promise.all([
      kvGet('edgetrack_exchanges'),
      ...profiles.map(pr => kvGet(`edgetrack_${pr}`))
    ]);

    const backup = {
      version: 4,
      exportedAt: new Date().toISOString(),
      exportedBy: 'MBWorld-Server',
      state: {
        exchanges: exchanges || {},
        profiles: {}
      }
    };

    profiles.forEach((pr, i) => {
      const data = profileData[i] || {};
      backup.state.profiles[pr] = {
        bank: data.bank || 0,
        bankUpdatedAt: data.bankUpdatedAt || 0,
        bookies: data.bookies || {},
        transactions: data.transactions || [],
        freeBets: data.freeBets || [],
        casino: data.casino || [],
        _deletedTxIds: data._deletedTxIds || [],
        _deletedCasinoIds: data._deletedCasinoIds || []
      };
    });

    // Summary for verification
    const summary = {};
    profiles.forEach((pr, i) => {
      const data = profileData[i] || {};
      summary[pr] = {
        transactions: (data.transactions || []).length,
        casino: (data.casino || []).length,
        bookies: Object.keys(data.bookies || {}).length
      };
    });

    // Set download headers
    const filename = `mbworld-backup-${new Date().toISOString().slice(0,10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');

    return res.status(200).json({ ...backup, summary });
  } catch(e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
