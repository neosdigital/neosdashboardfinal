/* Aviso dos vendedores no WhatsApp: usa o disparo que já existe no backend do
   neosformulario (POST /api/notify-whatsapp). Token, template (novo_lead_neos)
   e números dos vendedores (CLOSER_PHONES) continuam configurados só lá. */
const NOTIFY_URL = `${process.env.NEOSFORMULARIO_API_URL || 'https://neosformulario-production.up.railway.app'}/api/notify-whatsapp`;

/* A Meta rejeita parâmetro de template vazio — manda "-" no lugar */
const orDash = v => String(v || '').trim() || '-';

async function notifyNewLead({ name, whatsapp, businessType, situacao, origin }) {
    const res = await fetch(NOTIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            name: orDash(name),
            whatsapp: orDash(whatsapp),
            businessType: orDash(businessType),
            situacao: orDash(situacao),
            origin: orDash(origin)
        })
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`notify_whatsapp_failed:${res.status}:${JSON.stringify(body)}`);
    return { sent: body.sent ?? 0, failed: body.failed ?? 0 };
}

module.exports = { notifyNewLead };
