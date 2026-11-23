// The dashboard's side of the insights store.
//
//   POST /api/admin/v2/sign-in        { key } -> session cookie (30 days)
//   POST /api/admin/v2/sign-out
//   GET  /api/admin/v2/frame          builds, tracking start, new issue count
//   GET  /api/admin/v2/cards          the names of all cards and actions
//   GET  /api/admin/v2/q/<card>       one card of one page (queries/*.js, worker thread)
//   POST /api/admin/v2/do/<action>    a change (main-actions/*.js here, else queries/*.js)
//   GET  /api/admin/v2/thumb/<file>   a gallery thumbnail
//   GET  /api/admin/v2/crash-archive/<id>   the archive of one crash report
//   GET  /insights/*                  the interface (insights-ui/dist)
//
// Nothing here reads stored data on the main thread except the two file
// downloads; every question goes to the worker.
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const COOKIE = 'insights_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const ASK_MS = 20 * 1000;
const NAME = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;

const expectedKey = () => (typeof process.env.ADMIN_RESET_KEY === 'string' && process.env.ADMIN_RESET_KEY !== '' ? process.env.ADMIN_RESET_KEY : null);

function sameText(a, b) {
    const left = Buffer.from(String(a));
    const right = Buffer.from(String(b));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// The cookie holds an expiry time and a signature made with the admin key, not
// the key itself. Changing the admin key ends every session.
function sign(expires, key) {
    return crypto.createHmac('sha256', key).update(`insights-session:${expires}`).digest('hex');
}
function newToken(key, now = Date.now()) {
    const expires = now + SESSION_MS;
    return `${expires}.${sign(expires, key)}`;
}
function validToken(token, key, now = Date.now()) {
    if (typeof token !== 'string') return false;
    const dot = token.indexOf('.');
    if (dot < 1) return false;
    const expires = Number(token.slice(0, dot));
    if (!Number.isSafeInteger(expires) || expires < now) return false;
    return sameText(token.slice(dot + 1), sign(expires, key));
}

// True when the request carries a valid dashboard session. A request that
// changes something must also carry the header the interface always sends,
// which a form on another site cannot add.
function hasSession(req) {
    const key = expectedKey();
    if (!key) return false;
    if (!validToken(req.cookies && req.cookies[COOKIE], key)) return false;
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-insights'] !== '1') return false;
    return true;
}

function hasAdminKey(req) {
    const key = expectedKey();
    const sent = req.headers['x-admin-key'];
    return Boolean(key) && typeof sent === 'string' && sameText(sent, key);
}

// A request of the signed-in dashboard to its own routes. Used by server.js to
// leave these out of the general per-address limit.
function isDashboardRequest(req) {
    return typeof req.originalUrl === 'string' && req.originalUrl.startsWith('/api/admin/v2/') && (hasSession(req) || hasAdminKey(req));
}

function requireSession(req, res, next) {
    if (!expectedKey()) return res.status(503).json({ error: 'not_configured' });
    if (hasSession(req) || hasAdminKey(req)) return next();
    res.status(401).json({ error: 'signed_out' });
}

// main-actions/*.js: { actions: { 'section.name': async (body, context) => result } }.
// For changes that need the network or files the main server owns.
function loadMainActions(log) {
    const actions = {};
    const dir = path.join(__dirname, 'main-actions');
    let names = [];
    try { names = fs.readdirSync(dir).filter((name) => name.endsWith('.js')).sort(); } catch (error) { names = []; }
    for (const name of names) {
        try {
            Object.assign(actions, require(path.join(dir, name)).actions || {});
        } catch (error) {
            log.error('Insights: main action file could not be loaded:', name, error);
        }
    }
    return actions;
}

function statusOf(error) {
    if (!error || !error.code) return 500;
    if (error.code === 'unknown_card' || error.code === 'unknown_action' || error.code === 'not_found') return 404;
    if (error.code === 'invalid') return 400;
    if (error.code === 'conflict') return 409;
    if (error.code === 'no_database') return 503;
    if (error.code === 'upstream') return 502; // a service the action called did not answer
    return 500;
}

function register(app, options) {
    const { storageDir, clientIp, rateLimit, ask, log } = options;
    const production = process.env.NODE_ENV === 'production';
    const mainActions = loadMainActions(log);

    const signInLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: 10,
        standardHeaders: true,
        legacyHeaders: false,
        keyGenerator: clientIp,
        validate: { xForwardedForHeader: false },
        skipSuccessfulRequests: true,
        message: { error: 'too_many_attempts' }
    });

    app.post('/api/admin/v2/sign-in', signInLimiter, (req, res) => {
        const key = expectedKey();
        if (!key) return res.status(503).json({ error: 'not_configured' });
        const sent = req.body && typeof req.body.key === 'string' ? req.body.key.trim() : '';
        if (sent === '' || !sameText(sent, key)) return res.status(401).json({ error: 'invalid_key' });
        res.cookie(COOKIE, newToken(key), { httpOnly: true, secure: production, sameSite: 'strict', maxAge: SESSION_MS, path: '/' });
        res.status(204).end();
    });

    app.post('/api/admin/v2/sign-out', (req, res) => {
        res.clearCookie(COOKIE, { path: '/' });
        res.status(204).end();
    });

    const noStore = (req, res, next) => {
        res.set('Cache-Control', 'no-store');
        next();
    };

    app.get('/api/admin/v2/frame', requireSession, noStore, async (req, res) => {
        try {
            const frame = await ask('frame', {}, ASK_MS);
            // Behind Railway's proxy the request itself is plain http; the proxy names the real scheme.
            const scheme = String(req.headers['x-forwarded-proto'] || req.protocol).split(',')[0].trim() || 'https';
            const base = process.env.SHORT_LINK_BASE || `${scheme}://${req.get('host')}/go/`;
            res.json({ ...frame, short_link_base: base });
        } catch (error) {
            res.status(statusOf(error) === 500 ? 503 : statusOf(error)).json({ error: 'unavailable', detail: String(error.message || error).slice(0, 200) });
        }
    });

    // The names of every card and action (for scripts/check-insights-dashboard.js).
    app.get('/api/admin/v2/cards', requireSession, noStore, async (req, res) => {
        try {
            const list = await ask('list', {}, ASK_MS);
            res.json({ ...list, main_actions: Object.keys(mainActions).sort() });
        } catch (error) {
            res.status(503).json({ error: 'unavailable' });
        }
    });

    app.get('/api/admin/v2/q/:card', requireSession, noStore, async (req, res) => {
        if (!NAME.test(req.params.card)) return res.status(404).json({ error: 'unknown_card' });
        // Only plain string parameters reach the worker.
        const params = {};
        for (const [key, value] of Object.entries(req.query)) {
            if (typeof value === 'string' && key.length <= 40 && value.length <= 300) params[key] = value;
        }
        try {
            res.json(await ask('card', { card: req.params.card, params }, ASK_MS));
        } catch (error) {
            const status = statusOf(error);
            if (status === 500) log.error(`Insights card ${req.params.card} failed:`, error.message);
            res.status(status).json({ error: error.code || 'failed', detail: String(error.message || error).slice(0, 300) });
        }
    });

    app.post('/api/admin/v2/do/:action', requireSession, noStore, async (req, res) => {
        const name = req.params.action;
        if (!NAME.test(name)) return res.status(404).json({ error: 'unknown_action' });
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        try {
            if (Object.prototype.hasOwnProperty.call(mainActions, name)) {
                const result = await mainActions[name](body, {
                    storageDir, log, req,
                    card: (card, params = {}) => ask('card', { card, params }, ASK_MS),
                    action: (action, actionBody = {}) => ask('action', { action, body: actionBody }, ASK_MS)
                });
                return res.json({ ok: true, ...(result && typeof result === 'object' ? result : {}) });
            }
            res.json(await ask('action', { action: name, body }, ASK_MS));
        } catch (error) {
            const status = statusOf(error);
            if (status === 500) log.error(`Insights action ${name} failed:`, error.message);
            res.status(status).json({ error: error.code || 'failed', detail: String(error.message || error).slice(0, 300) });
        }
    });

    // Gallery thumbnails for the dashboard. The game's own thumbnail route may
    // be gated by the game's API key, which the dashboard does not have.
    app.get('/api/admin/v2/thumb/:file', requireSession, (req, res) => {
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(req.params.file)) return res.status(404).end();
        res.sendFile(req.params.file, { root: path.join(storageDir, 'thumbnails'), maxAge: 3600 * 1000, dotfiles: 'deny' }, (error) => {
            if (error && !res.headersSent) res.status(404).end();
        });
    });

    app.get('/api/admin/v2/crash-archive/:id', requireSession, async (req, res) => {
        try {
            const found = await ask('crash_file', { id: req.params.id }, ASK_MS);
            if (!found || !found.file) return res.status(404).json({ error: 'not_found' });
            const file = path.resolve(storageDir, found.file);
            const inside = path.relative(path.resolve(storageDir), file);
            // Old reports recorded an absolute path when the archive lay outside the storage folder.
            if ((inside.startsWith('..') || path.isAbsolute(inside)) && !path.isAbsolute(found.file)) return res.status(404).json({ error: 'not_found' });
            if (!fs.existsSync(file)) return res.status(404).json({ error: 'archive_gone' });
            res.download(file, `R-${found.id}-${String(found.crash_guid).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)}${path.extname(file) || '.zip'}`);
        } catch (error) {
            res.status(503).json({ error: 'unavailable' });
        }
    });

    // The interface. Its files hold no data; everything it shows comes from the routes above.
    const uiDir = path.join(__dirname, '..', 'insights-ui', 'dist');
    if (fs.existsSync(path.join(uiDir, 'index.html'))) {
        app.use('/insights', express.static(uiDir, { index: false, maxAge: '1h', setHeaders(res, file) {
            if (file.endsWith('.html')) res.set('Cache-Control', 'no-cache');
            else if (/[\\/]assets[\\/]/.test(file)) res.set('Cache-Control', 'public, max-age=31536000, immutable');
        } }));
        app.get(['/insights', '/insights/*'], (req, res) => {
            res.set('Cache-Control', 'no-cache');
            res.sendFile(path.join(uiDir, 'index.html'));
        });
        log.log('Insights dashboard enabled at /insights');
    } else {
        log.log('Insights dashboard not built (insights-ui/dist is missing); the API is available');
    }
}

module.exports = { register, hasSession, isDashboardRequest, newToken, validToken };
