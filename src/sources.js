// The public trackers the dashboard can show. Each is queried anonymously for team-level figures only.
export const SOURCES = {
  product: { jira: 'https://jira.atlassian.com', project: 'JRACLOUD', history: true, cap: 3000, openCap: 400 },
  engine: {
    jira: 'https://jira.mongodb.org', project: 'SERVER', history: false, cap: 11000, openCap: 1000,
    // Where open work can sit, in pipeline order, and the stages finished work may have passed through.
    stages: ['Needs Triage', 'Backlog', 'Ready for Work', 'In Progress', 'Investigating', 'In Code Review', 'Needs Merge', 'Needs Verification', 'Blocked', 'Waiting For User Input'],
    passedThrough: [['Worked on', 'In Progress'], ['Code reviewed', 'In Code Review'], ['Blocked at any point', 'Blocked']],
  },
};
export const DEFAULT_SOURCE = 'product';
