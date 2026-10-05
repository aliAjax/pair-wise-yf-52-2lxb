import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatChipsModule } from '@angular/material/chips';
import { MatIconModule } from '@angular/material/icon';
import { MatTabsModule } from '@angular/material/tabs';
import { MatToolbarModule } from '@angular/material/toolbar';
import { Store } from '@ngrx/store';
import { TranslocoModule } from '@jsverse/transloco';
import { Subscription, take } from 'rxjs';
import { activateVersion, addVersion, mergeOfflineBatch, reorderLines, reviewCue, reviewLine, setOnline, toggleRehearsal } from './state/script.actions';
import { ScriptState, ScriptVersion } from './state/script.reducer';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, DragDropModule, MatToolbarModule, MatButtonModule, MatCardModule, MatTabsModule, MatChipsModule, MatIconModule, TranslocoModule],
  template: `
    <mat-toolbar color="primary" class="topbar">
      <span>{{ 'title' | transloco }}</span>
      <span class="spacer"></span>
      <button mat-stroked-button (click)="toggleOnline()">
        {{ ((state$ | async)?.online ? 'online' : 'offline') | transloco }}
      </button>
      <button mat-flat-button color="accent" (click)="toggleRehearsal()">
        {{ ((state$ | async)?.rehearsalMode ? 'normalMode' : 'rehearsalMode') | transloco }}
      </button>
    </mat-toolbar>

    <main [class.rehearsal]="(state$ | async)?.rehearsalMode">
      <section class="summary">
        <mat-card>
          <mat-card-title>版本控制</mat-card-title>
          <p>编剧提交后由舞台监督逐条采纳，未确认内容不会进入排练版本。</p>
          <div class="chips">
            <button mat-stroked-button *ngFor="let version of (state$ | async)?.versions" [color]="version.id === (state$ | async)?.activeVersionId ? 'primary' : ''" (click)="activate(version.id)">
              {{ version.label }} · {{ version.playwright }}
            </button>
            <button mat-flat-button color="primary" (click)="createDraft()">新增导演修订</button>
            <button mat-flat-button color="accent" (click)="publishNewVersion()">模拟编剧交稿</button>
          </div>
        </mat-card>
      </section>

      <section *ngIf="(state$ | async) as state" class="merge-panel">
        <mat-card *ngIf="state.online && state.offlineBatches.length" class="merge">
          <mat-card-title>离线改动合并</mat-card-title>
          <p>断网期间舞台监督的采纳、退回与顺序调整按批次保留；联网后合并到编剧新版本，被改动的台词需重新确认，被移除的条目留下未处理痕迹。</p>
          <div *ngFor="let batch of state.offlineBatches" class="batch">
            <div class="batch-head">
              <mat-chip [color]="batch.status === 'merged' ? 'accent' : batch.status === 'failed' ? 'warn' : 'primary'" selected>{{ batch.status }}</mat-chip>
              <span class="batch-meta">{{ batch.actions.length }} 项动作 · 草稿 {{ batch.baseVersionId }}<span *ngIf="batch.targetVersionId"> → {{ batch.targetVersionId }}</span></span>
              <button mat-button color="primary" *ngIf="batch.status !== 'merged'" (click)="mergeBatch(batch.id)">合并到最新版本</button>
            </div>
            <p class="batch-error" *ngIf="batch.status === 'failed'">合并失败（{{ batch.error }}）：批次已保留，可重新合并重试。</p>
          </div>
          <div class="traces" *ngIf="state.mergeTraces.length">
            <h4>合并痕迹</h4>
            <div *ngFor="let trace of state.mergeTraces" class="trace" [class]="trace.kind">
              <b>{{ trace.kind }}</b> · {{ trace.itemId }} · {{ trace.detail }}
            </div>
          </div>
        </mat-card>
      </section>

      <section *ngIf="activeVersion$ | async as activeVersion" class="workspace">
        <mat-card class="script">
          <mat-card-title>{{ activeVersion.label }}</mat-card-title>
          <mat-card-subtitle>{{ activeVersion.note }}</mat-card-subtitle>
          <mat-tab-group>
            <mat-tab label="角色台词">
              <div cdkDropList (cdkDropListDropped)="dropLine($event)"><article class="line" cdkDrag *ngFor="let line of activeVersion.lines">
                <div><b>{{ line.role }}</b><p>{{ line.text }}</p><span class="status" [class.ok]="line.status === 'accepted'">{{ line.status }}</span></div>
                <div>
                  <button mat-button color="primary" (click)="reviewLine(line.id, 'accepted')">采纳</button>
                  <button mat-button color="warn" (click)="reviewLine(line.id, 'returned')">退回</button>
                </div>
              </article></div>
            </mat-tab>
            <mat-tab label="舞台提示">
              <article class="line" *ngFor="let cue of activeVersion.cues">
                <div><b>{{ cue.scene }}</b><p>{{ cue.text }}</p><span class="status" [class.ok]="cue.status === 'accepted'">{{ cue.status }}</span></div>
                <div>
                  <button mat-button color="primary" (click)="reviewCue(cue.id, 'accepted')">采纳</button>
                  <button mat-button color="warn" (click)="reviewCue(cue.id, 'returned')">退回</button>
                </div>
              </article>
            </mat-tab>
          </mat-tab-group>
        </mat-card>

        <mat-card class="compare">
          <mat-card-title>版本对比</mat-card-title>
          <p class="version-name">基准 v12 → {{ activeVersion.label }}</p>
          <div class="diff"><b>新增</b><span>{{ activeVersion.lines.length }} 条台词 / {{ activeVersion.cues.length }} 条提示</span></div>
          <div class="diff"><b>待确认</b><span>{{ pendingCount(activeVersion) }} 项</span></div>
          <div class="diff warn"><b>规则</b><span>台词退回后会自动标记为不可进入正式排练</span></div>
        </mat-card>
      </section>

      <aside class="offline" *ngIf="!(state$ | async)?.online">网络不可用，{{ pendingActionCount((state$ | async)!) }} 项离线修改已写入本地缓存；恢复网络后自动合并，被新版本改动的台词需重新确认。</aside>
    </main>
  `,
  styles: [`
    .topbar { position: sticky; top: 0; z-index: 4; }
    .spacer { flex: 1; }
    main { max-width: 1180px; margin: 24px auto; padding: 0 18px 48px; }
    main.rehearsal { max-width: 860px; background: #111827; color: #f9fafb; margin-top: 0; }
    main.rehearsal .script, main.rehearsal .compare, main.rehearsal .summary { opacity: .92; }
    .summary { margin-bottom: 18px; }
    .chips { display: flex; gap: 10px; flex-wrap: wrap; margin-top: 16px; }
    .workspace { display: grid; grid-template-columns: minmax(0, 2fr) minmax(280px, 1fr); gap: 18px; }
    .line { cursor: grab; display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 16px 0; border-bottom: 1px solid #e5e7eb; }
    .line p { margin: 8px 0; font-size: 17px; line-height: 1.6; }
    .status { font-size: 12px; color: #b45309; }
    .status.ok { color: #15803d; }
    .version-name { padding: 12px; background: #f3f4f6; border-radius: 8px; }
    .diff { display: flex; justify-content: space-between; border-bottom: 1px solid #e5e7eb; padding: 14px 0; }
    .diff.warn b { color: #b45309; }
    .offline { position: fixed; right: 18px; bottom: 18px; padding: 14px 18px; color: #fff; background: #b45309; border-radius: 10px; box-shadow: 0 8px 30px #0003; }
    .merge-panel { margin-bottom: 18px; }
    .batch { padding: 12px 0; border-bottom: 1px solid #e5e7eb; }
    .batch-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    .batch-meta { color: #6b7280; font-size: 13px; }
    .batch-error { color: #b45309; margin: 8px 0 0; }
    .traces { margin-top: 12px; }
    .traces h4 { margin: 8px 0; }
    .trace { font-size: 13px; padding: 6px 10px; border-radius: 6px; margin-bottom: 4px; }
    .trace.applied { background: #ecfdf5; color: #065f46; }
    .trace.reconfirm { background: #fffbeb; color: #92400e; }
    .trace.unprocessed { background: #fef2f2; color: #991b1b; }
    @media (max-width: 820px) { .workspace { grid-template-columns: 1fr; } .line { align-items: flex-start; } }
  `]
})
export class AppComponent implements OnInit, OnDestroy {
  readonly state$ = this.store.select('script');
  readonly activeVersion$ = this.store.select((state) => {
    const script = state.script as ScriptState;
    return script.versions.find((item) => item.id === script.activeVersionId) ?? script.versions[0];
  });
  private subscription?: Subscription;
  private onlineHandler = () => {
    this.store.dispatch(setOnline({ online: true }));
    this.autoMerge();
  };
  private offlineHandler = () => this.store.dispatch(setOnline({ online: false }));

  constructor(private readonly store: Store<{ script: ScriptState }>) {}

  ngOnInit() {
    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
    this.subscription = this.state$.subscribe((state) => localStorage.setItem('yf52-script-state', JSON.stringify(state)));
  }

  ngOnDestroy() {
    window.removeEventListener('online', this.onlineHandler);
    window.removeEventListener('offline', this.offlineHandler);
    this.subscription?.unsubscribe();
  }

  activate(id: string) { this.store.dispatch(activateVersion({ id })); }
  toggleRehearsal() { this.store.dispatch(toggleRehearsal()); }
  setOnline(online: boolean) { this.store.dispatch(setOnline({ online })); }
  toggleOnline() {
    this.state$.pipe(take(1)).subscribe((state) => {
      const next = !state.online;
      this.setOnline(next);
      if (next) this.autoMerge();
    });
  }
  reviewLine(id: string, decision: 'accepted' | 'returned') { this.store.dispatch(reviewLine({ id, decision })); }
  dropLine(event: CdkDragDrop<unknown>) {
    if (event.previousIndex === event.currentIndex) return;
    this.activeVersion$.pipe(take(1)).subscribe((version) => {
      const itemId = version.lines[event.previousIndex]?.id;
      if (itemId) this.store.dispatch(reorderLines({ itemId, from: event.previousIndex, to: event.currentIndex }));
    });
  }
  reviewCue(id: string, decision: 'accepted' | 'returned') { this.store.dispatch(reviewCue({ id, decision })); }
  pendingCount(version: ScriptVersion) { return version.lines.filter((item) => item.status === 'pending').length + version.cues.filter((item) => item.status === 'pending').length; }
  pendingActionCount(state: ScriptState): number {
    return state.offlineBatches
      .filter((batch) => batch.status !== 'merged')
      .reduce((sum, batch) => sum + batch.actions.length, 0);
  }
  /** 联网后把所有待合并/失败批次合并到最新版本；批次已合并时 reducer 直接跳过，重复合并不会产生两份记录。 */
  autoMerge() {
    this.state$.pipe(take(1)).subscribe((state) => {
      const target = state.versions[state.versions.length - 1];
      state.offlineBatches
        .filter((batch) => batch.status === 'pending' || batch.status === 'failed')
        .forEach((batch) => this.store.dispatch(mergeOfflineBatch({ batchId: batch.id, targetVersionId: target.id })));
    });
  }
  mergeBatch(batchId: string) {
    this.state$.pipe(take(1)).subscribe((state) => {
      const target = state.versions[state.versions.length - 1];
      this.store.dispatch(mergeOfflineBatch({ batchId, targetVersionId: target.id }));
    });
  }
  /** 模拟编剧在线交稿：基于当前版本生成新版本，首条台词与首条提示被改动，末条台词被移除，并新增一条台词。 */
  publishNewVersion() {
    this.activeVersion$.pipe(take(1)).subscribe((base) => {
      const id = `v${Date.now().toString().slice(-4)}`;
      const changedLines = base.lines.map((line, index) => index === 0 ? { ...line, text: `${line.text}（编剧修订）`, status: 'pending' as const } : line);
      const keptLines = changedLines.length > 1 ? changedLines.slice(0, -1) : changedLines;
      const changedCues = base.cues.map((cue, index) => index === 0 ? { ...cue, text: `${cue.text}（编剧修订）` } : cue);
      const version: ScriptVersion = {
        id,
        label: `编剧交稿 ${id}`,
        playwright: '林编剧',
        note: `基于 ${base.label} 的新版本：首条台词与首条提示有改动，末条台词被移除。`,
        basedOn: base.id,
        lines: [...keptLines, { id: `${id}-l-new`, role: base.lines[0]?.role ?? '周岚', text: '灯亮之前，我们把没说完的话说完。', status: 'pending' }],
        cues: changedCues
      };
      this.store.dispatch(addVersion({ version }));
      this.store.dispatch(activateVersion({ id }));
    });
  }
  createDraft() {
    const id = `v${Date.now().toString().slice(-4)}`;
    const version: ScriptVersion = {
      id,
      label: `导演修订 ${id}`,
      playwright: '本地草稿',
      note: '断网期间创建的修订，等待与编剧版本合并。',
      lines: [{ id: `${id}-l1`, role: '周岚', text: '这次换你告诉我，灯亮之后准备去哪里。', status: 'pending' }],
      cues: [{ id: `${id}-c1`, scene: '第三场', text: '追光保持到台词结束，再执行全场收光', status: 'pending' }]
    };
    this.store.dispatch(addVersion({ version }));
    this.store.dispatch(activateVersion({ id }));
  }
}

