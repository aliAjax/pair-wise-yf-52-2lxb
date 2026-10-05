import { createReducer, on } from '@ngrx/store';
import { addVersion, activateVersion, dismissOrphan, mergeOfflineActions, reorderLines, retryMergeBatch, reviewCue, reviewLine, setOnline, toggleRehearsal } from './script.actions';
import { MergeBatch, migratePersistedState, OfflineAction, OrphanTrace, reduceBatch } from './script.merge';

export type CueDecision = 'pending' | 'accepted' | 'returned';

export interface ScriptVersion {
  id: string;
  label: string;
  playwright: string;
  note: string;
  lines: Array<{ id: string; role: string; text: string; status: 'pending' | 'accepted' | 'returned' }>;
  cues: Array<{ id: string; scene: string; text: string; status: CueDecision }>;
}

export const SCHEMA_VERSION = 2;
const STORAGE_KEY = 'yf52-script-state';

export interface ScriptState {
  schemaVersion: number;
  versions: ScriptVersion[];
  activeVersionId: string;
  rehearsalMode: boolean;
  online: boolean;
  /** 离线期间记录、尚未进入合并批次的动作 */
  offlineQueue: OfflineAction[];
  /** 合并批次历史；失败的批次保留在这里等待重试 */
  mergeBatches: MergeBatch[];
  /** 被新版本移除的条目留下的未处理痕迹 */
  orphans: OrphanTrace[];
  actionSeq: number;
  batchSeq: number;
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

function freshState(): ScriptState {
  return {
    schemaVersion: SCHEMA_VERSION,
    versions: initialVersions,
    activeVersionId: 'v12',
    rehearsalMode: false,
    online: true,
    offlineQueue: [],
    mergeBatches: [],
    orphans: [],
    actionSeq: 0,
    batchSeq: 0
  };
}

/** 旧稿升级：v1（无 schemaVersion）的本地缓存补齐离线合并所需字段后继续可用 */
function migrate(parsed: Partial<ScriptState>): ScriptState {
  return migratePersistedState(parsed, freshState(), SCHEMA_VERSION);
}

function getInitialState(): ScriptState {
  if (typeof localStorage === 'undefined') return freshState();
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? migrate(JSON.parse(saved) as Partial<ScriptState>) : freshState();
  } catch {
    return freshState();
  }
}

/** 离线时把操作记入队列，附带目标条目的原文快照，供回网后合并比对 */
function recordOffline(state: ScriptState, action: Omit<OfflineAction, 'id' | 'baseVersionId' | 'at'>): Partial<ScriptState> {
  if (state.online) return {};
  const entry: OfflineAction = {
    ...action,
    id: `a${state.actionSeq + 1}`,
    baseVersionId: state.activeVersionId,
    at: Date.now()
  };
  return { offlineQueue: [...state.offlineQueue, entry], actionSeq: state.actionSeq + 1 };
}

export const scriptReducer = createReducer(
  getInitialState(),
  on(addVersion, (state, { version }) => ({ ...state, versions: [...state.versions, version] })),
  on(activateVersion, (state, { id }) => ({ ...state, activeVersionId: id })),
  on(reviewLine, (state, { id, decision }) => {
    const active = state.versions.find((version) => version.id === state.activeVersionId);
    const line = active?.lines.find((item) => item.id === id);
    return {
      ...state,
      versions: state.versions.map((version) => version.id !== state.activeVersionId ? version : ({
        ...version,
        lines: version.lines.map((item) => item.id === id ? { ...item, status: decision } : item)
      })),
      ...recordOffline(state, { kind: 'reviewLine', targetId: id, decision, baseText: line?.text ?? '' })
    };
  }),
  on(reorderLines, (state, { from, to }) => {
    const active = state.versions.find((version) => version.id === state.activeVersionId);
    const moved = active?.lines[from];
    return {
      ...state,
      versions: state.versions.map((version) => {
        if (version.id !== state.activeVersionId || from === to) return version;
        const lines = [...version.lines];
        const [item] = lines.splice(from, 1);
        lines.splice(to, 0, item);
        return { ...version, lines };
      }),
      ...recordOffline(state, { kind: 'reorderLines', targetId: moved?.id, baseText: moved?.text ?? '', from, to })
    };
  }),
  on(reviewCue, (state, { id, decision }) => {
    const active = state.versions.find((version) => version.id === state.activeVersionId);
    const cue = active?.cues.find((item) => item.id === id);
    return {
      ...state,
      versions: state.versions.map((version) => version.id !== state.activeVersionId ? version : ({
        ...version,
        cues: version.cues.map((item) => item.id === id ? { ...item, status: decision } : item)
      })),
      ...(decision === 'pending' ? {} : recordOffline(state, { kind: 'reviewCue', targetId: id, decision, baseText: cue?.text ?? '' }))
    };
  }),
  on(toggleRehearsal, (state) => ({ ...state, rehearsalMode: !state.rehearsalMode })),
  on(setOnline, (state, { online }) => ({ ...state, online })),
  on(mergeOfflineActions, (state, { targetVersionId }) => {
    if (state.offlineQueue.length === 0) return state;
    const batch: MergeBatch = {
      id: `b${state.batchSeq + 1}`,
      targetVersionId,
      createdAt: Date.now(),
      status: 'merging',
      actions: state.offlineQueue,
      records: []
    };
    const result = reduceBatch(state.versions, state.orphans, batch);
    return {
      ...state,
      versions: result.versions,
      orphans: result.orphans,
      // 动作一旦进入批次就由批次承载，队列清空；失败时靠批次重试，不会重复记录
      offlineQueue: [],
      mergeBatches: [...state.mergeBatches, result.batch],
      batchSeq: state.batchSeq + 1
    };
  }),
  on(retryMergeBatch, (state, { batchId }) => {
    const batch = state.mergeBatches.find((item) => item.id === batchId);
    if (!batch || batch.status === 'merged') return state;
    const result = reduceBatch(state.versions, state.orphans, batch);
    return {
      ...state,
      versions: result.versions,
      orphans: result.orphans,
      mergeBatches: state.mergeBatches.map((item) => (item.id === batchId ? result.batch : item))
    };
  }),
  on(dismissOrphan, (state, { id }) => ({ ...state, orphans: state.orphans.filter((orphan) => orphan.id !== id) }))
);
