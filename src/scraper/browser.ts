import { Browser, BrowserContext, Page, chromium } from 'playwright';

const STEALTH_SCRIPT = `
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'languages', { get: () => ['en-IN', 'en-US', 'en'] });
  Object.defineProperty(navigator, 'plugins', { get: () => [
    { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
    { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
    { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
  ]});
  window.chrome = { runtime: {} };
  const originalQuery = window.navigator.permissions ? window.navigator.permissions.query.bind(window.navigator.permissions) : null;
  if (originalQuery) {
    window.navigator.permissions.query = (p) =>
      p.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission, onchange: null })
        : originalQuery(p);
  }
`;

class BrowserManager {
  private browser: Browser | null = null;
  private launchPromise: Promise<Browser> | null = null;

  async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;

    if (this.launchPromise) return this.launchPromise;

    this.launchPromise = chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--lang=en-IN',
      ],
    }).then((b) => {
      this.browser = b;
      this.launchPromise = null;
      b.on('disconnected', () => {
        this.browser = null;
      });
      return b;
    });

    return this.launchPromise;
  }

  async newPage(userAgent?: string): Promise<{ context: BrowserContext; page: Page }> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      userAgent: userAgent ?? 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
      viewport: { width: 1366, height: 768 },
      extraHTTPHeaders: {
        'Accept-Language': 'en-IN,en-GB;q=0.9,en-US;q=0.8,en;q=0.7',
      },
      ...(process.env.HTTP_PROXY ? { proxy: { server: process.env.HTTP_PROXY } } : {}),
    });
    const page = await context.newPage();
    await page.addInitScript(STEALTH_SCRIPT);
    return { context, page };
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

export const browserManager = new BrowserManager();

export async function withPage<T>(
  fn: (page: Page) => Promise<T>,
  userAgent?: string,
): Promise<T> {
  const { context, page } = await browserManager.newPage(userAgent);
  try {
    return await fn(page);
  } finally {
    await context.close();
  }
}
