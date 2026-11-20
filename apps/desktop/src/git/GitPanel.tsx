import { useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import {
  Check,
  GitBranch,
  GitCommitHorizontal,
  Minus,
  Plus,
  RefreshCw,
} from "lucide-react";
import type { BranchInfo, FileState, StatusEntry } from "@turing/contracts";
import { gitErrorMessage } from "./git-ipc";
import type { GitState } from "./use-git";

const badge: Record<FileState, { letter: string; label: string }> = {
  modified: { letter: "M", label: "Modified" },
  added: { letter: "A", label: "Added" },
  deleted: { letter: "D", label: "Deleted" },
  renamed: { letter: "R", label: "Renamed" },
  copied: { letter: "C", label: "Copied" },
  untracked: { letter: "U", label: "Untracked" },
  unmerged: { letter: "!", label: "Merge conflict" },
};

export function GitPanel({
  git,
  editorBusy,
  openFile,
}: {
  git: GitState;
  editorBusy: boolean;
  openFile: (path: string) => void;
}) {
  if (!git.available) {
    return (
      <div className="pane-empty">
        <GitBranch size={17} aria-hidden="true" />
        <p>Open a folder in the desktop app to use source control.</p>
      </div>
    );
  }
  if (git.unavailable) {
    return (
      <div className="pane-empty">
        <GitBranch size={17} aria-hidden="true" />
        <p>{gitErrorMessage(git.unavailable)}</p>
        <button
          type="button"
          className="quiet-button"
          onClick={() => void git.refresh()}
        >
          <RefreshCw size={13} aria-hidden="true" /> Check again
        </button>
      </div>
    );
  }
  if (!git.status) {
    return (
      <p className="panel-message" role="status">
        Reading repository…
      </p>
    );
  }

  const staged = git.status.entries.filter((entry) => entry.staged);
  const changes = git.status.entries.filter((entry) => !entry.staged);

  return (
    <div className="git-panel">
      <BranchBar git={git} />
      <CommitBox git={git} stagedCount={staged.length} />
      {git.error && (
        <p className="panel-message git-error" role="alert">
          {git.error}
        </p>
      )}
      {/* Stays mounted: WebKit ignores live regions inserted with text. */}
      <div role="status">
        {git.notice && <p className="panel-message">{git.notice}</p>}
      </div>
      {staged.length === 0 && changes.length === 0 ? (
        <p className="panel-message">No changes in the working tree.</p>
      ) : (
        <>
          <ChangeGroup
            title="Staged changes"
            entries={staged}
            bulkLabel="Unstage all"
            itemLabel="Unstage"
            icon={<Minus size={13} aria-hidden="true" />}
            disabled={!!git.busy}
            onBulk={() => void git.unstage(".")}
            onItem={(path) => void git.unstage(path)}
            editorBusy={editorBusy}
            openFile={openFile}
          />
          <ChangeGroup
            title="Changes"
            entries={changes}
            bulkLabel="Stage all"
            itemLabel="Stage"
            icon={<Plus size={13} aria-hidden="true" />}
            disabled={!!git.busy}
            onBulk={() => void git.stage(".")}
            onItem={(path) => void git.stage(path)}
            editorBusy={editorBusy}
            openFile={openFile}
          />
        </>
      )}
    </div>
  );
}

function BranchBar({ git }: { git: GitState }) {
  const [branches, setBranches] = useState<BranchInfo[] | null>(null);
  const [creating, setCreating] = useState("");
  const status = git.status;
  if (!status) return null;

  async function toggle() {
    setBranches(branches ? null : await git.branches());
  }

  async function switchTo(name: string, create: boolean) {
    if (await git.checkout(name, create)) {
      setBranches(null);
      setCreating("");
    }
  }

  const local = branches?.filter((branch) => !branch.isRemote) ?? [];

  return (
    <div className="git-branch">
      <div className="git-branch-row">
        <button
          type="button"
          className="quiet-button git-branch-button"
          aria-expanded={!!branches}
          aria-controls="git-branch-list"
          disabled={!!git.busy}
          onClick={() => void toggle()}
          title="Switch branch"
        >
          <GitBranch size={13} aria-hidden="true" />
          <span>{status.branch ?? "Detached HEAD"}</span>
        </button>
        {(status.ahead > 0 || status.behind > 0) && (
          <span
            className="git-sync"
            title={`${status.ahead} ahead, ${status.behind} behind upstream`}
          >
            <span aria-hidden="true">
              ↑{status.ahead} ↓{status.behind}
            </span>
            <span className="visually-hidden">
              {status.ahead} ahead, {status.behind} behind upstream
            </span>
          </span>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh source control"
          title="Refresh"
          onClick={() => void git.refresh()}
        >
          <RefreshCw size={13} aria-hidden="true" />
        </button>
      </div>
      {branches && (
        <div id="git-branch-list" className="git-branch-list">
          <ul aria-label="Local branches">
            {local.map((branch) => (
              <li key={branch.name}>
                <button
                  type="button"
                  aria-current={branch.isHead || undefined}
                  disabled={branch.isHead || !!git.busy}
                  onClick={() => void switchTo(branch.name, false)}
                >
                  {branch.isHead ? (
                    <Check size={12} aria-hidden="true" />
                  ) : (
                    <span className="git-branch-spacer" />
                  )}
                  {branch.name}
                </button>
              </li>
            ))}
          </ul>
          <form
            className="git-new-branch"
            onSubmit={(event) => {
              event.preventDefault();
              if (creating.trim()) void switchTo(creating.trim(), true);
            }}
          >
            <label>
              New branch from here
              <input
                type="text"
                maxLength={255}
                spellCheck={false}
                placeholder="feature/name"
                value={creating}
                onChange={(event) => setCreating(event.target.value)}
              />
            </label>
            <button
              type="submit"
              className="quiet-button"
              disabled={!creating.trim() || !!git.busy}
            >
              Create
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function CommitBox({
  git,
  stagedCount,
}: {
  git: GitState;
  stagedCount: number;
}) {
  const [message, setMessage] = useState("");
  const canCommit = stagedCount > 0 && !!message.trim() && !git.busy;

  async function submit() {
    if (!canCommit) return;
    if (await git.commit(message)) setMessage("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submit();
    }
  }

  return (
    <form
      className="git-commit"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <textarea
        aria-label="Commit message"
        rows={3}
        placeholder={
          stagedCount > 0
            ? "Commit message (Ctrl+Enter to commit)"
            : "Stage changes to commit"
        }
        value={message}
        onChange={(event) => setMessage(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" className="quiet-button" disabled={!canCommit}>
        <GitCommitHorizontal size={14} aria-hidden="true" />
        {git.busy === "committing"
          ? "Committing…"
          : `Commit${stagedCount ? ` ${stagedCount} file${stagedCount === 1 ? "" : "s"}` : ""}`}
      </button>
    </form>
  );
}

function ChangeGroup({
  title,
  entries,
  bulkLabel,
  itemLabel,
  icon,
  disabled,
  onBulk,
  onItem,
  editorBusy,
  openFile,
}: {
  title: string;
  entries: StatusEntry[];
  bulkLabel: string;
  itemLabel: string;
  icon: ReactNode;
  disabled: boolean;
  onBulk: () => void;
  onItem: (path: string) => void;
  editorBusy: boolean;
  openFile: (path: string) => void;
}) {
  if (entries.length === 0) return null;
  return (
    <section className="git-group" aria-label={title}>
      <header>
        <h3>
          {title} <span>{entries.length}</span>
        </h3>
        <button
          type="button"
          className="icon-button"
          aria-label={bulkLabel}
          title={bulkLabel}
          disabled={disabled}
          onClick={onBulk}
        >
          {icon}
        </button>
      </header>
      <ul>
        {entries.map((entry) => {
          const { letter, label } = badge[entry.state];
          const slash = entry.path.lastIndexOf("/");
          const name = entry.path.slice(slash + 1);
          const folder = slash > 0 ? entry.path.slice(0, slash) : "";
          return (
            <li key={`${entry.staged}:${entry.path}`} className="git-entry">
              <button
                type="button"
                className="git-entry-open"
                aria-label={`${entry.path}, ${label}`}
                disabled={editorBusy || entry.state === "deleted"}
                title={
                  entry.originalPath
                    ? `${entry.originalPath} → ${entry.path}`
                    : entry.path
                }
                onClick={() => openFile(entry.path)}
              >
                <span className="git-entry-name">{name}</span>
                {folder && <span className="git-entry-folder">{folder}</span>}
              </button>
              <button
                type="button"
                className="icon-button git-entry-action"
                aria-label={`${itemLabel} ${entry.path}`}
                title={itemLabel}
                disabled={disabled}
                onClick={() => onItem(entry.path)}
              >
                {icon}
              </button>
              <span
                className={`git-badge git-badge-${entry.state}`}
                title={label}
                aria-hidden="true"
              >
                {letter}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
