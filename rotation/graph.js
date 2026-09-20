"use strict";

const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const { requireEnv } = require("../src/config");

const secretsClient = new SecretsManagerClient({});

/**
 * Fetches the Microsoft Graph app registration's credentials from the
 * Secrets Manager secret named by GRAPH_API_CREDENTIALS_SECRET_ID. Expected
 * shape (provisioned by IT alongside the Azure AD app registration):
 * {"tenantId": "...", "clientId": "...", "clientSecret": "...", "mailbox": "..."}
 */
async function getGraphCredentials() {
  const secretId = requireEnv("GRAPH_API_CREDENTIALS_SECRET_ID");
  const result = await secretsClient.send(new GetSecretValueCommand({ SecretId: secretId }));

  if (!result.SecretString) {
    throw new Error(`Secret ${secretId} has no SecretString value`);
  }

  const parsed = JSON.parse(result.SecretString);
  for (const field of ["tenantId", "clientId", "clientSecret", "mailbox"]) {
    if (!parsed[field]) {
      throw new Error(`Secret ${secretId} must contain a "${field}" field`);
    }
  }
  return parsed;
}

/**
 * OAuth2 client-credentials flow against the Microsoft identity platform.
 * Returns a Graph API bearer token valid for ~1 hour.
 */
async function getAccessToken({ tenantId, clientId, clientSecret }) {
  const res = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope: "https://graph.microsoft.com/.default",
    }),
  });
  if (!res.ok) {
    throw new Error(`Graph token request failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.access_token;
}

/**
 * Polls the given mailbox (via Microsoft Graph) for an email received after
 * sinceIso, optionally matching a sender substring. Throws if nothing shows
 * up within timeoutMs — the reset link's own expiry should be longer than
 * this, or the link may already be dead by the time it's found.
 */
async function findResetEmail({ accessToken, mailbox, sinceIso, senderContains, timeoutMs, pollIntervalMs }) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const url = new URL(`https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages`);
    url.searchParams.set("$filter", `receivedDateTime ge ${sinceIso}`);
    url.searchParams.set("$orderby", "receivedDateTime desc");
    url.searchParams.set("$top", "10");
    url.searchParams.set("$select", "id,subject,from,receivedDateTime,body");

    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      throw new Error(`Graph messages request failed: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    const match = (data.value || []).find(
      (m) => !senderContains || (m.from?.emailAddress?.address || "").toLowerCase().includes(senderContains.toLowerCase())
    );
    if (match) return match;

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error("Timed out waiting for the Gradwell password-reset email to arrive");
}

/**
 * Pulls the first link pointing at linkHostContains out of an HTML email
 * body. TODO: verify against a real reset email — this assumes a plain
 * <a href="..."> in HTML content and may need adjusting once the actual
 * email template is seen.
 */
function extractResetLink(message, linkHostContains) {
  const html = message.body?.content || "";
  const hrefs = [...html.matchAll(/href="([^"]+)"/gi)].map((m) => m[1]);
  const link = hrefs.find((u) => u.includes(linkHostContains));
  if (!link) {
    throw new Error(`Could not find a reset link containing "${linkHostContains}" in the email body`);
  }
  return link.replace(/&amp;/g, "&");
}

module.exports = { getGraphCredentials, getAccessToken, findResetEmail, extractResetLink };
