import type { ScriptVersion } from './script.reducer';

/** 离线期间被记录下来的单条操作 */
export interface OfflineAction {
  id: string;
  kind: 'reviewLine' | 'reviewCue' | 'reorderLines';
  /** 操作发生时基于的版本 */
  baseVersionId: string;
  /** 台词/提示 id；reorderLines 时为被移动的台词 id */
  targetId?: string;
  decision?: 'accepted' | 'returned';
  /** 操作发生时目标条目的原文快照，用于判断新版本是否改动过 */
  baseText?: string;
  from?: number;
  to?: number;
  at: number;
}

export type MergeOutcome = 'applied' | 'needsReconfirm' | 'orphaned';

export interface MergeRecord {
  actionId: string;
  kind: OfflineAction['kind'];
  targetId: string;
  outcome: MergeOutcome;
  detail: string;
}

/** 被新版本移除的条目留下的未处理痕迹 */
export interface OrphanTrace {
  id: string;
  actionId: string;
  kind: OfflineAction['kind'];
  targetId: string;
  snapshotText: string;
  note: string;
  at: number;
}

export interface MergeBatch {
  id: string;
  targetVersionId: string;
  createdAt: number;
  status: 'merging' | 'merged' | 'failed';
  actions: OfflineAction[];
  records: MergeRecord[];
  error?: string;
}

export interface ApplyResult {
  versions: ScriptVersion[];
  record: MergeRecord;
  orphan?: OrphanTrace;
}

const KIND_LABEL: Record<OfflineAction['kind'], string> = {
  reviewLine: '台词审阅',
  reviewCue: '舞台提示审阅',
  reorderLines: '台词排序'
};

function updateVersion(versions: ScriptVersion[], versionId: string, update: (version: ScriptVersion) => ScriptVersion): ScriptVersion[] {
  return versions.map((version) => (version.id === versionId ? update(version) : version));
}

function orphanOf(action: OfflineAction, detail: string): ApplyResult['orphan'] {
  return {
    id: `orphan-${action.id}`,
    actionId: action.id,
    kind: action.kind,
    targetId: action.targetId ?? '',
    snapshotText: action.baseText ?? '',
    note: detail,
    at: action.at
  };
}

/**
 * 把一条离线动作合并进目标版本。纯函数：
 * - 目标文本与快照一致 → 直接应用离线时的决定；
 * - 目标文本被新版本改动 → 重置为 pending，旧的采纳结果作废，需重新确认；
 * - 目标条目已被新版本移除 → 不改动版本，留下未处理痕迹；
 * - 无法识别的动作（例如旧稿里的脏数据）→ 抛错，由批次层捕获并保留重试。
 */
export function applyOfflineAction(versions: ScriptVersion[], targetVersionId: string, action: OfflineAction): ApplyResult {
  const target = versions.find((version) => version.id === targetVersionId);
  if (!target) throw new Error(`目标版本 ${targetVersionId} 不存在`);
  if (!(action.kind in KIND_LABEL)) throw new Error(`无法识别的离线动作类型：${String((action as OfflineAction).kind)}（${action.id}）`);

  if (action.kind === 'reorderLines') {
    const index = target.lines.findIndex((line) => line.id === action.targetId);
    if (index < 0) {
      const detail = `台词排序未生效：台词 ${action.targetId} 已在新版本中移除`;
      return { versions, record: { actionId: action.id, kind: action.kind, targetId: action.targetId ?? '', outcome: 'orphaned', detail }, orphan: orphanOf(action, detail) };
    }
    const to = Math.max(0, Math.min(action.to ?? index, target.lines.length - 1));
    const next = updateVersion(versions, targetVersionId, (version) => {
      const lines = [...version.lines];
      const [moved] = lines.splice(index, 1);
      lines.splice(to, 0, moved);
      return { ...version, lines };
    });
    return { versions: next, record: { actionId: action.id, kind: action.kind, targetId: action.targetId ?? '', outcome: 'applied', detail: `已应用：台词「${target.lines[index].text}」移动到第 ${to + 1} 位` } };
  }

  const isLine = action.kind === 'reviewLine';
  const items: Array<{ id: string; text: string }> = isLine ? target.lines : target.cues;
  const found = items.find((item) => item.id === action.targetId);
  const kindLabel = isLine ? '台词' : '舞台提示';
  if (!found) {
    const detail = `${kindLabel}审阅未生效：${kindLabel} ${action.targetId} 已在新版本中移除`;
    return { versions, record: { actionId: action.id, kind: action.kind, targetId: action.targetId ?? '', outcome: 'orphaned', detail }, orphan: orphanOf(action, detail) };
  }
  const setStatus = (version: ScriptVersion, status: 'pending' | 'accepted' | 'returned'): ScriptVersion =>
    isLine
      ? { ...version, lines: version.lines.map((item) => (item.id === action.targetId ? { ...item, status } : item)) }
      : { ...version, cues: version.cues.map((item) => (item.id === action.targetId ? { ...item, status } : item)) };
  if (found.text !== (action.baseText ?? '')) {
    const next = updateVersion(versions, targetVersionId, (version) => setStatus(version, 'pending'));
    return { versions: next, record: { actionId: action.id, kind: action.kind, targetId: action.targetId ?? '', outcome: 'needsReconfirm', detail: `需重新确认：${kindLabel}「${found.text}」已被新版本改动，离线时的${action.decision === 'accepted' ? '采纳' : '退回'}结果作废` } };
  }
  const decision = action.decision ?? 'pending';
  const next = updateVersion(versions, targetVersionId, (version) => setStatus(version, decision));
  return { versions: next, record: { actionId: action.id, kind: action.kind, targetId: action.targetId ?? '', outcome: 'applied', detail: `已应用：${kindLabel}「${found.text}」${decision === 'accepted' ? '采纳' : '退回'}` } };
}

/**
 * 处理一个合并批次中尚未产生记录的动作。
 * 幂等：已有记录的动作直接跳过，同一批动作重复合并不会出现两份记录；
 * 可重试：任一动作抛错时保留已产生的记录，批次标记 failed，剩余动作留待重试。
 */
export function reduceBatch(versions: ScriptVersion[], orphans: OrphanTrace[], batch: MergeBatch): { versions: ScriptVersion[]; orphans: OrphanTrace[]; batch: MergeBatch } {
  let records = batch.records;
  for (const action of batch.actions) {
    if (records.some((record) => record.actionId === action.id)) continue;
    try {
      const result = applyOfflineAction(versions, batch.targetVersionId, action);
      versions = result.versions;
      records = [...records, result.record];
      if (result.orphan && !orphans.some((orphan) => orphan.actionId === action.id)) {
        orphans = [...orphans, result.orphan];
      }
    } catch (error) {
      const failed: MergeBatch = { ...batch, records, status: 'failed', error: error instanceof Error ? error.message : String(error) };
      return { versions, orphans, batch: failed };
    }
  }
  return { versions, orphans, batch: { ...batch, records, status: 'merged', error: undefined } };
}

/**
 * 旧稿升级：把本地缓存的旧结构合并到当前结构的默认值上，
 * 缺失的新字段（离线队列、合并批次、痕迹等）取默认值，已有数据原样保留。
 */
export function migratePersistedState<T extends object>(parsed: Partial<T>, fallback: T, schemaVersion: number): T {
  return { ...fallback, ...parsed, schemaVersion };
}
