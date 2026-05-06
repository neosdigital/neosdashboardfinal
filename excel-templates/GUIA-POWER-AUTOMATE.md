# Guia: Neos Dashboard → Excel via Power Automate

## O que foi feito no Dashboard

Um botão **"Sync Excel"** foi adicionado na barra lateral do seu SaaS.
Ao clicar, você cola a URL do Power Automate e sincroniza todos os dados.

Os dados enviados são:
- **Clientes** (Nome, Empresa, Email, Telefone, Mensalidade, Serviço, Status...)
- **Tarefas** (Título, Cliente, Status, Prioridade, Responsável, Prazo...)
- **Financeiro** (Cliente, Valor, Status, Tipo, Data...)
- **Tráfego** (Cliente, Investimento, CPL, CPA, ROAS, Leads, Vendas...)
- **Design** (Título, Cliente, Responsável, Status, Revisões, Feedback...)

---

## PARTE 1 — Preparar o Excel

### Passo 1: Criar o arquivo Excel no OneDrive ou SharePoint

1. Abra o **OneDrive** (onedrive.live.com) ou **SharePoint** da sua empresa
2. Crie uma pasta chamada `Neos Dashboard`
3. Dentro dessa pasta, crie um novo arquivo Excel chamado `banco-de-dados-neos.xlsx`

### Passo 2: Criar as 5 abas e tabelas

No Excel, crie **5 abas** com os seguintes nomes e colunas:

---

#### ABA 1 — Clientes
Nome da tabela: `TabelaClientes`

| ID | Nome | Empresa | Email | Telefone | Mensalidade | DataInicio | Servico | Status | Observacoes | DataCriacao |

---

#### ABA 2 — Tarefas
Nome da tabela: `TabelaTarefas`

| ID | Titulo | Cliente | Status | Prioridade | Responsavel | Prazo | Descricao | DataCriacao |

---

#### ABA 3 — Financeiro
Nome da tabela: `TabelaFinanceiro`

| ID | Cliente | Valor | Status | Tipo | Data | Observacoes | DataCriacao |

---

#### ABA 4 — Trafego
Nome da tabela: `TabelaTrafego`

| ID | Cliente | Investimento | CPL | CPA | ROAS | Leads | Vendas | TaxaConversao | ReceitaEstimada |

---

#### ABA 5 — Design
Nome da tabela: `TabelaDesign`

| ID | Titulo | Cliente | Responsavel | Status | Prazo | Descricao | Feedback | Revisoes | DataCriacao |

---

### Passo 3: Formatar como Tabela

Para CADA aba:
1. Selecione a linha de cabeçalho + pelo menos 1 linha abaixo (ex: A1:K2)
2. Vá em **Inserir → Tabela** (ou Ctrl+T)
3. Marque "Minha tabela tem cabeçalhos"
4. Clique em OK
5. Na aba **Design da Tabela** (que aparece ao clicar na tabela), altere o **Nome da Tabela** no canto superior esquerdo para o nome correto (ex: `TabelaClientes`)

---

## PARTE 2 — Criar o Fluxo no Power Automate

### Passo 4: Acessar o Power Automate

1. Acesse: https://make.powerautomate.com
2. Faça login com sua conta Microsoft

### Passo 5: Criar novo fluxo

1. Clique em **"Criar"** no menu lateral
2. Selecione **"Fluxo de nuvem instantâneo"** (Instant cloud flow)
3. Dê o nome: `Neos Dashboard → Excel`
4. Em "Como disparar este fluxo?", selecione **"Quando uma solicitação HTTP é recebida"**
5. Clique em **Criar**

### Passo 6: Configurar o Trigger HTTP

1. Clique no trigger **"Quando uma solicitação HTTP é recebida"**
2. Em **"Esquema JSON do corpo da solicitação"**, cole o seguinte:

```json
{
  "type": "object",
  "properties": {
    "clientes": { "type": "array" },
    "tarefas": { "type": "array" },
    "financeiro": { "type": "array" },
    "trafego": { "type": "array" },
    "design": { "type": "array" }
  }
}
```

3. Clique em **Salvar** (no canto superior direito)
4. Depois de salvar, a **URL do HTTP POST** vai aparecer no trigger — **copie essa URL** (você vai precisar dela no passo final)

### Passo 7: Adicionar ação para Clientes

1. Clique em **"+ Nova etapa"**
2. Busque por **"Aplicar a cada um"** (Apply to each)
3. Em **"Selecionar uma saída das etapas anteriores"**, clique no campo e selecione **"clientes"** (vindo do body do trigger)
4. Dentro do "Aplicar a cada um", clique em **"Adicionar uma ação"**
5. Busque **"Excel Online (Business)"**
6. Selecione **"Adicionar uma linha a uma tabela"** (Add a row into a table)
7. Preencha:
   - **Localização**: OneDrive for Business (ou SharePoint)
   - **Biblioteca de documentos**: OneDrive (ou o nome do seu SharePoint)
   - **Arquivo**: Selecione o arquivo `banco-de-dados-neos.xlsx`
   - **Tabela**: `TabelaClientes`
8. Nos campos da tabela, mapeie cada coluna usando o conteúdo dinâmico **"Item atual"**:
   - ID → `items('Apply_to_each')?['ID']`
   - Nome → `items('Apply_to_each')?['Nome']`
   - Empresa → `items('Apply_to_each')?['Empresa']`
   - *(repita para todos os campos)*

### Passo 8: Repetir para as demais tabelas

Adicione mais 4 blocos **"Aplicar a cada um"**, um para cada:
- `tarefas` → `TabelaTarefas`
- `financeiro` → `TabelaFinanceiro`
- `trafego` → `TabelaTrafego`
- `design` → `TabelaDesign`

Cada um segue o mesmo padrão do Passo 7.

### Passo 9: Salvar o fluxo

Clique em **Salvar** e aguarde a confirmação.

---

## PARTE 3 — Conectar o Dashboard ao Power Automate

### Passo 10: Copiar a URL do trigger

1. No Power Automate, volte ao fluxo criado
2. Clique no trigger **"Quando uma solicitação HTTP é recebida"**
3. Copie toda a URL que aparece em **"URL do HTTP POST"**

### Passo 11: Colar a URL no Dashboard

1. Abra o seu **Neos CEO's Dashboard** no navegador
2. Na barra lateral, clique em **"Sync Excel"** (botão azul)
3. Cole a URL copiada no campo
4. Clique em **"Sincronizar Agora"**
5. Aguarde a notificação de confirmação

---

## PARTE 4 — Evitar Duplicatas (Avançado)

Por padrão, cada sincronização **adiciona** novas linhas ao Excel.
Para evitar duplicatas, adicione uma etapa antes de cada "Adicionar linha":

1. Antes do "Aplicar a cada um", adicione **"Listar linhas presentes em uma tabela"**
2. Em seguida, adicione **"Aplicar a cada um"** para deletar cada linha listada
3. Depois faça o "Aplicar a cada um" com os dados novos

Ou, mais simples: **limpe manualmente as linhas do Excel antes de sincronizar**
(selecionar todas as linhas de dados → Delete, sem deletar os cabeçalhos).

---

## Resumo do Fluxo

```
[Dashboard] → Clica "Sync Excel"
     ↓
[POST JSON] → URL do Power Automate
     ↓
[Power Automate recebe os dados]
     ↓
[Para cada item em "clientes"] → Adiciona linha em TabelaClientes
[Para cada item em "tarefas"]  → Adiciona linha em TabelaTarefas
[Para cada item em "financeiro"] → Adiciona linha em TabelaFinanceiro
[Para cada item em "trafego"]  → Adiciona linha em TabelaTrafego
[Para cada item em "design"]   → Adiciona linha em TabelaDesign
     ↓
[Excel atualizado no OneDrive/SharePoint]
```
