import axios from 'axios';
import { Page } from 'playwright';

const TWOCAPTCHA_BASE = 'https://2captcha.com';

async function submitRecaptchaV2(siteKey: string, pageUrl: string): Promise<string> {
  const apiKey = process.env.TWOCAPTCHA_API_KEY;
  if (!apiKey) throw new Error('TWOCAPTCHA_API_KEY not set');

  const submitRes = await axios.get(`${TWOCAPTCHA_BASE}/in.php`, {
    params: { key: apiKey, method: 'userrecaptcha', googlekey: siteKey, pageurl: pageUrl, json: 1 },
  });
  if (submitRes.data.status !== 1) throw new Error(`2captcha submit failed: ${submitRes.data.request}`);
  const taskId = submitRes.data.request;

  // Poll for solution (up to 2 minutes)
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    const pollRes = await axios.get(`${TWOCAPTCHA_BASE}/res.php`, {
      params: { key: apiKey, action: 'get', id: taskId, json: 1 },
    });
    if (pollRes.data.status === 1) return pollRes.data.request as string;
    if (pollRes.data.request !== 'CAPCHA_NOT_READY') {
      throw new Error(`2captcha poll error: ${pollRes.data.request}`);
    }
  }
  throw new Error('2captcha timed out');
}

export async function solveRecaptchaOnPage(page: Page): Promise<void> {
  const siteKey = await page.evaluate(() => {
    const el = document.querySelector('[data-sitekey]');
    return el ? el.getAttribute('data-sitekey') : null;
  });
  if (!siteKey) return; // no captcha present

  const token = await submitRecaptchaV2(siteKey, page.url());
  await page.evaluate((t) => {
    const textarea = document.getElementById('g-recaptcha-response') as HTMLTextAreaElement | null;
    if (textarea) {
      textarea.style.display = 'block';
      textarea.value = t;
    }
    // Trigger callback if present
    const el = document.querySelector('[data-callback]');
    if (el) {
      const callbackName = el.getAttribute('data-callback');
      const w = window as unknown as Record<string, unknown>;
      if (callbackName && w[callbackName]) {
        (w[callbackName] as (t: string) => void)(t);
      }
    }
  }, token);
}

export const captchaAvailable = (): boolean => !!process.env.TWOCAPTCHA_API_KEY;
