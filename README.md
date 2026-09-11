# nexusgov-redmine MCP

Servidor MCP: tarefas do Redmine + spec OpenAPI do backend NexusGOV.

Dois modos de uso:
- **Portainer (recomendado)** — container centralizado, devs conectam via URL, sem instalar nada
- **Local (stdio)** — roda na máquina de cada dev com sua própria API key

## Tools

- `redmine_list_issues` — tarefas de um projeto por status e/ou tracker
- `redmine_get_issues` — detalhe de 1+ tarefas por id
- `redmine_create_issue` — cria uma nova tarefa (exige confirmação do usuário, ver abaixo)
- `redmine_update_issue` — edita campos de uma tarefa existente (exige confirmação do usuário, ver abaixo)
- `redmine_update_issue_status` — muda status de uma tarefa
- `redmine_list_statuses` — lista status configurados no Redmine (nome + id)
- `redmine_list_trackers` — lista trackers/tipos de tarefa (nome + id)
- `redmine_list_priorities` — lista prioridades (nome + id)
- `api_search_endpoints` — busca endpoints no swagger por texto livre
- `api_get_endpoint` — contrato completo de um endpoint (schemas resolvidos)

### Criar/editar tarefa exige confirmação

`redmine_create_issue` e `redmine_update_issue` têm um parâmetro obrigatório `confirmado: true`. A descrição da tool instrui o agente a montar e mostrar o texto final (assunto, descrição, tracker, prioridade, responsável) pro usuário antes de chamar a tool — só marcar `confirmado: true` depois que o usuário aprovar explicitamente. Isso é reforçado por instrução no prompt da tool, não é uma trava do servidor.

### Sugestão de cruzar com a API

Toda tool `redmine_*` pergunta, ao final, se o usuário quer cruzar aquela informação com a API (swagger) pra checar inconsistências. Em clients que suportam a capability de *elicitation* do MCP (ex: form/dialog nativo), aparece uma caixa de diálogo real com opção sim/não. Em clients sem suporte a elicitation, a tool cai num fallback simples: um texto sugerindo usar `api_search_endpoints`/`api_get_endpoint`.

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
   | `REDMINE_URL` | URL do Redmine |
   | `REDMINE_DEFAULT_PROJECT_ID` | `15` |
   | `SWAGGER_URL` | URL do swagger |

   > `REDMINE_API_KEY` **não vai no Portainer** — cada dev envia a própria key via header.

4. **Deploy the stack**

Verificar:

```bash
curl http://IP_DO_SERVIDOR:3001/health
# {"status":"ok","sessions":0}
```

### Conectar (cada dev, uma vez)

Obter API key pessoal: Redmine → **Minha conta** → **Chave de acesso à API**.

```bash
claude mcp add --transport sse --scope user nexusgov-redmine http://IP_DO_SERVIDOR:3001/sse --header "X-Redmine-Api-Key: SUA_KEY_PESSOAL"
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

Rode de dentro da pasta do projeto:

```bash
claude mcp add --scope user nexusgov-redmine -- node "$(pwd)/dist/index.js"
```

`--scope user` deixa disponível em qualquer sessão.

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
