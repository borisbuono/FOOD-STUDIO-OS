export const config = { runtime: 'edge' };

const CORS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return new Response(JSON.stringify({
      content: [{ text: '⚠️ ANTHROPIC_API_KEY is not set in Vercel environment variables. Go to Vercel → Project → Settings → Environment Variables and add it.' }]
    }), { status: 200, headers: CORS });
  }

  try {
    const body = await req.json();
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    return new Response(JSON.stringify(data), { status: resp.status, headers: CORS });
  } catch (e) {
    return new Response(JSON.stringify({ error: { message: e.message } }), { status: 500, headers: CORS });
  }
}
