// v3 - bandwidth diet + safer reads. Reconciliation and name-normalisation
// logic is unchanged from v2. What's different:
//   * kvGet now THROWS on a failed request. v2 returned null, so a failed
//     read of edgetrack_jg combined with a successful read of the frozen
//     edgetrack_me key made the reconcile step write a BLANK profile over
//     the real one. A failed read now aborts with a 500 and writes nothing.
//   * Conditional loads: answers 304 Not Modified after reading only a tiny
//     revision key, so repeat loads cost bytes instead of ~3.5 MB. The ETag
//     also rolls over every 15 minutes as a safety net against any writer
//     that forgets to bump the revision.
//   * The frozen edgetrack_me / edgetrack_wife keys are only read once a day
//     (edgetrack_legacy_ok) instead of on every load.
//   * Also returns bookieNames per profile so casino.html no longer needs
//     to download the whole of /api/load just to fill its bookie dropdown.
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();

  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    const profiles = ['jg', 'hg', 'bp', 'rq', 'wa'];
    const LEGACY_KEY_SUFFIX = { jg: 'me', hg: 'wife' };
    const LEGACY_RECHECK_MS = 24 * 60 * 60 * 1000;
    const ETAG_BUCKET_MS = 15 * 60 * 1000;

    const kvGet = async (key) => {
      const r = await fetch(`${kvUrl}/get/${key}`, {
        headers: { Authorization: `Bearer ${kvToken}`, 'Cache-Control': 'no-cache' }
      });
      if (!r.ok) throw new Error(`KV fetch failed for ${key}: ${r.status}`);
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
    const kvSetNumber = async (key, n) => {
      const r = await fetch(`${kvUrl}/set/${key}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(n)
      });
      if (!r.ok) throw new Error(`KV set error on ${key}: ${r.status}`);
    };

    const makeEtag = (rev) => `W/"${rev}-${Math.floor(Date.now() / ETAG_BUCKET_MS)}"`;

    // ---- Cheap change check ------------------------------------------------
    let rev = await kvGet('edgetrack_rev_casino');
    if (typeof rev !== 'number') {
      rev = Date.now();
      await kvSetNumber('edgetrack_rev_casino', rev);
    }
    res.setHeader('Cache-Control', 'no-cache'); // cacheable, but always revalidate
    res.setHeader('ETag', makeEtag(rev));
    if (req.headers['if-none-match'] === makeEtag(rev)) {
      return res.status(304).end();
    }

    const CASINO_NAME_RENAMES = {
      'hot streak casino': 'Hot Streak',
      'gala': 'Gala Casino',
      'bet st george': 'BetStGeorge',
      'betstgeorge': 'BetStGeorge',
      'grosvenor casinos': 'Grosvenor',
      'planet sports': 'Planet Sport Bet',
    };
    const normalizeSessionNames = (sessions) => {
      let changed = false;
      const out = sessions.map(s => {
        if (!s.casino) return s;
        const canonical = CASINO_NAME_RENAMES[s.casino.toLowerCase()];
        if (canonical && canonical !== s.casino) {
          changed = true;
          return { ...s, casino: canonical };
        }
        return s;
      });
      return { sessions: out, changed };
    };

    const legacyCheckedAt = await kvGet('edgetrack_legacy_ok');
    const legacyFresh = typeof legacyCheckedAt === 'number' &&
      (Date.now() - legacyCheckedAt) >= 0 && (Date.now() - legacyCheckedAt) < LEGACY_RECHECK_MS;

    let anyWritten = false;

    const profileData = await Promise.all(
      profiles.map(async pr => {
        const data = await kvGet(`edgetrack_${pr}`);
        const legacySuffix = LEGACY_KEY_SUFFIX[pr];
        const bookieNames = Object.keys(data?.bookies || {});

        if (!legacySuffix || legacyFresh) {
          // No legacy key to reconcile (bp/rq, or already reconciled today):
          // just normalise session names.
          const sessions = data?.casino || [];
          const { sessions: normalized, changed } = normalizeSessionNames(sessions);
          if (changed) {
            await kvSet(`edgetrack_${pr}`, { ...(data || { bank: 0, bookies: {}, transactions: [], freeBets: [] }), casino: normalized });
            anyWritten = true;
          }
          return { pr, casino: normalized, bookieNames };
        }

        const legacyData = await kvGet(`edgetrack_${legacySuffix}`);
        const newCasino = data?.casino || [];
        const legacyCasino = legacyData?.casino || [];

        const newIds = new Set(newCasino.map(s => String(s.id)));
        const strayFromLegacy = legacyCasino.filter(s => !newIds.has(String(s.id)));

        if (strayFromLegacy.length === 0) {
          const { sessions: normalized, changed } = normalizeSessionNames(newCasino);
          if (changed) {
            await kvSet(`edgetrack_${pr}`, { ...data, casino: normalized });
            anyWritten = true;
          }
          return { pr, casino: normalized, bookieNames };
        }

        // Sessions that only exist under the old key: fold them in, along
        // with the bookie balance delta they represent.
        const reconciled = [...newCasino, ...strayFromLegacy];
        const { sessions: normalizedReconciled } = normalizeSessionNames(reconciled);
        const updatedProfile = { ...(data || { bank: 0, bookies: {}, transactions: [], freeBets: [] }), casino: normalizedReconciled };
        if (!updatedProfile.bookies) updatedProfile.bookies = {};
        strayFromLegacy.forEach(s => {
          const net = (s.startBal !== undefined && s.endBal !== undefined)
            ? (s.endBal - s.startBal)
            : (s.netProfit || 0);
          const bookieKey = CASINO_NAME_RENAMES[(s.casino || '').toLowerCase()] || s.casino;
          if (!updatedProfile.bookies[bookieKey]) updatedProfile.bookies[bookieKey] = { bal: 0, status: 'Active', notes: '' };
          updatedProfile.bookies[bookieKey].bal = (updatedProfile.bookies[bookieKey].bal || 0) + net;
          updatedProfile.bookies[bookieKey].balUpdatedAt = Date.now();
        });
        await kvSet(`edgetrack_${pr}`, updatedProfile);
        anyWritten = true;

        return { pr, casino: normalizedReconciled, bookieNames: Object.keys(updatedProfile.bookies) };
      })
    );

    // Whole pass completed without errors: legacy keys are reconciled, so
    // don't touch them again for a day.
    if (!legacyFresh) await kvSetNumber('edgetrack_legacy_ok', Date.now());

    if (anyWritten) {
      const now = Date.now();
      await Promise.all([
        kvSetNumber('edgetrack_rev_casino', now),
        kvSetNumber('edgetrack_rev_sports', now)
      ]);
      res.setHeader('ETag', makeEtag(now));
    }

    const result = {};
    profileData.forEach(({ pr, casino, bookieNames }) => {
      result[pr] = { casino, bookieNames };
    });

    return res.status(200).json({ ok: true, data: result });
  } catch (e) {
    console.error('Load-casino error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
