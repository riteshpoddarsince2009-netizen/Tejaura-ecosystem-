import type {
  Agent,
  AgentPermittedAutonomyLevel,
  Tool,
} from '../contracts/types/index.ts';

export const STAGE46_DEPARTMENTS = [
  'executive',
  'engineering',
  'design',
  'seo',
  'content',
  'customer_support',
  'analytics',
  'security',
  'quality_assurance',
  'research',
] as const;

export type Stage46Department = (typeof STAGE46_DEPARTMENTS)[number];

export type AgentRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface DepartmentAgentDefinition {
  id: string;
  name: string;
  department: Stage46Department;
  role: string;
  description: string;
  capabilities: string[];
  allowed_actions: string[];
  allowed_tool_ids: string[];
  scopes: string[];
  preferred_model_ids: string[];
  permitted_autonomy_level: AgentPermittedAutonomyLevel;
  input_schema: string;
  output_schema: string;
  timeout_ms: number;
  max_retries: number;
  max_delegation_depth: number;
  max_children: number;
  allowed_delegate_ids: string[];
  risk_level: AgentRiskLevel;
  requires_model: boolean;
}

export interface DepartmentToolDefinition extends Tool {
  id: string;
}

export function toContractAgent(
  definition: DepartmentAgentDefinition,
  createdAt: string,
): Agent {
  return {
    id: definition.id,
    name: definition.name,
    department: definition.department,
    role: definition.role,
    description: definition.description,
    status: 'active',
    enabled: true,
    permitted_autonomy_level: definition.permitted_autonomy_level,
    allowed_tool_ids: [...definition.allowed_tool_ids],
    preferred_model_ids: [...definition.preferred_model_ids],
    created_at: createdAt,
    schema_version: '1.0.0',
  };
}
