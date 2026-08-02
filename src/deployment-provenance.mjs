import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

async function defaultExecGit(args, cwd) {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout;
}

export async function reviewedMainDeploymentCommit({
  cwd = new URL("..", import.meta.url),
  execGit = defaultExecGit
} = {}) {
  const run = async (args) => String(await execGit(args, cwd)).trim();
  const [head, localMain, remoteMain, status] = await Promise.all([
    run(["rev-parse", "HEAD"]),
    run(["rev-parse", "refs/heads/main"]),
    run(["rev-parse", "refs/remotes/origin/main"]),
    run(["status", "--porcelain=v1", "--untracked-files=all"])
  ]);
  if (!/^[0-9a-f]{40}$/.test(head)) {
    throw new Error("deployment repository HEAD is invalid");
  }
  if (status) {
    throw new Error("deployment repository worktree must be clean");
  }
  if (head !== localMain || head !== remoteMain) {
    throw new Error(
      "deployment repository HEAD must equal both local main and origin/main"
    );
  }
  return head;
}
