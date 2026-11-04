// Login helper for the setup project (auth/auth.setup.ts), used when the project keeps a saved login (auth.approach "storage-state").
//
// The setup project runs before every browser project, so every test starts with a login that was checked a moment ago. A saved
// session is only reused after the application has accepted it in THIS run; if it is gone (expired, ended on the server, signed
// out by another test) the helper signs in again and saves the new session. The pipeline sets PIPELINE_AUTH_STATE=reuse once
// it has checked the saved file's age; anything else (a plain `npx playwright test`) always signs in.
//
//   setup('authenticate', async ({ browser, baseURL }) => {
//     await reuseOrSignIn({
//       browser, baseURL, stateFile: path.join(import.meta.dirname, 'storage-state.json'),
//       check: async (page) => { await home.open(); await expect(home.welcomeHeading).toBeVisible({ timeout: 5_000 }); },
//       signIn: async (page) => { ...fill the login form, then assert the signed-in page... },
//     });
//   });

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Browser, Page } from '@playwright/test';

export interface ReuseOrSignInOptions {
  browser: Browser;
  baseURL: string | undefined;
  stateFile: string;
  // Opens a page that needs a login and throws (a failed expect, a timeout) unless the user is signed in.
  check: (page: Page) => Promise<void>;
  // Signs in through the UI on a signed-out page and asserts that it worked. Called only when there is no usable session.
  signIn: (page: Page) => Promise<void>;
}

export type SessionOrigin = 'reused' | 'signed-in';

export async function reuseOrSignIn(o: ReuseOrSignInOptions): Promise<SessionOrigin> {
  if (process.env.PIPELINE_AUTH_STATE === 'reuse' && existsSync(o.stateFile)) {
    const saved = await o.browser.newContext({ baseURL: o.baseURL, storageState: o.stateFile });
    try {
      await o.check(await saved.newPage());
      return 'reused';
    } catch {
      // the application no longer accepts the saved session: sign in again below
    } finally {
      await saved.close();
    }
  }
  const fresh = await o.browser.newContext({ baseURL: o.baseURL, storageState: { cookies: [], origins: [] } });
  try {
    await o.signIn(await fresh.newPage());
    mkdirSync(path.dirname(o.stateFile), { recursive: true });
    await fresh.storageState({ path: o.stateFile });
    return 'signed-in';
  } finally {
    await fresh.close();
  }
}
