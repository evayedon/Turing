export interface DisposableModel {
  dispose(): void;
}

export interface ModelViewer<M> {
  getModel(): M | null;
}

/**
 * One text model per open document, shared by every editor group that shows
 * it, so edits and the undo stack are common to all views. Views keep their
 * own cursor, selection and scroll.
 *
 * Lifetime follows the editor groups: a model lives while at least one group
 * lists its document, and `retain` disposes the rest. It holds no Monaco
 * import so the workbench can own it without loading the editor.
 */
export class ModelRegistry<M extends DisposableModel> {
  private readonly models = new Map<string, M>();
  private readonly snapshots = new Map<
    string,
    { draft: string; text: string; bom: number }
  >();
  private readonly viewers = new Set<ModelViewer<M>>();
  private readonly reported = new Map<string, number>();
  private syncDepth = 0;

  get size() {
    return this.models.size;
  }

  get(key: string) {
    return this.models.get(key);
  }

  keyOf(model: M) {
    for (const [key, item] of this.models) if (item === model) return key;
  }

  /** Returns the document's model, creating it on first use. */
  acquire(key: string, create: () => M) {
    let model = this.models.get(key);
    if (!model) {
      model = create();
      this.models.set(key, model);
    }
    return model;
  }

  snapshot(key: string) {
    return this.snapshots.get(key);
  }

  remember(key: string, draft: string, text: string, bom: number) {
    this.snapshots.set(key, { draft, text, bom });
  }

  /**
   * Disposes every model whose document is no longer open in any group.
   * Returns the keys that were disposed.
   */
  retain(open: ReadonlySet<string>) {
    const disposed: string[] = [];
    for (const [key, model] of this.models) {
      if (open.has(key)) continue;
      this.models.delete(key);
      this.reported.delete(key);
      this.snapshots.delete(key);
      model.dispose();
      disposed.push(key);
    }
    return disposed;
  }

  clear() {
    return this.retain(new Set());
  }

  /** Registers an editor view. Returns its unregister function. */
  attach(viewer: ModelViewer<M>) {
    this.viewers.add(viewer);
    return () => {
      this.viewers.delete(viewer);
    };
  }

  /** Whether any attached view currently shows `model`. */
  isShown(model: M) {
    for (const viewer of this.viewers)
      if (viewer.getModel() === model) return true;
    return false;
  }

  /** True while the workbench writes into a model, which is not a user edit. */
  get syncing() {
    return this.syncDepth > 0;
  }

  sync<T>(write: () => T): T {
    this.syncDepth += 1;
    try {
      return write();
    } finally {
      this.syncDepth -= 1;
    }
  }

  /**
   * Every view of a shared model hears the same content change. The first
   * view to claim a model version reports it; the others skip it.
   */
  claimChange(key: string, version: number) {
    if (this.reported.get(key) === version) return false;
    this.reported.set(key, version);
    return true;
  }
}
