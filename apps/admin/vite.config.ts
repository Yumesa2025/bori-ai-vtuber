import { createHash } from 'node:crypto';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

const devServer = { host: '127.0.0.1', port: 5174 };

/**
 * 개발 서버용 CSP 보정.
 * React Fast Refresh는 준비 코드를 인라인 script로 넣는데, index.html의 CSP는 인라인 script를 막는다.
 * 'unsafe-inline'을 열지 않고 그 코드의 해시만 허용하고, HMR 웹소켓 주소를 더한다.
 * 해시는 플러그인이 내보내는 원문으로 계산하므로 플러그인을 올려도 맞는다. 빌드 산출물은 index.html 그대로다.
 */
function devCsp(): Plugin {
  const preamble = react.preambleCode.replace('__BASE__', '/');
  const hash = createHash('sha256').update(preamble).digest('base64');
  return {
    name: 'bori-admin-dev-csp',
    apply: 'serve',
    transformIndexHtml: html => html
      .replace("script-src 'self'", `script-src 'self' 'sha256-${hash}'`)
      .replace("connect-src 'self'", `connect-src 'self' ws://${devServer.host}:${devServer.port}`),
  };
}

export default defineConfig({
  plugins: [react(), devCsp()],
  cacheDir: '../../.vite-cache/admin',
  server: {
    ...devServer,
    proxy: { '/api': 'http://127.0.0.1:4310' },
  },
});
