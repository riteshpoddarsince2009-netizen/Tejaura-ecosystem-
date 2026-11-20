export type AgentStatus = 'active' | 'paused' | 'disabled' | 'retired';

/**
 * Agents may only hold autonomy levels L0 through L3.
 * L4 (owner_exclusive) is permanently reserved for the human owner.
 */
export type AgentPermittedAutonomyLevel = 'L0' | 'L1' | 'L2' | 'L3';

export interface Agent {
  id: string;
  name: string;
  department: string;
  role: string;
  description: string;
  status: AgentStatus;
  enabled: boolean;
  permitted_autonomy_level: AgentPermittedAutonomyLevel;
  allowed_tool_ids: string[];
  preferred_model_ids: string[];
  created_at: string;
  schema_version?: string;
}
