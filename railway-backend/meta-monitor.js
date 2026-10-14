const { sendPush } = require('./push');

const GRAPH = 'https://graph.facebook.com/v21.0';
const TZ = 'America/Sao_Paulo';

/* ── MONITOR META ADS ──
   A cada META_MONITOR_MINUTES (padrão 15) lê as contas das BMs escolhidas na
   Central Meta Ads (hubBms da conexão), e para cada problema novo — sem saldo /
   pagamento pendente, saldo baixo, campanha ativa sem gasto, token vencendo —
   manda push para todos os aparelhos e cria uma tarefa no Kanban. Problema que
   some é resolvido sozinho: a tarefa vai para "Concluído".
   Contas paradas (sem saldo / pagamento pendente) dividem uma notificação só
   (tag fixa, substitui a anterior), repetida de 3 em 3h enquanto houver alguma.
   Regras iguais às dos cards da aba (hubAlertOf no index.html) — manter em sincronia. */

const ACC_STATUS = { 2: 'Desativada', 3: 'Pagamento pendente', 7: 'Em análise', 8: 'Liquidação pendente', 9: 'Período de carência', 100: 'Encerrando', 101: 'Encerrada' };
/* hoje (sem gasto), últimos 3 e 7 dias (ritmo real de gasto) e ontem (resumo das 8h) */
const ACC_FIELDS = 'name,account_status,balance,is_prepay_account,funding_source_details,business{id,name},'
    + 'insights.date_preset(today).as(hoje){spend},insights.date_preset(last_3d).as(tresdias){spend},insights.date_preset(last_7d).as(setedias){spend},'
    + 'insights.date_preset(yesterday).as(ontem){spend,actions},campaigns.limit(200){effective_status,daily_budget}';
/* etapas do saldo baixo, em dias de gasto restantes */
const LOW_WARN_DAYS = 3, LOW_URGENT_DAYS = 1;
/* resumo diário: sai na primeira rodada a partir das 8h (até 11h, se o servidor estiver fora às 8h) */
const DAILY_FROM_HOUR = 8, DAILY_UNTIL_HOUR = 11;
/* "campanha ativa sem gasto" só vale depois desse horário — de madrugada todas estão em zero */
const IDLE_FROM_HOUR = 10;
const RENOTIFY_MS = 24 * 60 * 60 * 1000;
/* contas paradas (sem saldo / pagamento pendente): um lembrete único com todas, que substitui o anterior */
const STOPPED_REMIND_MS = 3 * 60 * 60 * 1000;

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

const spendOf = (a, alias) => parseFloat(a[alias]?.data?.[0]?.spend) || 0;
const leadsOf = (a, alias) => {
    const acts = a[alias]?.data?.[0]?.actions || [];
    const v = t => parseFloat(acts.find(x => x.action_type === t)?.value) || 0;
    return v('lead') || v('onsite_conversion.lead_grouped');
};
/* Gasto diário real: a maior média entre 3 e 7 dias (avisa antes quando o gasto acelera);
   sem histórico, usa o orçamento diário das campanhas ativas */
const burnRate = (a, dailyBudget) => Math.max(spendOf(a, 'tresdias') / 3, spendOf(a, 'setedias') / 7) || dailyBudget;

/* Mesmo cálculo da aba: tipo do alerta da conta, ou null */
function alertOf(a) {
    const camps = a.campaigns?.data || [];
    const active = camps.filter(c => c.effective_status === 'ACTIVE');
    if (!active.length) return null;
    const spendToday = spendOf(a, 'hoje');
    const prepaid = a.is_prepay_account;
    const balance = prepaid ? (parseMetaMoney(a.funding_source_details?.display_string) ?? 0) : null;
    const daily = burnRate(a, active.reduce((s, c) => s + (parseFloat(c.daily_budget) || 0) / 100, 0));
    const n = active.length, s = n > 1 ? 's' : '';
    /* body = texto curto da notificação; detail = descrição da tarefa no Kanban */
    if (a.account_status !== 1) {
        const label = ACC_STATUS[a.account_status] || 'Com problema';
        return { type: 'payment', group: 'payment', stopped: true, title: label, task: `Regularizar pagamento: ${a.name}`,
            body: `${a.name} · ${n} campanha${s} parada${s}`,
            detail: `${a.name} está com "${label.toLowerCase()}" e ${n} campanha${s} ativa${s} sem veicular. Regularize para voltar a rodar.` };
    }
    if (prepaid && balance <= 0) {
        return { type: 'nofunds', group: 'funds', stopped: true, title: 'Sem saldo', task: `Recarregar saldo: ${a.name}`,
            body: `${a.name} · ${n} campanha${s} parada${s}`,
            detail: `${a.name} está sem saldo e ${n} campanha${s} ativa${s} parada${s}. Adicione saldo para voltar a veicular.` };
    }
    const days = prepaid && daily > 0 ? balance / daily : null;
    /* 3 dias: dá tempo de boleto compensar · 1 dia: urgente */
    if (prepaid && (days != null ? days <= LOW_WARN_DAYS : balance < 50)) {
        const urgent = days != null ? days <= LOW_URGENT_DAYS : balance < 20;
        const pace = days != null ? ` no ritmo atual (${fmt(daily)}/dia)` : '';
        return { type: urgent ? 'low1' : 'low3', group: 'funds', title: urgent ? 'Saldo acabando' : 'Saldo baixo', task: `Recarregar saldo: ${a.name}`,
            priority: urgent ? 'Alta' : 'Média',
            body: `${a.name} · ${fmt(balance)}${days != null ? ` · dura ${daysLabel(days)}` : ''}`,
            detail: `${a.name} está com ${fmt(balance)} de saldo.${days != null ? ` Dura ${daysLabel(days)}${pace}.` : ''} ${urgent ? 'Recarregue hoje para não parar.' : 'Planeje a recarga (boleto leva até 3 dias úteis).'}` };
    }
    if (spendToday === 0 && hourBR() >= IDLE_FROM_HOUR) {
        return { type: 'idle', group: 'idle', title: 'Sem gasto hoje', task: `Verificar veiculação: ${a.name}`,
            body: `${a.name} · ${n} campanha${s} ativa${s} sem veicular`,
            detail: `${a.name} tem ${n} campanha${s} ativa${s}, mas não gastou nada hoje. Verifique a veiculação.` };
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
            desc: `${alert.detail || alert.body}\n\nBM: ${bmName || '—'}\nCriada automaticamente pela Central Meta Ads em ${nowBR()}.`,
            status: 'A Fazer', dueDate: todayBR(), clientId: '', clientName: bmName || '', priority: alert.priority || (alert.type === 'idle' ? 'Média' : 'Alta'),
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

    /* Mesmo problema mudou de etapa: atualiza prioridade e anota na descrição */
    const updateTask = async (taskId, alert) => {
        if (!taskId) return;
        const { rows } = await pool.query(`SELECT _doc FROM "tasks" WHERE _doc->>'id' = $1`, [taskId]);
        const t = rows[0]?._doc;
        if (!t || t.status === 'Concluído') return;
        const priority = alert.priority || (alert.type === 'idle' ? 'Média' : 'Alta');
        const patch = { priority, desc: `${t.desc || ''}\n\n${nowBR()} — ${alert.title}: ${alert.detail || alert.body}`, modifiedBy: 'Central Meta Ads', modifiedAt: new Date().toISOString() };
        const { rows: upd } = await pool.query(`UPDATE "tasks" SET _doc = _doc || $1::jsonb WHERE _doc->>'id' = $2 RETURNING _doc`, [JSON.stringify(patch), taskId]);
        if (upd[0]) broadcast({ eventType: 'UPDATE', table: 'tasks', new: upd[0]._doc });
    };

    const run = async () => {
        if (running) return;
        running = true;
        try {
            await pool.query(`CREATE TABLE IF NOT EXISTS "meta_alert_state" (key TEXT PRIMARY KEY, data JSONB NOT NULL, task_id TEXT, notified_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT now())`);
            await pool.query(`CREATE TABLE IF NOT EXISTS "push_config" (key TEXT PRIMARY KEY, value JSONB NOT NULL)`);
            const { rows: connRows } = await pool.query(`SELECT _doc FROM "meta_connections"`);
            const conns = connRows.map(r => r._doc).filter(c => c.accessToken);
            const current = new Map();   /* key → alerta ativo agora */
            const checked = new Set();   /* contas/conexões lidas com sucesso nesta rodada */
            const outOfScope = new Set(); /* contas de BMs desmarcadas na aba */
            const yesterday = { spend: 0, leads: 0, accounts: 0 }; /* soma das BMs acompanhadas, para o resumo das 8h */

            for (const c of conns) {
                /* Dois prazos: a validade do token (pode ser "nunca") e o acesso aos dados, que o Meta
                   corta a cada 90 dias sem nova autorização do app — o que vencer primeiro */
                let exp = c.expiresAt ? new Date(c.expiresAt).getTime() : null;
                try {
                    const d = (await graph('debug_token', c.accessToken, { input_token: c.accessToken })).data || {};
                    [d.expires_at, d.data_access_expires_at].filter(x => x > 0).forEach(x => { exp = Math.min(exp ?? Infinity, x * 1000); });
                } catch {}
                const daysLeft = exp != null ? (exp - Date.now()) / 86400000 : null;
                checked.add(`token:${c.id}`);
                if (daysLeft != null && daysLeft <= 5) {
                    const expired = daysLeft <= 0;
                    current.set(`token:${c.id}`, { key: `token:${c.id}`, type: 'token', group: 'token', title: 'Token do Meta', task: 'Renovar token do Meta (Central Meta Ads)',
                        body: expired ? 'Acesso expirado. Gere um token novo e cole na Central Meta Ads.' : `Acesso vence em ${daysLabel(daysLeft)}. Gere um token novo na Central Meta Ads.`,
                        detail: expired ? `O acesso do token do Meta de ${c.metaUserName || 'sua conta'} expirou. A Central Meta Ads parou de atualizar — gere um token novo no Graph API Explorer (app Saas) e cole em Central Meta Ads → Token.`
                            : `O acesso do token do Meta de ${c.metaUserName || 'sua conta'} vence em ${daysLabel(daysLeft)}. Gere um token novo no Graph API Explorer (app Saas) e cole em Central Meta Ads → Token.`, bm: '' });
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
                    yesterday.spend += spendOf(a, 'ontem'); yesterday.leads += leadsOf(a, 'ontem'); yesterday.accounts++;
                    const al = alertOf(a);
                    if (al) current.set(`${al.group}:${a.id}`, { ...al, key: `${al.group}:${a.id}`, account: a.id, bm: a.business?.name || '' });
                }
            }

            const { rows: stateRows } = await pool.query(`SELECT key, data, task_id, notified_at FROM "meta_alert_state"`);
            const state = new Map(stateRows.map(r => [r.key, r]));

            let newStopped = false;
            for (const [key, al] of current) {
                const prev = state.get(key);
                /* saldo baixo → sem saldo (ou o contrário) é o mesmo problema mudando: avisa de novo, mantém a tarefa */
                const changed = prev && prev.data?.type !== al.type;
                /* paradas são relembradas pelo resumo de 3 em 3h abaixo; sem gasto não é relembrado */
                const stale = prev && !al.stopped && al.type !== 'idle' && Date.now() - new Date(prev.notified_at).getTime() > RENOTIFY_MS;
                if (prev && !changed && !stale) continue;
                if (al.stopped) newStopped = true;
                /* paradas não têm push próprio: entram na notificação única logo abaixo */
                if (!al.stopped) await sendPush(pool, { title: al.title, body: al.body, tag: `meta_${key}`, view: 'metahub' });
                if (!prev) {
                    const taskId = await createTask(al, al.bm).catch(e => { console.error('[Neos] Monitor Meta: tarefa não criada —', e.message); return null; });
                    await pool.query(`INSERT INTO "meta_alert_state" (key, data, task_id, notified_at) VALUES ($1, $2::jsonb, $3, now()) ON CONFLICT (key) DO NOTHING`, [key, JSON.stringify(al), taskId]);
                    console.log(`[Neos] Monitor Meta: novo alerta ${key} — ${al.body}`);
                } else {
                    await pool.query(`UPDATE "meta_alert_state" SET notified_at = now(), data = $2::jsonb WHERE key = $1`, [key, JSON.stringify(al)]);
                    /* etapa mudou (ex.: 3 dias → 1 dia → sem saldo): a mesma tarefa sobe de prioridade */
                    if (changed) await updateTask(prev.task_id, al).catch(() => {});
                }
            }

            /* Resumo diário: uma notificação por dia, com tag fixa */
            const { rows: dailyRows } = await pool.query(`SELECT value FROM "push_config" WHERE key = 'meta_daily_last'`);
            const h = hourBR();
            if (h >= DAILY_FROM_HOUR && h < DAILY_UNTIL_HOUR && dailyRows[0]?.value?.date !== todayBR() && yesterday.accounts > 0) {
                const all = [...current.values()];
                const nStopped = all.filter(al => al.stopped).length, nLow = all.filter(al => al.type === 'low1' || al.type === 'low3').length;
                const status = [nStopped && `${nStopped} parada${nStopped > 1 ? 's' : ''}`, nLow && `${nLow} com saldo baixo`].filter(Boolean).join(' · ') || 'Todas as contas em dia';
                const body = `${status} · Ontem: ${fmt(yesterday.spend)} e ${yesterday.leads} lead${yesterday.leads !== 1 ? 's' : ''}`;
                await sendPush(pool, { title: 'Resumo de hoje', body, tag: 'meta_resumo', view: 'metahub' });
                await pool.query(`INSERT INTO "push_config" (key, value) VALUES ('meta_daily_last', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ date: todayBR() })]);
                console.log(`[Neos] Monitor Meta: resumo diário — ${body}`);
            }

            /* Lembrete das contas paradas: uma notificação só, com tag fixa (substitui a anterior no aparelho) */
            const stopped = [...current.values()].filter(al => al.stopped);
            const { rows: lastRows } = await pool.query(`SELECT value FROM "push_config" WHERE key = 'meta_stopped_last'`);
            const last = lastRows[0]?.value?.at ? new Date(lastRows[0].value.at).getTime() : 0;
            const markSent = () => pool.query(`INSERT INTO "push_config" (key, value) VALUES ('meta_stopped_last', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify({ at: new Date().toISOString() })]);
            /* sai quando uma conta nova para, ou de 3 em 3h enquanto houver alguma parada */
            if (stopped.length && (newStopped || Date.now() - last >= STOPPED_REMIND_MS)) {
                const one = stopped.length === 1;
                const names = stopped.map(al => al.body.split(' · ')[0]).join(', ');
                await sendPush(pool, { title: one ? stopped[0].title : `Contas paradas (${stopped.length})`, body: one ? stopped[0].body : names, tag: 'meta_paradas', view: 'metahub' });
                await markSent();
                console.log(`[Neos] Monitor Meta: contas paradas (${newStopped ? 'nova' : 'lembrete'}) — ${names}`);
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
