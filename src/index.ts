import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env"), quiet: true });

const {
  getIssueStatuses,
  getIssueTrackers,
  getIssuePriorities,
  listIssues,
  getIssues,
  updateIssueStatus,
  createIssue,
  updateIssue,
  toSummaryIssue,
  addNote,
  getIssueJournals,
  updateCustomFields,
  listRelations,
  listChildren,
  searchIssues,
  attachFile,
} = await import("./redmine.js");
const { searchApiEndpoints, getApiEndpoint } = await import("./swagger.js");

const STATUS_NAMES = [
  "Nova",
  "Priorizada",
  "Paralizada",
  "Em andamento",
  "Teste de Qualidade",
  "Em Ajuste",
  "Concluído",
  "Fechada",
  "Cancelada",
] as const;

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Erro: ${message}` }],
    isError: true,
  };
}

function buildServer(apiKey: string): McpServer {
  const server = new McpServer({
    name: "nexusgov-redmine",
    version: "1.0.0",
  });

  server.registerTool(
    "redmine_list_issues",
    {
      title: "Listar tarefas do Redmine por status e/ou tracker",
      description:
        "Busca as tarefas de um projeto Redmine filtradas por status (Nova, Priorizada, Paralizada, Em andamento, Teste de Qualidade, Em Ajuste, Concluído, Fechada, Cancelada) e/ou tracker (tipo da tarefa, ex: Bug, Feature, Task). Use redmine_list_trackers pra ver os nomes exatos disponíveis.",
      inputSchema: {
        status: z.enum(STATUS_NAMES).optional().describe("Nome exato do status no Redmine"),
        tracker: z.string().optional().describe("Nome exato do tracker/tipo no Redmine, ex: Bug"),
        projectId: z
          .string()
          .optional()
          .describe("ID do projeto Redmine. Se omitido, usa REDMINE_DEFAULT_PROJECT_ID do .env"),
        limit: z.number().int().positive().max(200).optional().describe("Máximo de tarefas (default 100)"),
      },
    },
    async ({ status, tracker, projectId, limit }) => {
      try {
        const issues = await listIssues({ statusName: status, trackerName: tracker, projectId, limit, apiKey });
        return textResult(issues);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "redmine_get_issues",
    {
      title: "Buscar tarefa(s) do Redmine por id",
      description:
        "Busca detalhes de uma ou várias tarefas do Redmine pelos ids, numa única chamada. Por padrão traz descrição completa e histórico; use resumido: true pra uma versão mais enxuta (descrição truncada, sem histórico). IMPORTANTE: se a intenção for cruzar a tarefa com a API (swagger) pra checar inconsistências, NÃO use resumido — a descrição pode ser truncada e esconder detalhes relevantes pra comparação. Use resumido só quando não for cruzar com a API.",
      inputSchema: {
        issueIds: z.array(z.number().int().positive()).min(1).describe("Lista de ids das tarefas"),
        resumido: z
          .boolean()
          .optional()
          .describe(
            "Se true, retorna versão resumida (descrição truncada, sem histórico). Não usar se for cruzar a tarefa com a API.",
          ),
      },
    },
    async ({ issueIds, resumido }) => {
      try {
        const issues = await getIssues(issueIds, apiKey);
        const output = resumido ? issues.map(toSummaryIssue) : issues;
        return textResult(output);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "redmine_update_issue_status",
    {
      title: "Alterar status de uma tarefa do Redmine",
      description: "Atualiza o status de uma tarefa do Redmine pelo id.",
      inputSchema: {
        issueId: z.number().int().positive().describe("Id da tarefa"),
        status: z.enum(STATUS_NAMES).describe("Novo status"),
        notes: z.string().optional().describe("Comentário opcional explicando o motivo da mudança de status"),
      },
    },
    async ({ issueId, status, notes }) => {
      try {
        await updateIssueStatus(issueId, status, apiKey, notes);
        return textResult({ issueId, status, updated: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "redmine_list_statuses",
    {
      title: "Listar status disponíveis no Redmine",
      description: "Lista os status de tarefa configurados no Redmine (nome + id).",
      inputSchema: {},
    },
    async () => {
      try {
        const statuses = await getIssueStatuses(apiKey);
        return textResult(statuses);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "redmine_list_trackers",
    {
      title: "Listar trackers (tipos de tarefa) disponíveis no Redmine",
      description: "Lista os trackers/tipos de tarefa configurados no Redmine (nome + id), ex: Bug, Feature, Task.",
      inputSchema: {},
    },
    async () => {
      try {
        const trackers = await getIssueTrackers(apiKey);
        return textResult(trackers);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "redmine_list_priorities",
    {
      title: "Listar prioridades disponíveis no Redmine",
      description: "Lista as prioridades de tarefa configuradas no Redmine (nome + id).",
      inputSchema: {},
    },
    async () => {
      try {
        const priorities = await getIssuePriorities(apiKey);
        return textResult(priorities);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "redmine_create_issue",
    {
      title: "Criar uma nova tarefa no Redmine",
      description:
        "Cria uma nova tarefa no Redmine. IMPORTANTE: antes de chamar essa tool, monte e mostre pro usuário o texto final da tarefa (assunto, descrição, tracker, prioridade, responsável, projeto) e só chame a tool depois que o usuário confirmar explicitamente. O parâmetro confirmado precisa ser true — nunca assuma confirmação, sempre peça.",
      inputSchema: {
        confirmado: z
          .literal(true)
          .describe("Só true depois que o usuário viu o texto final e confirmou explicitamente a criação"),
        subject: z.string().min(1).describe("Título/assunto da tarefa"),
        description: z.string().optional().describe("Descrição da tarefa"),
        tracker: z.string().optional().describe("Nome exato do tracker/tipo, ex: Bug, Feature, Task"),
        priority: z.string().optional().describe("Nome exato da prioridade, ex: Normal, Alta, Urgente"),
        assignedToId: z.number().int().positive().optional().describe("Id do usuário responsável pela tarefa"),
        projectId: z
          .string()
          .optional()
          .describe("ID do projeto Redmine. Se omitido, usa REDMINE_DEFAULT_PROJECT_ID do .env"),
        parentIssueId: z.number().int().positive().optional().describe("Id da tarefa-mãe, pra criar como subtarefa"),
      },
    },
    async ({ subject, description, tracker, priority, assignedToId, projectId, parentIssueId }) => {
      try {
        const issue = await createIssue({
          projectId,
          subject,
          description,
          trackerName: tracker,
          priorityName: priority,
          assignedToId,
          parentIssueId,
          apiKey,
        });
        return textResult(issue);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "redmine_update_issue",
    {
      title: "Editar uma tarefa existente no Redmine",
      description:
        "Edita campos de uma tarefa existente no Redmine (assunto, descrição, tracker, prioridade, status, responsável). IMPORTANTE: antes de chamar essa tool, monte e mostre pro usuário o texto final com as mudanças propostas e só chame a tool depois que o usuário confirmar explicitamente. O parâmetro confirmado precisa ser true — nunca assuma confirmação, sempre peça. Para trocar só o status, prefira redmine_update_issue_status.",
      inputSchema: {
        confirmado: z
          .literal(true)
          .describe("Só true depois que o usuário viu o texto final e confirmou explicitamente a edição"),
        issueId: z.number().int().positive().describe("Id da tarefa"),
        subject: z.string().optional().describe("Novo título/assunto"),
        description: z.string().optional().describe("Nova descrição"),
        tracker: z.string().optional().describe("Novo tracker/tipo, ex: Bug, Feature, Task"),
        priority: z.string().optional().describe("Nova prioridade, ex: Normal, Alta, Urgente"),
        status: z.enum(STATUS_NAMES).optional().describe("Novo status"),
        assignedToId: z.number().int().positive().optional().describe("Id do novo responsável"),
        notes: z.string().min(1).describe("Comentário obrigatório explicando o motivo da alteração"),
      },
    },
    async ({ issueId, subject, description, tracker, priority, status, assignedToId, notes }) => {
      try {
        await updateIssue({
          issueId,
          subject,
          description,
          trackerName: tracker,
          priorityName: priority,
          statusName: status,
          assignedToId,
          notes,
          apiKey,
        });
        return textResult({ issueId, updated: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "redmine_add_note",
    {
      title: "Comentar uma tarefa do Redmine sem alterar campos",
      description:
        "Adiciona um comentário (nota) numa tarefa do Redmine, sem tocar em assunto/descrição/status. IMPORTANTE: antes de chamar essa tool, mostre pro usuário o texto final do comentário e só chame a tool depois que o usuário confirmar explicitamente. O parâmetro confirmado precisa ser true — nunca assuma confirmação, sempre peça.",
      inputSchema: {
        confirmado: z
          .literal(true)
          .describe("Só true depois que o usuário viu o texto final e confirmou explicitamente o comentário"),
        issueId: z.number().int().positive().describe("Id da tarefa"),
        notes: z.string().min(1).describe("Texto do comentário"),
        privateNotes: z.boolean().optional().describe("Se true, comentário fica visível só pra usuários internos (default false)"),
      },
    },
    async ({ issueId, notes, privateNotes }) => {
      try {
        await addNote(issueId, notes, privateNotes, apiKey);
        return textResult({ issueId, noteAdded: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "redmine_get_issue_journals",
    {
      title: "Histórico completo de uma tarefa do Redmine",
      description:
        "Busca o histórico completo (journals) de uma tarefa: todos os comentários e todas as mudanças de campo (com valor antigo e novo), inclusive journals sem comentário. Use quando precisar comparar versões da descrição ou ver quem mudou o quê.",
      inputSchema: {
        issueId: z.number().int().positive().describe("Id da tarefa"),
      },
    },
    async ({ issueId }) => {
      try {
        const journals = await getIssueJournals(issueId, apiKey);
        return textResult(journals);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "redmine_update_custom_fields",
    {
      title: "Preencher campos personalizados de uma tarefa do Redmine",
      description:
        "Atualiza campos personalizados de uma tarefa (ex: 'Cenários de Teste' id 7, 'Frontend Concluído' id 20). IMPORTANTE: antes de chamar essa tool, mostre pro usuário os campos e valores finais e só chame a tool depois que o usuário confirmar explicitamente. O parâmetro confirmado precisa ser true — nunca assuma confirmação, sempre peça.",
      inputSchema: {
        confirmado: z
          .literal(true)
          .describe("Só true depois que o usuário viu os campos finais e confirmou explicitamente a edição"),
        issueId: z.number().int().positive().describe("Id da tarefa"),
        fields: z
          .array(z.object({ id: z.number().int().positive(), value: z.string() }))
          .min(1)
          .describe("Lista de campos personalizados a atualizar, com id e novo valor"),
        notes: z.string().optional().describe("Comentário opcional explicando a alteração"),
      },
    },
    async ({ issueId, fields, notes }) => {
      try {
        await updateCustomFields(issueId, fields, notes, apiKey);
        return textResult({ issueId, updated: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "redmine_list_relations",
    {
      title: "Listar relações formais de uma tarefa do Redmine",
      description: "Lista as relações (bloqueia, depende de, duplica, etc) de uma tarefa com outras tarefas.",
      inputSchema: {
        issueId: z.number().int().positive().describe("Id da tarefa"),
      },
    },
    async ({ issueId }) => {
      try {
        const relations = await listRelations(issueId, apiKey);
        return textResult(relations);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "redmine_list_children",
    {
      title: "Listar tarefas-filhas de uma tarefa-mãe no Redmine",
      description: "Lista todas as subtarefas (qualquer status) de uma tarefa-mãe pelo id.",
      inputSchema: {
        parentId: z.number().int().positive().describe("Id da tarefa-mãe"),
      },
    },
    async ({ parentId }) => {
      try {
        const children = await listChildren(parentId, apiKey);
        return textResult(children);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "redmine_search_issues",
    {
      title: "Buscar tarefas do Redmine por palavra-chave",
      description: "Busca tarefas do Redmine cujo texto (assunto/descrição) bate com a palavra-chave informada.",
      inputSchema: {
        query: z.string().min(1).describe("Texto a buscar"),
      },
    },
    async ({ query }) => {
      try {
        const results = await searchIssues(query, apiKey);
        return textResult(results);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "redmine_attach_file",
    {
      title: "Anexar arquivo a uma tarefa do Redmine",
      description:
        "Anexa um arquivo (conteúdo em base64) a uma tarefa do Redmine. IMPORTANTE: antes de chamar essa tool, confirme com o usuário o arquivo e a tarefa de destino. O parâmetro confirmado precisa ser true — nunca assuma confirmação, sempre peça.",
      inputSchema: {
        confirmado: z
          .literal(true)
          .describe("Só true depois que o usuário confirmou explicitamente o anexo"),
        issueId: z.number().int().positive().describe("Id da tarefa"),
        filename: z.string().min(1).describe("Nome do arquivo, com extensão"),
        contentBase64: z.string().min(1).describe("Conteúdo do arquivo codificado em base64"),
        description: z.string().optional().describe("Descrição opcional do anexo"),
        notes: z.string().optional().describe("Comentário opcional explicando o anexo"),
      },
    },
    async ({ issueId, filename, contentBase64, description, notes }) => {
      try {
        const fileContent = Buffer.from(contentBase64, "base64");
        await attachFile({ issueId, fileContent, filename, description, notes, apiKey });
        return textResult({ issueId, filename, attached: true });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "api_search_endpoints",
    {
      title: "Buscar endpoints na API do NexusGOV (swagger)",
      description:
        "Busca (por texto livre) endpoints no OpenAPI spec atual do backend NexusGOV, batendo contra path, summary, operationId e tags. Retorna uma lista compacta — use api_get_endpoint para pegar o contrato completo de um endpoint específico.",
      inputSchema: {
        query: z.string().min(1).describe("Termo de busca, ex: 'processo-sancionador', 'contrato', 'ocorrencia'"),
      },
    },
    async ({ query }) => {
      try {
        const results = await searchApiEndpoints(query);
        return textResult(results);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "api_get_endpoint",
    {
      title: "Detalhe de um endpoint da API do NexusGOV (swagger)",
      description:
        "Retorna o contrato completo (parameters, requestBody, responses, schemas resolvidos) de um endpoint específico da API do backend NexusGOV. Use api_search_endpoints antes para achar o path/method certo.",
      inputSchema: {
        path: z.string().min(1).describe("Path exato do endpoint, ex: /api/v1/contratos/{id}"),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).describe("Método HTTP"),
      },
    },
    async ({ path, method }) => {
      try {
        const endpoint = await getApiEndpoint(path, method);
        return textResult(endpoint);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

async function mainStdio() {
  const apiKey = process.env.REDMINE_API_KEY ?? "";
  if (!apiKey) throw new Error("REDMINE_API_KEY precisa estar definido no .env");
  const server = buildServer(apiKey);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function mainHttp() {
  const port = parseInt(process.env.PORT ?? "3000");
  const sessions = new Map<string, SSEServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", sessions: sessions.size }));
      return;
    }

    if (req.method === "GET" && req.url === "/sse") {
      const apiKey = req.headers["x-redmine-api-key"] as string | undefined;
      if (!apiKey) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Header X-Redmine-Api-Key obrigatório" }));
        return;
      }
      const server = buildServer(apiKey);
      const transport = new SSEServerTransport("/message", res);
      sessions.set(transport.sessionId, transport);
      transport.onclose = () => sessions.delete(transport.sessionId);
      await server.connect(transport);
      return;
    }

    if (req.method === "POST" && req.url?.startsWith("/message")) {
      const sessionId = new URL(req.url, "http://localhost").searchParams.get("sessionId") ?? "";
      const transport = sessions.get(sessionId);
      if (!transport) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Sessão não encontrada" }));
        return;
      }
      await transport.handlePostMessage(req, res);
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  httpServer.listen(port, () => {
    console.error(`MCP SSE server ouvindo na porta ${port}`);
  });
}

const main = process.env.MCP_TRANSPORT === "http" ? mainHttp : mainStdio;
main().catch((err) => {
  console.error("Falha ao iniciar servidor MCP nexusgov-redmine:", err);
  process.exit(1);
});
