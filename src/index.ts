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

const CROSS_CHECK_ACCEPTED_HINT =
  "\n\nUsuário pediu pra cruzar com a API — use api_search_endpoints/api_get_endpoint pra comparar com os dados acima e apontar inconsistências.";
const CROSS_CHECK_FALLBACK_HINT =
  "\n\nDica: quer cruzar essa informação com a API (Swagger)? Use api_search_endpoints ou api_get_endpoint.";

async function askCrossCheckApi(server: McpServer): Promise<boolean | null> {
  try {
    const result = await server.server.elicitInput({
      mode: "form",
      message: "Deseja cruzar essa informação do Redmine com a API (Swagger) para checar inconsistências/divergências?",
      requestedSchema: {
        type: "object",
        properties: {
          cruzar: {
            type: "boolean",
            title: "Cruzar com a API?",
            description: "Se sim, o assistente vai buscar o endpoint correspondente na API pra comparar.",
            default: false,
          },
        },
        required: ["cruzar"],
      },
    });
    if (result.action === "accept" && result.content) {
      return Boolean(result.content.cruzar);
    }
    return null;
  } catch {
    return null;
  }
}

async function askGetIssuesOptions(server: McpServer): Promise<{ crossCheck: boolean; resumido: boolean } | null> {
  try {
    const result = await server.server.elicitInput({
      mode: "form",
      message: "Como você quer receber a(s) tarefa(s)?",
      requestedSchema: {
        type: "object",
        properties: {
          nivel: {
            type: "string",
            title: "Nível de detalhe",
            description: "Completo traz descrição integral e histórico. Resumido trunca a descrição e omite histórico.",
            enum: ["completo", "resumido"],
            default: "completo",
          },
          cruzar: {
            type: "boolean",
            title: "Cruzar com a API?",
            description: "Se sim, o assistente vai buscar o endpoint correspondente na API pra comparar.",
            default: false,
          },
        },
        required: ["nivel", "cruzar"],
      },
    });
    if (result.action === "accept" && result.content) {
      return {
        crossCheck: Boolean(result.content.cruzar),
        resumido: result.content.nivel === "resumido",
      };
    }
    return null;
  } catch {
    return null;
  }
}

function textResultRedmine(data: unknown, crossCheck: boolean | null) {
  const base = JSON.stringify(data);
  const hint = crossCheck === true ? CROSS_CHECK_ACCEPTED_HINT : CROSS_CHECK_FALLBACK_HINT;
  return {
    content: [{ type: "text" as const, text: base + hint }],
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
        const crossCheck = await askCrossCheckApi(server);
        return textResultRedmine(issues, crossCheck);
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
        "Busca detalhes completos (descrição, histórico) de uma ou várias tarefas do Redmine pelos ids, numa única chamada.",
      inputSchema: {
        issueIds: z.array(z.number().int().positive()).min(1).describe("Lista de ids das tarefas"),
      },
    },
    async ({ issueIds }) => {
      try {
        const issues = await getIssues(issueIds, apiKey);
        const options = await askGetIssuesOptions(server);
        const output = options?.resumido ? issues.map(toSummaryIssue) : issues;
        return textResultRedmine(output, options?.crossCheck ?? null);
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
      },
    },
    async ({ issueId, status }) => {
      try {
        await updateIssueStatus(issueId, status, apiKey);
        const crossCheck = await askCrossCheckApi(server);
        return textResultRedmine({ issueId, status, updated: true }, crossCheck);
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
      },
    },
    async ({ subject, description, tracker, priority, assignedToId, projectId }) => {
      try {
        const issue = await createIssue({
          projectId,
          subject,
          description,
          trackerName: tracker,
          priorityName: priority,
          assignedToId,
          apiKey,
        });
        const crossCheck = await askCrossCheckApi(server);
        return textResultRedmine(issue, crossCheck);
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
      },
    },
    async ({ issueId, subject, description, tracker, priority, status, assignedToId }) => {
      try {
        await updateIssue({
          issueId,
          subject,
          description,
          trackerName: tracker,
          priorityName: priority,
          statusName: status,
          assignedToId,
          apiKey,
        });
        const crossCheck = await askCrossCheckApi(server);
        return textResultRedmine({ issueId, updated: true }, crossCheck);
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
