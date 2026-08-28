const SWAGGER_URL = process.env.SWAGGER_URL ?? "";

if (!SWAGGER_URL) {
  throw new Error("SWAGGER_URL precisa estar definido no .env do servidor MCP");
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head"] as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type JsonObject = Record<string, any>;

interface OpenApiDoc {
  paths: JsonObject;
  components?: { schemas?: JsonObject };
}

async function fetchSpec(): Promise<OpenApiDoc> {
  const res = await fetch(SWAGGER_URL);
  if (!res.ok) {
    throw new Error(`GET ${SWAGGER_URL} -> ${res.status} ${res.statusText}`);
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

export async function searchApiEndpoints(query: string): Promise<EndpointSummary[]> {
  const spec = await fetchSpec();
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

export async function getApiEndpoint(path: string, method: string): Promise<JsonObject> {
  const spec = await fetchSpec();
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
