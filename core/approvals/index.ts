export {
  ApprovalService,
  InMemoryApprovalStore,
  toContractApproval,
} from './approval-service.ts';

export type {
  ApprovalOperationResult,
  ApprovalRecord,
  ApprovalServiceOptions,
  ApprovalStore,
  CreateApprovalRequestInput,
  DecideApprovalInput,
  TrustedReviewerContext,
  VerifyAndConsumeApprovalInput,
} from './approval-types.ts';
