import puppeteer from 'puppeteer-core';
import { logger } from './logger.js';

function truthy(value, fallback) {
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

/**
 * Thin wrapper around this Browserless fork's WebSocket endpoint.
 *
 * Two distinct open-source features are used here, and they solve
 * different problems:
 *
 *  - `stealth` / `blockAds` (see src/browsers/browsers.cdp.ts) make a
 *    session look like a normal browser.
 *  - `trackingId` just labels a *currently open* session for Browserless's
 *    own /sessions and /kill management APIs, and guards against two
 *    connections claiming the same label concurrently — it does NOT let a
 *    later, separate connect() resume a previous session.
 *
 * To actually stay logged in to a job board across separate CLI runs, pass
 * `userDataDir` pointing at a path on a persistent volume (see
 * docker-compose.job-sourcing.yml). Chrome's cookies/localStorage live
 * there on disk, independent of any one WebSocket connection.
 */
export class BrowserlessClient {
  constructor({
    wsUrl = process.env.BROWSERLESS_WS_URL ?? 'ws://localhost:3000',
    token = process.env.BROWSERLESS_TOKEN,
    stealth = truthy(process.env.JOB_SOURCING_STEALTH, true),
    blockAds = truthy(process.env.JOB_SOURCING_BLOCK_ADS, true),
  } = {}) {
    this.wsUrl = wsUrl;
    this.token = token;
    this.stealth = stealth;
    this.blockAds = blockAds;
  }

  /**
   * Builds the connect URL for a session.
   * @param {{trackingId?: string, userDataDir?: string}} options
   */
  buildEndpoint({ trackingId, userDataDir } = {}) {
    const url = new URL(this.wsUrl);
    if (this.token) url.searchParams.set('token', this.token);
    if (this.blockAds) url.searchParams.set('blockAds', 'true');
    if (trackingId) url.searchParams.set('trackingId', trackingId);
    if (this.stealth || userDataDir) {
      url.searchParams.set(
        'launch',
        JSON.stringify({
          ...(this.stealth ? { stealth: true } : {}),
          ...(userDataDir ? { userDataDir } : {}),
        }),
      );
    }
    return url.toString();
  }

  async connect(options = {}) {
    const browserWSEndpoint = this.buildEndpoint(options);
    logger.debug('Connecting to Browserless', options);
    return puppeteer.connect({ browserWSEndpoint });
  }

  /**
   * Opens a page, runs `fn(page, browser)`, then always closes the page
   * and disconnects. Browserless itself owns the remote browser process's
   * lifetime — it closes shortly after the last client disconnects — so
   * this never tries to keep a live session around between separate CLI
   * runs. For a job board that needs a login to persist across runs, pass
   * `userDataDir` (a path on the server's disk); Chrome's cookies for that
   * profile survive there independent of any one connection.
   */
  async withPage(options = {}, fn) {
    const browser = await this.connect(options);
    const page = await browser.newPage();
    try {
      return await fn(page, browser);
    } finally {
      await page.close().catch(() => {});
      await browser.disconnect();
    }
  }

  /**
   * Calls this fork's open-source `/function` HTTP endpoint to run a
   * one-shot script server-side, without holding a WS connection open
   * from the caller. `code` must be a string exporting a default async
   * function `({ page }) => result`, matching Browserless's function API.
   */
  async runFunction(code, { context } = {}) {
    const url = new URL('/function', this.wsUrl.replace(/^ws/, 'http'));
    if (this.token) url.searchParams.set('token', this.token);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, context }),
    });
    if (!res.ok) {
      throw new Error(`/function call failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
  }
}
