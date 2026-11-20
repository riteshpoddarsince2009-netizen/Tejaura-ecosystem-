import type { LocalModelEntry } from '../model-registry/local-model-registry.ts';
import type { ComputeNode, HardwareFitResult } from './hardware-types.ts';

function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function cloneNode(node: ComputeNode): ComputeNode {
  return {
    ...node,
    supported_runtimes: [...node.supported_runtimes],
    installed_model_ids: [...node.installed_model_ids],
  };
}

/**
 * Deterministic, fail-closed hardware fit check.
 * Never assumes a model fits on a node without explicit verified capacity.
 */
export function checkHardwareFit(
  model: LocalModelEntry,
  node: ComputeNode | null | undefined,
): HardwareFitResult {
  if (!node) {
    return {
      fits: false,
      code: 'NODE_NOT_FOUND',
      reason: 'Target compute node is not registered.',
    };
  }

  if (!node.online) {
    return {
      fits: false,
      code: 'NODE_OFFLINE',
      reason: `Compute node "${node.node_id}" is offline.`,
      node_id: node.node_id,
    };
  }

  if (
    !isNonNegativeFinite(node.total_ram_mb) ||
    !isNonNegativeFinite(node.available_ram_mb) ||
    !isNonNegativeFinite(node.total_vram_mb) ||
    !isNonNegativeFinite(node.available_vram_mb) ||
    !isNonNegativeFinite(node.total_storage_mb) ||
    !isNonNegativeFinite(node.available_storage_mb) ||
    node.available_ram_mb > node.total_ram_mb ||
    node.available_vram_mb > node.total_vram_mb ||
    node.available_storage_mb > node.total_storage_mb
  ) {
    return {
      fits: false,
      code: 'INVALID_NODE_TELEMETRY',
      reason: `Compute node "${node.node_id}" reported invalid or inconsistent resource telemetry.`,
      node_id: node.node_id,
    };
  }

  if (!node.supported_runtimes.includes(model.runtime_type)) {
    return {
      fits: false,
      code: 'UNSUPPORTED_RUNTIME',
      reason: `Compute node "${node.node_id}" does not support runtime "${model.runtime_type}".`,
      node_id: node.node_id,
    };
  }

  const req = model.hardware_requirements;
  if (req.requires_gpu && !node.has_gpu) {
    return {
      fits: false,
      code: 'GPU_REQUIRED',
      reason: `Model "${model.model_id}" requires a GPU, but node "${node.node_id}" has no GPU.`,
      node_id: node.node_id,
    };
  }

  if (node.available_vram_mb < req.min_vram_mb) {
    return {
      fits: false,
      code: 'INSUFFICIENT_VRAM',
      reason: `Node "${node.node_id}" has ${node.available_vram_mb} MB free VRAM; model "${model.model_id}" requires ${req.min_vram_mb} MB.`,
      node_id: node.node_id,
    };
  }

  if (node.available_ram_mb < req.min_ram_mb) {
    return {
      fits: false,
      code: 'INSUFFICIENT_RAM',
      reason: `Node "${node.node_id}" has ${node.available_ram_mb} MB free RAM; model "${model.model_id}" requires ${req.min_ram_mb} MB.`,
      node_id: node.node_id,
    };
  }

  if (node.available_storage_mb < req.min_storage_mb) {
    return {
      fits: false,
      code: 'INSUFFICIENT_STORAGE',
      reason: `Node "${node.node_id}" has ${node.available_storage_mb} MB free storage; model "${model.model_id}" requires ${req.min_storage_mb} MB.`,
      node_id: node.node_id,
    };
  }

  return {
    fits: true,
    code: 'FIT_OK',
    reason: `Model "${model.model_id}" fits compute node "${node.node_id}".`,
    node_id: node.node_id,
    headroom: {
      ram_mb: node.available_ram_mb - req.min_ram_mb,
      vram_mb: node.available_vram_mb - req.min_vram_mb,
      storage_mb: node.available_storage_mb - req.min_storage_mb,
    },
  };
}

export class HardwareManager {
  private readonly nodes = new Map<string, ComputeNode>();

  constructor(initialNodes: readonly ComputeNode[] = []) {
    for (const node of initialNodes) {
      this.registerNode(node);
    }
  }

  registerNode(node: ComputeNode): void {
    if (!node.node_id || node.node_id.trim().length === 0) {
      throw new Error('Compute node must declare a non-empty node_id.');
    }
    this.nodes.set(node.node_id, cloneNode(node));
  }

  getNode(nodeId: string): ComputeNode | null {
    const found = this.nodes.get(nodeId);
    return found ? cloneNode(found) : null;
  }

  listNodes(): ComputeNode[] {
    return [...this.nodes.values()].map(cloneNode);
  }

  setNodeOnline(nodeId: string, online: boolean, seenAt = new Date().toISOString()): boolean {
    const existing = this.nodes.get(nodeId);
    if (!existing) {
      return false;
    }
    this.nodes.set(nodeId, {
      ...cloneNode(existing),
      online,
      last_seen_at: seenAt,
    });
    return true;
  }

  updateAvailableResources(
    nodeId: string,
    resources: Partial<
      Pick<
        ComputeNode,
        'available_ram_mb' | 'available_vram_mb' | 'available_storage_mb' | 'installed_model_ids'
      >
    >,
  ): boolean {
    const existing = this.nodes.get(nodeId);
    if (!existing) {
      return false;
    }
    this.nodes.set(nodeId, {
      ...cloneNode(existing),
      ...resources,
      installed_model_ids: resources.installed_model_ids
        ? [...resources.installed_model_ids]
        : [...existing.installed_model_ids],
      last_seen_at: new Date().toISOString(),
    });
    return true;
  }

  checkModelFitOnNode(model: LocalModelEntry, nodeId: string): HardwareFitResult {
    return checkHardwareFit(model, this.nodes.get(nodeId));
  }

  findBestCompatibleNode(
    model: LocalModelEntry,
  ): {
    node: ComputeNode | null;
    fit: HardwareFitResult;
    checked: HardwareFitResult[];
  } {
    if (model.node_id) {
      const fit = this.checkModelFitOnNode(model, model.node_id);
      return {
        node: fit.fits ? this.getNode(model.node_id) : null,
        fit,
        checked: [fit],
      };
    }

    const candidates = this.listNodes();
    if (candidates.length === 0) {
      const noNode: HardwareFitResult = {
        fits: false,
        code: 'NODE_NOT_FOUND',
        reason: 'No compute nodes are registered in HardwareManager.',
      };
      return { node: null, fit: noNode, checked: [noNode] };
    }

    const checked: HardwareFitResult[] = [];
    let best: { node: ComputeNode; fit: HardwareFitResult; score: number } | null = null;

    for (const node of candidates) {
      const fit = checkHardwareFit(model, node);
      checked.push(fit);
      if (fit.fits && fit.headroom) {
        const score =
          (node.location === 'local' ? 1_000_000 : 0) +
          (node.installed_model_ids.includes(model.model_id) ? 500_000 : 0) +
          fit.headroom.vram_mb +
          fit.headroom.ram_mb * 0.1;
        if (!best || score > best.score) {
          best = { node, fit, score };
        }
      }
    }

    if (best) {
      return { node: best.node, fit: best.fit, checked };
    }

    return {
      node: null,
      fit: checked[0],
      checked,
    };
  }
}
