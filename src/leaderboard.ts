import type { ActivationStats, Breakdown, LiveLineDetail } from './crm.ts';

const MEDALS = ['🥇', '🥈', '🥉'];

export function renderLeaderboard(b: Breakdown): string {
  if (b.reps.length === 0) {
    return '📊 *Kits Sold — Closed Won*\n\nNo closed deals yet — go get one! 🚀';
  }

  const lines: string[] = ['📊 *Kits Sold — Closed Won*', ''];
  let rank = 0;
  let prevTotal = -1;
  b.reps.forEach((rep, i) => {
    if (rep.total !== prevTotal) rank = i + 1; // ties share a rank
    prevTotal = rep.total;
    const badge = rep.id === 'former' ? ' •' : rank <= 3 ? MEDALS[rank - 1] : ` ${rank}.`;
    lines.push(
      `${badge} ${rep.name} — *${rep.total}* kit${rep.total === 1 ? '' : 's'}` +
        `  (${rep.month} this month · ${rep.week} this week)`,
    );
  });

  lines.push(
    '',
    `🛰️ Team: *${b.team.total}* all time · *${b.team.month}* this month · *${b.team.week}* this week`,
  );
  return lines.join('\n');
}

/** Mirrors the "Kits live — activation queue" dashboard tiles. */
export function renderActivationBoard(s: ActivationStats, newLines: LiveLineDetail[] = []): string {
  const lines: string[] = [];

  if (newLines.length > 0) {
    lines.push(`⚡ *+${newLines.length} kit${newLines.length === 1 ? '' : 's'} just went LIVE!* 🎉`, '');
    // One line per company+rep pair, with kit count and close→live days.
    const groups = new Map<string, { company: string; rep: string; count: number; days: number | null }>();
    for (const l of newLines) {
      const key = `${l.company}|${l.rep}`;
      const g = groups.get(key);
      if (g) {
        g.count += 1;
        if (l.days !== null && (g.days === null || l.days > g.days)) g.days = l.days;
      } else {
        groups.set(key, { company: l.company, rep: l.rep, count: 1, days: l.days });
      }
    }
    for (const g of groups.values()) {
      const kits = g.count > 1 ? ` — ${g.count} kits` : '';
      const days =
        g.days !== null ? ` · ⏱️ ${g.days} day${g.days === 1 ? '' : 's'} from close to live` : '';
      lines.push(`🏢 ${g.company}${kits} · 👤 ${g.rep}${days}`);
    }
    lines.push('');
  }

  lines.push(
    '⚡ *Kits Live — Activation Queue*',
    '',
    `🛰️ Total live: *${s.totalLive}*`,
    `📈 Taken live: *${s.thisWeek}* this week · *${s.thisMonth}* this month`,
    `📅 Scheduled this month: *${s.scheduledThisMonth}*`,
    `⏳ Unscheduled: *${s.unscheduled}*`,
  );
  if (s.avgDaysToLive !== null) {
    lines.push(`⏱️ Avg close → live: *${s.avgDaysToLive}* days`);
  }
  return lines.join('\n');
}
