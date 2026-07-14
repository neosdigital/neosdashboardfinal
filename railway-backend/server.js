const express = require('express');
const { Pool } = require('pg');
const http = require('http');
const WebSocket = require('ws');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '50mb' }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

/* ── TABLES ── todas as tabelas do Neos Dashboard */
const TABLES = [
    'clients', 'tasks', 'financials', 'trafficData', 'designReqs',
    'performance', 'calEvents', 'costs', 'clientImages', 'leads',
    'leadInteractions', 'goals', 'login_users', 'meta_connections',
    'dailyTasks', 'dailyTaskComments', 'dailyTaskChecklists', 'dailyTaskLinks'
];

/* ── INIT DB ── cria tabelas e índices automaticamente no primeiro boot */
async function initDB() {
    for (const t of TABLES) {
        await pool.query(`CREATE TABLE IF NOT EXISTS "${t}" (_doc JSONB NOT NULL)`);
        await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS "${t}_id_idx" ON "${t}" ((_doc->>'id'))`);
    }
    console.log('[Neos] Banco inicializado ✓ —', TABLES.length, 'tabelas');
}
initDB().catch(e => console.error('[Neos] Erro ao inicializar banco:', e.message));

const tableOk = t => TABLES.includes(t);

/* ─────────────────────────────────────────────────
   REST API
───────────────────────────────────────────────── */

/* GET /api/:table → retorna todos os documentos */
app.get('/api/:table', async (req, res) => {
    if (!tableOk(req.params.table)) return res.status(400).json({ error: 'Tabela inválida' });
    try {
        const { rows } = await pool.query(`SELECT _doc FROM "${req.params.table}"`);
        res.json({ data: rows.map(r => r._doc) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* GET /api/:table/filter?eq_col=val&not_null=col&neq_col=val → query com filtros */
app.get('/api/:table/filter', async (req, res) => {
    if (!tableOk(req.params.table)) return res.status(400).json({ error: 'Tabela inválida' });
    try {
        const conditions = [], params = [];
        for (const [k, v] of Object.entries(req.query)) {
            if (k.startsWith('eq_')) {
                conditions.push(`_doc->>'${k.slice(3)}' = $${params.length + 1}`);
                params.push(v);
            } else if (k === 'not_null') {
                conditions.push(`_doc->>'${v}' IS NOT NULL AND _doc->>'${v}' != '' AND _doc->>'${v}' != '[]'`);
            } else if (k.startsWith('neq_')) {
                conditions.push(`(_doc->>'${k.slice(4)}' IS NULL OR _doc->>'${k.slice(4)}' != $${params.length + 1})`);
                params.push(v);
            }
        }
        let sql = `SELECT _doc FROM "${req.params.table}"`;
        if (conditions.length) sql += ` WHERE ${conditions.join(' AND ')}`;
        const { rows } = await pool.query(sql, params);
        res.json({ data: rows.map(r => r._doc) });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

/* POST /api/:table → insert */
app.post('/api/:table', async (req, res) => {
    if (!tableOk(req.params.table)) return res.status(400).json({ error: 'Tabela inválida' });
    try {
        const doc = req.body;
        await pool.query(
            `INSERT INTO "${req.params.table}" (_doc) VALUES ($1::jsonb)
             ON CONFLICT ((_doc->>'id')) DO NOTHING`,
            [JSON.stringify(doc)]
        );
        broadcast({ eventType: 'INSERT', table: req.params.table, new: doc });
        res.json({ data: doc, error: null });
    } catch (e) {
        res.status(500).json({ data: null, error: { message: e.message } });
    }
});

/* POST /api/:table/bulk → upsert múltiplos registros em uma transação */
app.post('/api/:table/bulk', async (req, res) => {
    if (!tableOk(req.params.table)) return res.status(400).json({ error: 'Tabela inválida' });
    const docs = req.body;
    if (!Array.isArray(docs) || docs.length === 0) return res.json({ data: [], error: null });
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        for (const doc of docs) {
            await client.query(
                `INSERT INTO "${req.params.table}" (_doc) VALUES ($1::jsonb)
                 ON CONFLICT ((_doc->>'id')) DO UPDATE SET _doc = EXCLUDED._doc`,
                [JSON.stringify(doc)]
            );
        }
        await client.query('COMMIT');
        broadcast({ eventType: 'UPDATE', table: req.params.table, count: docs.length });
        res.json({ data: docs, error: null });
    } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        res.status(500).json({ data: null, error: { message: e.message } });
    } finally {
        client.release();
    }
});

/* PUT /api/:table → upsert (insert or update) */
app.put('/api/:table', async (req, res) => {
    if (!tableOk(req.params.table)) return res.status(400).json({ error: 'Tabela inválida' });
    try {
        const doc = req.body;
        await pool.query(
            `INSERT INTO "${req.params.table}" (_doc) VALUES ($1::jsonb)
             ON CONFLICT ((_doc->>'id')) DO UPDATE SET _doc = EXCLUDED._doc`,
            [JSON.stringify(doc)]
        );
        broadcast({ eventType: 'UPDATE', table: req.params.table, new: doc });
        res.json({ data: doc, error: null });
    } catch (e) {
        res.status(500).json({ data: null, error: { message: e.message } });
    }
});

/* PATCH /api/:table/:id → update parcial — retorna doc completo para broadcast correto */
app.patch('/api/:table/:id', async (req, res) => {
    if (!tableOk(req.params.table)) return res.status(400).json({ error: 'Tabela inválida' });
    try {
        const { table, id } = req.params;
        const { rows } = await pool.query(
            `UPDATE "${table}" SET _doc = _doc || $1::jsonb WHERE _doc->>'id' = $2 RETURNING _doc`,
            [JSON.stringify(req.body), id]
        );
        const doc = rows[0]?._doc || { id, ...req.body };
        broadcast({ eventType: 'UPDATE', table, new: doc });
        res.json({ data: doc, error: null });
    } catch (e) {
        res.status(500).json({ data: null, error: { message: e.message } });
    }
});

/* DELETE /api/:table/:id */
app.delete('/api/:table/:id', async (req, res) => {
    if (!tableOk(req.params.table)) return res.status(400).json({ error: 'Tabela inválida' });
    try {
        const { table, id } = req.params;
        await pool.query(`DELETE FROM "${table}" WHERE _doc->>'id' = $1`, [id]);
        broadcast({ eventType: 'DELETE', table, old: { id } });
        res.json({ data: { id }, error: null });
    } catch (e) {
        res.status(500).json({ data: null, error: { message: e.message } });
    }
});

/* Health check */
app.get('/health', (_, res) => res.json({ ok: true }));

/* ─────────────────────────────────────────────────
   WEBSOCKET — Realtime + Chat + Cursores + Presence
───────────────────────────────────────────────── */

const wsClients = new Set();
/* presenceState: channelName → Map<key, data> */
const presenceState = new Map();

wss.on('connection', ws => {
    ws._channels = new Set();
    ws._presenceKey = null;
    ws._presenceChannel = null;
    wsClients.add(ws);

    ws.on('message', raw => {
        try {
            const msg = JSON.parse(raw);

            /* Broadcast (chat, cursores) → repassa para todos */
            if (msg.type === 'broadcast') {
                const out = JSON.stringify(msg);
                wsClients.forEach(c => {
                    if (c !== ws && c.readyState === WebSocket.OPEN) c.send(out);
                });
                return;
            }

            /* Presence track → registra e avisa todos */
            if (msg.type === 'presence_track') {
                const ch = msg.channel || 'default';
                if (!presenceState.has(ch)) presenceState.set(ch, new Map());
                presenceState.get(ch).set(msg.key, msg.data);
                ws._presenceKey = msg.key;
                ws._presenceChannel = ch;
                broadcastPresence(ch);
                return;
            }
        } catch {}
    });

    ws.on('close', () => {
        wsClients.delete(ws);
        /* Remove presence ao desconectar */
        if (ws._presenceKey && ws._presenceChannel) {
            const ch = presenceState.get(ws._presenceChannel);
            if (ch) {
                ch.delete(ws._presenceKey);
                broadcastPresence(ws._presenceChannel);
            }
        }
    });

    ws.on('error', () => {});
});

function broadcast(payload) {
    const msg = JSON.stringify(payload);
    wsClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    });
}

function broadcastPresence(channel) {
    const state = {};
    (presenceState.get(channel) || new Map()).forEach((v, k) => { state[k] = [v]; });
    const msg = JSON.stringify({ type: 'presence_sync', channel, state });
    wsClients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`[Neos] Railway API rodando na porta ${PORT}`));
