import { createAction, props } from '@ngrx/store';
import { CueDecision, ScriptVersion } from './script.reducer';

export const addVersion = createAction('[Script] Add Version', props<{ version: ScriptVersion }>());
export const activateVersion = createAction('[Script] Activate Version', props<{ id: string }>());
export const reviewLine = createAction('[Script] Review Line', props<{ id: string; decision: 'accepted' | 'returned' }>());
export const reorderLines = createAction('[Script] Reorder Lines', props<{ itemId: string; from: number; to: number }>());
export const reviewCue = createAction('[Script] Review Cue', props<{ id: string; decision: CueDecision }>());
export const toggleRehearsal = createAction('[Script] Toggle Rehearsal');
export const setOnline = createAction('[Script] Set Online', props<{ online: boolean }>());
export const mergeOfflineBatch = createAction('[Script] Merge Offline Batch', props<{ batchId: string; targetVersionId: string }>());
export const retryOfflineBatch = createAction('[Script] Retry Offline Batch', props<{ batchId: string; targetVersionId: string }>());
