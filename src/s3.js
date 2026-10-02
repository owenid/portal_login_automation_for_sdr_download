"use strict";

const { S3Client, PutObjectCommand, ListObjectsV2Command } = require("@aws-sdk/client-s3");

const client = new S3Client({});

async function uploadBuffer(bucket, key, buffer, contentType) {
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    })
  );
}

/**
 * Lists the objects under a prefix (first 1,000 — far more than one month's
 * CDR files). Returns [{ key, size }].
 */
async function listObjects(bucket, prefix) {
  const result = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  return (result.Contents || []).map((o) => ({ key: o.Key, size: o.Size }));
}

module.exports = { uploadBuffer, listObjects };
