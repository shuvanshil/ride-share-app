const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

// Body parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Log requests
app.use((req, res, next) => {
    console.log(`${req.method} ${req.url}`);
    next();
});

// Explicit health route to match python-based API healthcheck
app.get('/api/health', (req, res) => {
    res.json({ ok: true });
});

// Dynamic API routing for Vercel-style Serverless Functions in www/api
app.all('/api/:endpoint', async (req, res) => {
    const endpoint = req.params.endpoint;

    // Prevent direct execution of helper files starting with underscore
    if (endpoint.startsWith('_')) {
        return res.status(404).json({ error: "Endpoint not found" });
    }

    const filePath = path.join(__dirname, 'www', 'api', `${endpoint}.js`);

    if (fs.existsSync(filePath)) {
        try {
            // Delete cache in non-production to allow hot reloading of endpoints
            if (process.env.NODE_ENV !== 'production') {
                delete require.cache[require.resolve(filePath)];
            }
            const handler = require(filePath);
            await handler(req, res);
        } catch (error) {
            console.error(`Error in endpoint ${endpoint}:`, error);
            if (!res.headersSent) {
                res.status(500).json({
                    error: "Internal Server Error",
                    message: error.message
                });
            }
        }
    } else {
        res.status(404).json({ error: "Endpoint not found" });
    }
});

// Serve static files from the www directory
app.use(express.static(path.join(__dirname, 'www')));

// Catch-all route to serve index.html for undefined frontend routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'www', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server is running on http://0.0.0.0:${PORT}`);
});
