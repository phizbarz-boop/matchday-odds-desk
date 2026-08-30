const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'predictions.json');

let redisClient = null;
async function getRedis() {
  if (!process.env.REDIS_URL) return null;
  if (redisClient) return redisClient;
  const { createClient } = require('redis');
  redisClient = createClient({ url: process.env.REDIS_URL });
  redisClient.on('error', (e) => console.error('Redis error', e.message));
  await redisClient.connect();
  return redisClient;
}

async function loadPredictions() {
  const client = await getRedis();
  if (client) {
    const raw = await client.get('predictions:latest');
    if (raw) return JSON.parse(raw);
    return { generatedAt: null, matches: [] };
  }
  if (fs.existsSync(DATA_FILE)) {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
  return { generatedAt: null, matches: [] };
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/predictions', async (req, res) => {
  try {
    const payload = await loadPredictions();
    res.json(payload);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load predictions' });
  }
});

// Manual/scheduled trigger to run the refresh job (protected by a shared secret).
// Pulling every league while respecting football-data.org's rate limit can take
// a couple of minutes, so this kicks the job off in the background and returns
// immediately rather than holding the HTTP request open the whole time.
app.post('/api/refresh', express.json(), (req, res) => {
  if (!process.env.REFRESH_SECRET || req.headers['x-refresh-secret'] !== process.env.REFRESH_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const { spawn } = require('child_process');
  const child = spawn('node', [path.join(__dirname, 'jobs', 'refresh.js')], {
    env: process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d; console.log(d.toString().trim()); });
  child.stderr.on('data', (d) => { log += d; console.error(d.toString().trim()); });
  child.on('exit', (code) => {
    console.log(`refresh job exited with code ${code}`);
  });
  child.unref();
  res.json({ ok: true, started: true, message: 'Refresh started in the background; check /api/predictions in a couple of minutes.' });
});

app.listen(PORT, () => console.log(`Matchday site listening on :${PORT}`));
