# Configuração do Banco de Dados no Supabase

Este guia explica como criar todas as tabelas necessárias no Supabase para o Neos Dashboard funcionar completamente na nuvem.

---

## 1. Acessar o Supabase

1. Acesse [https://supabase.com](https://supabase.com) e faça login
2. Selecione o projeto: **edlusjxoalqjkieugwce**
3. No menu lateral, clique em **SQL Editor**
4. Execute os scripts abaixo um a um (ou todos de uma vez)

---

## 2. Criar as Tabelas'

Abra o **SQL Editor** e execute o seguinte script completo:

```sql
-- ─────────────────────────────────────────
-- NEOS DASHBOARD — CRIAÇÃO DAS TABELAS
-- ─────────────────────────────────────────

-- Clientes
create table if not exists clients (
  id          text primary key,
  name        text,
  company     text,
  service     text,
  plan        numeric default 0,
  "startDate" text,
  status      text default 'Ativo',
  email       text,
  phone       text,
  notes       text,
  "createdAt" text
);

-- Tarefas (Kanban)
create table if not exists tasks (
  id          text primary key,
  "clientId"  text,
  "clientName" text,
  title       text,
  description text,
  status      text default 'Backlog',
  priority    text,
  assignee    text,
  "dueDate"   text,
  "createdAt" text
);

-- Financeiro (Receitas)
create table if not exists financials (
  id          text primary key,
  "clientId"  text,
  "clientName" text,
  amount      numeric default 0,
  type        text default 'Mensal',
  status      text default 'Pendente',
  date        text,
  notes       text,
  "createdAt" text
);

-- Tráfego Pago (Campanhas)
create table if not exists "trafficData" (
  id             text primary key,
  "clientId"     text,
  "clientName"   text,
  "campaignName" text,
  month          integer,
  year           integer,
  budget         numeric default 0,
  cpl            numeric default 0,
  cpa            numeric default 0,
  roas           numeric default 0,
  leads          integer default 0,
  sales          integer default 0,
  "createdAt"    text
);

-- Solicitações de Design
create table if not exists "designReqs" (
  id          text primary key,
  "clientId"  text,
  "clientName" text,
  title       text,
  description text,
  status      text default 'Aberto',
  assignee    text,
  revisions   integer default 0,
  "dueDate"   text,
  "createdAt" text
);

-- Performance (Redes Sociais)
create table if not exists performance (
  id                text primary key,
  "clientId"        text,
  "clientName"      text,
  platform          text,
  month             integer,
  year              integer,
  followers         integer default 0,
  "followersGained" integer default 0,
  reach             integer default 0,
  impressions       integer default 0,
  likes             integer default 0,
  comments          integer default 0,
  shares            integer default 0,
  saves             integer default 0,
  posts             integer default 0,
  stories           integer default 0,
  reels             integer default 0,
  notes             text,
  "createdAt"       text
);

-- Eventos do Calendário
create table if not exists "calEvents" (
  id             text primary key,
  title          text,
  description    text,
  date           text,
  type           text,
  source         text default 'local',
  "googleEventId" text,
  color          text,
  "clientId"     text,
  "allDay"       boolean default true,
  "startTime"    text,
  "createdAt"    text
);

-- Custos
create table if not exists costs (
  id          text primary key,
  name        text,
  type        text default 'Fixo',
  amount      numeric default 0,
  date        text,
  notes       text,
  category    text,
  "createdAt" text
);
```

---

## 3. Configurar Permissões (Row Level Security)

Após criar as tabelas, você precisa **desabilitar o RLS** (Row Level Security) ou criar políticas que permitam acesso com a chave pública. Execute:

```sql
-- Desabilitar RLS em todas as tabelas (mais simples para uso interno)
alter table clients          disable row level security;
alter table tasks             disable row level security;
alter table financials        disable row level security;
alter table "trafficData"     disable row level security;
alter table "designReqs"      disable row level security;
alter table performance       disable row level security;
alter table "calEvents"       disable row level security;
alter table costs             disable row level security;
```

> **Nota:** Como o dashboard é de uso interno da Neos, desabilitar o RLS é adequado. Se no futuro houver múltiplos usuários com dados separados, será necessário configurar políticas de acesso.

---

## 4. Migrar Dados Existentes (Opcional)

Se você tem dados salvos localmente (backup .json), siga estes passos:

1. No Neos Dashboard, clique em **Backup & Restaurar** (ícone no sidebar)
2. Clique em **Exportar Backup (.json)** para salvar os dados atuais
3. Recarregue a página — o app vai carregar do Supabase (vazio inicialmente)
4. Clique em **Restaurar de Backup (.json)** e selecione o arquivo exportado
5. Os dados serão importados e sincronizados com o Supabase automaticamente

---

## 5. Verificar a Conexão

No menu do Supabase, vá em **Table Editor** e verifique se as tabelas foram criadas. Após usar o dashboard, os dados devem aparecer nas tabelas em tempo real.

Você também pode verificar no **SQL Editor** com:
```sql
select count(*) from clients;
select count(*) from tasks;
select count(*) from financials;
select count(*) from "trafficData";
select count(*) from costs;
```

---

## 6. Informações da Conexão

| Campo | Valor |
|-------|-------|
| **URL** | `https://edlusjxoalqjkieugwce.supabase.co` |
| **Chave Pública** | `sb_publishable_OfZfNYJUrtOqVUpv8bvU4Q_HyGHHIyx` |
| **Tabelas** | clients, tasks, financials, trafficData, designReqs, performance, calEvents, costs |

---

## 7. Comportamento do App

- **Ao carregar:** busca todos os dados do Supabase
- **Se o Supabase falhar:** usa o cache local (IndexedDB) como fallback
- **Ao adicionar/editar/excluir:** sincroniza imediatamente com o Supabase
- **Campanhas de Tráfego Pago do cliente "Neos":** são automaticamente adicionadas em **Custos** e **Financeiro**
