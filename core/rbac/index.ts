export {
  ROLE_PERMISSIONS,
  RbacRoleRegistry,
  authorizeRbac,
  principalToPolicyActor,
  principalToTrustedReviewerContext,
} from './rbac-engine.ts';

export type {
  RbacBridgeContext,
  RbacCheckInput,
  RbacDecision,
  RbacPermission,
  RbacPrincipal,
} from './rbac-types.ts';
