export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;

    // Step 1: Read current combined data from edgetrack_main
    const loadRes = await fetch(`${kvUrl}/get/edgetrack_main`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    if (!loadRes.ok) throw new Error(`Load failed: ${loadRes.status}`);
    const loadData = await loadRes.json();
    if (!loadData.result) return res.status(200).json({ ok: false, error: 'No data found in edgetrack_main' });

    let combined = JSON.parse(loadData.result);
    if (typeof combined === 'string') combined = JSON.parse(combined);

    const profiles = ['me', 'wife', 'bp', 'rq'];

    // Step 2: Build sports-only state (strip casino sessions)
    const sportsState = { exchanges: combined.exchanges || {} };
    profiles.forEach(pr => {
      sportsState[pr] = {
        bank: combined[pr]?.bank || 0,
        bookies: combined[pr]?.bookies || {},
        transactions: combined[pr]?.transactions || []
      };
    });

    // Step 3: Build casino-only state
    const casinoState = {};
    profiles.forEach(pr => {
      casinoState[pr] = { casino: combined[pr]?.casino || [] };
    });

    // Step 4: Write both keys
    const [sportsRes, casinoRes] = await Promise.all([
      fetch(`${kvUrl}/set/edgetrack_main`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(JSON.stringify(sportsState))
      }),
      fetch(`${kvUrl}/set/edgetrack_casino`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(JSON.stringify(casinoState))
      })
    ]);

    if (!sportsRes.ok) throw new Error(`Sports save failed: ${sportsRes.status}`);
    if (!casinoRes.ok) throw new Error(`Casino save failed: ${casinoRes.status}`);

    // Report what was migrated
    const sportsTxCount = profiles.reduce((a, pr) => a + (sportsState[pr]?.transactions?.length || 0), 0);
    const casinoCount = profiles.reduce((a, pr) => a + (casinoState[pr]?.casino?.length || 0), 0);

    return res.status(200).json({
      ok: true,
      message: 'Migration complete',
      sports_transactions: sportsTxCount,
      casino_sessions: casinoCount,
      profiles: profiles.map(pr => ({
        profile: pr,
        transactions: sportsState[pr]?.transactions?.length || 0,
        casino: casinoState[pr]?.casino?.length || 0
      }))
    });
  } catch (e) {
    console.error('Migration error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
