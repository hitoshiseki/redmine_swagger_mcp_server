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

interface RedminePriority {
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
  journals?: RedmineJournal[];
}

interface RedmineJournal {
  id: number;
  user: { id: number; name: string };
  notes: string;
  created_on: string;
  details?: { property: string; name: string; old_value?: string; new_value?: string }[];
}

export interface CompactIssue {
  id: number;
  subject: string;
  tracker: string;
  status: string;
  priority: string;
  assignedTo?: string;
}

export interface DetailedIssue {
  id: number;
  subject: string;
  description: string;
  tracker: string;
  status: string;
  priority: string;
  project: string;
  author: string;
  assignedTo?: string;
  createdOn: string;
  updatedOn: string;
  journals?: { user: string; notes: string; createdOn: string }[];
}

function toCompactIssue(raw: RedmineIssue): CompactIssue {
  return {
    id: raw.id,
    subject: raw.subject,
    tracker: raw.tracker.name,
    status: raw.status.name,
    priority: raw.priority.name,
    ...(raw.assigned_to ? { assignedTo: raw.assigned_to.name } : {}),
  };
}

export interface SummaryIssue {
  id: number;
  subject: string;
  description: string;
  tracker: string;
  status: string;
  priority: string;
  assignedTo?: string;
  updatedOn: string;
}

const SUMMARY_DESCRIPTION_MAX_CHARS = 300;

export function toSummaryIssue(detailed: DetailedIssue): SummaryIssue {
  const description =
    detailed.description.length > SUMMARY_DESCRIPTION_MAX_CHARS
      ? `${detailed.description.slice(0, SUMMARY_DESCRIPTION_MAX_CHARS)}... (truncado, peça texto completo se precisar)`
      : detailed.description;
  return {
    id: detailed.id,
    subject: detailed.subject,
    description,
    tracker: detailed.tracker,
    status: detailed.status,
    priority: detailed.priority,
    ...(detailed.assignedTo ? { assignedTo: detailed.assignedTo } : {}),
    updatedOn: detailed.updatedOn,
  };
}

function toDetailedIssue(raw: RedmineIssue): DetailedIssue {
  return {
    id: raw.id,
    subject: raw.subject,
    description: raw.description,
    tracker: raw.tracker.name,
    status: raw.status.name,
    priority: raw.priority.name,
    project: raw.project.name,
    author: raw.author.name,
    ...(raw.assigned_to ? { assignedTo: raw.assigned_to.name } : {}),
    createdOn: raw.created_on,
    updatedOn: raw.updated_on,
    ...(raw.journals && raw.journals.length > 0
      ? {
          journals: raw.journals
            .filter((j) => j.notes)
            .map((j) => ({ user: j.user.name, notes: j.notes, createdOn: j.created_on })),
        }
      : {}),
  };
}

let statusCache: RedmineStatus[] | null = null;
let trackerCache: RedmineTracker[] | null = null;
let priorityCache: RedminePriority[] | null = null;

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

async function redmineUpload(path: string, apiKey: string, body: Buffer): Promise<Response> {
  const res = await fetch(`${REDMINE_URL}${path}`, {
    method: "POST",
    headers: {
      "X-Redmine-API-Key": apiKey,
      "Content-Type": "application/octet-stream",
    },
    body: new Uint8Array(body),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(`Redmine POST ${path} -> ${res.status} ${res.statusText}: ${errBody}`);
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

export async function getIssuePriorities(apiKey: string): Promise<RedminePriority[]> {
  if (priorityCache) return priorityCache;
  const res = await redmineFetch("/enumerations/issue_priorities.json", apiKey);
  const data = (await res.json()) as { issue_priorities: RedminePriority[] };
  priorityCache = data.issue_priorities;
  return priorityCache;
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

async function resolvePriorityId(priorityName: string, apiKey: string): Promise<number> {
  const priorities = await getIssuePriorities(apiKey);
  const match = priorities.find(
    (p) => p.name.toLowerCase() === priorityName.toLowerCase(),
  );
  if (!match) {
    const names = priorities.map((p) => p.name).join(", ");
    throw new Error(`Prioridade "${priorityName}" não encontrada no Redmine. Prioridades disponíveis: ${names}`);
  }
  return match.id;
}

export async function listIssues(params: {
  projectId?: string;
  statusName?: string;
  trackerName?: string;
  limit?: number;
  apiKey: string;
}): Promise<CompactIssue[]> {
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
  return data.issues.map(toCompactIssue);
}

export async function getIssues(issueIds: number[], apiKey: string): Promise<DetailedIssue[]> {
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
  return data.issues.map(toDetailedIssue);
}

export async function updateIssueStatus(
  issueId: number,
  statusName: string,
  apiKey: string,
  notes?: string,
): Promise<void> {
  const statusId = await resolveStatusId(statusName, apiKey);
  await redmineFetch(`/issues/${issueId}.json`, apiKey, {
    method: "PUT",
    body: JSON.stringify({ issue: { status_id: statusId, ...(notes ? { notes } : {}) } }),
  });
}

export async function createIssue(params: {
  projectId?: string;
  subject: string;
  description?: string;
  trackerName?: string;
  priorityName?: string;
  assignedToId?: number;
  parentIssueId?: number;
  apiKey: string;
}): Promise<DetailedIssue> {
  const projectId = params.projectId ?? REDMINE_DEFAULT_PROJECT_ID;
  if (!projectId) {
    throw new Error("projectId não informado e REDMINE_DEFAULT_PROJECT_ID não configurado");
  }
  const issue: Record<string, unknown> = {
    project_id: projectId,
    subject: params.subject,
  };
  if (params.description !== undefined) issue.description = params.description;
  if (params.trackerName) issue.tracker_id = await resolveTrackerId(params.trackerName, params.apiKey);
  if (params.priorityName) issue.priority_id = await resolvePriorityId(params.priorityName, params.apiKey);
  if (params.assignedToId !== undefined) issue.assigned_to_id = params.assignedToId;
  if (params.parentIssueId !== undefined) issue.parent_issue_id = params.parentIssueId;

  const res = await redmineFetch("/issues.json", params.apiKey, {
    method: "POST",
    body: JSON.stringify({ issue }),
  });
  const data = (await res.json()) as { issue: RedmineIssue };
  return toDetailedIssue(data.issue);
}

export async function updateIssue(params: {
  issueId: number;
  subject?: string;
  description?: string;
  trackerName?: string;
  priorityName?: string;
  statusName?: string;
  assignedToId?: number;
  notes?: string;
  apiKey: string;
}): Promise<void> {
  const issue: Record<string, unknown> = {};
  if (params.subject !== undefined) issue.subject = params.subject;
  if (params.description !== undefined) issue.description = params.description;
  if (params.trackerName) issue.tracker_id = await resolveTrackerId(params.trackerName, params.apiKey);
  if (params.priorityName) issue.priority_id = await resolvePriorityId(params.priorityName, params.apiKey);
  if (params.statusName) issue.status_id = await resolveStatusId(params.statusName, params.apiKey);
  if (params.assignedToId !== undefined) issue.assigned_to_id = params.assignedToId;
  if (params.notes !== undefined) issue.notes = params.notes;

  if (Object.keys(issue).length === 0) {
    throw new Error("Nenhum campo informado para atualizar");
  }

  await redmineFetch(`/issues/${params.issueId}.json`, params.apiKey, {
    method: "PUT",
    body: JSON.stringify({ issue }),
  });
}

export async function addNote(
  issueId: number,
  notes: string,
  privateNotes: boolean | undefined,
  apiKey: string,
): Promise<void> {
  await redmineFetch(`/issues/${issueId}.json`, apiKey, {
    method: "PUT",
    body: JSON.stringify({ issue: { notes, private_notes: privateNotes ?? false } }),
  });
}

export interface JournalDetail {
  property: string;
  name: string;
  oldValue?: string;
  newValue?: string;
}

export interface Journal {
  id: number;
  user: string;
  notes: string;
  createdOn: string;
  details: JournalDetail[];
}

export async function getIssueJournals(issueId: number, apiKey: string): Promise<Journal[]> {
  const res = await redmineFetch(`/issues/${issueId}.json?include=journals`, apiKey);
  const data = (await res.json()) as { issue: RedmineIssue };
  return (data.issue.journals ?? []).map((j) => ({
    id: j.id,
    user: j.user.name,
    notes: j.notes,
    createdOn: j.created_on,
    details: (j.details ?? []).map((d) => ({
      property: d.property,
      name: d.name,
      oldValue: d.old_value,
      newValue: d.new_value,
    })),
  }));
}

export async function updateCustomFields(
  issueId: number,
  fields: { id: number; value: string }[],
  notes: string | undefined,
  apiKey: string,
): Promise<void> {
  const customFields = fields.map((f) => ({ id: f.id, value: f.value }));
  await redmineFetch(`/issues/${issueId}.json`, apiKey, {
    method: "PUT",
    body: JSON.stringify({ issue: { custom_fields: customFields, ...(notes ? { notes } : {}) } }),
  });
}

export interface IssueRelation {
  id: number;
  issueId: number;
  issueToId: number;
  relationType: string;
  delay?: number;
}

export async function listRelations(issueId: number, apiKey: string): Promise<IssueRelation[]> {
  const res = await redmineFetch(`/issues/${issueId}/relations.json`, apiKey);
  const data = (await res.json()) as {
    relations: { id: number; issue_id: number; issue_to_id: number; relation_type: string; delay?: number }[];
  };
  return data.relations.map((r) => ({
    id: r.id,
    issueId: r.issue_id,
    issueToId: r.issue_to_id,
    relationType: r.relation_type,
    delay: r.delay,
  }));
}

export async function listChildren(parentId: number, apiKey: string): Promise<CompactIssue[]> {
  const qs = new URLSearchParams({
    parent_id: String(parentId),
    status_id: "*",
    limit: "100",
  });
  const res = await redmineFetch(`/issues.json?${qs}`, apiKey);
  const data = (await res.json()) as { issues: RedmineIssue[] };
  return data.issues.map(toCompactIssue);
}

export interface SearchResultItem {
  id: number;
  title: string;
  type: string;
  url: string;
  description: string;
  datetime: string;
}

export async function searchIssues(query: string, apiKey: string): Promise<SearchResultItem[]> {
  const qs = new URLSearchParams({ q: query, issues: "1", limit: "50" });
  const res = await redmineFetch(`/search.json?${qs}`, apiKey);
  const data = (await res.json()) as { results: SearchResultItem[] };
  return data.results;
}

export async function attachFile(params: {
  issueId: number;
  fileContent: Buffer;
  filename: string;
  description?: string;
  notes?: string;
  apiKey: string;
}): Promise<void> {
  const uploadRes = await redmineUpload(
    `/uploads.json?${new URLSearchParams({ filename: params.filename })}`,
    params.apiKey,
    params.fileContent,
  );
  const uploadData = (await uploadRes.json()) as { upload: { token: string } };
  await redmineFetch(`/issues/${params.issueId}.json`, params.apiKey, {
    method: "PUT",
    body: JSON.stringify({
      issue: {
        uploads: [
          {
            token: uploadData.upload.token,
            filename: params.filename,
            ...(params.description ? { description: params.description } : {}),
          },
        ],
        ...(params.notes ? { notes: params.notes } : {}),
      },
    }),
  });
}
