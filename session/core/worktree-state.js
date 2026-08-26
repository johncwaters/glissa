"use strict";

/**
 * @typedef {"none" | "pending-review" | "merging" | "parked" | "merged"} MergeStatus
 * @typedef {{ reason?: string | null, conflicts?: string[] }} MergeStatusDetail
 * @typedef {{ mergeStatus: MergeStatus, mergeReason: string | null, mergeConflicts: string[] }} MergeState
 */

/**
 * @param {MergeStatus} mergeStatus
 * @param {MergeStatusDetail} [detail]
 * @returns {MergeState}
 */
function projectMergeState(mergeStatus, detail = {}) {
  if (mergeStatus !== "parked") {
    return { mergeStatus, mergeReason: null, mergeConflicts: [] };
  }
  return {
    mergeStatus,
    mergeReason: detail.reason || null,
    mergeConflicts: Array.isArray(detail.conflicts) ? detail.conflicts : [],
  };
}

module.exports = { projectMergeState };
