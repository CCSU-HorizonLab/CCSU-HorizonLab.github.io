const yearTarget = document.querySelector("[data-year]");
if (yearTarget) {
  yearTarget.textContent = String(new Date().getFullYear());
}

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_CACHE_URL = new URL("assets/data/github.json", document.baseURI).toString();
const MEMBER_OVERRIDES_URL = new URL("assets/data/member-overrides.json", document.baseURI).toString();
const CURRENT_YEAR = 2026;
let githubCachePromise;
let memberOverridesPromise;

const navLinks = [...document.querySelectorAll(".site-nav a")];
const sections = navLinks
  .map((link) => document.querySelector(link.getAttribute("href")))
  .filter(Boolean);

if ("IntersectionObserver" in window && sections.length > 0) {
  const observer = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];

      if (!visible) return;

      navLinks.forEach((link) => {
        link.classList.toggle("is-active", link.getAttribute("href") === `#${visible.target.id}`);
      });
    },
    {
      rootMargin: "-28% 0px -58% 0px",
      threshold: [0.18, 0.42, 0.7],
    }
  );

  sections.forEach((section) => observer.observe(section));
}

function getOwnerFrom(track) {
  const owner = track?.dataset.githubOwner;
  return owner && !owner.includes("{{") ? owner : "CCSU-Horizon-Lab";
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    const error = new Error(`GitHub API request failed: ${response.status}`);
    error.status = response.status;
    throw error;
  }

  return response.json();
}

async function fetchFirstAvailable(urls) {
  let lastError;

  for (const url of urls) {
    try {
      return await fetchJson(url);
    } catch (error) {
      lastError = error;
      if (![404, 422].includes(error.status)) {
        throw error;
      }
    }
  }

  throw lastError;
}

async function fetchPublicRepos(owner) {
  const repos = await fetchFirstAvailable([
    `${GITHUB_API_BASE}/orgs/${owner}/repos?type=public&sort=updated&direction=desc&per_page=100`,
    `${GITHUB_API_BASE}/users/${owner}/repos?type=owner&sort=updated&direction=desc&per_page=100`,
  ]);

  if (!Array.isArray(repos)) return [];

  return repos
    .filter((repo) => !repo.private && repo.name !== `${owner}.github.io`)
    .sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
}

async function fetchGithubCache(owner) {
  if (!githubCachePromise) {
    githubCachePromise = fetch(GITHUB_CACHE_URL, { cache: "no-cache" })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`GitHub cache missing: ${response.status}`);
        }
        return response.json();
      })
      .catch((error) => {
        console.info("GitHub cache unavailable, falling back to live API.", error);
        return null;
      });
  }

  const cache = await githubCachePromise;
  if (!cache || cache.owner !== owner) return null;

  return cache;
}

async function fetchMemberOverrides() {
  if (!memberOverridesPromise) {
    memberOverridesPromise = fetch(MEMBER_OVERRIDES_URL, { cache: "no-cache" })
      .then((response) => {
        if (!response.ok) return {};
        return response.json();
      })
      .catch(() => ({}));
  }

  return memberOverridesPromise;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDate(value) {
  if (!value) return "最近更新";

  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function getApiMessage(error, fallback) {
  if (error?.status === 403) {
    return "GitHub API 当前限流，请稍后刷新页面。";
  }

  return fallback;
}

function renderTrackState(track, className, title, description, actionUrl) {
  track.innerHTML = `
    <article class="${className} load-state">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(description)}</p>
      ${actionUrl ? `<a href="${escapeHtml(actionUrl)}" target="_blank" rel="noopener">前往 GitHub &rarr;</a>` : ""}
    </article>
  `;
}

function setupAutoMarquee(track, speed = 44) {
  const scroller = track?.closest(".horizontal-scroller");
  if (!scroller) return;

  scroller.classList.add("auto-marquee");
  track.classList.add("marquee-track");
  track.style.setProperty("--marquee-duration", `${speed}s`);
}

// --- Fetch Team Members ---
const membersTrack = document.getElementById('members-track');
const allMembersPanel = document.getElementById("all-members-panel");
const allMembersGrid = document.getElementById("all-members-grid");
const toggleMembersButton = document.getElementById("toggle-members");
const openJoinInfoButton = document.getElementById("open-join-info");
const joinModal = document.getElementById("join-modal");
const joinModalPanel = joinModal?.querySelector(".join-modal__panel");
const joinModalCloseTargets = [...document.querySelectorAll("[data-join-modal-close]")];
let lastFocusedElement;

async function loadMembers() {
  if (!membersTrack) return;

  const owner = getOwnerFrom(membersTrack);

  try {
    const cache = await fetchGithubCache(owner);
    if (Array.isArray(cache?.members) && cache.members.length > 0) {
      await renderMembers(cache.members, owner);
      return;
    }

    const members = await fetchMembers(owner);

    if (!Array.isArray(members) || members.length === 0) {
      renderTrackState(
        membersTrack,
        "member-card",
        "暂无成员资料",
        "当成员参与账号下公开仓库贡献，或公开组织成员身份后，这里会自动显示。",
        `https://github.com/${owner}`
      );
      return;
    }

    await renderMembers(members, owner);
  } catch (error) {
    console.error("Failed to load members:", error);
    renderTrackState(
      membersTrack,
      "member-card",
      "成员加载失败",
      getApiMessage(error, "暂时无法读取 GitHub 公开成员资料。"),
      `https://github.com/${owner}`
    );
  }
}

async function renderMembers(members, owner) {
  const overrides = await fetchMemberOverrides();
  const allMembers = members
    .filter((user) => user?.login)
    .map((user) => applyMemberOverride(user, overrides))
    .sort(compareMembersByGrade);

  const activeMembers = allMembers
    .filter((user) => !isGraduated(user))
    .slice(0, 24);

  const html = renderMarqueeCards(activeMembers, renderMemberCard);

  if (html) {
    membersTrack.innerHTML = html;
    setupAutoMarquee(membersTrack, Math.max(34, activeMembers.length * 8));
    renderAllMembers(allMembers);
    return;
  }

  renderTrackState(
    membersTrack,
    "member-card",
    "暂无成员资料",
    "当成员参与账号下公开仓库贡献，或公开组织成员身份后，这里会自动显示。",
    `https://github.com/${owner}`
  );
}

function renderAllMembers(members) {
  if (!allMembersGrid) return;

  allMembersGrid.innerHTML = members.map(renderMemberCard).join("");
}

function renderMemberCard(user) {
  const avatarSrc = user.avatar_path || user.avatar_url || `https://github.com/${user.login}.png`;

  return `
    <a href="${escapeHtml(user.html_url)}" class="member-card" target="_blank" rel="noopener">
      <img src="${escapeHtml(avatarSrc)}" alt="${escapeHtml(user.login)}" class="member-avatar" loading="lazy" onerror="this.src='https://github.com/${escapeHtml(user.login)}.png'">
      <h3 class="member-name">${escapeHtml(user.name || user.login)}</h3>
      ${user.class_name ? `<span class="member-class">${escapeHtml(user.class_name)}</span>` : ""}
      <p class="member-bio">${escapeHtml(user.bio || '保持好奇，持续探索。')}</p>
      <span class="member-github">@${escapeHtml(user.login)}</span>
      <span class="member-meta">${escapeHtml(getMemberMeta(user))}</span>
    </a>
  `;
}

function applyMemberOverride(user, overrides) {
  const override = overrides[user.login] || {};

  return {
    ...user,
    name: override.display_name || user.name,
    class_name: override.class_name || user.class_name || "",
    bio: getDisplayBio(user, override),
  };
}

function getDisplayBio(user, override) {
  const candidates = [override.bio, user.bio];
  const bio = candidates.find((value) => value && !isGeneratedLabBio(value));
  return bio || "";
}

function isGeneratedLabBio(value) {
  return /^Horizon Lab (毕业)?成员，来自 .+。$/.test(String(value || ""));
}

function compareMembersByGrade(a, b) {
  const aGrade = getGradeYear(a);
  const bGrade = getGradeYear(b);
  const aGraduated = isGraduated(a);
  const bGraduated = isGraduated(b);

  if (aGraduated !== bGraduated) return aGraduated ? 1 : -1;
  if (aGrade !== bGrade) return aGrade - bGrade;
  return Number(b.contributions || 0) - Number(a.contributions || 0);
}

function getGradeYear(member) {
  const match = String(member.class_name || "").match(/^(\d{2})/);
  return match ? Number(`20${match[1]}`) : 9999;
}

function isGraduated(member) {
  const gradeYear = getGradeYear(member);
  return gradeYear !== 9999 && CURRENT_YEAR - gradeYear >= 5;
}

function getMemberMeta(member) {
  if (isGraduated(member)) return "已毕业成员";
  return "GitHub Member";
}

async function fetchMembers(owner) {
  try {
    const orgMembers = await fetchJson(`${GITHUB_API_BASE}/orgs/${owner}/members?per_page=100`);
    if (Array.isArray(orgMembers) && orgMembers.length > 0) {
      return orgMembers;
    }
  } catch (error) {
    if (![404, 422].includes(error.status)) {
      throw error;
    }
  }

  const repos = await fetchPublicRepos(owner);
  const contributorsByLogin = new Map();

  await Promise.all(
    repos.slice(0, 12).map(async (repo) => {
      try {
        const contributors = await fetchJson(`${repo.contributors_url}?per_page=30`);
        if (!Array.isArray(contributors)) return;

        contributors.forEach((contributor) => {
          if (!contributor?.login || contributor.type === "Bot") return;

          const existing = contributorsByLogin.get(contributor.login);
          contributorsByLogin.set(contributor.login, {
            ...contributor,
            contributions: Number(existing?.contributions || 0) + Number(contributor.contributions || 0),
          });
        });
      } catch (error) {
        if (![404, 409].includes(error.status)) {
          throw error;
        }
      }
    })
  );

  return [...contributorsByLogin.values()]
    .sort((a, b) => Number(b.contributions || 0) - Number(a.contributions || 0))
    .slice(0, 24);
}

// --- Fetch Open Source Projects ---
const projectsTrack = document.getElementById('projects-track');

async function loadProjects() {
  if (!projectsTrack) return;

  const owner = getOwnerFrom(projectsTrack);

  try {
    const cache = await fetchGithubCache(owner);
    if (Array.isArray(cache?.repos) && cache.repos.length > 0) {
      renderProjects(cache.repos, owner);
      return;
    }

    const publicRepos = await fetchPublicRepos(owner);

    if (publicRepos.length === 0) {
      renderTrackState(
        projectsTrack,
        "project-card project-card--empty",
        "暂无公开仓库",
        "当账号下出现新的公开仓库时，这里会自动显示。",
        `https://github.com/${owner}?tab=repositories`
      );
      return;
    }

    renderProjects(publicRepos, owner);
  } catch (error) {
    console.error("Failed to load projects:", error);
    renderTrackState(
      projectsTrack,
      "project-card project-card--empty",
      "项目加载失败",
      getApiMessage(error, "暂时无法读取 GitHub 公开仓库。"),
      `https://github.com/${owner}?tab=repositories`
    );
  }
}

function renderProjects(repos, owner) {
  const cards = repos
    .map((repo) => {
      const language = repo.language || "Repository";
      const topics = Array.isArray(repo.topics) ? repo.topics.slice(0, 3) : [];

      return renderProjectCard(repo, language, topics);
    });
  const html = renderMarqueeCards(cards, (card) => card);

  if (html) {
    projectsTrack.innerHTML = html;
    setupAutoMarquee(projectsTrack, Math.max(38, repos.length * 12));
    return;
  }

  renderTrackState(
    projectsTrack,
    "project-card project-card--empty",
    "暂无公开仓库",
    "当账号下出现新的公开仓库时，这里会自动显示。",
    `https://github.com/${owner}?tab=repositories`
  );
}

function renderProjectCard(repo, language, topics) {
  return `
    <article class="project-card" style="--project-accent: ${escapeHtml(getLangColor(repo.language))}">
      <div class="project-card__header">
        <h3 class="project-card__title">
          ${escapeHtml(repo.name)}
          <a href="${escapeHtml(repo.html_url)}" class="external-link" target="_blank" rel="noopener" aria-label="打开 ${escapeHtml(repo.name)} 仓库">
            <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M6 3h7v7M13 3L3 13" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </a>
        </h3>
        <div class="project-card__lang">
          <span class="language-dot"></span>
          <span>${escapeHtml(language)}</span>
        </div>
      </div>
      <p class="project-card__desc">${escapeHtml(repo.description || '探索技术边界的开源试验场。')}</p>
      ${topics.length ? `
      <div class="repo-topics" aria-label="${escapeHtml(repo.name)} topics">
        ${topics.map((topic) => `<span>${escapeHtml(topic)}</span>`).join("")}
      </div>
      ` : ""}

      <div class="project-card__footer">
        <span class="star-count">
          <svg aria-hidden="true" viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M8 2l2 4.5h4.5l-3.5 3.5 1 4.5-4-2.5-4 2.5 1-4.5L1.5 6.5H6z"/>
          </svg>
          ${Number(repo.stargazers_count || 0)}
        </span>
        <span class="star-count">Fork ${Number(repo.forks_count || 0)}</span>
        <span class="update-time">${formatDate(repo.updated_at)}</span>
      </div>
    </article>
  `;
}

function renderMarqueeCards(items, renderItem) {
  if (!items.length) return "";
  const firstSet = items.map(renderItem).join("");
  const secondSet = items.map((item) => {
    const html = renderItem(item);
    return html.replace(/<(a|article)\b/, '<$1 aria-hidden="true" tabindex="-1"');
  }).join("");

  return `${firstSet}${secondSet}`;
}

function getLangColor(lang) {
  const colors = {
    'JavaScript': '#f1e05a',
    'TypeScript': '#3178c6',
    'Python': '#3572A5',
    'PHP': '#4F5D95',
    'C++': '#f34b7d',
    'C': '#555555',
    'HTML': '#e34c26',
    'CSS': '#563d7c',
    'Vue': '#41b883',
    'Java': '#b07219',
    'Go': '#00ADD8',
    'Rust': '#dea584',
    'Shell': '#89e051',
    'Markdown': '#083fa1'
  };
  return colors[lang] || '#a0aec0';
}

// Init
document.addEventListener('DOMContentLoaded', () => {
  loadMembers();
  loadProjects();

  toggleMembersButton?.addEventListener("click", () => {
    if (!allMembersPanel) return;

    const willOpen = allMembersPanel.hidden;
    allMembersPanel.hidden = !willOpen;
    toggleMembersButton.textContent = willOpen ? "收起全部成员 ↑" : "展开全部成员 →";
  });

  openJoinInfoButton?.addEventListener("click", openJoinModal);
  joinModalCloseTargets.forEach((target) => {
    target.addEventListener("click", closeJoinModal);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && joinModal && !joinModal.hidden) {
      closeJoinModal();
    }
  });
});

function openJoinModal() {
  if (!joinModal) return;

  lastFocusedElement = document.activeElement;
  joinModal.hidden = false;
  openJoinInfoButton?.setAttribute("aria-expanded", "true");
  document.body.classList.add("modal-open");

  requestAnimationFrame(() => {
    joinModal.classList.add("is-open");
    joinModalPanel?.focus();
  });
}

function closeJoinModal() {
  if (!joinModal || joinModal.hidden) return;

  joinModal.classList.remove("is-open");
  openJoinInfoButton?.setAttribute("aria-expanded", "false");
  document.body.classList.remove("modal-open");

  window.setTimeout(() => {
    joinModal.hidden = true;
    if (lastFocusedElement instanceof HTMLElement) {
      lastFocusedElement.focus();
    }
  }, 180);
}
