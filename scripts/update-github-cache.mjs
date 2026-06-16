import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const owner = process.env.GITHUB_OWNER || "CCSU-HorizonLab";
const token = process.env.GITHUB_TOKEN || "";
const apiBase = "https://api.github.com";
const outputPath = path.join("assets", "data", "github.json");
const overridesPath = path.join("assets", "data", "member-overrides.json");
const avatarsDir = path.join("assets", "data", "avatars");
const existingCache = await readExistingCache();
const existingMembersByLogin = new Map(
  (existingCache.members || []).map((member) => [member.login.toLowerCase(), member])
);

async function fetchJson(url, optionalStatuses = []) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    if (optionalStatuses.includes(response.status)) return null;
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }

  return response.json();
}

async function fetchFirstAvailable(urls) {
  let lastError;

  for (const url of urls) {
    try {
      const data = await fetchJson(url, [404, 422]);
      if (data) return data;
    } catch (error) {
      lastError = error;
      if (String(error.message || "").startsWith("403")) {
        throw error;
      }
    }
  }

  if (lastError) throw lastError;
  return [];
}

async function fetchPublicRepos() {
  let repos;

  try {
    repos = await fetchFirstAvailable([
      `${apiBase}/orgs/${owner}/repos?type=public&sort=updated&direction=desc&per_page=100`,
      `${apiBase}/users/${owner}/repos?type=owner&sort=updated&direction=desc&per_page=100`,
    ]);
  } catch (error) {
    console.warn("Failed to fetch repos from GitHub API. Falling back to existing cache.", error.message);
    repos = existingCache.repos || [];
  }

  if (!Array.isArray(repos)) return [];

  return repos
    .filter((repo) => !repo.private && !isSiteRepository(repo))
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
}

function isSiteRepository(repo) {
  const repoName = String(repo?.name || "").toLowerCase();
  return repoName === `${owner.toLowerCase()}.github.io`;
}

async function fetchMembers(repos) {
  const overrides = await readMemberOverrides();
  let members;

  try {
    const orgMembers = await fetchJson(`${apiBase}/orgs/${owner}/members?per_page=100`, [403, 404, 422]);

    if (Array.isArray(orgMembers) && orgMembers.length > 0) {
      members = await hydrateUsers(orgMembers, overrides);
    } else {
      const contributorsByLogin = new Map();

      await Promise.all(
        repos.slice(0, 20).map(async (repo) => {
          if (!repo.contributors_url) return;

          const contributors = await fetchJson(`${repo.contributors_url}?per_page=50`, [403, 404, 409]);
          if (!Array.isArray(contributors)) return;

          contributors.forEach((contributor) => {
            if (!contributor?.login || contributor.type === "Bot") return;

            const existing = contributorsByLogin.get(contributor.login);
            contributorsByLogin.set(contributor.login, {
              ...contributor,
              contributions: Number(existing?.contributions || 0) + Number(contributor.contributions || 0),
            });
          });
        })
      );

      const contributors = [...contributorsByLogin.values()]
        .sort((a, b) => Number(b.contributions || 0) - Number(a.contributions || 0))
        .slice(0, 30);

      members = await hydrateUsers(contributors, overrides);
    }
  } catch (error) {
    console.warn("Failed to fetch members from GitHub API. Falling back to existing cache.", error.message);
    members = existingCache.members || [];
  }

  const allMembers = await includeOverrideOnlyMembers(members, overrides);
  return allMembers.filter((member) => !overrides[member.login]?.exclude);
}

async function hydrateUsers(users, overrides) {
  const profiles = await Promise.all(
    users.map(async (user) => {
      const existing = existingMembersByLogin.get(String(user.login || "").toLowerCase());
      const profile = user.url ? await fetchJson(user.url, [403, 404]) : null;
      return normalizeMember(profile || existing || user, user.contributions, overrides);
    })
  );

  return profiles.filter((user) => user.login);
}

async function readMemberOverrides() {
  try {
    return JSON.parse(await readFile(overridesPath, "utf8"));
  } catch {
    return {};
  }
}

async function readExistingCache() {
  try {
    return JSON.parse(await readFile(outputPath, "utf8"));
  } catch {
    return { repos: [], members: [] };
  }
}

async function includeOverrideOnlyMembers(members, overrides) {
  const byLogin = new Map(members.map((member) => [member.login.toLowerCase(), member]));

  await Promise.all(
    Object.keys(overrides).map(async (login) => {
      if (overrides[login]?.exclude) return;
      if (byLogin.has(login.toLowerCase())) return;

      const existing = existingMembersByLogin.get(login.toLowerCase());
      let profile = null;
      try {
        profile = await fetchJson(`${apiBase}/users/${login}`, [403, 404]);
      } catch (error) {
        console.warn(`Failed to fetch user profile for ${login}. Using fallback.`, error.message);
      }
      const fallback = existing || {
        login,
        name: login,
        html_url: `https://github.com/${login}`,
        avatar_url: `https://github.com/${login}.png`,
      };

      const member = normalizeMember(profile || fallback, 0, overrides);
      byLogin.set(member.login.toLowerCase(), member);
    })
  );

  return [...byLogin.values()].sort((a, b) => {
    const aHasClass = a.class_name ? 1 : 0;
    const bHasClass = b.class_name ? 1 : 0;
    if (aHasClass !== bHasClass) return bHasClass - aHasClass;
    return Number(b.contributions || 0) - Number(a.contributions || 0);
  });
}

function normalizeRepo(repo) {
  return {
    name: repo.name,
    description: repo.description,
    html_url: repo.html_url,
    language: repo.language,
    topics: Array.isArray(repo.topics) ? repo.topics : [],
    stargazers_count: repo.stargazers_count || 0,
    forks_count: repo.forks_count || 0,
    updated_at: repo.updated_at,
  };
}

function normalizeMember(user, contributions = 0, overrides = {}) {
  const override = overrides[user.login] || {};

  return {
    login: user.login,
    name: override.display_name || user.name || user.login,
    class_name: override.class_name || "",
    bio: getMemberBio(user, override),
    location: user.location || "",
    html_url: user.html_url || `https://github.com/${user.login}`,
    avatar_url: user.avatar_url || `https://github.com/${user.login}.png`,
    contributions: contributions || user.contributions || 0,
  };
}

function getMemberBio(user, override) {
  const candidates = [override.bio, user.bio];
  const bio = candidates.find((value) => value && !isGeneratedLabBio(value));
  return bio || "";
}

function isGeneratedLabBio(value) {
  return /^Horizon Lab (毕业)?成员，来自 .+。$/.test(String(value || ""));
}

const repos = await fetchPublicRepos();
const members = await cacheMemberAvatars(await fetchMembers(repos));

const cache = {
  owner,
  generated_at: new Date().toISOString(),
  repos: repos.map(normalizeRepo),
  members,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");

console.log(`Wrote ${outputPath}: ${cache.repos.length} repos, ${cache.members.length} members`);

async function cacheMemberAvatars(members) {
  await mkdir(avatarsDir, { recursive: true });

  return Promise.all(
    members.map(async (member) => {
      const safeName = member.login.replace(/[^a-zA-Z0-9._-]/g, "_");
      const avatarPath = path.join(avatarsDir, `${safeName}.png`).replaceAll("\\", "/");
      const existing = existingMembersByLogin.get(member.login.toLowerCase());

      try {
        const response = await fetch(member.avatar_url || `https://github.com/${member.login}.png`);
        if (!response.ok) throw new Error(`avatar ${response.status}`);

        const buffer = Buffer.from(await response.arrayBuffer());
        await writeFile(avatarPath, buffer);
        return {
          ...member,
          avatar_path: avatarPath,
        };
      } catch {
        return {
          ...member,
          avatar_path: existing?.avatar_path || member.avatar_path || "",
        };
      }
    })
  );
}
