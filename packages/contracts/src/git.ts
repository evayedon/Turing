// Git adapter contracts. Mirrors apps/desktop/src-tauri/src/git.rs.

export type GitError =
  | "NO_GIT"
  | "NOT_A_REPOSITORY"
  | "WORKSPACE_NOT_OPEN"
  | "INVALID_REF"
  | "INVALID_PATH"
  | "INVALID_MESSAGE"
  | "NOTHING_TO_COMMIT"
  | "IDENTITY_MISSING"
  | "UNCOMMITTED_CHANGES"
  | "OPERATION_FAILED"
  | "IO_ERROR";

export type FileState =
  | "untracked"
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "unmerged";

export interface StatusEntry {
  /** Workspace-relative path. */
  path: string;
  /** True for the index (staged) side of a change. */
  staged: boolean;
  state: FileState;
  /** Source path of a staged rename or copy. */
  originalPath: string | null;
}

export interface GitStatus {
  /** Current branch, or null when HEAD is detached. */
  branch: string | null;
  entries: StatusEntry[];
  ahead: number;
  behind: number;
}

export interface GitDiff {
  text: string;
  truncated: boolean;
}

export interface LogEntry {
  hash: string;
  shortHash: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  /** Relative date such as "2 days ago". */
  date: string;
}

export interface BranchInfo {
  name: string;
  isHead: boolean;
  isRemote: boolean;
}

interface InWorkspace {
  workspaceId: string;
}

export interface GitCommands {
  git_status: { args: InWorkspace; result: GitStatus };
  git_diff: {
    args: InWorkspace & { relativePath: string; staged: boolean };
    result: GitDiff;
  };
  /** Pass "." as relativePath to stage everything. */
  git_stage: { args: InWorkspace & { relativePath: string }; result: null };
  /** Pass "." as relativePath to unstage everything. */
  git_unstage: { args: InWorkspace & { relativePath: string }; result: null };
  /** Resolves to the short hash of the new commit. */
  git_commit: { args: InWorkspace & { message: string }; result: string };
  git_branches: { args: InWorkspace; result: BranchInfo[] };
  git_checkout: {
    args: InWorkspace & { branchName: string; create: boolean };
    result: null;
  };
  git_log: { args: InWorkspace & { limit: number }; result: LogEntry[] };
}
