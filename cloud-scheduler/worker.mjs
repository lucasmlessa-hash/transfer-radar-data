// Dependency-free clock for the existing GitHub pipeline. No public trigger.
// The secret only needs Actions:write on transfer-radar-data, never Contents.
const REPOSITORY = 'lucasmlessa-hash/transfer-radar-data';
const WORKFLOW = 'refresh-br-ratios.yml';
const FEED_URL = 'https://lucasmlessa-hash.github.io/transfer-radar-data/feed.json';
const API = `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}`;

async function request(url, options, fetcher) {
  const response = await fetcher(url, {
    ...options, redirect: 'error', signal: AbortSignal.timeout(20000),
  });
  // Do not log response bodies or headers: an upstream error can echo secrets.
  if (!response.ok) throw new Error(`Scheduler request failed: HTTP ${response.status}`);
  return response;
}

function verifyPublished(feed, since, now) {
  const problems = [];
  const current = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
    && Date.parse(value) >= since && Date.parse(value) <= now + 5 * 60000;
  if (!current(feed?.generatedAt)) problems.push('no publication from this daily window');
  if (!Array.isArray(feed?.routes)) problems.push('invalid feed');
  const health = feed?.health;
  if (health?.status !== 'ok' || health?.carriedForwardRoutes !== 0) problems.push('partial or missing collection report');
  for (const [group, ids] of Object.entries({
    sources: ['frequentmiler', 'awardwallet', 'livelo', 'esfera'],
    directories: ['fm-directory', 'livelo-directory'],
  })) for (const id of ids) {
    const source = health?.[group]?.[id];
    if (source?.status !== 'ok' || !current(source?.checkedAt)
      || (group === 'sources' && !current(source?.lastSuccessAt))) problems.push(`${id}: verification incomplete`);
  }
  if (problems.length) throw new Error(`Daily verification failed: ${problems.join('; ')}`);
}

export async function runScheduled(scheduledTime, env, fetcher = fetch) {
  const when = new Date(scheduledTime);
  const hour = when.getUTCHours();
  if (![9, 10].includes(hour)) throw new Error('Unexpected daily schedule hour');
  const since = Date.UTC(when.getUTCFullYear(), when.getUTCMonth(), when.getUTCDate(), 9);
  if (!env.GITHUB_TOKEN) throw new Error('Missing GITHUB_TOKEN secret');
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    'User-Agent': 'transfer-radar-daily-scheduler',
    'X-GitHub-Api-Version': '2026-03-10',
  };
  const response = await request(`${API}/runs?branch=main&per_page=20`, { headers }, fetcher);
  const data = await response.json();
  if (!Array.isArray(data.workflow_runs)) throw new Error('Invalid GitHub workflow response');
  if (hour === 10) {
    const checked = data.workflow_runs.filter(run => run.head_branch === 'main'
      && run.status === 'completed' && run.conclusion === 'success'
      && Date.parse(run.created_at) >= since - 2 * 3600000
      && Date.parse(run.created_at) <= scheduledTime
      && Date.parse(run.updated_at) >= since && Date.parse(run.updated_at) <= scheduledTime + 5 * 60000)
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
    if (!checked) throw new Error('Daily ratio verification incomplete: no successful run in this daily window');
    const feedResponse = await request(FEED_URL, { cache: 'no-store' }, fetcher);
    const feed = await feedResponse.json();
    verifyPublished(feed, Date.parse(checked.updated_at), scheduledTime);
    return { status: 'verified', generatedAt: feed.generatedAt };
  }
  const covered = data.workflow_runs.some(run => {
    const started = Date.parse(run.created_at);
    if (run.head_branch !== 'main' || !Number.isFinite(started) || started > scheduledTime + 5 * 60000) return false;
    // A queued job from yesterday must not suppress today's attempt forever.
    const active = ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status)
      && started >= scheduledTime - 2 * 3600000;
    return active || (run.status === 'completed' && run.conclusion === 'success' && started >= since);
  });
  if (covered) return { status: 'already-running-or-completed' };
  await request(`${API}/dispatches`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: 'main' }),
  }, fetcher);
  return { status: 'dispatched' };
}

export default {
  async scheduled(controller, env) {
    // Throwing records a failed Cron event; a 2xx dispatch is not a claim that
    // the collection succeeded. The 10 UTC event verifies actual publication.
    const result = await runScheduled(controller.scheduledTime, env);
    console.log(JSON.stringify(result));
  },
  async fetch() { return new Response('Not found', { status: 404 }); },
};
