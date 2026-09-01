const REDMINE_URL = (process.env.REDMINE_URL ?? "").replace(/\/$/, "");
const REDMINE_DEFAULT_PROJECT_ID = process.env.REDMINE_DEFAULT_PROJECT_ID ?? "";

if (!REDMINE_URL) {
  throw new Error("REDMINE_URL precisa estar definido no .env do servidor MCP");
}

interface RedmineStatus {
  id: number;
  name: string;
}

interface RedmineTracker {
  id: number;
  name: string;
}

interface RedmineIssue {
  id: number;
  project: { id: number; name: string };
  tracker: { id: number; name: string };
  status: { id: number; name: string };
  priority: { id: number; name: string };
  author: { id: number; name: string };
  assigned_to?: { id: number; name: string };
  subject: string;
  description: string;
  created_on: string;
  updated_on: string;
  journals?: unknown[];
}

let statusCache: RedmineStatus[] | null = null;
let trackerCache: RedmineTracker[] | null = null;

async function redmineFetch(path: string, apiKey: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`${REDMINE_URL}${path}`, {
    ...init,
    headers: {
      "X-Redmine-API-Key": apiKey,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Redmine ${init?.method ?? "GET"} ${path} -> ${res.status} ${res.statusText}: ${body}`);
  }
  return res;
}

export async function getIssueStatuses(apiKey: string): Promise<RedmineStatus[]> {
  if (statusCache) return statusCache;
  const res = await redmineFetch("/issue_statuses.json", apiKey);
  const data = (await res.json()) as { issue_statuses: RedmineStatus[] };
  statusCache = data.issue_statuses;
  return statusCache;
}

export async function getIssueTrackers(apiKey: string): Promise<RedmineTracker[]> {
  if (trackerCache) return trackerCache;
  const res = await redmineFetch("/trackers.json", apiKey);
  const data = (await res.json()) as { trackers: RedmineTracker[] };
  trackerCache = data.trackers;
  return trackerCache;
}

async function resolveTrackerId(trackerName: string, apiKey: string): Promise<number> {
  const trackers = await getIssueTrackers(apiKey);
  const match = trackers.find(
    (t) => t.name.toLowerCase() === trackerName.toLowerCase(),
  );
  if (!match) {
    const names = trackers.map((t) => t.name).join(", ");
    throw new Error(`Tracker "${trackerName}" não encontrado no Redmine. Trackers disponíveis: ${names}`);
  }
  return match.id;
}

async function resolveStatusId(statusName: string, apiKey: string): Promise<number> {
  const statuses = await getIssueStatuses(apiKey);
  const match = statuses.find(
    (s) => s.name.toLowerCase() === statusName.toLowerCase(),
  );
  if (!match) {
    const names = statuses.map((s) => s.name).join(", ");
    throw new Error(`Status "${statusName}" não encontrado no Redmine. Status disponíveis: ${names}`);
  }
  return match.id;
}

export async function listIssues(params: {
  projectId?: string;
  statusName?: string;
  trackerName?: string;
  limit?: number;
  apiKey: string;
}): Promise<RedmineIssue[]> {
  const projectId = params.projectId ?? REDMINE_DEFAULT_PROJECT_ID;
  if (!projectId) {
    throw new Error("projectId não informado e REDMINE_DEFAULT_PROJECT_ID não configurado");
  }
  const limit = params.limit ?? 100;
  const qs = new URLSearchParams({
    limit: String(limit),
  });
  if (params.statusName) {
    const statusId = await resolveStatusId(params.statusName, params.apiKey);
    qs.set("status_id", String(statusId));
  }
  if (params.trackerName) {
    const trackerId = await resolveTrackerId(params.trackerName, params.apiKey);
    qs.set("tracker_id", String(trackerId));
  }
  const res = await redmineFetch(`/projects/${projectId}/issues.json?${qs}`, params.apiKey);
  const data = (await res.json()) as { issues: RedmineIssue[] };
  return data.issues;
}

export async function getIssues(issueIds: number[], apiKey: string): Promise<RedmineIssue[]> {
  if (issueIds.length === 0) {
    throw new Error("issueIds vazio");
  }
  const qs = new URLSearchParams({
    issue_id: issueIds.join(","),
    include: "journals",
    limit: String(issueIds.length),
  });
  const res = await redmineFetch(`/issues.json?${qs}`, apiKey);
  const data = (await res.json()) as { issues: RedmineIssue[] };
  return data.issues;
}

export async function updateIssueStatus(issueId: number, statusName: string, apiKey: string): Promise<void> {
  const statusId = await resolveStatusId(statusName, apiKey);
  await redmineFetch(`/issues/${issueId}.json`, apiKey, {
    method: "PUT",
    body: JSON.stringify({ issue: { status_id: statusId } }),
  });
}
