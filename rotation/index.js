"use strict";

const {
  SecretsManagerClient,
  DescribeSecretCommand,
  GetSecretValueCommand,
  PutSecretValueCommand,
  UpdateSecretVersionStageCommand,
  GetRandomPasswordCommand,
} = require("@aws-sdk/client-secrets-manager");
const { chromium: playwright } = require("playwright-core");

const { config, env } = require("../src/config");
const { getGraphCredentials, getAccessToken, findResetEmail, extractResetLink } = require("./graph");

const secretsClient = new SecretsManagerClient({});

// Selectors specific to the password-reset flow, unverified against the
// live site (same caveat as everywhere else in this project) — override
// via env vars once confirmed against the real pages.
const rotationSelectors = {
  requestResetLink: env("SELECTOR_REQUEST_RESET_LINK", 'a:has-text("Request reset password")'),
  newPasswordInput: env("SELECTOR_NEW_PASSWORD_INPUT", 'input[type="password"]'),
  confirmPasswordInput: env("SELECTOR_CONFIRM_PASSWORD_INPUT", 'input[name="confirmPassword"], input[name="password_confirmation"]'),
  resetSubmitButton: env("SELECTOR_RESET_SUBMIT_BUTTON", 'button[type="submit"]'),
  loggedInMarker: env("SELECTOR_LOGGED_IN_MARKER", "text=Where do you want to go?"),
};

const RESET_LINK_HOST = env("RESET_LINK_HOST", "gradwell.com");
const RESET_EMAIL_SENDER_CONTAINS = env("RESET_EMAIL_SENDER_CONTAINS", "gradwell.com");
const EMAIL_POLL_TIMEOUT_MS = Number(env("EMAIL_POLL_TIMEOUT_MS", "300000"));
const EMAIL_POLL_INTERVAL_MS = Number(env("EMAIL_POLL_INTERVAL_MS", "10000"));

async function getSecretJson(secretArn, { versionStage, versionId } = {}) {
  const params = { SecretId: secretArn };
  if (versionId) params.VersionId = versionId;
  else params.VersionStage = versionStage;
  const res = await secretsClient.send(new GetSecretValueCommand(params));
  return JSON.parse(res.SecretString);
}

async function launchBrowser() {
  // Same ESM-vs-require() note as src/index.js: must be a dynamic import.
  const chromium = (await import("@sparticuz/chromium")).default;
  const browser = await playwright.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: true,
  });
  const context = await browser.newContext();
  const page = await context.newPage();
  return { browser, page };
}

async function loginWithCredentials(page, username, password) {
  await page.goto(config.ssoUrl, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });
  await page.locator(config.selectors.usernameInput).first().fill(username);
  await page.locator(config.selectors.passwordInput).first().fill(password);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs }).catch(() => {}),
    page.locator(config.selectors.loginButton).first().click(),
  ]);
}

/**
 * Step 1: generate a new random password and stage it as AWSPENDING,
 * without touching Gradwell yet. Idempotent — if a version already exists
 * for this token (a retried invocation), leave it alone.
 */
async function createSecret(secretArn, token) {
  try {
    await getSecretJson(secretArn, { versionId: token });
    console.log("createSecret: AWSPENDING version already exists for this token, skipping");
    return;
  } catch (err) {
    if (err.name !== "ResourceNotFoundException") throw err;
  }

  const current = await getSecretJson(secretArn, { versionStage: "AWSCURRENT" });
  const { RandomPassword: newPassword } = await secretsClient.send(
    new GetRandomPasswordCommand({
      PasswordLength: 24,
      ExcludeCharacters: "\"'\\/@`",
      RequireEachIncludedType: true,
    })
  );

  await secretsClient.send(
    new PutSecretValueCommand({
      SecretId: secretArn,
      ClientRequestToken: token,
      SecretString: JSON.stringify({ username: current.username, password: newPassword }),
      VersionStages: ["AWSPENDING"],
    })
  );
  console.log("createSecret: generated and staged a new AWSPENDING password");
}

/**
 * Step 2: the Gradwell-specific part. Log in with the current password,
 * trigger a reset email, read it via Microsoft Graph, follow the link, and
 * submit the new (AWSPENDING) password.
 *
 * TODO: every selector here and the exact reset-form field layout are
 * unverified against the live site — confirm before relying on this in
 * production, e.g. by temporarily adding debug screenshots (see
 * captureDebugScreenshot in src/index.js for the pattern).
 */
async function setSecret(secretArn, token) {
  const current = await getSecretJson(secretArn, { versionStage: "AWSCURRENT" });
  const pending = await getSecretJson(secretArn, { versionId: token });
  const graphCreds = await getGraphCredentials();
  const requestedAt = new Date().toISOString();

  let browser, page;
  try {
    ({ browser, page } = await launchBrowser());

    await loginWithCredentials(page, current.username, current.password);

    await page.locator(rotationSelectors.requestResetLink).first().click({ timeout: config.navigationTimeoutMs });

    const accessToken = await getAccessToken(graphCreds);
    const email = await findResetEmail({
      accessToken,
      mailbox: graphCreds.mailbox,
      sinceIso: requestedAt,
      senderContains: RESET_EMAIL_SENDER_CONTAINS,
      timeoutMs: EMAIL_POLL_TIMEOUT_MS,
      pollIntervalMs: EMAIL_POLL_INTERVAL_MS,
    });
    const resetLink = extractResetLink(email, RESET_LINK_HOST);

    await page.goto(resetLink, { waitUntil: "domcontentloaded", timeout: config.navigationTimeoutMs });

    await page.locator(rotationSelectors.newPasswordInput).first().fill(pending.password);
    const confirmField = page.locator(rotationSelectors.confirmPasswordInput).first();
    if (await confirmField.count()) {
      await confirmField.fill(pending.password);
    }
    await page.locator(rotationSelectors.resetSubmitButton).first().click();
    await page.waitForLoadState("domcontentloaded", { timeout: config.navigationTimeoutMs }).catch(() => {});
  } finally {
    if (browser) await browser.close();
  }
  console.log("setSecret: submitted the new password to Gradwell");
}

/**
 * Step 3: confirm the AWSPENDING password actually works before anything
 * is promoted to AWSCURRENT. This is what keeps a broken reset from
 * locking the account out — if login fails here, rotation stops and the
 * old password is still the one in use.
 */
async function testSecret(secretArn, token) {
  const pending = await getSecretJson(secretArn, { versionId: token });
  let browser, page;
  try {
    ({ browser, page } = await launchBrowser());
    await loginWithCredentials(page, pending.username, pending.password);
    await page.waitForSelector(rotationSelectors.loggedInMarker, { timeout: config.navigationTimeoutMs });
  } finally {
    if (browser) await browser.close();
  }
  console.log("testSecret: confirmed the new password logs in successfully");
}

/**
 * Step 4: promote AWSPENDING to AWSCURRENT. Only reached after testSecret
 * has already proven the new password works.
 */
async function finishSecret(secretArn, token) {
  const metadata = await secretsClient.send(new DescribeSecretCommand({ SecretId: secretArn }));
  let currentVersion;
  for (const [versionId, stages] of Object.entries(metadata.VersionIdsToStages || {})) {
    if (stages.includes("AWSCURRENT")) {
      currentVersion = versionId;
      break;
    }
  }
  if (currentVersion === token) {
    console.log("finishSecret: already AWSCURRENT, nothing to do");
    return;
  }
  await secretsClient.send(
    new UpdateSecretVersionStageCommand({
      SecretId: secretArn,
      VersionStage: "AWSCURRENT",
      MoveToVersionId: token,
      RemoveFromVersionId: currentVersion,
    })
  );
  console.log("finishSecret: promoted AWSPENDING to AWSCURRENT");
}

exports.handler = async (event) => {
  const { SecretId: secretArn, ClientRequestToken: token, Step: step } = event;

  const metadata = await secretsClient.send(new DescribeSecretCommand({ SecretId: secretArn }));
  if (!metadata.RotationEnabled) {
    throw new Error(`Secret ${secretArn} is not enabled for rotation`);
  }
  const stages = metadata.VersionIdsToStages || {};
  if (!stages[token]) {
    throw new Error(`Secret version ${token} has no stage for rotation of ${secretArn}`);
  }
  if (stages[token].includes("AWSCURRENT")) {
    console.log(`Version ${token} is already AWSCURRENT; step "${step}" is a no-op`);
    return;
  }
  if (!stages[token].includes("AWSPENDING")) {
    throw new Error(`Version ${token} is not staged AWSPENDING for rotation of ${secretArn}`);
  }

  switch (step) {
    case "createSecret":
      return createSecret(secretArn, token);
    case "setSecret":
      return setSecret(secretArn, token);
    case "testSecret":
      return testSecret(secretArn, token);
    case "finishSecret":
      return finishSecret(secretArn, token);
    default:
      throw new Error(`Invalid rotation step: ${step}`);
  }
};
