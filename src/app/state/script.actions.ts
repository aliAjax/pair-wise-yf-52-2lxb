import { createAction, props } from '@ngrx/store';
import { CueDecision, ScriptVersion } from './script.reducer';

export const addVersion = createAction('[Script] Add Version', props<{ version: ScriptVersion }>());
export const activateVersion = createAction('[Script] Activate Version', props<{ id: string }>());
export const reviewLine = createAction('[Script] Review Line', props<{ id: string; decision: 'accepted' | 'returned' }>());
export const reorderLines = createAction('[Script] Reorder Lines', props<{ from: number; to: number }>());
export const reviewCue = createAction('[Script] Review Cue', props<{ id: string; decision: CueDecision }>());
export const toggleRehearsal = createAction('[Script] Toggle Rehearsal');
export const setOnline = createAction('[Script] Set Online', props<{ online: boolean }>());
export const mergeOfflineActions = createAction('[Script] Merge Offline Actions', props<{ targetVersionId: string }>());
export const retryMergeBatch = createAction('[Script] Retry Merge Batch', props<{ batchId: string }>());
export const dismissOrphan = createAction('[Script] Dismiss Orphan', props<{ id: string }>());
