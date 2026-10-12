export function authCors(req: Request) {
  const origins = (Deno.env.get('PRINTKUB_ALLOWED_ORIGINS') || '').split(',').map(value => value.trim()).filter(Boolean)
  const origin = req.headers.get('Origin')
  const allowed = !!origin && origins.includes(origin)
  return {
    allowed,
    headers: {
      ...(allowed ? { 'Access-Control-Allow-Origin': origin! } : {}),
      'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json',
      'Vary': 'Origin',
    },
  }
}
