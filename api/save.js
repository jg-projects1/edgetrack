export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    const incoming = req.body;

    // Use client-provided server state if available (avoids stale replica reads)
    // Otherwise fall back to reading from KV
    let server = {};
    let serverSource = 'kv';
    if (incoming._serverState && typeof incoming._serverState === 'object' && Object.keys(incoming._serverState).length > 0) {
      server = incoming._serverState;
      serverSource = 'client';
    } else {
      const loadRes = await fetch(`${kvUrl}/get/edgetrack_main`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      if (!loadRes.ok) throw new Error(`KV load error: ${loadRes.status}`);
      const loadData = await loadRes.json();
      if (loadData.result) {
        let parsed = JSON.parse(loadData.result);
        if (typeof parsed === 'string') parsed = JSON.parse(parsed);
        server = parsed;
      }
    }

    const profiles = ['me', 'wife', 'bp', 'rq'];
    const merged = JSON.parse(JSON.stringify(server));

    profiles.forEach(pr => {
      if (!merged[pr]) merged[pr] = { transactions: [], bank: 0, bookies: {} };
      if (!incoming[pr]) return;

      const serverTxs = server[pr]?.transactions || [];
      const incomingTxs = incoming[pr]?.transactions || [];
      // Simple additive merge — client provides lastServerState so no stale reads
      // Union of server + incoming by ID, with explicit deletes honoured
      const deletedIds = new Set((incoming[pr]?.deletedIds || []).map(String));
      const serverMap = new Map(serverTxs.map(t => [String(t.id), t]));
      const incomingMap = new Map(incomingTxs.map(t => [String(t.id), t]));
      const allIds = new Set([...serverMap.keys(), ...incomingMap.keys()]);
      const mergedTxs = [];
      allIds.forEach(id => {
        if (deletedIds.has(id)) return;
        const serverTx = serverMap.get(id);
        const incomingTx = incomingMap.get(id);
        if (incomingTx && serverTx) {
          // Both have it — prefer settled over pending
          if (serverTx.result !== 'Pending' && incomingTx.result === 'Pending') {
            mergedTxs.push(serverTx);
          } else {
            mergedTxs.push(incomingTx);
          }
        } else if (incomingTx) {
          mergedTxs.push(incomingTx); // new transaction
        } else if (serverTx) {
          mergedTxs.push(serverTx); // only on server — keep it
        }
      });
      merged[pr].transactions = mergedTxs;

      // Always apply incoming balances
      if (incoming[pr].bank !== undefined) merged[pr].bank = incoming[pr].bank;
      // Merge freeBets — keep all, deduplicate by id, incoming wins for status updates
      const serverFB = server[pr]?.freeBets || [];
      const incomingFB = incoming[pr]?.freeBets || [];
      const fbMap = new Map();
      serverFB.forEach(fb => fbMap.set(String(fb.id), fb));
      incomingFB.forEach(fb => fbMap.set(String(fb.id), fb));
      merged[pr].freeBets = Array.from(fbMap.values());
      if (incoming[pr].bookies && Object.keys(incoming[pr].bookies).length > 0) {
        const serverBookies = server[pr]?.bookies || {};
        const mergedBookies = { ...serverBookies, ...incoming[pr].bookies };
        merged[pr].bookies = mergedBookies;
      }
    });

    if (incoming.exchanges) merged.exchanges = incoming.exchanges;

    // Save to KV
    const jsonString = JSON.stringify(merged);
    const saveRes = await fetch(`${kvUrl}/set/edgetrack_main`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(jsonString)
    });
    if (!saveRes.ok) throw new Error(`KV save error: ${saveRes.status}`);

    // Read back to verify what was actually saved
    const verifyRes = await fetch(`${kvUrl}/get/edgetrack_main`, {
      headers: { Authorization: `Bearer ${kvToken}` }
    });
    let verifiedBanks = {};
    let verifiedCounts = {};
    if (verifyRes.ok) {
      const vd = await verifyRes.json();
      if (vd.result) {
        let vp = JSON.parse(vd.result);
        if (typeof vp === 'string') vp = JSON.parse(vp);
        verifiedBanks = Object.fromEntries(profiles.map(pr => [pr, vp[pr]?.bank || 0]));
        verifiedCounts = Object.fromEntries(profiles.map(pr => [pr, vp[pr]?.transactions?.length || 0]));
      }
    }

    // Log audit AFTER verified save
    const auditEntry = {
      ts: new Date().toISOString(),
      source: incoming._source || 'unknown',
      serverSource,
      serverCounts: Object.fromEntries(profiles.map(pr => [pr, server[pr]?.transactions?.length || 0])),
      counts: verifiedCounts,
      banks: verifiedBanks,
      intended_counts: Object.fromEntries(profiles.map(pr => [pr, merged[pr]?.transactions?.length || 0])),
      intended_banks: Object.fromEntries(profiles.map(pr => [pr, merged[pr]?.bank || 0])),
      incoming_counts: Object.fromEntries(profiles.map(pr => [pr, incoming[pr]?.transactions?.length || 0])),
      incoming_banks: Object.fromEntries(profiles.map(pr => [pr, incoming[pr]?.bank]))
    };

    let audit = [];
    try {
      const auditRes = await fetch(`${kvUrl}/get/edgetrack_audit`, {
        headers: { Authorization: `Bearer ${kvToken}` }
      });
      if (auditRes.ok) {
        const auditData = await auditRes.json();
        if (auditData.result) {
          audit = JSON.parse(auditData.result);
          if (typeof audit === 'string') audit = JSON.parse(audit);
        }
      }
    } catch(e) {}
    audit.push(auditEntry);
    if (audit.length > 100) audit = audit.slice(-100);
    await fetch(`${kvUrl}/set/edgetrack_audit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(JSON.stringify(audit))
    });

    // Write count stamp so load.js knows what to expect
    const countStamp = {
      ts: new Date().toISOString(),
      counts: Object.fromEntries(profiles.map(pr => [pr, merged[pr]?.transactions?.length || 0]))
    };
    await fetch(`${kvUrl}/set/edgetrack_stamp`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${kvToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(JSON.stringify(countStamp))
    });

    // Strip any bookies not in the approved list
    const DEFAULT_BOOKIES = [
      '10bet','247bet','32Red','36 Vegas','7bet','888 Sport','Admiral Casino','Arrowbet',
      'Bally Casino','Bella Casino','Bestodds','Bet UK','Bet442','Bet600','Betano','Betfair',
      'Betfred','Betgoodwin','BetMGM','Betstgeorge','BetTom','Betvickers','Betvictor','Betway',
      'Betwright','Betzone','Bingostars','Boyle','Bresbet','Buzz Casino','Bwin','Casumo',
      'Copybet','Coral','Dabble','Dazn','Double Bubble','Dragonbet','Dream Vegas','Fabulous Vegas',
      'Fairplay','Fanteam','Fitzbet','Fitzdares','Foxy','Fruit Kings','Gala Casino','Geoff Banks',
      'Grosvenor','GRP','Highbet','Hollywoodbets','Hot Streak Casino','Jackpot Joy','Jackpot Mobile',
      'Ken Howells','Kwiff','Ladbrokes','Leovegas','Livescorebet','Lottoland','Lottomart','LottoGo',
      'Luckymate','Mecca Bingo','Mega Riches','Meta Betting','Midnite','Monopoly','MrQ','MrVegas',
      'Netbet','Octobet','Paddy Power','Parimatch','Party Casino','Pink Casino','Planet Sport Bet',
      'Planet Sports','Play Bingo','Priced Up','Puntit','Quick Bet','Quinnbet','Rainbow Riches',
      'Regal Wins','Royale Lounge','Skybet','Slot Boss','Slot Planet','Smooth Spins','Spin & Win',
      'Sporting Bet','Spreadex','Stakemate','Star Sports','Sun Vegas','Swifty Sports','Talksportbet',
      'Tigerbet','Tombola Arcade','Unibet','Vbet','Video Slots','Virgin Bet','Virgin Games','William Hill'
    ];
    const bookieSet = new Set(DEFAULT_BOOKIES);
    profiles.forEach(pr => {
      if (merged[pr] && merged[pr].bookies) {
        const cleaned = {};
        DEFAULT_BOOKIES.forEach(b => {
          if (merged[pr].bookies[b]) cleaned[b] = merged[pr].bookies[b];
          else cleaned[b] = { bal: 0, status: 'Not Signed Up', notes: '' };
        });
        merged[pr].bookies = cleaned;
      }
    });

    return res.status(200).json({ ok: true, data: merged });
  } catch (e) {
    console.error('Save error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
