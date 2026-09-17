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
    // The SDR list is a table (Start Date / End Date / Download columns)
    // sorted newest-first, with an icon-only download control (no text) in
    // the last cell of each row. Scoping to the first data row's clickable
    // control both finds it and picks the latest period.
    downloadButton: env(
      "SELECTOR_DOWNLOAD_BUTTON",
      "table tbody tr:first-child td:last-child a, table tbody tr:first-child td:last-child button, table tbody tr:first-child a, table tbody tr:first-child button"
    ),
    // "End Date" is the 2nd column (Start Date / End Date / Download) of the
    // newest (first) row.
    latestEndDateCell: env(
      "SELECTOR_LATEST_END_DATE_CELL",
      "table tbody tr:first-child td:nth-child(2)"
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
