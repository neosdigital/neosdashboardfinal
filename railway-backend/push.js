const express = require('express');
const webpush = require('web-push');

/* ── WEB PUSH ──
   Notificação no celular (PWA instalado / Chrome Android / Safari iOS 16.4+)
   quando chega lead novo, mesmo com o dashboard fechado. As chaves VAPID vêm de
   VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY; sem elas, são geradas no 1º boot e
   guardadas no banco — trocar as chaves invalida todas as inscrições. */

let ready = null;

function initPush(pool) {
    ready = (async () => {
        await pool.query(`CREATE TABLE IF NOT EXISTS "push_config" (key TEXT PRIMARY KEY, value JSONB NOT NULL)`);
        await pool.query(`CREATE TABLE IF NOT EXISTS "push_subscriptions" (
            endpoint TEXT PRIMARY KEY, sub JSONB NOT NULL, username TEXT, name TEXT, created_at TIMESTAMPTZ DEFAULT now())`);
        let keys = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
            ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
            : null;
        if (!keys) {
            const { rows } = await pool.query(`SELECT value FROM "push_config" WHERE key = 'vapid'`);
            keys = rows[0]?.value;
            if (!keys) {
                keys = webpush.generateVAPIDKeys();
                await pool.query(`INSERT INTO "push_config" (key, value) VALUES ('vapid', $1::jsonb) ON CONFLICT (key) DO NOTHING`, [JSON.stringify(keys)]);
                const { rows: again } = await pool.query(`SELECT value FROM "push_config" WHERE key = 'vapid'`);
                keys = again[0].value;
            }
        }
        webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'https://neosdashboardfinal.vercel.app', keys.publicKey, keys.privateKey);
        console.log('[Neos] Web Push pronto ✓');
        return keys.publicKey;
    })();
    ready.catch(e => console.error('[Neos] Web Push indisponível:', e.message));
    return ready;
}

/* Envia para todas as inscrições (menos a de quem gerou o evento, se informado) */
async function sendPush(pool, payload, { exceptName } = {}) {
    if (!ready) return;
    try { await ready; } catch { return; }
    const { rows } = await pool.query(`SELECT endpoint, sub, name FROM "push_subscriptions"`);
    const body = JSON.stringify(payload);
    await Promise.all(rows.filter(r => !exceptName || r.name !== exceptName).map(async r => {
        try {
            await webpush.sendNotification(r.sub, body, { TTL: 60 * 60 * 24, urgency: 'high' });
        } catch (e) {
            /* 404/410 = inscrição expirada ou app desinstalado */
            if (e.statusCode === 404 || e.statusCode === 410) {
                await pool.query(`DELETE FROM "push_subscriptions" WHERE endpoint = $1`, [r.endpoint]).catch(() => {});
            } else {
                console.warn('[Neos] Push falhou:', e.statusCode || '', e.message);
            }
        }
    }));
}

/* Mesmo texto do alerta interno do dashboard (onNewLead) */
function notifyNewLeadPush(pool, lead) {
    return sendPush(pool, {
        title: '🎯 Novo Lead',
        body: `${lead.name || 'Lead sem nome'} · ${lead.origin || 'Site'}`,
        tag: `lead_${lead.id}`,
        view: 'leads'
    }, { exceptName: lead.modifiedBy }).catch(e => console.error('[Neos] Push de lead falhou:', e.message));
}

function pushRouter(pool) {
    const router = express.Router();

    router.get('/public-key', async (_, res) => {
        try { res.json({ publicKey: await ready }); }
        catch { res.status(503).json({ error: 'push_unavailable' }); }
    });

    router.post('/subscribe', async (req, res) => {
        const { subscription: sub, username, name } = req.body || {};
        if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) return res.status(400).json({ error: 'invalid_subscription' });
        try {
            await pool.query(
                `INSERT INTO "push_subscriptions" (endpoint, sub, username, name) VALUES ($1, $2::jsonb, $3, $4)
                 ON CONFLICT (endpoint) DO UPDATE SET sub = EXCLUDED.sub, username = EXCLUDED.username, name = EXCLUDED.name`,
                [sub.endpoint, JSON.stringify(sub), username || null, name || null]
            );
            res.json({ ok: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    /* Botão "Testar" da aba Configurações: envia só para o aparelho que pediu */
    router.post('/test', async (req, res) => {
        const endpoint = req.body?.endpoint;
        if (!endpoint) return res.status(400).json({ error: 'missing_endpoint' });
        try {
            await ready;
            const { rows } = await pool.query(`SELECT sub FROM "push_subscriptions" WHERE endpoint = $1`, [endpoint]);
            if (!rows[0]) return res.status(404).json({ error: 'not_subscribed' });
            await webpush.sendNotification(rows[0].sub, JSON.stringify({
                title: '🔔 Notificações ativas',
                body: 'É assim que você será avisado quando chegar um lead novo.',
                tag: 'neos_test',
                view: 'leads'
            }), { TTL: 60, urgency: 'high' });
            res.json({ ok: true });
        } catch (e) {
            if (e.statusCode === 404 || e.statusCode === 410) {
                await pool.query(`DELETE FROM "push_subscriptions" WHERE endpoint = $1`, [endpoint]).catch(() => {});
                return res.status(410).json({ error: 'subscription_expired' });
            }
            res.status(500).json({ error: e.message });
        }
    });

    router.post('/unsubscribe', async (req, res) => {
        const endpoint = req.body?.endpoint;
        if (!endpoint) return res.status(400).json({ error: 'missing_endpoint' });
        await pool.query(`DELETE FROM "push_subscriptions" WHERE endpoint = $1`, [endpoint]).catch(() => {});
        res.json({ ok: true });
    });

    return router;
}

module.exports = { initPush, pushRouter, notifyNewLeadPush };
