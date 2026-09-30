const https = require('https');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false }
});

const ALLOWED_ORIGINS = ['https://stackdcoach.com', 'https://www.stackdcoach.com'];
// Test-mode price IDs. Swap for live ones when you go live.
const ALLOWED_PRICES = ['price_1UL8ERLXx05PYhrDXYZuoMMt', 'price_1UL8FbLXx05PYhrDKTUOWWS0'];

function httpsJson(options, payload) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Bad response from ' + options.hostname)); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function stripeRequest(method, path, data) {
  const payload = data ? new URLSearchParams(data).toString() : '';
  return httpsJson({
    hostname: 'api.stripe.com',
    path: `/v1/${path}`,
    method,
    headers: {
      'Authorization': `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);
}

function send(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function getAuthUser(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data || !data.user) return null;
  return data.user;
}

function verifyStripeSignature(payload, header, secret) {
  if (!header || !secret) return false;
  const parts = header.split(',').map(p => p.split('='));
  const timestamp = (parts.find(p => p[0] === 't') || [])[1];
  const sigs = parts.filter(p => p[0] === 'v1').map(p => p[1]);
  if (!timestamp || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
  return sigs.some(s => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}

// Max 40 coach messages per user per hour (protects your Anthropic credits)
const hits = new Map();
function rateLimited(userId) {
  const now = Date.now();
  const recent = (hits.get(userId) || []).filter(t => now - t < 3600000);
  if (recent.length >= 40) { hits.set(userId, recent); return true; }
  recent.push(now);
  hits.set(userId, recent);
  return false;
}

const server = require('http').createServer((req, res) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.url === '/health') { send(res, 200, { status: 'ok' }); return; }

  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if (body.length > 100000) req.destroy();
  });

  req.on('end', async () => {
    try {
      const parsed = body ? JSON.parse(body) : {};

      // AI coach (logged in + subscribed only)
      if (req.method === 'POST' && req.url === '/api/coach') {
        const user = await getAuthUser(req);
        if (!user) return send(res, 401, { error: 'Please sign in again.' });

        const { data: profile } = await supabase
          .from('profiles').select('subscribed').eq('id', user.id).single();
        if (!profile || !profile.subscribed) {
          return send(res, 402, { error: 'Start your free trial to use the coach.' });
        }
        if (rateLimited(user.id)) {
          return send(res, 429, { error: 'Too many messages. Try again in a bit.' });
        }

        const context = String(parsed.context || '').slice(0, 2000);
        const checkin = String(parsed.checkin || '').slice(0, 4000);
        if (!checkin.trim()) return send(res, 400, { error: 'Empty message.' });

        const payload = JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          system: `You are a direct coach for young entrepreneurs. Context: ${context}`,
          messages: [{ role: 'user', content: checkin }]
        });

        const result = await httpsJson({
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(payload)
          }
        }, payload);

        if (result.error) return send(res, 500, { error: result.error.message });
        return send(res, 200, { reply: result.content[0].text });
      }

      // Stripe checkout (logged in only)
      if (req.method === 'POST' && req.url === '/api/create-checkout') {
        const user = await getAuthUser(req);
        if (!user) return send(res, 401, { error: 'Please sign in again.' });

        const { priceId } = parsed;
        if (!ALLOWED_PRICES.includes(priceId)) return send(res, 400, { error: 'Invalid plan.' });

        const session = await stripeRequest('POST', 'checkout/sessions', {
          'payment_method_types[]': 'card',
          'line_items[0][price]': priceId,
          'line_items[0][quantity]': '1',
          'mode': 'subscription',
          'customer_email': user.email,
          'success_url': 'https://stackdcoach.com/app.html?payment=success',
          'cancel_url': 'https://stackdcoach.com/app.html?payment=cancelled',
          'metadata[user_id]': user.id,
          'subscription_data[trial_period_days]': '7'
        });

        if (session.error) return send(res, 400, { error: session.error.message });
        return send(res, 200, { url: session.url });
      }

      // Stripe webhook
      if (req.method === 'POST' && req.url === '/api/stripe-webhook') {
        if (!verifyStripeSignature(body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET)) {
          return send(res, 400, { error: 'Invalid signature' });
        }
        const event = parsed;

        if (event.type === 'checkout.session.completed') {
          const s = event.data.object;
          const userId = s.metadata && s.metadata.user_id;
          if (userId) {
            const { error } = await supabase
              .from('profiles')
              .update({ subscribed: true, subscription_id: s.subscription })
              .eq('id', userId);
            if (error) { console.error(error); return send(res, 500, { error: 'db' }); }
          }
        }

        if (event.type === 'customer.subscription.deleted') {
          const sub = event.data.object;
          await supabase.from('profiles').update({ subscribed: false }).eq('subscription_id', sub.id);
        }

        return send(res, 200, { received: true });
      }

      // Delete account (cancels the subscription too)
      if (req.method === 'POST' && req.url === '/api/delete-account') {
        const user = await getAuthUser(req);
        if (!user) return send(res, 401, { error: 'Please sign in again.' });

        const { data: profile } = await supabase
          .from('profiles').select('subscription_id').eq('id', user.id).single();
        if (profile && profile.subscription_id) {
          await stripeRequest('DELETE', `subscriptions/${profile.subscription_id}`);
        }

        const { error } = await supabase.auth.admin.deleteUser(user.id);
        if (error) return send(res, 500, { error: 'Could not delete account.' });
        return send(res, 200, { success: true });
      }
            // Free beta activation
      if (req.method === 'POST' && req.url === '/api/start-beta') {
        const user = await getAuthUser(req);
        if (!user) return send(res, 401, { error: 'Please sign in again.' });
        if (process.env.FREE_BETA !== 'true') return send(res, 403, { error: 'The free beta is closed.' });

        const { count } = await supabase
          .from('profiles').select('id', { count: 'exact', head: true }).eq('subscribed', true);
        if (count >= 100) return send(res, 403, { error: 'The free beta is full.' });

        const { error } = await supabase.from('profiles').update({ subscribed: true }).eq('id', user.id);
        if (error) return send(res, 500, { error: 'Could not activate.' });
        return send(res, 200, { success: true });
      }

      send(res, 404, { error: 'Not found' });
    } catch (e) {
      console.error(e);
      send(res, 500, { error: 'Server error' });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
