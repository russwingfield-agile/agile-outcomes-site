// The public trackers the dashboard can show. Each is queried anonymously for team-level figures only.
export const SOURCES = {
  product: { jira: 'https://jira.atlassian.com', project: 'JRACLOUD', history: true, cap: 3000, openCap: 400 },
  engine: {
    jira: 'https://jira.mongodb.org', project: 'SERVER', history: false, countHistory: true, cap: 11000, openCap: 1000,
    // Statuses the tracker groups as "in progress": used to ask how many items were in progress on a given date.
    doing: ['In Progress', 'In Code Review', 'Waiting For User Input', 'Needs Merge', 'Needs Verification', 'Investigating', 'Blocked', 'Exception in Review', 'Remediation in Review', 'Needs Backport', 'Remediation Pending Release'],
  },
};
export const DEFAULT_SOURCE = 'product';
