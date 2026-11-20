export type ToolCategory =
  | 'filesystem'
  | 'governance'
  | 'intelligence'
  | 'network'
  | 'deployment'
  | 'billing'
  | 'publishing'
  | 'system'
  | 'utility';

export type ToolRiskLevel = 'low' | 'medium' | 'high' | 'critical';

export interface Tool {
  id: string;
  name: string;
  description: string;
  category: ToolCategory;
  input_schema_ref: string;
  output_schema_ref: string;
  permission_scope: string;
  risk_level: ToolRiskLevel;
  enabled: boolean;
  schema_version?: string;
}
