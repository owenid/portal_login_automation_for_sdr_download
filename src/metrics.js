"use strict";

const { CloudWatchClient, PutMetricDataCommand } = require("@aws-sdk/client-cloudwatch");

// Custom metrics for the monitoring dashboard and alarms. The function's IAM
// policy only allows PutMetricData in this namespace.
const NAMESPACE = "CdrDownloader";

const client = new CloudWatchClient({});

/**
 * Publishes one data point to the CdrDownloader namespace. Never throws: a
 * monitoring problem is logged and must never fail or mask the CDR run.
 */
async function putMetric(name, value, unit, dimensions = []) {
  try {
    await client.send(
      new PutMetricDataCommand({
        Namespace: NAMESPACE,
        MetricData: [{ MetricName: name, Value: value, Unit: unit, Dimensions: dimensions }],
      })
    );
  } catch (err) {
    console.error(`Failed to publish metric ${NAMESPACE}/${name}:`, err);
  }
}

module.exports = { putMetric, NAMESPACE };
