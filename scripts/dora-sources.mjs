// Projects the release metrics can be built for. Each needs a public Jira project whose ticket keys appear in pull request titles.
// Apache Kafka fits: squash-merged pull requests titled "KAFKA-12345: ...", release dates on the Jira versions.
export const SOURCES = {
  kafka: {
    id: 'kafka', title: 'Apache Kafka', github: 'apache/kafka', baseBranch: 'trunk',
    jira: 'https://issues.apache.org/jira', project: 'KAFKA',
    jiraBrowse: 'https://issues.apache.org/jira/browse/', jiraUrl: 'https://issues.apache.org/jira/browse/KAFKA', githubUrl: 'https://github.com/apache/kafka',
  },
};
