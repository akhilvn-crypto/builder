// Base class for page objects. A page object owns the locators and user actions of one page or component;
// assertions stay in the tests, so each test still reads as the spec's expected results.
//
//   import { BasePage } from './BasePage.ts';
//
//   export class LoginPage extends BasePage {
//     readonly path = '/login';
//     readonly email = this.page.getByLabel('Email');
//     readonly submit = this.page.getByRole('button', { name: 'Sign in' });
//
//     async signIn(email: string, password: string): Promise<void> {
//       await this.email.fill(email);
//       await this.page.getByLabel('Password').fill(password);
//       await this.submit.click();
//     }
//   }
//
// Locator order: getByRole → getByLabel → getByPlaceholder/getByText → getByTestId → scoped locator() (last resort).

import type { Locator, Page } from '@playwright/test';

export abstract class BasePage {
  readonly page: Page;
  // Path relative to the configured baseURL, e.g. '/login'.
  abstract readonly path: string;

  constructor(page: Page) {
    this.page = page;
  }

  async open(): Promise<void> {
    await this.page.goto(this.path);
  }

  byTestId(id: string): Locator {
    return this.page.getByTestId(id);
  }
}
