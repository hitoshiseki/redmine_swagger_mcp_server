# nexusgov-redmine MCP

Servidor MCP local (stdio): tarefas do Redmine + spec OpenAPI atual do backend. Roda na máquina de cada dev, cada um com sua própria API key do Redmine.

## Tools

- `redmine_list_issues` — tarefas de um projeto por status
- `redmine_get_issues` — detalhe de 1+ tarefas por id
- `redmine_update_issue_status` — muda status de uma tarefa
- `redmine_list_statuses` — lista status configurados no Redmine (nome + id)
- `api_search_endpoints` — busca endpoints no swagger por texto livre
- `api_get_endpoint` — contrato completo de um endpoint (schemas resolvidos)

## Setup (cada dev, uma vez)

```bash
git clone https://github.com/hitoshiseki/redmine_swagger_mcp_server.git nexusgov-redmine-mcp
cd nexusgov-redmine-mcp
npm install
npm run build
cp .env.example .env
```

Editar `.env` com sua própria API key do Redmine:

1. Redmine → **Minha conta** (canto superior direito) → **Chave de acesso à API** → mostrar/gerar
2. Colar em `REDMINE_API_KEY` no `.env`

`.env` nunca é commitado (`.gitignore`) — cada dev mantém o dele local.

## Registrar no Claude Code

```bash
claude mcp add nexusgov-redmine --scope user -- node "$(pwd)/dist/index.js"
```

Rode esse comando de dentro da pasta do projeto (usa `$(pwd)` pra gravar o path absoluto certo na sua máquina). `--scope user` deixa disponível em qualquer sessão/projeto seu, não só neste repo.

Conferir:

```bash
claude mcp list
```

Deve aparecer `nexusgov-redmine ... ✓ Connected`. Se aparecer `✗ Failed to connect`, reveja se `.env` está preenchido e se `npm run build` rodou sem erro.

## Atualizar depois de um `git pull`

```bash
npm install   # se package.json mudou
npm run build
```

Reinicie a sessão do Claude Code (ou abra uma nova) pra pegar o build novo — o processo MCP é iniciado uma vez por sessão.

## Rodar isolado (debug)

```bash
npm start
```
Espera mensagens JSON-RPC via stdin. Sem output fora do protocolo MCP no stdout.
