import { createReducer, on } from '@ngrx/store';
import { addVersion, activateVersion, mergeOfflineBatch, reorderLines, retryOfflineBatch, reviewCue, reviewLine, setOnline, toggleRehearsal } from './script.actions';
import { mergeBatchIntoVersion } from './merge-logic';

export type CueDecision = 'pending' | 'accepted' | 'returned';

export interface ScriptVersion {
  id: string;
  label: string;
  playwright: string;
  note: string;
  /** 新版本基于哪个旧版本发布，用于离线合并时比对条目文本是否被改动。 */
  basedOn?: string;
  lines: Array<{ id: string; role: string; text: string; status: 'pending' | 'accepted' | 'returned' }>;
  cues: Array<{ id: string; scene: string; text: string; status: CueDecision }>;
}

export type OfflineActionType = 'reviewLine' | 'reviewCue' | 'reorderLines';

export interface OfflineAction {
  id: string;
  batchId: string;
  type: OfflineActionType;
  /** 离线动作发生时所基于的草稿版本，合并时用它比对文本是否被新版本改动。 */
  baseVersionId: string;
  payload: { itemId?: string; decision?: CueDecision; to?: number };
  createdAt: number;
}

export interface OfflineBatch {
  id: string;
  createdAt: number;
  baseVersionId: string;
  /** pending: 待联网合并；merged: 已合并（重复合并不会再产生记录）；failed: 合并中途失败，保留批次可重试。 */
  status: 'pending' | 'merged' | 'failed';
  actions: OfflineAction[];
  mergedAt?: number;
  targetVersionId?: string;
  error?: string;
}

export interface MergeTrace {
  id: string;
  batchId: string;
  actionId: string;
  /** applied: 已采纳；reconfirm: 条目被新版本改动，旧结果作废需重新确认；unprocessed: 条目被移除，动作未处理。 */
  kind: 'applied' | 'reconfirm' | 'unprocessed';
  itemId?: string;
  detail: string;
  at: number;
}

export interface ScriptState {
  versions: ScriptVersion[];
  activeVersionId: string;
  rehearsalMode: boolean;
  online: boolean;
  offlineBatches: OfflineBatch[];
  mergeTraces: MergeTrace[];
}

const initialVersions: ScriptVersion[] = [
  {
    id: 'v12', label: '排练稿 v12', playwright: '林编剧', note: '重写第三场父女冲突，舞台灯光提示延后2拍。',
    lines: [
      { id: 'l1', role: '周岚', text: '你每次都说等明天，可舞台不会等我们。', status: 'pending' },
      { id: 'l2', role: '周野', text: '那就让灯灭吧，我早已背熟黑暗。', status: 'pending' }
    ],
    cues: [
      { id: 'c1', scene: '第三场', text: '侧灯收至30%，雨声渐入', status: 'pending' },
      { id: 'c2', scene: '第三场', text: '周野坐到舞台左前区，保留两拍静默', status: 'accepted' }
    ]
  },
  {
    id: 'v13', label: '导演修订 v13', playwright: '林编剧', note: '调整周岚结论，加入一次性追光变化。',
    lines: [
      { id: 'l1', role: '周岚', text: '你总说明天，但今晚我们必须把话说完。', status: 'pending' },
      { id: 'l3', role: '周岚', text: '看着灯，再说一次你为什么回来。', status: 'pending' }
    ],
    cues: [{ id: 'c3', scene: '第三场', text: '追光由冷白切换至琥珀，等待雨声下落', status: 'pending' }]
  }
];

function fallbackState(): ScriptState {
  return { versions: initialVersions, activeVersionId: 'v12', rehearsalMode: false, online: true, offlineBatches: [], mergeTraces: [] };
}

function getInitialState(): ScriptState {
  if (typeof localStorage === 'undefined') return fallbackState();
  const savedRaw = localStorage.getItem('yf52-script-state');
  if (!savedRaw) return fallbackState();
  const saved = JSON.parse(savedRaw) as Partial<ScriptState>;
  return {
    ...fallbackState(),
    ...saved,
    offlineBatches: saved.offlineBatches ?? [],
    mergeTraces: saved.mergeTraces ?? []
  };
}

/** 离线时把动作记入当前待合并批次；没有待合并批次则新建一个。 */
function recordAction(state: ScriptState, action: Omit<OfflineAction, 'id' | 'batchId' | 'createdAt'>): OfflineBatch[] {
  const batches = state.offlineBatches.map((batch) => ({ ...batch, actions: [...batch.actions] }));
  let batch = batches.find((item) => item.status === 'pending');
  if (!batch) {
    batch = {
      id: `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
      createdAt: Date.now(),
      baseVersionId: state.activeVersionId,
      status: 'pending',
      actions: []
    };
    batches.push(batch);
  }
  batch.actions.push({
    ...action,
    id: `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    batchId: batch.id,
    createdAt: Date.now()
  });
  return batches;
}

function markBatch(state: ScriptState, batchId: string, patch: Partial<OfflineBatch>): OfflineBatch[] {
  return state.offlineBatches.map((batch) => (batch.id === batchId ? { ...batch, ...patch } : batch));
}

/** 合并批次；已合并的批次直接返回原状态，保证重复合并不会产生两份记录。 */
function applyMerge(state: ScriptState, batchId: string, targetVersionId: string): ScriptState {
  const batch = state.offlineBatches.find((item) => item.id === batchId);
  if (!batch || batch.status === 'merged') return state;
  const target = state.versions.find((version) => version.id === targetVersionId);
  if (!target) {
    return { ...state, offlineBatches: markBatch(state, batchId, { status: 'failed', error: 'target-not-found' }) };
  }
  try {
    const { version: mergedVersion, traces } = mergeBatchIntoVersion(target, state.versions, batch, Date.now());
    return {
      ...state,
      versions: state.versions.map((version) => (version.id === targetVersionId ? mergedVersion : version)),
      offlineBatches: markBatch(state, batchId, { status: 'merged', mergedAt: Date.now(), targetVersionId, error: undefined }),
      mergeTraces: [...state.mergeTraces, ...traces]
    };
  } catch (error) {
    // 合并中途失败：保留批次为 failed，不写痕迹，联网后可重试。
    return {
      ...state,
      offlineBatches: markBatch(state, batchId, {
        status: 'failed',
        error: error instanceof Error ? error.message : 'merge-failed'
      })
    };
  }
}

export const scriptReducer = createReducer(
  getInitialState(),
  on(addVersion, (state, { version }) => ({ ...state, versions: [...state.versions, version] })),
  on(activateVersion, (state, { id }) => ({ ...state, activeVersionId: id })),
  on(reviewLine, (state, { id, decision }) => {
    const versions = state.versions.map((version) => version.id !== state.activeVersionId ? version : ({
      ...version,
      lines: version.lines.map((line) => line.id === id ? { ...line, status: decision } : line)
    }));
    if (state.online) return { ...state, versions };
    return {
      ...state,
      versions,
      offlineBatches: recordAction(state, { type: 'reviewLine', baseVersionId: state.activeVersionId, payload: { itemId: id, decision } })
    };
  }),
  on(reorderLines, (state, { itemId, from, to }) => {
    const versions = state.versions.map((version) => {
      if (version.id !== state.activeVersionId || from === to) return version;
      const lines = [...version.lines];
      const [moved] = lines.splice(from, 1);
      lines.splice(to, 0, moved);
      return { ...version, lines };
    });
    if (state.online) return { ...state, versions };
    return {
      ...state,
      versions,
      offlineBatches: recordAction(state, { type: 'reorderLines', baseVersionId: state.activeVersionId, payload: { itemId, to } })
    };
  }),
  on(reviewCue, (state, { id, decision }) => {
    const versions = state.versions.map((version) => version.id !== state.activeVersionId ? version : ({
      ...version,
      cues: version.cues.map((cue) => cue.id === id ? { ...cue, status: decision } : cue)
    }));
    if (state.online) return { ...state, versions };
    return {
      ...state,
      versions,
      offlineBatches: recordAction(state, { type: 'reviewCue', baseVersionId: state.activeVersionId, payload: { itemId: id, decision } })
    };
  }),
  on(mergeOfflineBatch, (state, { batchId, targetVersionId }) => applyMerge(state, batchId, targetVersionId)),
  on(retryOfflineBatch, (state, { batchId, targetVersionId }) => applyMerge(state, batchId, targetVersionId)),
  on(toggleRehearsal, (state) => ({ ...state, rehearsalMode: !state.rehearsalMode })),
  on(setOnline, (state, { online }) => ({ ...state, online }))
);
