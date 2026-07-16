import { readFile, writeFile } from "node:fs/promises";

const START_MARKER = "<!-- BUILD-ACTIVITY:START -->";
const END_MARKER = "<!-- BUILD-ACTIVITY:END -->";
const README_PATH = process.env.README_PATH ?? "README.md";
const username = process.env.PROJECT_USERNAME ?? process.env.GITHUB_REPOSITORY_OWNER;
const maxProjects = Number.parseInt(process.env.MAX_PROJECTS ?? "4", 10);

if (!username) {
  throw new Error("Set PROJECT_USERNAME or GITHUB_REPOSITORY_OWNER.");
}

if (!Number.isInteger(maxProjects) || maxProjects < 1) {
  throw new Error("MAX_PROJECTS must be a positive integer.");
}

const excludedRepositories = new Set(
  [
    `${username}/${username}`,
    `${username}/${username}.github.io`,
    `${username}/resume`,
    ...(process.env.EXCLUDED_REPOSITORIES ?? "").split(","),
  ]
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean),
);

const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": `${username}-profile-readme`,
};

if (process.env.GITHUB_TOKEN) {
  headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
}

async function fetchJson(path) {
  const response = await fetch(`https://api.github.com${path}`, { headers });
  if (!response.ok) {
    throw new Error(`GitHub API returned ${response.status} for ${path}: ${await response.text()}`);
  }
  return response.json();
}

function escapeMarkdown(text) {
  return text
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\s+/g, " ")
    .trim();
}

function activityLabel(eventTypes) {
  const labels = [];
  if (eventTypes.has("PushEvent")) labels.push("pushes");
  if (eventTypes.has("PullRequestEvent")) labels.push("pull requests");
  if (eventTypes.has("CreateEvent")) labels.push("new repo / branch / tag");
  return labels.join(" · ");
}

function formatCount(count) {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

function renderProject({ repository, lastActivity, eventTypes }) {
  const details = [
    repository.language,
    repository.stargazers_count > 0 ? `★ ${formatCount(repository.stargazers_count)}` : null,
    activityLabel(eventTypes),
    lastActivity.slice(0, 10),
  ].filter(Boolean);

  return `- [${escapeMarkdown(repository.full_name)}](${repository.html_url}) — ${details.join(" · ")}`;
}

const trackedEvents = new Set(["PushEvent", "PullRequestEvent", "CreateEvent"]);
const activityByRepository = new Map();

for (let page = 1; page <= 3; page += 1) {
  const events = await fetchJson(
    `/users/${encodeURIComponent(username)}/events/public?per_page=100&page=${page}`,
  );

  for (const event of events) {
    if (!trackedEvents.has(event.type)) continue;
    if (excludedRepositories.has(event.repo.name.toLowerCase())) continue;

    const current = activityByRepository.get(event.repo.name) ?? {
      lastActivity: event.created_at,
      eventTypes: new Set(),
    };
    current.eventTypes.add(event.type);
    activityByRepository.set(event.repo.name, current);
  }

  if (events.length < 100) break;
}

const recentActivity = [...activityByRepository.entries()]
  .sort(([, a], [, b]) => new Date(b.lastActivity) - new Date(a.lastActivity))
  .slice(0, maxProjects * 3);

const projects = (
  await Promise.all(
    recentActivity.map(async ([name, activity]) => ({
      ...activity,
      repository: await fetchJson(`/repos/${name}`),
    })),
  )
)
  .filter(({ repository }) => !repository.archived && !repository.disabled && !repository.fork)
  .slice(0, maxProjects);

const readme = await readFile(README_PATH, "utf8");
const startIndex = readme.indexOf(START_MARKER);
const endIndex = readme.indexOf(END_MARKER);

if (startIndex === -1 || endIndex === -1 || startIndex >= endIndex) {
  throw new Error(`README must contain ${START_MARKER} before ${END_MARKER}.`);
}

const activityList = projects.length
  ? projects.map(renderProject).join("\n")
  : "_No recent public build activity found._";
const updatedReadme = `${readme.slice(0, startIndex + START_MARKER.length)}\n${activityList}\n${readme.slice(endIndex)}`;

await writeFile(README_PATH, updatedReadme);
console.log(`Updated ${README_PATH} with ${projects.length} active projects for ${username}.`);
