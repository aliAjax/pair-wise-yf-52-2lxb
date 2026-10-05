import { MergeTrace, OfflineAction, OfflineBatch, ScriptVersion } from './script.reducer';

export interface MergeResult {
  version: ScriptVersion;
  traces: MergeTrace[];
}

/**
 * 将一个离线批次合并到目标版本。
 *
 * 规则：
 * - 目标版本中仍然存在且文本未被新版本改动的条目，采纳/退回/排序照常生效（trace: applied）。
 * - 目标版本中仍然存在但文本被新版本改动过的条目，旧的采纳结果作废，状态回到待确认（trace: reconfirm）。
 * - 目标版本中已被移除的条目，动作无法执行，留下未处理痕迹（trace: unprocessed）。
 * - 排序按条目 id 定位，位置索引做越界收敛；条目被移除时记为未处理。
 *
 * 本函数是纯函数：不修改传入的任何对象，失败时由调用方决定保留批次重试。
 */
export function mergeBatchIntoVersion(
  target: ScriptVersion,
  allVersions: ScriptVersion[],
  batch: OfflineBatch,
  now: number
): MergeResult {
  const traces: MergeTrace[] = [];
  let lines = target.lines.map((line) => ({ ...line }));
  let cues = target.cues.map((cue) => ({ ...cue }));

  for (const action of batch.actions) {
    // 以每条动作自身记录的基准版本为准（离线期间可能切换过草稿），批次基准仅作兜底。
    const base = allVersions.find((version) => version.id === (action.baseVersionId ?? batch.baseVersionId));
    if (action.type === 'reviewLine') {
      const idx = lines.findIndex((line) => line.id === action.payload.itemId);
      if (idx < 0) {
        traces.push(traceFor(action, 'unprocessed', 'removed', now));
        continue;
      }
      const baseLine = base?.lines.find((line) => line.id === action.payload.itemId);
      const changed = !baseLine || baseLine.text !== lines[idx].text;
      if (changed) {
        lines[idx] = { ...lines[idx], status: 'pending' };
        traces.push(traceFor(action, 'reconfirm', 'changed', now));
      } else {
        lines[idx] = { ...lines[idx], status: action.payload.decision ?? 'pending' };
        traces.push(traceFor(action, 'applied', undefined, now));
      }
    } else if (action.type === 'reviewCue') {
      const idx = cues.findIndex((cue) => cue.id === action.payload.itemId);
      if (idx < 0) {
        traces.push(traceFor(action, 'unprocessed', 'removed', now));
        continue;
      }
      const baseCue = base?.cues.find((cue) => cue.id === action.payload.itemId);
      const changed = !baseCue || baseCue.text !== cues[idx].text;
      if (changed) {
        cues[idx] = { ...cues[idx], status: 'pending' };
        traces.push(traceFor(action, 'reconfirm', 'changed', now));
      } else {
        cues[idx] = { ...cues[idx], status: action.payload.decision ?? 'pending' };
        traces.push(traceFor(action, 'applied', undefined, now));
      }
    } else if (action.type === 'reorderLines') {
      const from = lines.findIndex((line) => line.id === action.payload.itemId);
      if (from < 0) {
        traces.push(traceFor(action, 'unprocessed', 'removed', now));
        continue;
      }
      const rawTo = action.payload.to ?? from;
      const to = Math.max(0, Math.min(rawTo, lines.length - 1));
      const next = [...lines];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      lines = next;
      traces.push(traceFor(action, 'applied', undefined, now));
    }
  }

  return { version: { ...target, lines, cues }, traces };
}

function traceFor(action: OfflineAction, kind: MergeTrace['kind'], detail: string | undefined, now: number): MergeTrace {
  return {
    id: `${action.id}#trace`,
    batchId: action.batchId,
    actionId: action.id,
    kind,
    itemId: action.payload.itemId,
    detail: detail ?? kind,
    at: now
  };
}
