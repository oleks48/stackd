export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { context, checkin } = req.body;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      system: `You are a direct, no-nonsense coach for young entrepreneurs. Be specific to their situation. Call them out if they are drifting. Keep it under 120 words. No fluff. Context: ${context}`,
      messages: [{ role: 'user', content: checkin }]
    })
  });

  const data = await response.json();
  
  if (data.error) {
    return res.status(500).json({ error: data.error.message });
  }

  res.status(200).json({ reply: data.content[0].text });
}
