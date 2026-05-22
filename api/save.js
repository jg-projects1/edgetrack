const { kv } = require('@vercel/kv');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

  try {
    const data = req.body;
    // Add server timestamp to every save
    data._savedAt = Date.now();
    await kv.set('edgetrack_data', data);
    res.status(200).json({ ok: true, savedAt: data._savedAt });
  } catch (e) {
    console.error('Save error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};
