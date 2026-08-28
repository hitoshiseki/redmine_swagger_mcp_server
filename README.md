# nexusgov-redmine MCP

Servidor MCP: tarefas do Redmine + spec OpenAPI do backend NexusGOV.

Dois modos de uso:
- **Portainer (recomendado)** — container centralizado, devs conectam via URL, sem instalar nada
- **Local (stdio)** — roda na máquina de cada dev com sua própria API key

## Tools

- `redmine_list_issues` — tarefas de um projeto por status
- `redmine_get_issues` — detalhe de 1+ tarefas por id
- `redmine_update_issue_status` — muda status de uma tarefa
- `redmine_list_statuses` — lista status configurados no Redmine (nome + id)
- `api_search_endpoints` — busca endpoints no swagger por texto livre
- `api_get_endpoint` — contrato completo de um endpoint (schemas resolvidos)

---

## Modo Portainer (centralizado)

### Deploy

1. No Portainer: **Stacks → Add Stack → Repository**
2. Preencher:

   | Campo | Valor |
   |-------|-------|
   | Name | `nexusgov-redmine-mcp` |
   | Repository URL | URL deste repo |
   | Repository reference | `refs/heads/main` |
   | Compose path | `docker-compose.yml` |

3. Em **Environment variables**, adicionar:

   | Variável | Valor |
   |----------|-------|
   | `REDMINE_URL` | `https://sistemas.sofintech.com.br/redmine` |
   | `REDMINE_API_KEY` | Chave de API do Redmine (compartilhada da equipe) |
   | `REDMINE_DEFAULT_PROJECT_ID` | `15` |
   | `SWAGGER_URL` | `http://45.79.207.184:8080/v3/api-docs` |

4. **Deploy the stack**

Verificar:

```bash
curl http://IP_DO_SERVIDOR:3001/health
# {"status":"ok"}
```

### Conectar (cada dev, uma vez)

```bash
claude mcp add nexusgov-redmine --transport sse http://IP_DO_SERVIDOR:3001/sse
```

Reiniciar sessão do Claude Code. Pronto.

### Atualizar servidor

Com GitOps ativo: `git push` → Portainer faz redeploy automático.

Manual: Portainer → Stack → **Pull and redeploy**.

---

## Modo local (stdio)

### Setup (cada dev, uma vez)

```bash
git clone https://github.com/hitoshiseki/redmine_swagger_mcp_server.git nexusgov-redmine-mcp
cd nexusgov-redmine-mcp
npm install
npm run build
cp .env.example .env
```

Editar `.env` com sua própria API key:

1. Redmine → **Minha conta** → **Chave de acesso à API** → mostrar/gerar
2. Colar em `REDMINE_API_KEY` no `.env`
3. Deixar `MCP_TRANSPORT` em branco ou removido (stdio é padrão)

`.env` nunca é commitado — cada dev mantém o dele local.

### Registrar no Claude Code

```bash
claude mcp add nexusgov-redmine --scope user -- node "$(pwd)/dist/index.js"
```

Rode de dentro da pasta do projeto. `--scope user` deixa disponível em qualquer sessão.

```bash
claude mcp list
# nexusgov-redmine ... ✓ Connected
```

Se aparecer `✗ Failed to connect`: verificar `.env` preenchido e `npm run build` sem erro.

### Atualizar após `git pull`

```bash
npm install   # se package.json mudou
npm run build
```

Reiniciar sessão do Claude Code para pegar o build novo.

### Debug isolado

```bash
npm start
```

Aguarda JSON-RPC via stdin. Sem output fora do protocolo MCP no stdout.
