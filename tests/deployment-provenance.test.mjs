import assert from "node:assert/strict";
import test from "node:test";

import { reviewedMainDeploymentCommit } from "../src/deployment-provenance.mjs";

const commit = "a".repeat(40);

function fakeGit(values) {
  return async (args) => {
    const key = args.join(" ");
    if (!(key in values)) throw new Error(`unexpected git command ${key}`);
    return values[key];
  };
}

const cleanMain = {
  "rev-parse HEAD": commit,
  "rev-parse refs/heads/main": commit,
  "rev-parse refs/remotes/origin/main": commit,
  "status --porcelain=v1 --untracked-files=all": ""
};

test("deployment provenance accepts only one clean local and remote main commit", async () => {
  assert.equal(
    await reviewedMainDeploymentCommit({ execGit: fakeGit(cleanMain) }),
    commit
  );
});

test("deployment provenance rejects a dirty worktree", async () => {
  await assert.rejects(
    reviewedMainDeploymentCommit({
      execGit: fakeGit({
        ...cleanMain,
        "status --porcelain=v1 --untracked-files=all": " M src/file.mjs"
      })
    }),
    /worktree must be clean/
  );
});

test("deployment provenance rejects feature or stale remote commits", async () => {
  await assert.rejects(
    reviewedMainDeploymentCommit({
      execGit: fakeGit({
        ...cleanMain,
        "rev-parse HEAD": "b".repeat(40)
      })
    }),
    /must equal both local main and origin\/main/
  );
  await assert.rejects(
    reviewedMainDeploymentCommit({
      execGit: fakeGit({
        ...cleanMain,
        "rev-parse refs/remotes/origin/main": "c".repeat(40)
      })
    }),
    /must equal both local main and origin\/main/
  );
});
