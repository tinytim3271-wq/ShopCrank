#!/usr/bin/env node
import express from 'express';
import { request } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.FRONTEND_PORT || 3000);
const app = express();

app.use('/api', (req, res) => {
  const upstream = request({
    host: '127.0.0.1',
    port: 8787,
    path: req.originalUrl,
    method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${port}` },
  }, response => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.on('error', error => res.destroy(error));
    response.pipe(res);
  });
  upstream.on('error', error => {
    if (res.headersSent) {
      res.destroy(error);
      return;
    }
    res.status(502).send('Worker API unavailable');
  });
  req.on('aborted', () => upstream.destroy());
  req.pipe(upstream);
});

app.use(express.static(root));
app.listen(port, '127.0.0.1', () => {
  console.log(`ShopCrank frontend listening at http://127.0.0.1:${port}`);
});
