// v7 - conditional loads: answers 304 Not Modified (reading only the tiny
// edgetrack_meta key) when nothing has changed since the browser's last load.
// Browsers send If-None-Match automatically on repeat fetches of the same URL,
// provided the client doesn't use cache:'no-store' or a cache-busting ?t=.
// Data/migration/dedupe logic is unchanged from v6.
import { createHash } from 'node:crypto';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).end();
  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;
    const profiles = ['jg', 'hg', 'bp', 'rq'];
    const LEGACY_KEY_SUFFIX = { jg: 'me', hg: 'wife' };

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
        body: JSON.stringify(value) // single stringify (v6 double-stringified, +~16%)
      });
      if (!r.ok) throw new Error(`KV set error on ${key}: ${r.status}`);
    };

    // ---- Cheap change check ------------------------------------------------
    // edgetrack_meta is a few hundred bytes. If it's missing (first deploy, or
    // you deleted it to force a refresh) it is rebuilt with fresh timestamps,
    // which changes the ETag and forces one full reload.
    let meta = await kvGet('edgetrack_meta');
    if (!meta || !meta.v) {
      const t = Date.now();
      meta = { v: { jg: t, hg: t, bp: t, rq: t, exchanges: t, library: t }, h: {} };
      await kvSet('edgetrack_meta', meta);
    }
    const etag = '"' + createHash('md5').update(JSON.stringify(meta)).digest('hex') + '"';
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'no-cache'); // store it, but always revalidate
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    // Any write this request makes must also bump the meta, so other
    // devices' cached copies are invalidated.
    let metaDirty = false;
    const bump = (key) => { meta.v[key] = Date.now(); metaDirty = true; };

    const BOOKIE_RENAMES = {
      'hot streak casino': 'Hot Streak',
      'gala': 'Gala Casino',
      'bet st george': 'BetStGeorge',
      'betstgeorge': 'BetStGeorge',
    };
    const dedupeBookies = (bk) => {
      if (!bk) return { bookies: bk, changed: false };
      const out = { ...bk };
      let changed = false;
      const mergeInto = (canonical, staleKey) => {
        if (!out[staleKey] || staleKey === canonical) return;
        if (!out[canonical]) out[canonical] = { bal: 0, status: 'Not Signed Up', notes: '' };
        out[canonical] = {
          ...out[canonical],
          bal: (out[canonical].bal || 0) + (out[staleKey].bal || 0),
          status: out[staleKey].status && out[staleKey].status !== 'Not Signed Up' ? out[staleKey].status : out[canonical].status,
          notes: out[staleKey].notes || out[canonical].notes,
          balUpdatedAt: Math.max(out[canonical].balUpdatedAt || 0, out[staleKey].balUpdatedAt || 0)
        };
        delete out[staleKey];
        changed = true;
      };
      Object.keys(out).forEach(k => {
        const canonical = BOOKIE_RENAMES[k.toLowerCase()];
        if (canonical && canonical !== k) mergeInto(canonical, k);
      });
      const seenLower = {};
      Object.keys(out).forEach(k => {
        const lower = k.toLowerCase();
        if (seenLower[lower] && seenLower[lower] !== k) {
          mergeInto(seenLower[lower], k);
        } else {
          seenLower[lower] = k;
        }
      });
      return { bookies: out, changed };
    };

    const [profileData, exchanges, betBuilderLibrary] = await Promise.all([
      Promise.all(profiles.map(async pr => {
        const data = await kvGet(`edgetrack_${pr}`);
        return { pr, data };
      })),
      kvGet('edgetrack_exchanges'),
      kvGet('edgetrack_bet_builder_library')
    ]);

    for (const entry of profileData) {
      const legacySuffix = LEGACY_KEY_SUFFIX[entry.pr];
      if (!legacySuffix) continue;
      if (entry.data !== null) continue;
      const legacyData = await kvGet(`edgetrack_${legacySuffix}`);
      if (legacyData !== null) {
        entry.data = legacyData;
        await kvSet(`edgetrack_${entry.pr}`, legacyData);
        bump(entry.pr);
      }
    }

    const hasSplitData = profileData.some(p => p.data !== null);
    if (hasSplitData) {
      const result = { exchanges: exchanges || {}, betBuilderLibrary: betBuilderLibrary || [] };
      await Promise.all(profileData.map(async ({ pr, data }) => {
        if (!data) {
          result[pr] = { transactions: [], bank: 0, bankUpdatedAt: 0, bookies: {}, freeBets: [], casino: [] };
          return;
        }
        const { bookies, changed } = dedupeBookies(data.bookies || {});
        const cleaned = { ...data, bookies };
        result[pr] = cleaned;
        if (changed) {
          await kvSet(`edgetrack_${pr}`, cleaned);
          bump(pr);
        }
      }));
      if (metaDirty) {
        await kvSet('edgetrack_meta', meta);
        // The data is newer than the ETag we already sent; send the new one
        // so the browser caches this exact response against it.
        res.setHeader('ETag', '"' + createHash('md5').update(JSON.stringify(meta)).digest('hex') + '"');
      }
      return res.status(200).json({ ok: true, data: result });
    }

    const legacy = await kvGet('edgetrack_main');
    if (legacy) {
      const remapped = { ...legacy };
      Object.entries(LEGACY_KEY_SUFFIX).forEach(([newKey, oldKey]) => {
        if (!remapped[newKey] && remapped[oldKey]) remapped[newKey] = remapped[oldKey];
      });
      return res.status(200).json({ ok: true, data: remapped });
    }
    return res.status(200).json({ ok: true, data: null });
  } catch (e) {
    console.error('Load error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
