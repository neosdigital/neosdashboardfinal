/* Service worker do Neos Dashboard — só instalação (PWA) e Web Push.
   Não intercepta requisições (sem handler de fetch): o app continua sendo
   carregado sempre da rede, exatamente como no navegador. */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

/* iOS/Safari revoga a inscrição se um push chegar sem notificação visível */
const IS_APPLE = /iPhone|iPad|iPod|Macintosh/.test(self.navigator.userAgent) && !/Chrome|Android/.test(self.navigator.userAgent);

self.addEventListener('push', e => {
    let data = {};
    try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data && e.data.text() }; }
    e.waitUntil((async () => {
        /* Com o app aberto e em foco o popup + som do próprio dashboard já avisam */
        const isTest = data.tag === 'neos_test';
        const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (!IS_APPLE && !isTest && wins.some(w => w.focused && w.visibilityState === 'visible')) return;
        await self.registration.showNotification(data.title || 'Neos Dashboard', {
            body: data.body || '',
            icon: '/icons/icon-192.png',
            badge: '/icons/badge-96.png',
            tag: data.tag || undefined,
            renotify: !!data.tag,
            /* toca o som/vibração do sistema e, no computador, fica na tela até ser visto */
            silent: false,
            vibrate: [200, 100, 200, 100, 300],
            requireInteraction: !isTest,
            data: { view: data.view || '' }
        });
    })());
});

self.addEventListener('notificationclick', e => {
    e.notification.close();
    const view = (e.notification.data && e.notification.data.view) || '';
    e.waitUntil((async () => {
        const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        const win = wins[0];
        if (win) {
            await win.focus();
            if (view) win.postMessage({ type: 'neos-open-view', view });
            return;
        }
        await self.clients.openWindow(view ? '/?view=' + encodeURIComponent(view) : '/');
    })());
});
