export type Ambiente = "producao" | "desenvolvimento";

const SWAGGER_URLS: Record<Ambiente, string> = {
  producao: process.env.SWAGGER_URL ?? "",
  desenvolvimento: process.env.SWAGGER_URL_DEV ?? "",
};

if (!SWAGGER_URLS.producao) {
  throw new Error("SWAGGER_URL precisa estar definido no .env do servidor MCP");
}

function resolveSwaggerUrl(ambiente: Ambiente): string {
  const url = SWAGGER_URLS[ambiente];
  if (!url) {
    throw new Error(`SWAGGER_URL_DEV precisa estar definido no .env do servidor MCP para usar o ambiente "${ambiente}"`);
  }
  return url;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head"] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>;

interface OpenApiDoc {
  paths: JsonObject;
  components?: { schemas?: JsonObject };
}

async function fetchSpec(ambiente: Ambiente): Promise<OpenApiDoc> {
  const url = resolveSwaggerUrl(ambiente);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GET ${url} -> ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as OpenApiDoc;
}

export interface EndpointSummary {
  path: string;
  method: string;
  summary?: string;
  operationId?: string;
  tags?: string[];
}

export async function searchApiEndpoints(query: string, ambiente: Ambiente = "desenvolvimento"): Promise<EndpointSummary[]> {
  const spec = await fetchSpec(ambiente);
  const q = query.toLowerCase();
  const results: EndpointSummary[] = [];

  for (const [path, methods] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = (methods as JsonObject)[method];
      if (!op) continue;
      const haystack = [path, op.summary, op.operationId, ...(op.tags ?? [])]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (haystack.includes(q)) {
        results.push({
          path,
          method: method.toUpperCase(),
          summary: op.summary,
          operationId: op.operationId,
          tags: op.tags,
        });
      }
    }
  }
  return results;
}

// Resolve $ref recursivamente contra components, com detecção de ciclo
// (evita árvore infinita em schemas auto-referentes).
function resolveRefs(node: unknown, doc: OpenApiDoc, chain: Set<string>): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => resolveRefs(item, doc, chain));
  }
  if (node && typeof node === "object") {
    const obj = node as JsonObject;
    if (typeof obj.$ref === "string") {
      const refPath = obj.$ref as string;
      if (chain.has(refPath)) {
        return { $ref: refPath, note: "referência circular, não expandida novamente" };
      }
      const parts = refPath.replace(/^#\//, "").split("/");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let target: any = doc;
      for (const part of parts) {
        target = target?.[part];
      }
      if (target === undefined) {
        return { $ref: refPath, note: "não encontrado no spec" };
      }
      const nextChain = new Set(chain);
      nextChain.add(refPath);
      return resolveRefs(target, doc, nextChain);
    }
    const out: JsonObject = {};
    for (const [key, value] of Object.entries(obj)) {
      out[key] = resolveRefs(value, doc, chain);
    }
    return out;
  }
  return node;
}

export async function getApiEndpoint(path: string, method: string, ambiente: Ambiente = "desenvolvimento"): Promise<JsonObject> {
  const spec = await fetchSpec(ambiente);
  const methodLower = method.toLowerCase();
  const pathItem = spec.paths?.[path];
  if (!pathItem) {
    const available = Object.keys(spec.paths ?? {}).filter((p) => p.includes(path));
    throw new Error(
      `Path "${path}" não encontrado no spec.` +
        (available.length ? ` Caminhos parecidos: ${available.slice(0, 10).join(", ")}` : ""),
    );
  }
  const op = pathItem[methodLower];
  if (!op) {
    const available = Object.keys(pathItem).filter((k) => (HTTP_METHODS as readonly string[]).includes(k));
    throw new Error(`Método "${method}" não existe em "${path}". Métodos disponíveis: ${available.join(", ")}`);
  }
  return resolveRefs(op, spec, new Set()) as JsonObject;
}
