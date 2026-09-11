// integrity-check.js — read-only, one-time sanity check across all live
// data. Checks for the specific things that COULD have gone subtly
// wrong given how much has changed (rename, tombstones, timestamp
// merging, split save/load endpoints) — not because anything's known
// to be broken, just as a peace-of-mind checkpoint.
// GET /api/integrity-check
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
      } catch (e) { return null; }
    };

    const sessionPnl = (s) => {
      if (s.startBal !== undefined && s.endBal !== undefined && (s.startBal !== 0 || s.endBal !== 0)) {
        return s.endBal - s.startBal;
      }
      return s.netProfit || 0;
    };

    const CASINO_NAME_RENAMES = {
      'hot streak casino': 'Hot Streak',
      'gala': 'Gala Casino',
      'bet st george': 'BetStGeorge',
      'betstgeorge': 'BetStGeorge',
      'grosvenor casinos': 'Grosvenor',
      'planet sports': 'Planet Sport Bet',
    };

    const profileData = await Promise.all(profiles.map(async pr => ({
      pr, data: await kvGet(`edgetrack_${pr}`)
    })));

    const issues = { duplicateCasinoIds: [], duplicateTxIds: [], unnormalizedNames: [], untrackedNonZeroBookies: [], malformedSessions: [], malformedTransactions: [] };
    const totals = {};

    profileData.forEach(({ pr, data }) => {
      if (!data) { totals[pr] = { status: 'no data at all — worth checking separately' }; return; }

      const casino = data.casino || [];
      const transactions = data.transactions || [];
      const bookies = data.bookies || {};

      // 1. Duplicate session IDs — would mean two sessions collapsed into
      // one somewhere, or a reconciliation step ran twice and doubled up.
      const casinoIdCounts = {};
      casino.forEach(s => { const id = String(s.id); casinoIdCounts[id] = (casinoIdCounts[id] || 0) + 1; });
      Object.entries(casinoIdCounts).forEach(([id, count]) => {
        if (count > 1) issues.duplicateCasinoIds.push({ profile: pr, id, count });
      });

      // 2. Duplicate transaction IDs — same idea, for bets/balance edits.
      const txIdCounts = {};
      transactions.forEach(t => { const id = String(t.id); txIdCounts[id] = (txIdCounts[id] || 0) + 1; });
      Object.entries(txIdCounts).forEach(([id, count]) => {
        if (count > 1) issues.duplicateTxIds.push({ profile: pr, id, count });
      });

      // 3. Unnormalized names — a session's `casino` field, or a bookie
      // balance key, that should have been merged by now but wasn't.
      // Catches a rename that didn't actually persist somewhere.
      casino.forEach(s => {
        if (s.casino && CASINO_NAME_RENAMES[s.casino.toLowerCase()] && CASINO_NAME_RENAMES[s.casino.toLowerCase()] !== s.casino) {
          issues.unnormalizedNames.push({ profile: pr, id: s.id, found: s.casino, shouldBe: CASINO_NAME_RENAMES[s.casino.toLowerCase()], where: 'session' });
        }
      });
      Object.keys(bookies).forEach(name => {
        if (CASINO_NAME_RENAMES[name.toLowerCase()] && CASINO_NAME_RENAMES[name.toLowerCase()] !== name) {
          issues.unnormalizedNames.push({ profile: pr, found: name, shouldBe: CASINO_NAME_RENAMES[name.toLowerCase()], where: 'bookie balance' });
        }
      });

      // 4. Bookies holding real, non-zero money with NO tracked activity
      // at all — these will show as permanently red under the new RAG
      // dot logic (bal!==0, no balUpdatedAt), so worth surfacing here
      // rather than discovering them one at a time in the UI.
      Object.entries(bookies).forEach(([name, b]) => {
        if (Math.abs(b.bal || 0) >= 0.01 && !b.balUpdatedAt) {
          issues.untrackedNonZeroBookies.push({ profile: pr, name, bal: b.bal });
        }
      });

      // 5. Structurally malformed records — no date, no casino/bookie
      // name, or a P&L that computes to NaN. These would render oddly
      // or silently get excluded from totals elsewhere.
      casino.forEach(s => {
        const pnl = sessionPnl(s);
        if (!s.date || !s.casino || Number.isNaN(pnl)) {
          issues.malformedSessions.push({ profile: pr, id: s.id, date: s.date, casino: s.casino, pnlIsNaN: Number.isNaN(pnl) });
        }
      });
      transactions.forEach(t => {
        if (!t.date || Number.isNaN(t.pnl)) {
          issues.malformedTransactions.push({ profile: pr, id: t.id, date: t.date, pnlIsNaN: Number.isNaN(t.pnl) });
        }
      });

      // Running totals, for a final eyeball cross-check against what the
      // app itself displays.
      totals[pr] = {
        transactions: transactions.length,
        casinoSessions: casino.length,
        bookieCount: Object.keys(bookies).length,
        bank: data.bank || 0,
        bankUpdatedAt: data.bankUpdatedAt || null,
        casinoPnl: Math.round(casino.reduce((a, s) => a + sessionPnl(s), 0) * 100) / 100,
        deletedTxTombstoneCount: (data._deletedTxIds || []).length,
        deletedCasinoTombstoneCount: (data._deletedCasinoIds || []).length,
      };
    });

    const totalIssues = issues.duplicateCasinoIds.length + issues.duplicateTxIds.length
      + issues.unnormalizedNames.length + issues.untrackedNonZeroBookies.length
      + issues.malformedSessions.length + issues.malformedTransactions.length;

    return res.status(200).json({
      ok: true,
      summary: totalIssues === 0 ? 'No issues found — everything checked out clean.' : `${totalIssues} item(s) worth a look — see issues below.`,
      totals,
      issues
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
