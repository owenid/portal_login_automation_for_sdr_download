# Gradwell SDR CDR Downloader

An AWS Lambda function that runs on the 1st of every month, logs into the
Gradwell portal, and downloads the SDR CDR file into S3.

## Flow

1. **SSO login** — navigates to `https://sso.prod.gradwell.com`, fills in the
   username/password fields, and submits the login form.
2. **Admin section** — clicks the "Admin" option, landing on
   `https://admin.prod.gradwell.com/home`.
3. **SDR section** — clicks the "SDR" option, landing on
   `https://admin.prod.gradwell.com/sdrs`.
4. **Download** — clicks the download link/button on the SDR page, and
   uploads the resulting file to S3 at `cdr/<yyyy>/<mm>/<yyyy-mm-dd>-<filename>`.

The browser automation is done with [Playwright](https://playwright.dev/)
(`playwright-core`) driving a headless Chromium binary provided by
[`@sparticuz/chromium`](https://github.com/Sparticuz/chromium), which is
built to run inside the Lambda execution environment.

## ⚠️ Selectors have not been verified against the live site

I don't have access to the real Gradwell SSO/Admin/SDR pages, so the CSS/text
selectors used to find the username field, password field, login button,
"Admin" link, "SDR" link, and download button in `src/config.js` are
best-effort defaults, not verified. **You will very likely need to tune
them** after inspecting the real pages (e.g. via browser dev tools).

Every selector is overridable through an environment variable — no code
change or redeploy needed:

| Env var                     | Purpose                              | Default                                                  |
|------------------------------|---------------------------------------|-----------------------------------------------------------|
| `SSO_URL`                   | SSO login page                        | `https://sso.prod.gradwell.com`                           |
| `ADMIN_HOME_URL`             | Expected URL after choosing Admin     | `https://admin.prod.gradwell.com/home`                    |
| `SDR_URL`                    | Expected URL after choosing SDR       | `https://admin.prod.gradwell.com/sdrs`                    |
| `SELECTOR_USERNAME_INPUT`   | Username field on the SSO page        | `input[name="username"], input[type="email"], #username` |
| `SELECTOR_PASSWORD_INPUT`   | Password field on the SSO page        | `input[name="password"], input[type="password"], #password` |
| `SELECTOR_LOGIN_BUTTON`     | Submit button on the SSO page         | `button[type="submit"], input[type="submit"]`             |
| `SELECTOR_ADMIN_OPTION`     | Link/button that opens Admin          | `a:has-text("Admin")`                                      |
| `SELECTOR_SDR_OPTION`       | Link/button that opens SDR            | `a:has-text("SDR")`                                        |
| `SELECTOR_DOWNLOAD_BUTTON`  | Icon/link/button that starts the download for the latest (first-row) period | `table tbody tr:first-child td:last-child a, table tbody tr:first-child td:last-child button, table tbody tr:first-child a, table tbody tr:first-child button` |
| `SELECTOR_LATEST_END_DATE_CELL` | "End Date" cell of the newest (first) SDR row, used only for the 1st-of-month freshness check below | `table tbody tr:first-child td:nth-child(2)` |
| `NAVIGATION_TIMEOUT_MS`     | Timeout for each navigation step       | `30000`                                                    |
| `DOWNLOAD_TIMEOUT_MS`       | Timeout waiting for the download to start | `60000`                                               |
| `DEBUG_SCREENSHOTS`         | `true` to upload a screenshot to S3 after every step (`debug/<run-id>/<step>.png`), for tuning selectors without shell access | `false` |

`DEBUG_SCREENSHOTS` is set via the `DebugScreenshots` **template
parameter**, not by editing the Lambda's environment variables directly —
`sam deploy` resets environment variables to whatever the template says on
every deploy, so a manual `aws lambda update-function-configuration` change
gets silently wiped out the next time you deploy. To turn it on:

```bash
sam deploy --parameter-overrides DebugScreenshots=true
```

Trigger a manual invoke, then check the `debug/` prefix in the S3 bucket to
see exactly what the automation saw at each step — that's the fastest way
to figure out the real selectors and adjust the env vars above. Turn it
back off the same way (`DebugScreenshots=false`) once you're done tuning.

If the actual login flow is multi-step (e.g. username on one screen, then a
"Next" button, then password on a second screen — common with SSO
providers), `src/index.js`'s `loginToSso` function will need a small edit to
add the intermediate click; the current implementation assumes a single-page
username + password + submit form.

### 1st-of-month "record not yet available" check

On the 1st of the month (UTC), `verifyLatestRecordIsAvailable` in
`src/index.js` reads the newest SDR row's "End Date" and confirms it equals
the last calendar day of the previous month — i.e. the period that should
have just completed. If Gradwell hasn't published that period yet (the
newest row is still last month's), the function throws instead of silently
downloading and storing an old file under the new month's S3 key. That
throw is a normal Lambda error, so it shows up in CloudWatch Logs and trips
the `CdrDownloaderErrorsAlarm` (→ Datadog) the same as any other failure.
This check is a no-op on any other day of the month, so manual test invokes
on non-1st days aren't affected by it.

## Repository layout

```
template.yaml        AWS SAM template: Lambda, S3 bucket, Secrets Manager
                      secret, EventBridge monthly schedule, IAM policies
src/
  index.js           Lambda handler — orchestrates the browser automation
  config.js          URLs, selectors, timeouts (env-overridable)
  secrets.js         Fetches {username, password} from Secrets Manager
  s3.js              S3 upload helper
events/
  manual-invoke.json Empty event payload for `sam local invoke` / test invokes
```

## Deploying

Requires the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
and AWS credentials configured.

```bash
npm install
sam build
sam deploy --guided
```

`sam deploy --guided` will prompt for a stack name and save the answers to
`samconfig.toml` for future `sam deploy` runs.

### Optional: Datadog Forwarder topic ARN

`DatadogForwarderTopicArn` (see **Alerting** under Operational notes below)
defaults to an empty string, so the stack deploys fine without it — the
CloudWatch alarm still exists, it just has no `AlarmActions`/`OKActions`
until you supply a real Datadog Forwarder SNS topic ARN. Once that
Forwarder exists, wire it up with:

```bash
sam deploy --parameter-overrides DatadogForwarderTopicArn=arn:aws:sns:eu-west-2:123456789012:datadog-forwarder-topic
```

### Credentials secret

This stack does **not** create the credentials secret — it expects one to
already exist in Secrets Manager and only grants the function
`secretsmanager:GetSecretValue` on it. The secret name defaults to
`prod/AdminPortal/Gradwell` (the `CredentialsSecretName` template
parameter); override it at deploy time if yours is named differently:

```bash
sam deploy --parameter-overrides CredentialsSecretName=prod/AdminPortal/Gradwell
```

Create/populate the secret yourself, as type **"Other type of secret"**,
with exactly two key/value pairs:

```bash
aws secretsmanager create-secret \
  --name prod/AdminPortal/Gradwell \
  --secret-string '{"username":"YOUR_USERNAME","password":"YOUR_PASSWORD"}'
# or, if it already exists:
aws secretsmanager put-secret-value \
  --secret-id prod/AdminPortal/Gradwell \
  --secret-string '{"username":"YOUR_USERNAME","password":"YOUR_PASSWORD"}'
```

## Testing

**Manual invoke** (after deploying, to test end-to-end against the real
site without waiting for the 1st of the month):

```bash
aws lambda invoke \
  --function-name <CdrDownloaderFunctionArn or name> \
  --payload file://events/manual-invoke.json \
  --cli-binary-format raw-in-base64-out \
  out.json
cat out.json
```

On success, `out.json` includes `durationMs` — wall-clock time for the whole
run (login through S3 upload), e.g.:

```json
{"statusCode":200,"bucket":"...","key":"cdr/2026/09/...","durationMs":18342}
```

The same duration is also logged to CloudWatch on both success
(`CDR file uploaded to s3://... in <ms>ms`) and failure
(`CDR download automation failed after <ms>ms: ...`) — useful for spotting
runs that are creeping toward the function's 180s timeout.

Check CloudWatch Logs for the function, and the S3 bucket's `cdr/` (and, if
`DEBUG_SCREENSHOTS=true`, `debug/`) prefixes.

**Local invoke** with `sam local invoke` also works, but note it runs inside
a Docker container that emulates the Lambda runtime — network access to the
real Gradwell hosts from that container depends on your local Docker/network
setup.

## Operational notes

- **Schedule**: AWS EventBridge Scheduler (`MonthlyCdrDownloadSchedule`),
  not a classic EventBridge Rule — `cron(0 9 1 * ? *)` evaluated in the
  `ScheduleTimezone` parameter (default `Europe/London`), which fires at
  a fixed **09:00 UK local time year-round**. EventBridge Scheduler
  applies the GMT/BST transition automatically, so the cron expression
  never needs to change between winter and summer. Scheduler invokes the
  Lambda directly using `SchedulerInvokeRole`, an IAM role scoped to
  `lambda:InvokeFunction` on just this function. Override the time via
  `ScheduleExpression`, or the timezone via `ScheduleTimezone`.
- **Timeout/memory**: 180s timeout, 2048 MB memory, 1024 MB of `/tmp`
  ephemeral storage — headless Chromium needs headroom; adjust in
  `template.yaml` if downloads are large or the site is slow.
- **Alerting**: `CdrDownloaderErrorsAlarm` watches the function's `Errors`
  metric (namespace `AWS/Lambda`). If `DatadogForwarderTopicArn` is set, it
  publishes ALARM/OK state changes to that SNS topic — your Datadog
  Forwarder — so a failed run surfaces as a Datadog monitor event rather
  than sitting silently in CloudWatch Logs. Left unset (the default), the
  alarm still exists and is visible via CloudWatch/`describe-alarms`, it
  just has no external notification target. Because this function only
  runs once a month, the alarm uses a 1-day evaluation period with
  `TreatMissingData: notBreaching`: a day with no invocation reads as "no
  data" rather than a false alarm, and only the scheduled run day can
  actually trip it.

  To test the alarm without waiting for a real failure, invoke the
  function with bad credentials (or any other guaranteed failure) so it
  errors, then check the alarm's state:

  ```bash
  aws cloudwatch describe-alarms --alarm-names <stack-name>-lambda-errors
  ```
- **Secrets**: credentials are only ever read at runtime from Secrets
  Manager via the function's IAM role; they are never stored in code,
  environment variables, or the S3 bucket.
- **IAM scope**: the execution role's S3 permission is prefix-scoped, not
  bucket-wide — `s3:PutObject` only on `cdr/*` and `debug/*` within
  `CdrBucket` (the only two prefixes the code ever writes to), plus
  `secretsmanager:GetSecretValue` scoped to the one named secret's ARN
  pattern. No broader S3 or Secrets Manager access is granted.
- **Chromium/Playwright versions**: `@sparticuz/chromium` and
  `playwright-core` versions are pinned in `package.json`. If you bump
  `@sparticuz/chromium`, re-check its
  [README](https://github.com/Sparticuz/chromium) for the Node.js runtime
  and `playwright-core` versions it currently expects.
