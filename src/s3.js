"use strict";

const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

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

module.exports = { uploadBuffer };
