// .github/scripts/weekly-report.js
// Génère un rapport hebdomadaire GitHub → Slack

const { Octokit } = require('@octokit/rest');
const fs = require('fs');

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });
const owner = process.env.REPO_OWNER;
const repo = process.env.REPO_NAME;

// Plage : 7 derniers jours
const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
const weekLabel = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric', month: 'long'
}).format(new Date(since)) + ' → ' +
new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric', month: 'long'
}).format(new Date());

async function fetchPRs() {
  const { data } = await octokit.pulls.list({
    owner, repo, state: 'all', per_page: 100,
    sort: 'updated', direction: 'desc'
  });

  const merged = data.filter(pr =>
    pr.merged_at && new Date(pr.merged_at) >= new Date(since)
  );
  const opened = data.filter(pr =>
    pr.state === 'open' && new Date(pr.created_at) >= new Date(since)
  );
  const closed = data.filter(pr =>
    pr.state === 'closed' && !pr.merged_at &&
    new Date(pr.closed_at) >= new Date(since)
  );

  // Temps moyen de review des PRs mergées
  const reviewTimes = merged
    .filter(pr => pr.created_at && pr.merged_at)
    .map(pr => (new Date(pr.merged_at) - new Date(pr.created_at)) / 3600000);
  const avgReviewHours = reviewTimes.length
    ? Math.round(reviewTimes.reduce((a, b) => a + b, 0) / reviewTimes.length)
    : 0;

  // Top auteurs
  const authorCount = {};
  merged.forEach(pr => {
    const login = pr.user?.login || 'inconnu';
    authorCount[login] = (authorCount[login] || 0) + 1;
  });
  const topAuthors = Object.entries(authorCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([login, count]) => `${login} (${count})`)
    .join(', ') || '—';

  return { merged, opened, closed, avgReviewHours, topAuthors };
}

async function fetchIssues() {
  const [openedRes, closedRes] = await Promise.all([
    octokit.issues.listForRepo({ owner, repo, state: 'open', since, per_page: 100 }),
    octokit.issues.listForRepo({ owner, repo, state: 'closed', since, per_page: 100 })
  ]);

  const opened = openedRes.data.filter(i => !i.pull_request);
  const closed = closedRes.data.filter(i =>
    !i.pull_request && new Date(i.closed_at) >= new Date(since)
  );

  // Issues par label
  const labelCount = {};
  [...opened, ...closed].forEach(issue => {
    issue.labels.forEach(l => {
      labelCount[l.name] = (labelCount[l.name] || 0) + 1;
    });
  });
  const topLabels = Object.entries(labelCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => `\`${name}\` ×${count}`)
    .join('  ') || '—';

  return { opened, closed, topLabels };
}

async function fetchCommits() {
  const { data } = await octokit.repos.listCommits({
    owner, repo, since, per_page: 100
  });

  const authorCount = {};
  data.forEach(c => {
    const login = c.author?.login || c.commit.author?.name || 'inconnu';
    authorCount[login] = (authorCount[login] || 0) + 1;
  });
  const topCommitter = Object.entries(authorCount)
    .sort((a, b) => b[1] - a[1])[0];

  return {
    total: data.length,
    topCommitter: topCommitter
      ? `${topCommitter[0]} (${topCommitter[1]} commits)`
      : '—'
  };
}

async function fetchWorkflowStats() {
  try {
    const { data } = await octokit.actions.listWorkflowRunsForRepo({
      owner, repo, per_page: 100, created: `>=${since}`
    });
    const runs = data.workflow_runs;
    const success = runs.filter(r => r.conclusion === 'success').length;
    const failure = runs.filter(r => r.conclusion === 'failure').length;
    const total = success + failure;
    const rate = total > 0 ? Math.round((success / total) * 100) : 100;
    return { total, success, failure, rate };
  } catch {
    return { total: 0, success: 0, failure: 0, rate: 100 };
  }
}

function emoji(n, good, warn) {
  if (n >= good) return '🟢';
  if (n >= warn) return '🟡';
  return '🔴';
}

function ciEmoji(rate) {
  if (rate >= 90) return '🟢';
  if (rate >= 70) return '🟡';
  return '🔴';
}

async function main() {
  console.log('📊 Récupération des données GitHub...');
  const [prs, issues, commits, ci] = await Promise.all([
    fetchPRs(), fetchIssues(), fetchCommits(), fetchWorkflowStats()
  ]);

  const repoUrl = `https://github.com/${owner}/${repo}`;

  const payload = {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `📊 Rapport hebdo · ${repo}`,
          emoji: true
        }
      },
      {
        type: 'context',
        elements: [{
          type: 'mrkdwn',
          text: `📅 Semaine du *${weekLabel}*  ·  <${repoUrl}|${owner}/${repo}>`
        }]
      },
      { type: 'divider' },

      // Pull Requests
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*🔀 Pull Requests*'
        }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*✅ Mergées*\n${prs.merged.length}` },
          { type: 'mrkdwn', text: `*🆕 Ouvertes*\n${prs.opened.length}` },
          { type: 'mrkdwn', text: `*⏱ Temps moyen review*\n${prs.avgReviewHours}h` },
          { type: 'mrkdwn', text: `*🏆 Top auteurs*\n${prs.topAuthors}` }
        ]
      },
      { type: 'divider' },

      // Issues
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*🐛 Issues*' }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*🆕 Créées*\n${issues.opened.length}` },
          { type: 'mrkdwn', text: `*✅ Fermées*\n${issues.closed.length}` },
          { type: 'mrkdwn', text: `*🏷 Labels fréquents*\n${issues.topLabels}` }
        ]
      },
      { type: 'divider' },

      // Commits & CI
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*⚙️ Activité & CI/CD*' }
      },
      {
        type: 'section',
        fields: [
          { type: 'mrkdwn', text: `*📝 Commits*\n${commits.total}` },
          { type: 'mrkdwn', text: `*✍️ Top committer*\n${commits.topCommitter}` },
          {
            type: 'mrkdwn',
            text: `*${ciEmoji(ci.rate)} Taux de succès CI*\n${ci.rate}% (${ci.success}✅ ${ci.failure}❌)`
          },
          { type: 'mrkdwn', text: `*🔁 Total workflows*\n${ci.total} runs` }
        ]
      },
      { type: 'divider' },

      // Score santé global
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: [
            '*📈 Score santé du repo cette semaine*',
            `${emoji(prs.merged.length, 3, 1)} PRs mergées : *${prs.merged.length}*`,
            `${emoji(issues.closed.length, 3, 1)} Issues fermées : *${issues.closed.length}*`,
            `${ciEmoji(ci.rate)} CI : *${ci.rate}%* de succès`,
            `${emoji(commits.total, 10, 3)} Commits : *${commits.total}*`
          ].join('\n')
        }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '🔀 Voir les PRs', emoji: true },
            url: `${repoUrl}/pulls`
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '🐛 Voir les issues', emoji: true },
            url: `${repoUrl}/issues`
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '⚙️ Workflows CI', emoji: true },
            url: `${repoUrl}/actions`
          }
        ]
      }
    ]
  };

  fs.writeFileSync('slack-payload.json', JSON.stringify(payload, null, 2));
  console.log('✅ Payload Slack généré → slack-payload.json');
  console.log(`   PRs mergées: ${prs.merged.length} | Issues fermées: ${issues.closed.length} | CI: ${ci.rate}% | Commits: ${commits.total}`);
}

main().catch(err => {
  console.error('❌ Erreur:', err);
  process.exit(1);
});
