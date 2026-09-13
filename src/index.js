"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { chromium: playwright } = require("playwright-core");

const { config, requireEnv } = require("./config");
const { getCredentials } = require("./secrets");
const { uploadBuffer } = require("./s3");

/**
 * Logs into the Gradwell SSO page.
 */
async function loginToSso(page, username, password) {
  await page.goto(config.ssoUrl, {
    waitUntil: "domcontentloaded",
    timeout: config.navigationTimeoutMs,
  });

  await page.locator(config.selectors.usernameInput).first().fill(username);
  await page.locator(config.selectors.passwordInput).first().fill(password);

  await Promise.all([
    page
      .waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: config.navigationTimeoutMs,
      })
      .catch(() => {}),
    page.locator(config.selectors.loginButton).first().click(),
  ]);
}

/**
 * Clicks through to the Admin section, falling back to a direct navigation
 * if the click doesn't land on the expected admin home URL (same
 * authenticated browser context, so this is a safe fallback).
 */
async function goToAdminHome(page) {
  // The nav link may sit inside a collapsed/off-screen menu panel (seen on
  // the real portal: a "MENU" toggle hides the sidebar until clicked), so a
  // click failure here isn't necessarily fatal — fall back to navigating
  // directly, which works identically within the same authenticated
  // session.
  try {
    await page.locator(config.selectors.adminOption).first().click({ timeout: config.navigationTimeoutMs });
    await page.waitForLoadState("domcontentloaded", { timeout: config.navigationTimeoutMs }).catch(() => {});
  } catch (err) {
    console.warn(`Could not click admin option (${err.message}); falling back to direct navigation`);
  }

  if (!page.url().startsWith(config.adminHomeUrl)) {
    await page.goto(config.adminHomeUrl, {
      waitUntil: "domcontentloaded",
      timeout: config.navigationTimeoutMs,
    });
  }
}

/**
 * Clicks through to the SDR section, falling back to a direct navigation.
 */
async function goToSdrSection(page) {
  try {
    await page.locator(config.selectors.sdrOption).first().click({ timeout: config.navigationTimeoutMs });
    await page.waitForLoadState("domcontentloaded", { timeout: config.navigationTimeoutMs }).catch(() => {});
  } catch (err) {
    console.warn(`Could not click SDR option (${err.message}); falling back to direct navigation`);
  }

  if (!page.url().startsWith(config.sdrUrl)) {
    await page.goto(config.sdrUrl, {
      waitUntil: "domcontentloaded",
      timeout: config.navigationTimeoutMs,
    });
  }

  // The SDR list loads asynchronously after the page shell renders (a
  // "Loading SDRs..." spinner is shown first), so wait for network activity
  // to settle before treating the page as ready — otherwise the list (and
  // its download controls) may not exist yet.
  await page.waitForLoadState("networkidle", { timeout: config.navigationTimeoutMs }).catch(() => {});
}

/**
 * Clicks the download link/button and reads the resulting file into memory.
 */
async function downloadCdrFile(page) {
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: config.downloadTimeoutMs }),
    page.locator(config.selectors.downloadButton).first().click(),
  ]);

  const failure = await download.failure();
  if (failure) {
    throw new Error(`Download failed: ${failure}`);
  }

  const filePath = await download.path();
  const buffer = await fs.promises.readFile(filePath);
  const filename = download.suggestedFilename() || `cdr-${Date.now()}.csv`;

  return { buffer, filename };
}

function buildS3Key(filename) {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `cdr/${yyyy}/${mm}/${yyyy}-${mm}-${dd}-${safeName}`;
}

async function captureDebugScreenshot(page, bucket, runId, stepName) {
  if (!config.debugScreenshots || !page) return;
  try {
    const buffer = await page.screenshot({ fullPage: true });
    await uploadBuffer(bucket, `debug/${runId}/${stepName}.png`, buffer, "image/png");
  } catch (err) {
    console.error(`Failed to capture debug screenshot for step "${stepName}":`, err);
  }
}

exports.handler = async () => {
  const bucket = requireEnv("CDR_BUCKET_NAME");
  const runId = crypto.randomUUID();

  const { username, password } = await getCredentials();

  // @sparticuz/chromium is published as an ES module. Some local Node
  // versions can require() it transparently via Node's newer require(esm)
  // interop, but AWS Lambda's nodejs22.x runtime cannot, so it must be
  // loaded with a dynamic import() instead.
  const chromium = (await import("@sparticuz/chromium")).default;

  let browser;
  let page;
  try {
    browser = await playwright.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
      downloadsPath: "/tmp/downloads",
    });

    const context = await browser.newContext();
    page = await context.newPage();

    await loginToSso(page, username, password);
    await captureDebugScreenshot(page, bucket, runId, "01-after-login");

    await goToAdminHome(page);
    await captureDebugScreenshot(page, bucket, runId, "02-admin-home");

    await goToSdrSection(page);
    await captureDebugScreenshot(page, bucket, runId, "03-sdr-section");

    const { buffer, filename } = await downloadCdrFile(page);
    const key = buildS3Key(filename);
    await uploadBuffer(bucket, key, buffer);

    console.log(`CDR file uploaded to s3://${bucket}/${key}`);
    return { statusCode: 200, bucket, key };
  } catch (err) {
    console.error("CDR download automation failed:", err);
    await captureDebugScreenshot(page, bucket, runId, "99-failure");
    throw err;
  } finally {
    if (browser) await browser.close();
  }
};
