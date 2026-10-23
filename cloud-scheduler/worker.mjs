// Dependency-free clock for the existing GitHub pipeline. No public trigger.
// The secret only needs Actions:write on transfer-radar-data, never Contents.
const REPOSITORY = 'lucasmlessa-hash/transfer-radar-data';
const WORKFLOW = 'refresh-br-ratios.yml';
const FEED_URL = 'https://lucasmlessa-hash.github.io/transfer-radar-data/feed.json';
const API = `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${WORKFLOW}`;

async function request(url, options, fetcher) {
  const response = await fetcher(url, {
    // Workers does not implement redirect:error. Manual keeps credentials on
    // the original host; the non-2xx guard below rejects every redirect.
    ...options, redirect: 'manual', signal: AbortSignal.timeout(20000),
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

// Re-running a workflow retains created_at; its latest attempt has a new start.
const startedAt = run => Date.parse(run.run_started_at || run.created_at);

export async function runScheduled(scheduledTime, env, fetcher = fetch) {
  const when = new Date(scheduledTime);
  const hour = when.getUTCHours();
  if (![9, 10, 11].includes(hour)) throw new Error('Unexpected daily schedule hour');
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
  const dispatch = async () => request(`${API}/dispatches`, {
    method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ ref: 'main' }),
  }, fetcher);
  if (hour >= 10) {
    const runs = data.workflow_runs.filter(run => run.head_branch === 'main'
      && startedAt(run) >= since - 2 * 3600000
      && startedAt(run) <= scheduledTime + 5 * 60000)
      .sort((a, b) => startedAt(b) - startedAt(a));
    // One recovery window, not a retry loop. An already started recovery,
    // including a failed one, must not be dispatched again on duplicate ticks.
    if (hour === 10 && runs.some(run => startedAt(run) >= since + 3600000)) {
      return { status: 'recovery-already-attempted' };
    }
    if (hour === 10 && runs.some(run => ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status)
      && startedAt(run) >= scheduledTime - 2 * 3600000)) {
      return { status: 'already-running-or-completed' };
    }
    try {
      const checked = runs[0];
      if (!checked || checked.status !== 'completed' || checked.conclusion !== 'success'
        || !(Date.parse(checked.updated_at) >= since && Date.parse(checked.updated_at) <= scheduledTime + 5 * 60000)) {
        throw new Error('Daily ratio verification incomplete: no successful latest run in this daily window');
      }
      const feedResponse = await request(FEED_URL, { cache: 'no-store' }, fetcher);
      const feed = await feedResponse.json();
      verifyPublished(feed, Date.parse(checked.updated_at), scheduledTime);
      return { status: 'verified', generatedAt: feed.generatedAt };
    } catch (error) {
      if (hour !== 10) throw error;
      await dispatch();
      return { status: 'recovery-dispatched', reason: error.message };
    }
  }
  const covered = data.workflow_runs.some(run => {
    const started = startedAt(run);
    if (run.head_branch !== 'main' || !Number.isFinite(started) || started > scheduledTime + 5 * 60000) return false;
    // A queued job from yesterday must not suppress today's attempt forever.
    const active = ['queued', 'in_progress', 'waiting', 'pending', 'requested'].includes(run.status)
      && started >= scheduledTime - 2 * 3600000;
    return active || (run.status === 'completed' && run.conclusion === 'success' && started >= since);
  });
  if (covered) return { status: 'already-running-or-completed' };
  await dispatch();
  return { status: 'dispatched' };
}

export default {
  async scheduled(controller, env) {
    // Throwing records a failed Cron event; a 2xx dispatch is not a claim that
    // the collection succeeded. The 10 UTC event recovers failures; 11 UTC verifies publication.
    const result = await runScheduled(controller.scheduledTime, env);
    console.log(JSON.stringify(result));
  },
  async fetch() { return new Response('Not found', { status: 404 }); },
};
