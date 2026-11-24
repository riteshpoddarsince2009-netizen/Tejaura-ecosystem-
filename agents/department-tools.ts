import type { Tool, ToolCategory, ToolRiskLevel } from '../contracts/types/index.ts';
import type { DepartmentToolDefinition } from './agent-types.ts';

interface ToolSpec {
  id: string;
  name: string;
  description: string;
  category: ToolCategory;
  permission_scope: string;
  risk_level: ToolRiskLevel;
}

const TOOL_SPECS: readonly ToolSpec[] = [
  {
    id: 'ceo_planner',
    name: 'Objective Planner',
    description: 'Breaks an owner objective into bounded, dependency-aware department tasks.',
    category: 'intelligence',
    permission_scope: 'agent:plan',
    risk_level: 'low',
  },
  {
    id: 'delegation_dispatcher',
    name: 'Controlled Delegation Dispatcher',
    description: 'Submits validated child task envelopes to explicitly allowed department agents.',
    category: 'governance',
    permission_scope: 'delegation:create',
    risk_level: 'medium',
  },
  {
    id: 'repo_inspector',
    name: 'Workspace Inspector',
    description: 'Reads files only inside the authorized task workspace.',
    category: 'filesystem',
    permission_scope: 'fs:read:workspace',
    risk_level: 'low',
  },
  {
    id: 'sandbox_file_writer',
    name: 'Sandbox File Writer',
    description: 'Writes bounded files only inside an isolated task workspace.',
    category: 'filesystem',
    permission_scope: 'fs:write:sandbox',
    risk_level: 'medium',
  },
  {
    id: 'sandbox_test_runner',
    name: 'Sandbox Test Runner',
    description: 'Runs an allowlisted test command inside the isolated sandbox.',
    category: 'system',
    permission_scope: 'exec:run:sandbox',
    risk_level: 'medium',
  },
  {
    id: 'design_spec_writer',
    name: 'Design Specification Writer',
    description: 'Produces implementation-ready UI/UX specifications and component guidance.',
    category: 'intelligence',
    permission_scope: 'design:write',
    risk_level: 'low',
  },
  {
    id: 'design_consistency_reviewer',
    name: 'Visual Consistency Reviewer',
    description: 'Checks design outputs against the stated visual system and accessibility checklist.',
    category: 'intelligence',
    permission_scope: 'design:write',
    risk_level: 'low',
  },
  {
    id: 'seo_site_analyzer',
    name: 'SEO Site Analyzer',
    description: 'Audits supplied site structure, metadata, and crawlability information.',
    category: 'intelligence',
    permission_scope: 'seo:analyze',
    risk_level: 'low',
  },
  {
    id: 'seo_keyword_planner',
    name: 'Keyword Planner',
    description: 'Builds keyword clusters and intent maps without external paid APIs.',
    category: 'intelligence',
    permission_scope: 'seo:analyze',
    risk_level: 'low',
  },
  {
    id: 'seo_brief_writer',
    name: 'SEO Content Brief Writer',
    description: 'Writes structured content briefs for downstream drafting.',
    category: 'intelligence',
    permission_scope: 'seo:analyze',
    risk_level: 'low',
  },
  {
    id: 'content_drafter',
    name: 'Content Drafter',
    description: 'Drafts non-published content inside the owner-approved project context.',
    category: 'intelligence',
    permission_scope: 'content:draft',
    risk_level: 'low',
  },
  {
    id: 'campaign_planner',
    name: 'Campaign Planner',
    description: 'Creates campaign structure and channel plans for owner review.',
    category: 'intelligence',
    permission_scope: 'content:draft',
    risk_level: 'low',
  },
  {
    id: 'platform_post_adapter',
    name: 'Platform Post Adapter',
    description: 'Adapts approved copy to platform-specific formats without publishing.',
    category: 'intelligence',
    permission_scope: 'content:draft',
    risk_level: 'low',
  },
  {
    id: 'support_ticket_reader',
    name: 'Support Ticket Reader',
    description: 'Reads only the supplied, minimized customer query context.',
    category: 'intelligence',
    permission_scope: 'support:draft',
    risk_level: 'low',
  },
  {
    id: 'support_response_drafter',
    name: 'Support Response Drafter',
    description: 'Drafts a customer response without sending it externally.',
    category: 'intelligence',
    permission_scope: 'support:draft',
    risk_level: 'low',
  },
  {
    id: 'support_escalator',
    name: 'Support Escalation Planner',
    description: 'Flags sensitive or uncertain cases for human review.',
    category: 'governance',
    permission_scope: 'support:draft',
    risk_level: 'medium',
  },
  {
    id: 'metrics_reader',
    name: 'Project Metrics Reader',
    description: 'Reads supplied project metrics; performs no external data collection.',
    category: 'intelligence',
    permission_scope: 'analytics:read',
    risk_level: 'low',
  },
  {
    id: 'analytics_report_writer',
    name: 'Analytics Report Writer',
    description: 'Produces bounded operational reports from supplied metrics.',
    category: 'intelligence',
    permission_scope: 'analytics:read',
    risk_level: 'low',
  },
  {
    id: 'anomaly_detector',
    name: 'Anomaly Detector',
    description: 'Identifies metric anomalies and operational issues without mutating systems.',
    category: 'intelligence',
    permission_scope: 'analytics:read',
    risk_level: 'low',
  },
  {
    id: 'security_code_scanner',
    name: 'Security Code Scanner',
    description: 'Reviews supplied code for common vulnerability and secret-exposure patterns.',
    category: 'intelligence',
    permission_scope: 'security:review',
    risk_level: 'medium',
  },
  {
    id: 'security_config_reviewer',
    name: 'Security Configuration Reviewer',
    description: 'Reviews supplied configuration for unsafe defaults and privilege risks.',
    category: 'intelligence',
    permission_scope: 'security:review',
    risk_level: 'medium',
  },
  {
    id: 'vulnerability_triager',
    name: 'Vulnerability Triager',
    description: 'Classifies findings by severity and recommends remediation without changing controls.',
    category: 'intelligence',
    permission_scope: 'security:review',
    risk_level: 'medium',
  },
  {
    id: 'qa_acceptance_checker',
    name: 'Acceptance Criteria Checker',
    description: 'Validates deliverables against explicit acceptance criteria.',
    category: 'intelligence',
    permission_scope: 'review:write',
    risk_level: 'low',
  },
  {
    id: 'qa_output_reviewer',
    name: 'Output Reviewer',
    description: 'Independently reviews department outputs and rejects unsupported completion claims.',
    category: 'intelligence',
    permission_scope: 'review:write',
    risk_level: 'low',
  },
  {
    id: 'qa_test_evidence_reviewer',
    name: 'Test Evidence Reviewer',
    description: 'Checks that claimed tests have actual execution evidence.',
    category: 'intelligence',
    permission_scope: 'review:write',
    risk_level: 'low',
  },
  {
    id: 'research_source_reader',
    name: 'Supplied Source Reader',
    description: 'Reads only sources supplied by the owner or upstream tasks; performs no external collection.',
    category: 'intelligence',
    permission_scope: 'research:read',
    risk_level: 'low',
  },
  {
    id: 'research_synthesis_writer',
    name: 'Research Synthesis Writer',
    description: 'Synthesizes supplied evidence into a bounded brief with explicit confidence and gaps.',
    category: 'intelligence',
    permission_scope: 'research:read',
    risk_level: 'low',
  },
  {
    id: 'research_gap_analyzer',
    name: 'Research Gap Analyzer',
    description: 'Identifies missing evidence and unanswered questions without inventing facts.',
    category: 'intelligence',
    permission_scope: 'research:read',
    risk_level: 'low',
  },
] as const;

export const DEPARTMENT_TOOLS: ReadonlyMap<string, DepartmentToolDefinition> = new Map(
  TOOL_SPECS.map((spec) => [
    spec.id,
    {
      id: spec.id,
      name: spec.name,
      description: spec.description,
      category: spec.category,
      input_schema_ref: 'agents/schemas/delegation-task.schema.json',
      output_schema_ref: 'agents/schemas/delegation-result.schema.json',
      permission_scope: spec.permission_scope,
      risk_level: spec.risk_level,
      enabled: true,
      schema_version: '1.0.0',
    } satisfies DepartmentToolDefinition,
  ]),
);

export function getAgentTools(agentId: string, allowedToolIds: readonly string[]): Tool[] {
  const tools: Tool[] = [];
  for (const toolId of allowedToolIds) {
    const tool = DEPARTMENT_TOOLS.get(toolId);
    if (!tool) {
      throw new Error(`Agent "${agentId}" references unknown tool "${toolId}".`);
    }
    tools.push({ ...tool });
  }
  return tools;
}
