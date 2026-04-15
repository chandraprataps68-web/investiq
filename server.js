const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// The Yahoo Finance API calls are made client-side (from the browser)
// because Yahoo blocks server IPs but allows browser requests.
// This server just serves the static files.

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '3.0', note: 'Data fetched client-side' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`InvestIQ Pro v3.0 on port ${PORT}`));
