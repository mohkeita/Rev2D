/** The ReportSink of a build stage: issues in the order they were raised, statistics by name. */
import type { AvatarIssue, AvatarReport } from '../types.js';
import type { ReportSink } from './types.js';

export function createReportSink(): ReportSink {
  const issues: AvatarIssue[] = [];
  const stats: Record<string, number> = {};
  const add = (severity: AvatarIssue['severity'], code: string, message: string, extra: { path?: string; hint?: string } = {}) => {
    const issue: AvatarIssue = { severity, code, message };
    if (extra.path !== undefined) issue.path = extra.path;
    if (extra.hint !== undefined) issue.hint = extra.hint;
    issues.push(issue);
  };
  return {
    warning: (code, message, extra) => add('warning', code, message, extra),
    info: (code, message, extra) => add('info', code, message, extra),
    stat: (name, value) => {
      stats[name] = value;
    },
    issues,
    stats,
  };
}

/** Several reports as one: issues in order, later statistics win on a name clash. */
export function mergeReports(...reports: AvatarReport[]): AvatarReport {
  return { issues: reports.flatMap((r) => r.issues), stats: Object.assign({}, ...reports.map((r) => r.stats)) };
}
