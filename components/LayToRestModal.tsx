"use client";

import React from "react";

export interface LayToRestModalProps {
  /** Skeleton being laid to rest, shown in the heading for context. */
  skeletonId: string;
  /** Role of the Skeleton (e.g. "bonesetter"); optional, for the subtitle. */
  role?: string;
  /** Keep the Skeleton's commits and abandon the task. */
  onKeep: () => void;
  /** Discard the Skeleton's work entirely. */
  onDiscard: () => void;
  /** Close the modal without laying the Skeleton to rest. */
  onCancel: () => void;
}

/**
 * Confirmation dialog for laying a Skeleton to rest. The user must choose what
 * happens to the Skeleton's work (keep its commits or discard it) or cancel.
 * The choices map straight to the two recorded lay-to-rest outcomes.
 */
export function LayToRestModal({
  skeletonId,
  role,
  onKeep,
  onDiscard,
  onCancel,
}: LayToRestModalProps) {
  return (
    <div
      data-testid="lay-to-rest-modal"
      data-ui-element="lay-to-rest-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lay-to-rest-title"
      className="crypt-panel border-rose-500/45 bg-rose-950/30 p-4 space-y-3"
    >
      <div className="space-y-1">
        <h3
          id="lay-to-rest-title"
          className="text-sm font-bold text-rose-200 uppercase tracking-wider"
        >
          Lay this Skeleton to rest?
        </h3>
        <p className="text-xs text-parchment">
          {role ? `${role} ` : "Skeleton "}
          {skeletonId} will stop and its task will become abandoned. Choose what
          to do with its work.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="lay-to-rest-keep"
          onClick={onKeep}
          className="crypt-btn-ghost px-3 py-1.5 text-xs rounded"
        >
          Keep its commits
        </button>
        <button
          type="button"
          data-testid="lay-to-rest-discard"
          onClick={onDiscard}
          className="crypt-btn-danger px-3 py-1.5 text-xs rounded"
        >
          Discard its work
        </button>
        <button
          type="button"
          data-testid="lay-to-rest-cancel"
          onClick={onCancel}
          className="crypt-btn-ghost px-3 py-1.5 text-xs rounded text-ash"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

export default LayToRestModal;