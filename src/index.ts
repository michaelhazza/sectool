/**
 * audit-tool — internal security audit tool for Breakout Solutions apps.
 *
 * Static (SAST) scanning of source repos + live (DAST) scanning of
 * allowlisted staging URLs, merged into one prioritized remediation report.
 *
 * Entry point stub; the CLI is built out during the spec pipeline.
 */
export const TOOL_NAME = 'audit-tool';

export function toolBanner(): string {
  return `${TOOL_NAME}: internal security audit tool`;
}
