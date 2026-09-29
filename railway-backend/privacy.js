/* Política de privacidade pública — exigida pela Meta para o app ficar em modo Ativo
   (Configurações do app → Básico → URL da Política de Privacidade / exclusão de dados). */
const PRIVACY_HTML = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Política de Privacidade — NEOS Digital</title>
<style>
  :root { --bg: #ffffff; --fg: #1a1a1a; --muted: #555; --accent: #ff0040; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0e0e0e; --fg: #f2f2f2; --muted: #aaa; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.65 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 40px 16px 64px; }
  h1 { font-size: 28px; margin: 0 0 4px; }
  h2 { font-size: 19px; margin: 32px 0 8px; }
  p, li { color: var(--fg); }
  .muted { color: var(--muted); font-size: 14px; }
  a { color: var(--accent); }
</style>
</head>
<body>
<main>
  <h1>Política de Privacidade</h1>
  <p class="muted">NEOS Digital — última atualização: 29/09/2026</p>

  <p>Esta política explica como a NEOS Digital coleta, usa e protege os dados pessoais de quem
  preenche nossos formulários de cadastro, incluindo os formulários de anúncios do Facebook e do
  Instagram (Meta Lead Ads), em conformidade com a Lei Geral de Proteção de Dados (Lei nº 13.709/2018 — LGPD).</p>

  <h2>1. Dados que coletamos</h2>
  <ul>
    <li>Nome, telefone/WhatsApp e e-mail informados por você no formulário;</li>
    <li>Respostas às perguntas do formulário (por exemplo, segmento do negócio e objetivos);</li>
    <li>Informações da campanha de origem (nome do formulário, campanha e anúncio), fornecidas pela Meta.</li>
  </ul>

  <h2>2. Como usamos os dados</h2>
  <ul>
    <li>Entrar em contato com você sobre os serviços solicitados;</li>
    <li>Registrar seu atendimento em nosso sistema interno de gestão de clientes (CRM);</li>
    <li>Avisar nossa equipe comercial, via WhatsApp, de que um novo contato chegou.</li>
  </ul>
  <p>Não vendemos nem compartilhamos seus dados com terceiros para fins de marketing.</p>

  <h2>3. Compartilhamento</h2>
  <p>Os dados são acessados apenas pela equipe da NEOS Digital e pelos provedores estritamente
  necessários à operação: Meta Platforms (origem do cadastro e envio de mensagens pelo WhatsApp
  Business) e o serviço de hospedagem onde nosso sistema e banco de dados estão armazenados.</p>

  <h2>4. Armazenamento e segurança</h2>
  <p>Os dados ficam em servidores com acesso restrito e são mantidos apenas pelo tempo necessário
  ao atendimento e às obrigações legais.</p>

  <h2>5. Seus direitos</h2>
  <p>Você pode, a qualquer momento, solicitar acesso, correção ou exclusão dos seus dados,
  além de revogar o consentimento para contato.</p>

  <h2 id="exclusao">6. Como solicitar a exclusão dos seus dados</h2>
  <p>Envie um e-mail para <a href="mailto:neosdigital1406@gmail.com">neosdigital1406@gmail.com</a>
  com o assunto <strong>"Exclusão de dados"</strong>, informando o nome e o telefone usados no
  cadastro. Excluiremos seus dados de nossos sistemas em até 15 dias e confirmaremos por e-mail.</p>

  <h2>7. Contato</h2>
  <p>NEOS Digital<br>
  E-mail: <a href="mailto:neosdigital1406@gmail.com">neosdigital1406@gmail.com</a><br>
  WhatsApp: (14) 99140-1406<br>
  Instagram: @neos.digital_</p>
</main>
</body>
</html>`;

module.exports = { PRIVACY_HTML };
