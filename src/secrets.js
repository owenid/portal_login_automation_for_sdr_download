"use strict";

const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const { requireEnv } = require("./config");

const client = new SecretsManagerClient({});

/**
 * Fetches {username, password} from the Secrets Manager secret named by the
 * CREDENTIALS_SECRET_ID environment variable (a secret name or full ARN).
 * The secret's SecretString must be a JSON object:
 * {"username": "...", "password": "..."}.
 */
async function getCredentials() {
  const secretId = requireEnv("CREDENTIALS_SECRET_ID");
  const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));

  if (!result.SecretString) {
    throw new Error(`Secret ${secretId} has no SecretString value`);
  }

  let parsed;
  try {
    parsed = JSON.parse(result.SecretString);
  } catch (err) {
    throw new Error(`Secret ${secretId} SecretString is not valid JSON: ${err.message}`);
  }

  if (!parsed.username || !parsed.password) {
    throw new Error(`Secret ${secretId} must contain "username" and "password" fields`);
  }

  return { username: parsed.username, password: parsed.password };
}

module.exports = { getCredentials };
