const { sendPush } = require('./push');

const GRAPH = 'https://graph.facebook.com/v21.0';
const TZ = 'America/Sao_Paulo';

/* ── MONITOR META ADS ──
   A cada META_MONITOR_MINUTES (padrão 15) lê as contas das BMs escolhidas na
   Central Meta Ads (hubBms da conexão), e para cada problema novo — sem saldo /
   pagamento pendente, saldo baixo, campanha ativa sem gasto, token vencendo —
   manda push para todos os aparelhos e cria uma tarefa no Kanban. Problema que
   some é resolvido sozinho: a tarefa vai para "Concluído".
   Regras iguais às dos cards da aba (hubAlertOf no index.html) — manter em sincronia. */

const ACC_STATUS = { 2: 'Desativada', 3: 'Pagamento pendente', 7: 'Em análise', 8: 'Liquidação pendente', 9: 'Período de carência', 100: 'Encerrando', 101: 'Encerrada' };
const ACC_FIELDS = 'name,account_status,balance,is_prepay_account,funding_source_details,business{id,name},insights.date_preset(today){spend},campaigns.limit(200){effective_status,daily_budget}';
/* "campanha ativa sem gasto" só vale depois desse horário — de madrugada todas estão em zero */
const IDLE_FROM_HOUR = 10;
const RENOTIFY_MS = 24 * 60 * 60 * 1000;

async function graph(path, token, params = {}) {
    const qs = new URLSearchParams({ access_token: token, ...params });
    const d = await (await fetch(`${GRAPH}/${path}?${qs}`)).json();
    if (d.error) throw new Error(d.error.message);
    return d;
}
async function graphAll(path, token, params) {
    let page = await graph(path, token, params);
    const out = [...(page.data || [])];
    while (page.paging?.next && out.length < 2000) {
        page = await (await fetch(page.paging.next)).json();
        if (page.error) throw new Error(page.error.message);
        out.push(...(page.data || []));
    }
    return out;
}

const fmt = n => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(n || 0);
const parseMetaMoney = s => { const m = String(s || '').match(/([\d.]+,\d{2})/); return m ? parseFloat(m[1].replace(/\./g, '').replace(',', '.')) : null; };
const daysLabel = d => d < 1 ? 'menos de 1 dia' : Math.floor(d) + (Math.floor(d) === 1 ? ' dia' : ' dias');
const hourBR = () => parseInt(new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', hour12: false }).format(new Date()), 10);
const todayBR = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const nowBR = () => new Date().toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const genId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

/* Mesmo cálculo da aba: tipo do alerta da conta, ou null */
function alertOf(a) {
    const camps = a.campaigns?.data || [];
    const active = camps.filter(c => c.effective_status === 'ACTIVE');
    if (!active.length) return null;
    const spendToday = parseFloat(a.insights?.data?.[0]?.spend) || 0;
    const prepaid = a.is_prepay_account;
    const balance = prepaid ? (parseMetaMoney(a.funding_source_details?.display_string) ?? 0) : null;
    const daily = active.reduce((s, c) => s + (parseFloat(c.daily_budget) || 0) / 100, 0);
    const n = active.length, camp = `${n} campanha${n > 1 ? 's' : ''} ativa${n > 1 ? 's' : ''}`;
    if (a.account_status !== 1) {
        const label = ACC_STATUS[a.account_status] || 'Com problema';
        return { type: 'payment', group: 'payment', title: `🔴 ${label}`, task: `Regularizar pagamento: ${a.name}`,
            body: `${a.name} está com "${label.toLowerCase()}" e ${camp} sem veicular. Regularize para voltar a rodar.` };
    }
    if (prepaid && balance <= 0) {
        return { type: 'nofunds', group: 'funds', title: '🔴 Conta sem saldo', task: `Recarregar saldo: ${a.name}`,
            body: `${a.name} está sem saldo e ${camp} parada${n > 1 ? 's' : ''}. Adicione saldo para voltar a veicular.` };
    }
    const days = prepaid && daily > 0 ? balance / daily : null;
    if (prepaid && (days != null ? days < 2 : balance < 50)) {
        return { type: 'lowbal', group: 'funds', title: '🟡 Saldo baixo', task: `Recarregar saldo: ${a.name}`,
            body: `${a.name} está com saldo baixo (${fmt(balance)}).${days != null ? ` Vai durar ${daysLabel(days)} de campanha.` : ''} Atualize o saldo.` };
    }
    if (spendToday === 0 && hourBR() >= IDLE_FROM_HOUR) {
        return { type: 'idle', group: 'idle', title: '🟠 Campanha sem gasto', task: `Verificar veiculação: ${a.name}`,
            body: `${a.name} tem ${camp}, mas não gastou nada hoje. Verifique a veiculação.` };
    }
    return null;
}

async function loadAccounts(token) {
    const map = new Map();
    (await graphAll('me/adaccounts', token, { fields: ACC_FIELDS, limit: 50 })).forEach(a => map.set(a.id, a));
    const bizs = await graphAll('me/businesses', token, { fields: 'id,owned_ad_accounts.limit(200){id},client_ad_accounts.limit(200){id}', limit: 100 });
    const missing = [...new Set(bizs.flatMap(b => [...(b.owned_ad_accounts?.data || []), ...(b.client_ad_accounts?.data || [])].map(a => a.id)))].filter(id => !map.has(id));
    for (let i = 0; i < missing.length; i += 25) {
        const chunk = missing.slice(i, i + 25);
        try { Object.values(await graph('', token, { ids: chunk.join(','), fields: ACC_FIELDS })).forEach(a => map.set(a.id, a)); }
        catch { for (const id of chunk) { try { map.set(id, await graph(id, token, { fields: ACC_FIELDS })); } catch {} } }
    }
    return [...map.values()];
}

function startMetaMonitor(pool, broadcast) {
    let running = false;

    const createTask = async (alert, bmName) => {
        const now = new Date().toISOString();
        const task = {
            id: genId(), createdAt: now, title: alert.task,
            desc: `${alert.body}\n\nBM: ${bmName || '—'}\nCriada automaticamente pela Central Meta Ads em ${nowBR()}.`,
            status: 'A Fazer', dueDate: todayBR(), clientId: '', clientName: bmName || '', priority: alert.type === 'idle' ? 'Média' : 'Alta',
            assignee: '', category: 'Tráfego', fromCalendar: false, modifiedBy: 'Central Meta Ads', modifiedAt: now, metaAlertKey: alert.key
        };
        await pool.query(`INSERT INTO "tasks" (_doc) VALUES ($1::jsonb) ON CONFLICT ((_doc->>'id')) DO NOTHING`, [JSON.stringify(task)]);
        broadcast({ eventType: 'INSERT', table: 'tasks', new: task });
        return task.id;
    };

    /* Problema resolvido: conclui a tarefa, se ninguém concluiu antes */
    const closeTask = async (taskId, reason) => {
        if (!taskId) return;
        const { rows } = await pool.query(`SELECT _doc FROM "tasks" WHERE _doc->>'id' = $1`, [taskId]);
        const t = rows[0]?._doc;
        if (!t || t.status === 'Concluído') return;
        const patch = { status: 'Concluído', desc: `${t.desc || ''}\n\n✓ ${reason} (${nowBR()}).`, modifiedBy: 'Central Meta Ads', modifiedAt: new Date().toISOString() };
        const { rows: upd } = await pool.query(`UPDATE "tasks" SET _doc = _doc || $1::jsonb WHERE _doc->>'id' = $2 RETURNING _doc`, [JSON.stringify(patch), taskId]);
        if (upd[0]) broadcast({ eventType: 'UPDATE', table: 'tasks', new: upd[0]._doc });
    };

    const run = async () => {
        if (running) return;
        running = true;
        try {
            await pool.query(`CREATE TABLE IF NOT EXISTS "meta_alert_state" (key TEXT PRIMARY KEY, data JSONB NOT NULL, task_id TEXT, notified_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now())`);
            const { rows: connRows } = await pool.query(`SELECT _doc FROM "meta_connections"`);
            const conns = connRows.map(r => r._doc).filter(c => c.accessToken);
            const current = new Map();   /* key → alerta ativo agora */
            const checked = new Set();   /* contas/conexões lidas com sucesso nesta rodada */
            const outOfScope = new Set(); /* contas de BMs desmarcadas na aba */

            for (const c of conns) {
                const exp = c.expiresAt ? new Date(c.expiresAt) : null;
                const daysLeft = exp ? (exp - Date.now()) / 86400000 : null;
                checked.add(`token:${c.id}`);
                if (daysLeft != null && daysLeft <= 5) {
                    const expired = daysLeft <= 0;
                    current.set(`token:${c.id}`, { key: `token:${c.id}`, type: 'token', group: 'token', title: '🔑 Token do Meta', task: 'Renovar token do Meta (Central Meta Ads)',
                        body: expired ? `O token do Meta de ${c.metaUserName || 'sua conta'} expirou. A Central Meta Ads parou de atualizar — cole um token novo.`
                            : `O token do Meta de ${c.metaUserName || 'sua conta'} vence em ${daysLabel(daysLeft)}. Gere um novo para a Central Meta Ads não parar.`, bm: '' });
                    if (expired) continue;
                }
                let accounts;
                try { accounts = await loadAccounts(c.accessToken); }
                catch (e) { console.warn('[Neos] Monitor Meta: falha ao ler contas —', e.message); continue; }
                const sel = Array.isArray(c.hubBms) ? new Set(c.hubBms) : null;
                for (const a of accounts) {
                    checked.add(a.id);
                    if (sel && !sel.has(a.business?.id || 'none')) { outOfScope.add(a.id); continue; }
                    /* conta sem nome (só o número) fica difícil de reconhecer na notificação */
                    if (/^\d+$/.test(a.name || '') && a.business?.name) a.name = `${a.business.name} (conta ${a.name})`;
                    const al = alertOf(a);
                    if (al) current.set(`${al.group}:${a.id}`, { ...al, key: `${al.group}:${a.id}`, account: a.id, bm: a.business?.name || '' });
                }
            }

            const { rows: stateRows } = await pool.query(`SELECT key, data, task_id, notified_at FROM "meta_alert_state"`);
            const state = new Map(stateRows.map(r => [r.key, r]));

            for (const [key, al] of current) {
                const prev = state.get(key);
                /* saldo baixo → sem saldo (ou o contrário) é o mesmo problema mudando: avisa de novo, mantém a tarefa */
                const changed = prev && prev.data?.type !== al.type;
                const stale = prev && al.type !== 'idle' && Date.now() - new Date(prev.notified_at).getTime() > RENOTIFY_MS;
                if (prev && !changed && !stale) continue;
                await sendPush(pool, { title: al.title, body: al.body, tag: `meta_${key}`, view: 'metahub' });
                if (!prev) {
                    const taskId = await createTask(al, al.bm).catch(e => { console.error('[Neos] Monitor Meta: tarefa não criada —', e.message); return null; });
                    await pool.query(`INSERT INTO "meta_alert_state" (key, data, task_id, notified_at) VALUES ($1, $2::jsonb, $3, now()) ON CONFLICT (key) DO NOTHING`, [key, JSON.stringify(al), taskId]);
                    console.log(`[Neos] Monitor Meta: novo alerta ${key} — ${al.body}`);
                } else {
                    await pool.query(`UPDATE "meta_alert_state" SET notified_at = now(), data = $2::jsonb WHERE key = $1`, [key, JSON.stringify(al)]);
                }
            }

            /* resolve só o que foi conferido nesta rodada (falha de leitura não fecha tarefa) */
            for (const [key, prev] of state) {
                if (current.has(key)) continue;
                const subject = key.slice(key.indexOf(':') + 1);
                if (!checked.has(key.startsWith('token:') ? key : subject)) continue;
                /* antes do horário ninguém gastou ainda — não dá para dizer que voltou a veicular */
                if (key.startsWith('idle:') && hourBR() < IDLE_FROM_HOUR) continue;
                const reason = outOfScope.has(subject) ? 'Encerrada: a BM saiu do acompanhamento da Central Meta Ads'
                    : key.startsWith('funds:') ? 'Resolvido: a conta voltou a ter saldo'
                    : key.startsWith('payment:') ? 'Resolvido: pagamento regularizado'
                    : key.startsWith('idle:') ? 'Resolvido: a conta voltou a gastar' : 'Resolvido: token renovado';
                await closeTask(prev.task_id, reason).catch(() => {});
                await pool.query(`DELETE FROM "meta_alert_state" WHERE key = $1`, [key]);
                console.log(`[Neos] Monitor Meta: alerta resolvido ${key}`);
            }
        } catch (e) {
            console.error('[Neos] Monitor Meta falhou:', e.message);
        } finally {
            running = false;
        }
    };

    const minutes = Math.max(5, parseInt(process.env.META_MONITOR_MINUTES, 10) || 15);
    setTimeout(run, 60 * 1000);
    setInterval(run, minutes * 60 * 1000);
    console.log(`[Neos] Monitor Meta Ads ativo — a cada ${minutes} min`);
    return run;
}

module.exports = { startMetaMonitor };
