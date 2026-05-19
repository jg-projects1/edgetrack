export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const kvUrl = process.env.KV_REST_API_URL;
    const kvToken = process.env.KV_REST_API_TOKEN;

    if (!kvUrl || !kvToken) {
      return res.status(500).json({ ok: false, error: 'Missing KV env vars' });
    }

    const body = req.body;
    if (!body) return res.status(400).json({ ok: false, error: 'No body' });

    const value = typeof body === 'string' ? body : JSON.stringify(body);

    // Upstash REST API: POST to /set/key/value (value in the URL path won't work for large data)
    // Correct format: POST to /set/keyname with value as plain string body
    const response = await fetch(`${kvUrl}/set/edgetrack_main`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${kvToken}`,
        'Content-Type': 'text/plain'
      },
      body: value
    });

    const result = await response.json();
    console.log('Upstash set result:', JSON.stringify(result));

    if (!response.ok) throw new Error(`KV error: ${response.status} ${JSON.stringify(result)}`);
    return res.status(200).json({ ok: true, result });
  } catch (e) {
    console.error('Save error:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
