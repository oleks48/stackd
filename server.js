const https = require('https');

function sendEmail(to, subject, html) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      from: 'Stackd <noreply@stackdcoach.com>',
      to: [to],
      subject,
      html
    });

    const options = {
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

const server = require('http').createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }

  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const parsed = body ? JSON.parse(body) : {};

      // AI Coach
      if (req.method === 'POST' && req.url === '/api/coach') {
        const { context, checkin } = parsed;

        const payload = JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          system: `You are a direct coach for young entrepreneurs. Context: ${context}`,
          messages: [{ role: 'user', content: checkin }]
        });

        const options = {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
            'Content-Length': Buffer.byteLength(payload)
          }
        };

        const apiReq = https.request(options, (apiRes) => {
          let data = '';
          apiRes.on('data', chunk => data += chunk);
          apiRes.on('end', () => {
            try {
              const result = JSON.parse(data);
              if (result.error) {
                res.writeHead(500);
                res.end(JSON.stringify({ error: result.error.message }));
              } else {
                res.writeHead(200);
                res.end(JSON.stringify({ reply: result.content[0].text }));
              }
            } catch(e) {
              res.writeHead(500);
              res.end(JSON.stringify({ error: e.message }));
            }
          });
        });

        apiReq.on('error', (e) => {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        });

        apiReq.write(payload);
        apiReq.end();
        return;
      }

      // Send verification email
      if (req.method === 'POST' && req.url === '/api/send-verification') {
        const { email, token } = parsed;
        const link = `https://stackdcoach.com/verify.html?token=${token}`;
        
        await sendEmail(
          email,
          'Verify your Stackd account',
          `
            <div style="font-family:Inter,sans-serif; max-width:480px; margin:0 auto; padding:40px 24px; background:#0c0c0c; color:#fff;">
              <h1 style="font-size:28px; font-weight:800; margin-bottom:16px;">Stack<span style="color:#E9A84C;">d</span></h1>
              <h2 style="font-size:20px; font-weight:700; margin-bottom:12px;">Verify your email</h2>
              <p style="color:#888; margin-bottom:28px; line-height:1.6;">Click the button below to verify your email and start building.</p>
              <a href="${link}" style="background:#E9A84C; color:#0c0c0c; padding:14px 28px; border-radius:8px; text-decoration:none; font-weight:700; display:inline-block;">Verify email</a>
              <p style="color:#555; margin-top:24px; font-size:13px;">If you didn't create a Stackd account you can ignore this email.</p>
            </div>
          `
        );

        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
        return;
      }

      // Send password reset email
      if (req.method === 'POST' && req.url === '/api/send-reset') {
        const { email, token } = parsed;
        const link = `https://stackdcoach.com/reset.html?token=${token}`;

        await sendEmail(
          email,
          'Reset your Stackd password',
          `
            <div style="font-family:Inter,sans-serif; max-width:480px; margin:0 auto; padding:40px 24px; background:#0c0c0c; color:#fff;">
              <h1 style="font-size:28px; font-weight:800; margin-bottom:16px;">Stack<span style="color:#E9A84C;">d</span></h1>
              <h2 style="font-size:20px; font-weight:700; margin-bottom:12px;">Reset your password</h2>
              <p style="color:#888; margin-bottom:28px; line-height:1.6;">Click the button below to reset your password. This link expires in 1 hour.</p>
              <a href="${link}" style="background:#E9A84C; color:#0c0c0c; padding:14px 28px; border-radius:8px; text-decoration:none; font-weight:700; display:inline-block;">Reset password</a>
              <p style="color:#555; margin-top:24px; font-size:13px;">If you didn't request a password reset you can ignore this email.</p>
            </div>
          `
        );

        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));

    } catch(e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
