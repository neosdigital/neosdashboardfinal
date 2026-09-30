const crypto = require('crypto');
const express = require('express');
const { notifyNewLead } = require('./whatsapp');
const { notifyNewLeadPush } = require('./push');

const GRAPH = 'https://graph.facebook.com/v21.0';

/* ── META LEAD ADS ──
   Webhook "leadgen" da Página: todo lead dos formulários instantâneos (a
   "Central de Leads" da Meta) cai aqui → é gravado na tabela leads do
   dashboard (Kanban + alerta em tempo real) → avisa os closers no WhatsApp. */

/* Assinatura HMAC-SHA256 do corpo bruto com a chave secreta do app */
function signatureValid(rawBody, header) {
    const secret = process.env.META_APP_SECRET;
    if (!secret || !rawBody || !header || !header.startsWith('sha256=')) return false;
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(header), b = Buffer.from(expected);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* Token por página (META_PAGE_TOKEN_<pageId>) ou um único META_PAGE_TOKEN */
const pageToken = pageId => process.env[`META_PAGE_TOKEN_${pageId}`] || process.env.META_PAGE_TOKEN;

async function graphGet(path, token, fields) {
    const qs = new URLSearchParams({ access_token: token });
    if (fields) qs.set('fields', fields);
    const r = await fetch(`${GRAPH}/${path}?${qs}`);
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return d;
}

/* Nome de campanha/anúncio exige permissão de anúncios no token — se faltar,
   ainda salva o lead só com os dados do formulário. */
async function fetchLead(leadgenId, token) {
    try {
        return await graphGet(leadgenId, token, 'created_time,field_data,form_id,ad_id,ad_name,adset_name,campaign_name,platform');
    } catch (e) {
        console.warn('[Neos] Lead sem contexto de anúncio:', e.message);
        return graphGet(leadgenId, token, 'created_time,field_data,form_id,platform');
    }
}

/* Mesmo formato do neosformulario: DDD+número sem o 55, ex. (14) 99140-1406 */
function formatPhoneBR(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
    if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
    if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
    return raw || '';
}

const STANDARD_FIELDS = new Set(['full_name', 'first_name', 'last_name', 'phone_number', 'email', 'company_name']);
const prettyQuestion = k => k.replace(/_/g, ' ').replace(/\?$/, '').trim().replace(/^./, c => c.toUpperCase());

function buildLeadDoc(leadgenId, lead, formName) {
    const f = {};
    for (const item of lead.field_data || []) f[item.name] = (item.values || []).join(', ');
    const name = f.full_name || [f.first_name, f.last_name].filter(Boolean).join(' ') || 'Lead Meta Ads';
    const answers = Object.entries(f).filter(([k]) => !STANDARD_FIELDS.has(k)).map(([k, v]) => `${prettyQuestion(k)}: ${v}`);
    const platform = lead.platform === 'ig' ? 'Instagram' : lead.platform === 'fb' ? 'Facebook' : '';
    const tracking = [
        ['Formulário', formName], ['Campanha', lead.campaign_name], ['Conjunto', lead.adset_name],
        ['Anúncio', lead.ad_name], ['Plataforma', platform], ['Lead ID', leadgenId]
    ].filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`);
    const now = new Date().toISOString();
    const created = new Date(lead.created_time || now);
    return {
        id: `meta_${leadgenId}`,
        createdAt: isNaN(created) ? now : created.toISOString(),
        updatedAt: now,
        lastInteraction: now,
        status: 'Novos Leads',
        priority: 'Média',
        score: 0,
        origin: 'Meta Ads',
        name,
        company: f.company_name || '',
        phone: formatPhoneBR(f.phone_number),
        email: f.email || '',
        responsible: '',
        value: null,
        qualification: '',
        tags: lead.campaign_name || formName || '',
        notes: ['Lead recebido pela Central de Leads (formulário instantâneo Meta Ads).', ...answers, '', 'Rastreamento:', ...tracking].join('\n'),
        nextAction: '',
        nextActionDate: '',
        modifiedBy: 'Meta Lead Ads',
        modifiedAt: now,
        metaLeadId: leadgenId,
        _answers: answers
    };
}

async function processLeadgen(value, pool, broadcast) {
    const leadgenId = String(value.leadgen_id);
    const token = pageToken(value.page_id);
    if (!token) return console.error(`[Neos] Sem META_PAGE_TOKEN para a página ${value.page_id}`);

    const lead = await fetchLead(leadgenId, token);
    const formName = await graphGet(lead.form_id || value.form_id, token, 'name').then(d => d.name).catch(() => '');
    const { _answers: answers, ...doc } = buildLeadDoc(leadgenId, lead, formName);

    /* id fixo meta_<leadgen_id>: se a Meta reenviar o evento, não duplica nem re-notifica */
    const { rowCount } = await pool.query(
        `INSERT INTO "leads" (_doc) VALUES ($1::jsonb) ON CONFLICT ((_doc->>'id')) DO NOTHING`,
        [JSON.stringify(doc)]
    );
    if (!rowCount) return console.log(`[Neos] Lead Meta ${leadgenId} já existia — ignorado`);

    broadcast({ eventType: 'INSERT', table: 'leads', new: doc });
    notifyNewLeadPush(pool, doc);
    console.log(`[Neos] Lead Meta ${leadgenId} salvo (${doc.name})`);

    try {
        const r = await notifyNewLead({
            name: doc.name,
            whatsapp: doc.phone,
            businessType: doc.company || formName || 'Formulário Meta',
            situacao: answers.join(' | '),
            origin: ['Meta Ads', lead.campaign_name].filter(Boolean).join(' · ')
        });
        console.log(`[Neos] WhatsApp lead ${leadgenId}: ${r.sent} enviados, ${r.failed} falhas`);
    } catch (e) {
        console.error(`[Neos] Lead ${leadgenId} salvo, mas o aviso no WhatsApp falhou:`, e.message);
    }
}

function metaLeadsRouter(pool, broadcast) {
    const router = express.Router();

    /* Verificação exigida pela Meta ao cadastrar a URL de callback */
    router.get('/', (req, res) => {
        const ok = req.query['hub.mode'] === 'subscribe'
            && process.env.META_VERIFY_TOKEN
            && req.query['hub.verify_token'] === process.env.META_VERIFY_TOKEN;
        if (ok) return res.status(200).send(String(req.query['hub.challenge'] || ''));
        res.sendStatus(403);
    });

    /* Responde 200 na hora (a Meta re-tenta por horas se demorar/falhar) e processa em seguida */
    router.post('/', (req, res) => {
        if (!signatureValid(req.rawBody, req.get('x-hub-signature-256'))) {
            console.warn('[Neos] Webhook Meta com assinatura inválida');
            return res.sendStatus(401);
        }
        res.sendStatus(200);
        if (req.body?.object !== 'page') return;
        for (const entry of req.body.entry || []) {
            for (const change of entry.changes || []) {
                if (change.field !== 'leadgen') continue;
                processLeadgen(change.value, pool, broadcast)
                    .catch(e => console.error(`[Neos] Erro no lead Meta ${change.value?.leadgen_id}:`, e.message));
            }
        }
    });

    return router;
}

module.exports = { metaLeadsRouter };
