#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const README_PATH = process.env.FEATURED_PROJECTS_README || path.join(ROOT, 'README.md');
const CONFIG_PATH = process.env.FEATURED_PROJECTS_CONFIG || path.join(ROOT, 'config', 'featured-projects.json');
const API_BASE = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const TOKEN = process.env.GITHUB_TOKEN || '';
const DRY_RUN = process.env.FEATURED_PROJECTS_DRY_RUN === '1';
const FAIL_DISCOVERY = process.env.FEATURED_PROJECTS_FAIL_DISCOVERY === '1';
const START = '<!-- AUTO-PROJECTS-START -->';
const END = '<!-- AUTO-PROJECTS-END -->';
const HEADER = '| Project | Tech Stack | Live Demo | Repository |';

const FRONTEND_DEPS = [
  'next', 'react', 'react-dom', 'vue', 'nuxt', 'svelte', '@sveltejs/kit',
  '@angular/core', 'vite', '@vitejs/plugin-react', 'gatsby', 'astro', 'remix', '@remix-run/react'
];
const BACKEND_DEPS = [
  '@nestjs/core', 'fastify', 'koa', '@hapi/hapi', 'mongoose', 'mongodb', 'pg', 'mysql2',
  'sequelize', 'typeorm', 'prisma', '@prisma/client', 'drizzle-orm', 'socket.io', 'graphql',
  'apollo-server', 'better-auth'
];
const STACK_RULES = [
  ['next', 'Next.js'],
  ['react', 'React'],
  ['typescript', 'TypeScript'],
  ['vite', 'Vite'],
  ['tailwindcss', 'Tailwind CSS'],
  ['daisyui', 'DaisyUI'],
  ['@angular/core', 'Angular'],
  ['vue', 'Vue.js'],
  ['svelte', 'Svelte'],
  ['framer-motion', 'Framer Motion'],
  ['@reduxjs/toolkit', 'Redux'],
  ['redux', 'Redux'],
  ['mongoose', 'MongoDB'],
  ['mongodb', 'MongoDB'],
  ['prisma', 'Prisma'],
  ['pg', 'PostgreSQL'],
  ['mysql2', 'MySQL'],
  ['better-auth', 'BetterAuth'],
  ['@nestjs/core', 'NestJS'],
  ['fastify', 'Fastify'],
  ['express', 'Express.js'],
  ['socket.io', 'Socket.IO'],
  ['stripe', 'Stripe']
];
const DEMO_HOST = /(^|\.)(vercel\.app|netlify\.app|github\.io|web\.app|firebaseapp\.com|render\.com|onrender\.com|railway\.app|fly\.dev|herokuapp\.com|surge\.sh|pages\.dev)$/i;
const NO_WEB_MARKERS = ['run and deploy your ai studio app', 'ai.studio/apps/'];

let rateRemaining = null;
let requestCount = 0;

function log(message) {
  console.log(message);
}

function warn(message) {
  console.warn(`Warning: ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function canonical(value) {
  if (typeof value !== 'string') return '';
  return value.trim()
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '')
    .toLowerCase();
}

function requireArray(value, fallback) {
  return Array.isArray(value) ? value : fallback;
}

function repoApiPath(fullName) {
  return String(fullName).split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function loadConfig() {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  if (!config || typeof config.username !== 'string' || !config.username) {
    throw new Error('config must define a username');
  }
  if (!Array.isArray(config.manualInclude) || !Array.isArray(config.manualExclude)) {
    throw new Error('config must define manualInclude and manualExclude arrays');
  }
  const discovery = config.discovery || {};
  const delayOverride = Number(process.env.FEATURED_PROJECTS_REQUEST_DELAY_MS);
  config.discovery = {
    maxProjects: Number.isInteger(discovery.maxProjects) ? Math.max(0, discovery.maxProjects) : 6,
    minRepositorySizeKb: Number.isFinite(discovery.minRepositorySizeKb) ? discovery.minRepositorySizeKb : 20,
    requestDelayMs: process.env.FEATURED_PROJECTS_REQUEST_DELAY_MS && Number.isFinite(delayOverride)
      ? Math.max(0, delayOverride)
      : (Number.isFinite(discovery.requestDelayMs) ? Math.max(0, discovery.requestDelayMs) : 200),
    excludedLanguages: requireArray(discovery.excludedLanguages, []).map(String),
    excludedTopics: requireArray(discovery.excludedTopics, []).map(String),
    excludedNamePatterns: requireArray(discovery.excludedNamePatterns, []).map(String)
  };
  for (const project of config.manualInclude) {
    if (!project || typeof project.repository !== 'string' || typeof project.name !== 'string' || !Array.isArray(project.stack)) {
      throw new Error('each manualInclude entry needs repository, name, and stack');
    }
    project.requiredRepositories = project.requiredRepositories && project.requiredRepositories.length
      ? project.requiredRepositories
      : [project.repository];
    project.repoLinks = project.repoLinks && project.repoLinks.length
      ? project.repoLinks
      : [{ label: 'Code Repo', url: `https://github.com/${project.repository}` }];
    project.liveLabel = project.liveLabel || 'Live Preview';
    project.showCategory = Boolean(project.showCategory);
  }
  return config;
}

async function githubGet(pathOrUrl, options = {}) {
  const url = /^https?:\/\//i.test(pathOrUrl) ? pathOrUrl : `${API_BASE}${pathOrUrl}`;
  const headers = {
    'Accept': options.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
    'User-Agent': 'featured-projects-updater',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  const delay = loadConfigDelay();

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (rateRemaining !== null && rateRemaining <= 1) {
      throw new Error('GitHub API rate limit nearly exhausted');
    }
    if (requestCount > 0 && delay > 0) await sleep(delay);
    requestCount += 1;

    let response;
    try {
      response = await fetch(url, { headers, redirect: 'follow' });
    } catch (error) {
      if (attempt === 3) throw new Error(`network request failed for ${url}: ${error.message}`);
      await sleep(400 * attempt);
      continue;
    }

    const remainingHeader = response.headers.get('x-ratelimit-remaining');
    if (remainingHeader !== null) rateRemaining = Number(remainingHeader);

    if (response.status === 404) {
      return { status: 404, data: null };
    }
    if (response.status === 403 || response.status === 429) {
      const retryAfter = Number(response.headers.get('retry-after'));
      const reset = Number(response.headers.get('x-ratelimit-reset'));
      const retryMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : (Number.isFinite(reset) && reset > 0 ? Math.max(0, reset * 1000 - Date.now()) : 500 * attempt);
      if (attempt < 3) {
        await sleep(Math.min(60000, retryMs));
        continue;
      }
      throw new Error(`GitHub API refused the request (${response.status}) for ${url}`);
    }
    if (response.status >= 500) {
      if (attempt < 3) {
        await sleep(500 * attempt);
        continue;
      }
      throw new Error(`GitHub API server error (${response.status}) for ${url}`);
    }
    if (!response.ok) {
      throw new Error(`GitHub API error (${response.status}) for ${url}`);
    }
    const data = options.raw ? await response.text() : await response.json();
    return { status: response.status, data };
  }
  throw new Error(`GitHub API request failed for ${url}`);
}

let configuredDelay = 200;
function loadConfigDelay() {
  return configuredDelay;
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function parseTable(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(eol);
  const markers = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === START || trimmed === END) markers.push({ index, value: trimmed });
  });
  if (markers.length !== 2) {
    throw new Error(`expected exactly one ${START} and one ${END} marker; found ${markers.length}`);
  }
  const start = markers[0];
  const end = markers[1];
  if (start.value !== START || end.value !== END || start.index >= end.index) {
    throw new Error('AUTO-PROJECTS markers are missing, duplicated, or in the wrong order');
  }
  if (lines[start.index - 2] !== HEADER) {
    throw new Error('Featured Projects table header changed; refusing to edit');
  }
  const separator = lines[start.index - 1] || '';
  const columns = separator.split('|').length - 2;
  if (!/^\|[\s:|-]+\|$/.test(separator) || columns !== 4) {
    throw new Error('Featured Projects table separator changed; refusing to edit');
  }
  const rowLines = lines.slice(start.index + 1, end.index);
  if (rowLines.some((line) => line.trim() !== '' && !line.startsWith('|'))) {
    throw new Error('unexpected content inside the Featured Projects table; refusing to edit');
  }
  return { eol, lines, startIndex: start.index, endIndex: end.index };
}

function outsideTable(text, table) {
  const lines = text.split(table.eol);
  return lines
    .filter((line, index) => index < table.startIndex || index >= table.endIndex)
    .join(table.eol);
}

function isManualRow(row, manualProjects) {
  const lower = row.toLowerCase();
  return manualProjects.some((project) =>
    project.repoLinks.some((link) => lower.includes(String(link.url).toLowerCase())) ||
    lower.includes(`github.com/${canonical(project.repository)}`) ||
    lower.includes(`**${project.name.toLowerCase()}**`)
  );
}

function parsePackage(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

function extractName(repo, readme) {
  const heading = String(readme || '').split(/\r?\n/).map((line) => line.trim())
    .find((line) => /^#{1,3}\s+\S/.test(line));
  let name = heading
    ? heading.replace(/^#{1,3}\s+/, '').replace(/[*_`]/g, '').trim()
    : String(repo.name || '');
  name = name.replace(/[^\p{L}\p{N}\s&+.'/-]/gu, '').replace(/\s+/g, ' ').trim();
  if (!name) name = String(repo.name || 'project');
  return name.slice(0, 60);
}

function validDemoUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.hostname === 'github.com' || url.hostname.endsWith('.github.com')) return null;
    if (!DEMO_HOST.test(url.hostname)) return null;
    return url.toString();
  } catch (error) {
    return null;
  }
}

function demoCandidates(readme, homepage) {
  const text = String(readme || '');
  const candidates = [];
  const markdown = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g;
  let match;
  while ((match = markdown.exec(text)) !== null) {
    const url = validDemoUrl(match[2]);
    if (url) {
      candidates.push({
        url,
        label: match[1].toLowerCase(),
        context: text.slice(0, match.index).split('\n').pop().toLowerCase()
      });
    }
  }
  const bare = /https?:\/\/[^\s<>"'`)\]]+/g;
  while ((match = bare.exec(text)) !== null) {
    const url = validDemoUrl(match[0].replace(/[.,;]+$/, ''));
    if (url && !candidates.some((candidate) => candidate.url === url)) {
      candidates.push({
        url,
        label: '',
        context: text.slice(0, match.index).split('\n').pop().toLowerCase()
      });
    }
  }
  const home = validDemoUrl(homepage);
  if (home) candidates.push({ url: home, label: 'homepage', context: 'homepage' });
  return candidates;
}

function pickDemoUrl(candidates, category) {
  if (!candidates.length) return null;
  const backend = category === 'Backend';
  const preferredLabels = backend
    ? ['server', 'backend', 'api']
    : ['live', 'demo', 'preview', 'client', 'portfolio', 'website'];
  const preferredHosts = backend
    ? ['onrender.com', 'render.com', 'railway.app', 'fly.dev', 'herokuapp.com']
    : ['vercel.app', 'netlify.app', 'github.io', 'pages.dev'];
  const scored = candidates.map((candidate) => {
    let score = 0;
    const haystack = `${candidate.label} ${candidate.context}`;
    for (const label of preferredLabels) {
      if (haystack.includes(label)) score += 4;
    }
    for (const host of preferredHosts) {
      if (candidate.url.includes(host)) score += 3;
    }
    if (candidate.label === 'homepage') score += 2;
    if (backend && candidate.url.includes('vercel.app') && !haystack.includes('server')) score -= 3;
    if (!backend && candidate.url.includes('onrender.com')) score -= 2;
    return { url: candidate.url, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].url;
}

function buildStack(dependencies, category) {
  const labels = [];
  for (const [dependency, label] of STACK_RULES) {
    if (dependencies[dependency] && !labels.includes(label)) labels.push(label);
    if (labels.length >= 6) break;
  }
  if (category !== 'Frontend' && !labels.includes('Node.js')) {
    const insertAt = labels.findIndex((label) => ['Express.js', 'NestJS', 'Fastify', 'MongoDB'].includes(label));
    labels.splice(insertAt === -1 ? labels.length : insertAt, 0, 'Node.js');
  }
  return labels.slice(0, 6);
}

function prefilter(repo, config) {
  if (!repo || repo.private || repo.fork || repo.archived || repo.disabled) return false;
  if (Number(repo.size) < config.discovery.minRepositorySizeKb) return false;
  const fullName = canonical(repo.full_name);
  if (!fullName || canonical(config.profileRepository) === fullName) return false;
  if (config.manualExclude.some((entry) => canonical(entry) === fullName)) return false;
  const name = String(repo.name || '').toLowerCase();
  if (config.discovery.excludedNamePatterns.some((pattern) => new RegExp(pattern, 'i').test(name))) return false;
  const language = String(repo.language || '').toLowerCase();
  if (config.discovery.excludedLanguages.some((entry) => entry.toLowerCase() === language)) return false;
  const topics = (repo.topics || []).map((topic) => String(topic).toLowerCase());
  if (topics.some((topic) => config.discovery.excludedTopics.some((entry) => entry.toLowerCase() === topic))) return false;
  return true;
}

async function classifyRepo(repo) {
  const base = `/repos/${repoApiPath(repo.full_name)}`;
  const [packageResponse, rootResponse, readmeResponse] = await Promise.all([
    githubGet(`${base}/contents/package.json`, { raw: true }),
    githubGet(`${base}/contents?per_page=1000`),
    githubGet(`${base}/readme`, { raw: true })
  ]);
  const readme = readmeResponse.status === 200 ? readmeResponse.data : '';
  const readmeLower = readme.toLowerCase();
  if (NO_WEB_MARKERS.some((marker) => readmeLower.includes(marker))) return null;

  const pkg = parsePackage(packageResponse.status === 200 ? packageResponse.data : '');
  const rootFiles = Array.isArray(rootResponse.data)
    ? rootResponse.data.map((file) => String(file.name || '').toLowerCase())
    : [];
  const dependencies = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const dependencyNames = Object.keys(dependencies);

  const hasFrontend = dependencyNames.some((dep) => FRONTEND_DEPS.includes(dep)) ||
    rootFiles.some((file) => /^(next|vite|nuxt|astro|svelte)\.config\./.test(file));
  const hasStrongBackend = dependencyNames.some((dep) => BACKEND_DEPS.includes(dep));
  const hasServerFile = rootFiles.some((file) =>
    ['server.js', 'server.ts', 'app.js', 'app.ts', 'index.js', 'index.ts', 'main.js', 'api', 'server'].includes(file));
  const hasBackend = hasStrongBackend || (dependencyNames.some((dep) => ['express', 'fastify', 'koa'].includes(dep)) && hasServerFile);
  if (!hasFrontend && !hasBackend) return null;

  const genericPackage = ['react-example', 'my-app', 'app', 'project', 'website'].includes(String(pkg.name || '').toLowerCase());
  if (!readme && !repo.description && genericPackage) return null;

  const category = hasFrontend && hasBackend ? 'Full Stack' : (hasBackend ? 'Backend' : 'Frontend');
  return {
    repository: repo.full_name,
    name: extractName(repo, readme),
    category,
    showCategory: true,
    stack: buildStack(dependencies, category),
    liveUrl: pickDemoUrl(demoCandidates(readme, repo.homepage), category),
    liveLabel: 'Live Preview',
    repoLinks: [{ label: 'Code Repo', url: `https://github.com/${repo.full_name}` }],
    protected: false
  };
}

async function discover(config) {
  const repos = [];
  for (let page = 1; page <= 5; page += 1) {
    const response = await githubGet(
      `/users/${encodeURIComponent(config.username)}/repos?per_page=100&page=${page}&type=owner&sort=updated`
    );
    if (!Array.isArray(response.data)) throw new Error('unexpected repository list response');
    repos.push(...response.data);
    if (response.data.length < 100) break;
  }
  return repos;
}

async function availableManualProjects(manualProjects) {
  const unique = new Map();
  for (const project of manualProjects) {
    for (const name of project.requiredRepositories) {
      const key = canonical(name);
      if (key && !unique.has(key)) unique.set(key, name);
    }
  }
  const checks = await mapLimit([...unique.entries()], 3, async ([key, name]) => {
    try {
      const response = await githubGet(`/repos/${repoApiPath(name)}`);
      return [key, response.status === 404 ? 'missing' : 'available'];
    } catch (error) {
      warn(`could not verify ${name}: ${error.message}`);
      return [key, 'unknown'];
    }
  });
  const states = new Map(checks);
  return manualProjects.filter((project) => {
    const missing = project.requiredRepositories
      .map((name) => [canonical(name), name])
      .filter(([key]) => states.get(key) === 'missing');
    if (missing.length) {
      log(`Removing protected project ${project.name}: ${missing.map(([, name]) => name).join(', ')} unavailable`);
      return false;
    }
    return true;
  });
}

function escapeCell(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function renderRow(project) {
  const title = `**${escapeCell(project.name)}**${project.showCategory ? ` (${escapeCell(project.category)})` : ''}`;
  const stack = project.stack.length ? project.stack.map(escapeCell).join(', ') : '—';
  const live = project.liveUrl
    ? `[${escapeCell(project.liveLabel || 'Live Preview')}](${project.liveUrl})`
    : 'Not Deployed';
  const repositories = project.repoLinks
    .map((link) => `[${escapeCell(link.label)}](${link.url})`)
    .join(' · ');
  return `| ${title} | ${stack} | ${live} | ${repositories} |`;
}

async function main() {
  const config = loadConfig();
  configuredDelay = config.discovery.requestDelayMs;
  const originalBuffer = fs.readFileSync(README_PATH);
  const originalText = originalBuffer.toString('utf8');
  const table = parseTable(originalText);
  const existingRows = table.lines.slice(table.startIndex + 1, table.endIndex).filter((line) => line.trim());
  const previousAutoRows = existingRows.filter((row) => !isManualRow(row, config.manualInclude));

  const manualProjects = await availableManualProjects(config.manualInclude);
  const projects = manualProjects.map((project) => ({ ...project, protected: true }));
  let autoRows = previousAutoRows;

  try {
    if (FAIL_DISCOVERY) throw new Error('simulated discovery failure');
    const repos = await discover(config);
    const eligible = repos.filter((repo) => prefilter(repo, config));
    const classified = (await mapLimit(eligible, 3, async (repo) => {
      try {
        return await classifyRepo(repo);
      } catch (error) {
        warn(`skipping ${repo.full_name}: ${error.message}`);
        return null;
      }
    })).filter(Boolean);

    const manualRepos = new Set(projects.map((project) => canonical(project.repository)));
    const usedNames = new Set(projects.map((project) => project.name.toLowerCase()));
    const autoProjects = [];
    for (const project of classified) {
      const key = canonical(project.repository);
      if (!key || manualRepos.has(key) || autoProjects.some((item) => canonical(item.repository) === key)) continue;
      if (usedNames.has(project.name.toLowerCase())) continue;
      usedNames.add(project.name.toLowerCase());
      autoProjects.push(project);
      if (autoProjects.length >= config.discovery.maxProjects) break;
    }
    autoRows = autoProjects.map(renderRow);
    log(`Discovery: ${repos.length} repositories, ${eligible.length} eligible, ${autoProjects.length} auto projects`);
    for (const row of previousAutoRows) {
      if (!autoRows.includes(row)) log(`Removed unavailable or ineligible auto project: ${row.slice(0, 72)}...`);
    }
  } catch (error) {
    warn(`discovery failed; existing project rows were kept unchanged: ${error.message}`);
  }

  const updatedLines = table.lines.slice();
  updatedLines.splice(
    table.startIndex + 1,
    table.endIndex - (table.startIndex + 1),
    ...projects.map(renderRow),
    ...autoRows
  );
  const updatedText = updatedLines.join(table.eol);
  if (outsideTable(originalText, table) !== outsideTable(updatedText, parseTable(updatedText))) {
    throw new Error('refusing to write: content outside the Featured Projects table would change');
  }
  const updatedBuffer = Buffer.from(updatedText, 'utf8');
  if (updatedBuffer.equals(originalBuffer)) {
    log('No changes to README.md');
    return;
  }
  if (DRY_RUN) {
    log('Dry run: README.md was not written');
    return;
  }

  const temporaryPath = `${README_PATH}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(temporaryPath, updatedBuffer);
    fs.renameSync(temporaryPath, README_PATH);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (ignored) {
      void ignored;
    }
    fs.writeFileSync(README_PATH, updatedBuffer);
  }
  log(`Updated README.md (${existingRows.length} -> ${projects.length + autoRows.length} project rows)`);
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  if (process.env.FEATURED_PROJECTS_DEBUG === '1') console.error(error);
  process.exit(1);
});
