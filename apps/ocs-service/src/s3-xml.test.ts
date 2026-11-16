// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 * S3 XML responses: keys and ETags must come back decoded whatever entity
 * style the backend uses (AWS `&quot;`, SeaweedFS `&#34;`).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { S3Client, xmlDecode } from './s3';

test('xmlDecode handles named and numeric references', () => {
  assert.equal(xmlDecode('a &amp; b &lt;c&gt; &quot;q&quot; &apos;s&apos;'), 'a & b <c> "q" \'s\'');
  assert.equal(xmlDecode('&#34;abc&#34; &#x26; &#38;'), '"abc" & &');
  assert.equal(xmlDecode('plain/key.txt'), 'plain/key.txt');
  assert.equal(xmlDecode('&amp;amp;'), '&amp;', 'decodes exactly once');
});

const server = http.createServer((_req, res) => {
  res.setHeader('content-type', 'application/xml');
  res.end(`<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult>
  <IsTruncated>true</IsTruncated>
  <NextContinuationToken>tok&amp;1</NextContinuationToken>
  <Contents><Key>tenants/t1/x y&amp;z.bin</Key><Size>3</Size><ETag>&#34;0b75926a&#34;</ETag></Contents>
  <Contents><Key>tenants/t1/a&lt;b&gt;.txt</Key><Size>1</Size><ETag>&quot;aab457e0&quot;</ETag></Contents>
</ListBucketResult>`);
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

test('list() decodes keys, ETags and the continuation token', async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  const client = new S3Client({
    endpoint: `http://127.0.0.1:${port}`,
    bucket: 'b',
    region: 'us-east-1',
    accessKey: 'k',
    secretKey: 's',
    pathStyle: true,
  });
  const page = await client.list('tenants/', 10);
  assert.deepEqual(page.objects.map((o) => [o.key, o.etag, o.size]), [
    ['tenants/t1/x y&z.bin', '0b75926a', 3],
    ['tenants/t1/a<b>.txt', 'aab457e0', 1],
  ]);
  assert.equal(page.next, 'tok&1');
});
