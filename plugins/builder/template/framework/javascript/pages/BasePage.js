// Base class for page objects. A page object owns the locators and user actions of one page or component;
// assertions stay in the tests, so each test still reads as the spec's expected results.
//
//   import { BasePage } from './BasePage.js';
//
//   export class LoginPage extends BasePage {
//     path = '/login';
//     email = this.page.getByLabel('Email');
//     submit = this.page.getByRole('button', { name: 'Sign in' });
//
//     async signIn(email, password) {
//       await this.email.fill(email);
//       await this.page.getByLabel('Password').fill(password);
//       await this.submit.click();
//     }
//   }
//
// Locator order: getByRole → getByLabel → getByPlaceholder/getByText → getByTestId → scoped locator() (last resort).

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').Locator} Locator */

export class BasePage {
  /** Path relative to the configured baseURL, e.g. '/login'. Subclasses set it. @type {string} */
  path = '/';

  /** @param {Page} page */
  constructor(page) {
    this.page = page;
  }

  async open() {
    await this.page.goto(this.path);
  }

  /**
   * @param {string} id
   * @returns {Locator}
   */
  byTestId(id) {
    return this.page.getByTestId(id);
  }
}
