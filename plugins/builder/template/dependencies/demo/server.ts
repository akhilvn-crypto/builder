// Tiny local demo app for exercising the pipeline end to end (no dependencies).
//
//   npm run demo:app                              → http://localhost:4173
//   DEMO_SIGNIN_LABEL="Log in" npm run demo:app   → the sign-in button is renamed (a UI change that
//                                                   breaks the generated locator, so healing can repair it)
//
// The cart page has a deliberate bug: the total ignores the last item. Tests asserting the correct
// total must keep failing (an application defect, never healed).

import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const port = Number(process.env.PORT ?? 4173);
const signInLabel = process.env.DEMO_SIGNIN_LABEL ?? 'Sign in';
const appDir = path.join(import.meta.dirname, 'app');
const pages: Record<string, string> = { '/': 'index.html', '/login': 'login.html', '/dashboard': 'dashboard.html', '/cart': 'cart.html' };

createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const file = pages[url.pathname];
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
    return;
  }
  const html = readFileSync(path.join(appDir, file), 'utf8').replaceAll('{{SIGNIN_LABEL}}', signInLabel);
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html);
}).listen(port, () => {
  process.stdout.write(`demo app on http://localhost:${port} (sign-in button: "${signInLabel}")\n`);
});
