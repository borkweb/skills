// One reminder line when a dream pass is due, or '' when it is not. Read-only apart from a
// throttle stamp. The dream pass itself never runs from here: it changes the private review
// criteria only row by row with the user's approval.
//
// Due means the `Last dreamed:` date in the private review criteria is more than DAYS old, or
// RUNS run directories have changed since it. A user with no private copy has never dreamed and
// is not nagged. BORK_DREAM_REMINDER=0 turns it off.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DAYS = 14;
const RUNS = 5;
const QUIET_DAYS = 3; // at most one reminder in this many days
const DAY = 86_400_000;

export function dreamDue({
  criteria = process.env.BORK_REVIEW_CRITERIA || join(homedir(), '.borkweb-skills', 'review-criteria.md'),
  handoffs = process.env.AGENT_HANDOFFS_DIR || join(homedir(), '.agent-handoffs'),
  now = Date.now(),
} = {}) {
  if (process.env.BORK_DREAM_REMINDER === '0') return '';
  try {
    if (!existsSync(criteria)) return '';
    const m = /^Last dreamed:\s*(\d{4}-\d{2}-\d{2}|none)\b/m.exec(readFileSync(criteria, 'utf8').slice(0, 8000));
    if (!m) return '';
    const cutoff = m[1] === 'none' ? 0 : Date.parse(`${m[1]}T23:59:59Z`);
    if (!Number.isFinite(cutoff)) return '';
    const runsDir = join(handoffs, 'runs');
    let runs = 0;
    if (existsSync(runsDir)) {
      for (const name of readdirSync(runsDir)) {
        if (/-dream-/.test(name)) continue; // a dream pass's own directory is not a run to learn from
        try { if (statSync(join(runsDir, name)).mtimeMs > cutoff) runs += 1; } catch { /* gone */ }
      }
    }
    const days = cutoff ? Math.floor((now - Date.parse(`${m[1]}T00:00:00Z`)) / DAY) : null;
    if (!(runs >= RUNS || (days !== null && days > DAYS && runs > 0))) return '';
    const stamp = join(handoffs, '.dream-reminder');
    try { if (now - statSync(stamp).mtimeMs < QUIET_DAYS * DAY) return ''; } catch { /* never reminded */ }
    try { mkdirSync(dirname(stamp), { recursive: true, mode: 0o700 }); writeFileSync(stamp, `${new Date(now).toISOString()}\n`); } catch { return ''; }
    const since = days === null ? 'No dream pass has run yet' : `The last dream pass was ${days} day(s) ago (${m[1]})`;
    return `[dream] ${since} and ${runs} run(s) have changed since. Tell the user once, in one line, that a dream pass is due (the \`dream\` skill). Do not run it unless they ask.\n`;
  } catch { return ''; }
}
