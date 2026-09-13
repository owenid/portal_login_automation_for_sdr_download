"use strict";

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const config = {
  ssoUrl: env("SSO_URL", "https://sso.prod.gradwell.com"),
  adminHomeUrl: env("ADMIN_HOME_URL", "https://admin.prod.gradwell.com/home"),
  sdrUrl: env("SDR_URL", "https://admin.prod.gradwell.com/sdrs"),

  // CSS/text selectors for each step of the journey. These are best-effort
  // defaults based on common portal patterns and have NOT been verified
  // against the live Gradwell site. Override any of them via environment
  // variables (see README) once you have inspected the real DOM, without
  // needing a code change or redeploy.
  selectors: {
    usernameInput: env(
      "SELECTOR_USERNAME_INPUT",
      'input[name="username"], input[type="email"], #username'
    ),
    passwordInput: env(
      "SELECTOR_PASSWORD_INPUT",
      'input[name="password"], input[type="password"], #password'
    ),
    loginButton: env(
      "SELECTOR_LOGIN_BUTTON",
      'button[type="submit"], input[type="submit"]'
    ),
    adminOption: env("SELECTOR_ADMIN_OPTION", 'a:has-text("Admin")'),
    sdrOption: env("SELECTOR_SDR_OPTION", 'a:has-text("SDR")'),
    downloadButton: env(
      "SELECTOR_DOWNLOAD_BUTTON",
      'a:has-text("Download"), button:has-text("Download")'
    ),
  },

  navigationTimeoutMs: Number(env("NAVIGATION_TIMEOUT_MS", "30000")),
  downloadTimeoutMs: Number(env("DOWNLOAD_TIMEOUT_MS", "60000")),

  // Set DEBUG_SCREENSHOTS=true to upload a screenshot to S3 after every step
  // (debug/<run-id>/<step>.png). Invaluable for tuning selectors against the
  // real site without shell access to the Lambda.
  debugScreenshots: env("DEBUG_SCREENSHOTS", "false") === "true",
};

module.exports = { config, env, requireEnv };
