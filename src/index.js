"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { chromium: playwright } = require("playwright-core");

const { config, requireEnv } = require("./config");
const { getCredentials } = require("./secrets");
const { uploadBuffer } = require("./s3");

/**
 * An automation failure that names the step that failed and why, so the
 * Lambda error (and CloudWatch/Datadog) reads e.g. "Opening the SDR page
 * failed: ... Page message: "customer is required"" instead of a bare
 * Playwright "Timeout 30000ms exceeded".
 */
class AutomationError extends Error {
  constructor(step, reason, options) {
    super(`${step} failed: ${reason}`, options);
    this.name = "AutomationError";
    this.step = step;
  }
}

/**
 * Collects what the page is currently showing: URL, title, any visible
 * error/validation messages, and a snippet of the visible text. Never
 * throws — it's only ever used to explain another failure.
 */
async function describePage(page) {
  if (!page || page.isClosed()) return null;

  const info = { url: page.url(), title: "", errorMessages: [], visibleText: "" };
  info.title = await page.title().catch(() => "");
  info.errorMessages = await page
    .evaluate((selector) => {
      const messages = [];
      for (const el of document.querySelectorAll(selector)) {
        const text = (el.innerText || "").replace(/\s+/g, " ").trim();
        if (text && el.getClientRects().length > 0 && !messages.includes(text)) messages.push(text);
      }
      return messages.slice(0, 5);
    }, config.selectors.pageErrorMessage)
    .catch(() => []);
  info.visibleText = await page
    .evaluate(() => {
      const root = document.querySelector("main") || document.body;
      return root ? (root.innerText || "").replace(/\s+/g, " ").trim().slice(0, 300) : "";
    })
    .catch(() => "");
  return info;
}

function summarizePage(info) {
  if (!info) return "No browser page was open.";
  const parts = [`Page URL: ${info.url}`];
  if (info.title) parts.push(`title: "${info.title}"`);
  if (info.errorMessages.length > 0) {
    parts.push(`page message: ${info.errorMessages.map((m) => `"${m}"`).join(", ")}`);
  } else if (info.visibleText) {
    parts.push(`visible text: "${info.visibleText}"`);
  }
  return `${parts.join("; ")}.`;
}

/**
 * Runs one step of the journey, rethrowing any unexpected error (typically
 * a Playwright TimeoutError) as an AutomationError that names the step and
 * describes what the page was showing at the time.
 */
async function runStep(page, step, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AutomationError) throw err;

    // Playwright's messages include terminal colour codes; strip them.
    const message = String(err.message || err).replace(/\u001b\[[0-9;]*m/g, "");
    const firstLine = message.split("\n")[0].replace(/\.$/, "");
    const waitingFor = /waiting for (.+)/.exec(message);
    const reason =
      err.name === "TimeoutError"
        ? `timed out (${firstLine}${waitingFor ? `, waiting for ${waitingFor[1].trim()}` : ""}).`
        : `${firstLine}.`;
    throw new AutomationError(step, `${reason} ${summarizePage(await describePage(page))}`, { cause: err });
  }
}

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
 * Navigates to the SDR section.
 *
 * Every production invocation logged so far shows the SDR nav link's
 * locator resolving correctly (it's really there, id="menu-nav-partner-sdrs")
 * but the click always timing out with "element is not visible" — it sits
 * inside a collapsed/off-screen menu panel that a real user would open via
 * a "MENU" toggle first, which headless runs never do. The fallback direct
 * navigation has succeeded in 100% of observed runs, so go there first
 * instead of burning a full navigationTimeoutMs on a click that's never
 * once worked; only attempt the click if the direct nav somehow doesn't
 * land on the expected URL.
 */
async function goToSdrSection(page) {
  await page.goto(config.sdrUrl, {
    waitUntil: "domcontentloaded",
    timeout: config.navigationTimeoutMs,
  });

  if (!page.url().startsWith(config.sdrUrl)) {
    try {
      await page.locator(config.selectors.sdrOption).first().click({ timeout: config.navigationTimeoutMs });
      await page.waitForLoadState("domcontentloaded", { timeout: config.navigationTimeoutMs }).catch(() => {});
    } catch (err) {
      console.warn(`Could not click SDR option (${err.message}); direct navigation also didn't land on ${config.sdrUrl}`);
    }
  }

  // The SDR list loads asynchronously after the page shell renders (a
  // "Loading SDRs..." spinner is shown first), so wait for network activity
  // to settle before treating the page as ready — otherwise the list (and
  // its download controls) may not exist yet.
  await page.waitForLoadState("networkidle", { timeout: config.navigationTimeoutMs }).catch(() => {});

  // Fail here, with whatever the page is showing instead, if the SDR table
  // never rendered — rather than letting a later step time out waiting for
  // a cell or download button that was never going to exist.
  const tableLoaded = await page
    .locator(config.selectors.sdrTableRow)
    .first()
    .waitFor({ state: "attached", timeout: config.navigationTimeoutMs })
    .then(
      () => true,
      () => false
    );
  if (!tableLoaded) {
    throw new AutomationError(
      "Opening the SDR page",
      `the SDR table did not appear within ${config.navigationTimeoutMs / 1000}s (no element matched "${config.selectors.sdrTableRow}"). ${summarizePage(await describePage(page))}`
    );
  }
}

function isFirstOfMonthUtc(date = new Date()) {
  return date.getUTCDate() === 1;
}

function lastDayOfPreviousMonthUtc(date = new Date()) {
  // Day 0 of the current month is the last day of the previous month.
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 0));
}

function isSameUtcCalendarDate(a, b) {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

/**
 * On the 1st of the month, the newest SDR row should cover the period that
 * just completed (i.e. end on the last day of the previous month). If
 * Gradwell hasn't published that period yet, downloading the next-newest
 * row would silently store last month's file under this month's S3 key.
 * Fail loudly instead, so it surfaces as a Lambda error — which the
 * CloudWatch alarm on the Errors metric (and therefore Datadog) picks up.
 */
async function verifyLatestRecordIsAvailable(page) {
  if (!isFirstOfMonthUtc()) return;

  let rawCellText;
  try {
    rawCellText = await page
      .locator(config.selectors.latestEndDateCell)
      .first()
      .textContent({ timeout: config.navigationTimeoutMs });
  } catch (err) {
    throw new AutomationError(
      "Checking the newest SDR period is published",
      `could not find the "End Date" cell of the newest SDR row (no element matched "${config.selectors.latestEndDateCell}" within ${config.navigationTimeoutMs / 1000}s) — the SDR table layout may differ from what's expected. ${summarizePage(await describePage(page))}`,
      { cause: err }
    );
  }
  const cellText = (rawCellText || "").trim();

  const datePart = cellText.split(",")[0].trim();
  const endDate = new Date(`${datePart} UTC`);
  if (isNaN(endDate.getTime())) {
    throw new Error(
      `Could not parse the latest SDR period's end date from "${cellText}" — the SDR table format may have changed.`
    );
  }

  const expected = lastDayOfPreviousMonthUtc();
  if (!isSameUtcCalendarDate(endDate, expected)) {
    throw new Error(
      `New CDR record not yet available: expected the newest SDR period to end ${expected.toISOString().slice(0, 10)} (last day of the previous month), but the newest row on the page ends ${endDate.toISOString().slice(0, 10)} ("${cellText}"). Gradwell likely hasn't published this month's CDR yet.`
    );
  }
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

// CloudWatch Logs caps a single log event at 256 KB, so the screenshot
// logged there is a viewport-only JPEG kept comfortably under that.
const MAX_LOGGED_SCREENSHOT_CHARS = 200 * 1024;

/**
 * Captures the state of the page at the moment of failure, regardless of
 * DEBUG_SCREENSHOTS: a full-page PNG and the page HTML go to S3 under
 * debug/<run-id>/, and a base64 JPEG screenshot is written to CloudWatch
 * Logs on a line starting with FAILURE_SCREENSHOT_BASE64 (see README for
 * how to decode it). Never throws.
 */
async function captureFailure(page, bucket, runId) {
  const result = { screenshotS3Uri: null, htmlS3Uri: null };
  if (!page || page.isClosed()) return result;

  try {
    const key = `debug/${runId}/99-failure.png`;
    await uploadBuffer(bucket, key, await page.screenshot({ fullPage: true }), "image/png");
    result.screenshotS3Uri = `s3://${bucket}/${key}`;
  } catch (err) {
    console.error("Failed to save failure screenshot to S3:", err);
  }

  try {
    const key = `debug/${runId}/99-failure.html`;
    await uploadBuffer(bucket, key, Buffer.from(await page.content(), "utf8"), "text/html; charset=utf-8");
    result.htmlS3Uri = `s3://${bucket}/${key}`;
  } catch (err) {
    console.error("Failed to save failure page HTML to S3:", err);
  }

  try {
    let encoded = "";
    for (const quality of [60, 30]) {
      encoded = (await page.screenshot({ type: "jpeg", quality })).toString("base64");
      if (encoded.length <= MAX_LOGGED_SCREENSHOT_CHARS) break;
    }
    if (encoded.length <= MAX_LOGGED_SCREENSHOT_CHARS) {
      console.error(`FAILURE_SCREENSHOT_BASE64 ${encoded}`);
    } else {
      console.error(
        `Failure screenshot too large to log to CloudWatch (${encoded.length} base64 chars); see ${result.screenshotS3Uri || "the debug/ prefix in S3"} instead.`
      );
    }
  } catch (err) {
    console.error("Failed to log failure screenshot to CloudWatch:", err);
  }

  return result;
}

exports.handler = async () => {
  const startedAt = Date.now();
  const bucket = requireEnv("CDR_BUCKET_NAME");
  const runId = crypto.randomUUID();

  let browser;
  let page;
  try {
    const { username, password } = await runStep(page, "Fetching portal credentials from Secrets Manager", () =>
      getCredentials()
    );

    // @sparticuz/chromium is published as an ES module. Some local Node
    // versions can require() it transparently via Node's newer require(esm)
    // interop, but AWS Lambda's nodejs22.x runtime cannot, so it must be
    // loaded with a dynamic import() instead.
    const chromium = (await import("@sparticuz/chromium")).default;

    browser = await runStep(page, "Launching the headless browser", async () =>
      playwright.launch({
        args: chromium.args,
        executablePath: await chromium.executablePath(),
        headless: true,
        downloadsPath: "/tmp/downloads",
      })
    );

    const context = await browser.newContext();
    page = await context.newPage();

    await runStep(page, "Logging in to Gradwell SSO", () => loginToSso(page, username, password));
    await captureDebugScreenshot(page, bucket, runId, "01-after-login");

    await runStep(page, "Opening the Admin home page", () => goToAdminHome(page));
    await captureDebugScreenshot(page, bucket, runId, "02-admin-home");

    await runStep(page, "Opening the SDR page", () => goToSdrSection(page));
    await captureDebugScreenshot(page, bucket, runId, "03-sdr-section");

    await runStep(page, "Checking the newest SDR period is published", () =>
      verifyLatestRecordIsAvailable(page)
    );

    const { buffer, filename } = await runStep(page, "Downloading the CDR file", () => downloadCdrFile(page));
    const key = buildS3Key(filename);
    await runStep(page, "Uploading the CDR file to S3", () => uploadBuffer(bucket, key, buffer));

    const durationMs = Date.now() - startedAt;
    console.log(`CDR file uploaded to s3://${bucket}/${key} in ${durationMs}ms`);
    return { statusCode: 200, bucket, key, durationMs };
  } catch (err) {
    const failure = await captureFailure(page, bucket, runId);
    const durationMs = Date.now() - startedAt;
    console.error(
      JSON.stringify({
        event: "CDR_DOWNLOAD_FAILED",
        runId,
        step: err.step || "unknown",
        reason: err.message,
        durationMs,
        screenshotS3Uri: failure.screenshotS3Uri,
        htmlS3Uri: failure.htmlS3Uri,
        stack: err.stack,
      })
    );
    if (failure.screenshotS3Uri) {
      err.message += ` Failure screenshot: ${failure.screenshotS3Uri}`;
    }
    throw err;
  } finally {
    if (browser) await browser.close();
  }
};
