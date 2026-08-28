import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
config({ path: join(dirname(fileURLToPath(import.meta.url)), "..", ".env"), quiet: true });

const { getIssueStatuses, listIssues, getIssues, updateIssueStatus } = await import("./redmine.js");
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

const server = new McpServer({
  name: "nexusgov-redmine",
  version: "1.0.0",
});

function textResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Erro: ${message}` }],
    isError: true,
  };
}

server.registerTool(
  "redmine_list_issues",
  {
    title: "Listar tarefas do Redmine por status",
    description:
      "Busca as tarefas de um projeto Redmine filtradas por status (Nova, Priorizada, Paralizada, Em andamento, Teste de Qualidade, Em Ajuste, Concluído, Fechada, Cancelada).",
    inputSchema: {
      status: z.enum(STATUS_NAMES).describe("Nome exato do status no Redmine"),
      projectId: z
        .string()
        .optional()
        .describe("ID do projeto Redmine. Se omitido, usa REDMINE_DEFAULT_PROJECT_ID do .env"),
      limit: z.number().int().positive().max(200).optional().describe("Máximo de tarefas (default 100)"),
    },
  },
  async ({ status, projectId, limit }) => {
    try {
      const issues = await listIssues({ statusName: status, projectId, limit });
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
      "Busca detalhes completos (descrição, histórico) de uma ou várias tarefas do Redmine pelos ids, numa única chamada.",
    inputSchema: {
      issueIds: z.array(z.number().int().positive()).min(1).describe("Lista de ids das tarefas"),
    },
  },
  async ({ issueIds }) => {
    try {
      const issues = await getIssues(issueIds);
      return textResult(issues);
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
      await updateIssueStatus(issueId, status);
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
      const statuses = await getIssueStatuses();
      return textResult(statuses);
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

async function mainStdio() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function mainHttp() {
  const port = parseInt(process.env.PORT ?? "3000");
  let activeTransport: SSEServerTransport | null = null;

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method === "GET" && req.url === "/sse") {
      activeTransport = new SSEServerTransport("/message", res);
      await server.connect(activeTransport);
      return;
    }
    if (req.method === "POST" && req.url === "/message") {
      if (!activeTransport) {
        res.writeHead(503);
        res.end("No SSE session active");
        return;
      }
      await activeTransport.handlePostMessage(req, res);
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
