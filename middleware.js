import { next } from '@vercel/edge';

export const config = { matcher: '/((?!_next|favicon.ico).*)' };

export default function middleware(request) {
  const password = process.env.PROTO_PASSWORD;
  const url = new URL(request.url);
  const cookie = request.headers.get('cookie') || '';
  const hasAuth = Boolean(password) && cookie.includes(`proto_auth=${password}`);

  if (hasAuth) {
    return next();
  }

  const pw = url.searchParams.get('pw');
  if (password && pw === password) {
    url.searchParams.delete('pw');
    return new Response(null, {
      status: 302,
      headers: {
        Location: url.toString(),
        'Set-Cookie': `proto_auth=${pw}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  }

  return new Response('Password required. Add ?pw=yourpassword to the URL.', { status: 401 });
}
