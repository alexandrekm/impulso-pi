import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decideProgram,
  flagStripped,
  matchesPattern,
  normalize,
  splitCommands,
  type GuardConfig,
} from "./engine.ts";

const workCfg = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "config.work.json"), "utf8"),
) as GuardConfig;

const cfg: GuardConfig = {
  ask: ["git push*", "rm *", "sudo *"],
  deny: ["kubectl delete*"],
};

function d(cmd: string, rules: GuardConfig = cfg): string {
  return decideProgram(cmd, rules).decision;
}

describe("baseline", () => {
  test("ask / deny / allow", () => {
    assert.equal(d("git push origin main"), "ask");
    assert.equal(d("kubectl delete pod foo"), "deny");
    assert.equal(d("git status"), "allow");
  });
});

describe("flag stripping", () => {
  test("git -C still matches git push*", () => {
    assert.equal(d("git -C /some/repo push origin main"), "ask");
  });
  test("--no-pager does not consume the subcommand", () => {
    assert.equal(d("git --no-pager push origin main"), "ask");
  });
  test("kubectl --namespace value is stripped", () => {
    assert.equal(d("kubectl --namespace prod delete pod foo"), "deny");
    assert.equal(d("kubectl --namespace=prod delete pod foo"), "deny");
    assert.equal(d("kubectl -n prod delete pod foo"), "deny");
  });
  test("skeleton keeps subcommand", () => {
    assert.equal(flagStripped("git -C /repo --no-pager push origin"), "git push origin");
  });
});

describe("normalize wrappers", () => {
  test("cd && prefix", () => {
    assert.equal(d("cd /repo && git push"), "ask");
    assert.equal(d("cd '/path/with spaces' && git push"), "ask");
  });
  test("sh/bash -c and eval", () => {
    assert.equal(d("sh -c 'git push origin main'"), "ask");
    assert.equal(d('bash -c "git push origin main"'), "ask");
    assert.equal(d("eval 'kubectl delete pod foo'"), "deny");
  });
  test("nested cd then bash -c", () => {
    assert.equal(d("cd /repo && sh -c 'git push'"), "ask");
    assert.equal(d('cd /repo && bash -c "kubectl delete pod foo"'), "deny");
  });
  test("timeout / env / nohup peel to the inner command", () => {
    assert.equal(d("timeout 3 node scripts/payload-browser.mjs"), "allow");
    assert.equal(d("timeout 3 git push origin main"), "ask");
    assert.equal(d("env FOO=1 git push"), "ask");
    assert.equal(d("nohup git status"), "allow");
    assert.equal(normalize("timeout 3 node foo.mjs"), "node foo.mjs");
  });
  test("xargs peels to the utility", () => {
    assert.equal(d("find extensions -name '*.ts' | xargs wc -l"), "allow");
    assert.equal(d("xargs rm -rf /tmp/foo"), "ask");
    assert.equal(normalize("xargs wc -l"), "wc -l");
  });
  test("session-style rematch uses flag-stripped skeleton", () => {
    const pattern = "git push*";
    const cmd = "git -C /repo push origin main";
    assert.equal(matchesPattern(pattern, cmd, cmd), false);
    assert.equal(matchesPattern(pattern, cmd, flagStripped(cmd)), true);
  });
});

describe("compound commands", () => {
  test("&& || ; most-restrictive wins", () => {
    assert.equal(d("git add . && git push"), "ask");
    assert.equal(d("git add . && kubectl delete pod foo"), "deny");
    assert.equal(d("git push && kubectl delete pod foo"), "deny");
    assert.equal(d("git add . && git commit -m 'fix' && git push"), "ask");
    assert.equal(d("git status; git push"), "ask");
    assert.equal(d("git push || echo failed"), "ask");
    assert.equal(d("git status && git log && git diff"), "allow");
  });
  test("quoted separators are not splits", () => {
    assert.equal(d('git commit -m "feat && fix" && git push'), "ask");
    assert.equal(d("git commit -m 'feat && fix' && git push"), "ask");
    assert.equal(d('git commit -m "pipe | here" && git push'), "ask");
  });
});

describe("subshell depth", () => {
  test("inner && is not a top-level split", () => {
    assert.equal(d('git commit -m "$(echo "bad && stuff")" && git push'), "ask");
  });
  test("deny inside $() is not promoted", () => {
    assert.equal(d('echo "$(kubectl delete pod foo)" && git status'), "allow");
  });
  test("heredoc commit then git push", () => {
    const cmd = [
      "git add foo/ && ",
      "git commit -m \"$(cat <<'EOF'\nsome message\nEOF\n)\" && ",
      "git push",
    ].join("");
    assert.equal(d(cmd), "ask");
  });
  test("deny text inside heredoc is not promoted", () => {
    const cmd = [
      "git commit -m \"$(cat <<'EOF'\n",
      "docs: do not run kubectl delete directly\n",
      'EOF\n)" && git status',
    ].join("");
    assert.equal(d(cmd), "allow");
  });
});

describe("splitCommands", () => {
  test("pipes split so xargs is its own unit", () => {
    assert.deepEqual(splitCommands("find . | xargs wc -l"), ["find .", "xargs wc -l"]);
  });
});

describe("work config", () => {
  test("allows git push", () => {
    assert.equal(d("git push origin main", workCfg), "allow");
  });
  test("asks on mutating anyscale, allows readonly", () => {
    assert.equal(d("anyscale job submit -f job.yaml", workCfg), "ask");
    assert.equal(d("anyscale job terminate --name my-job", workCfg), "ask");
    assert.equal(d("anyscale service deploy -f svc.yaml", workCfg), "ask");
    assert.equal(d("anyscale workspace_v2 start -n ws", workCfg), "ask");
    assert.equal(d("anyscale job list", workCfg), "allow");
    assert.equal(d("anyscale job status --name my-job", workCfg), "allow");
    assert.equal(d("anyscale job logs --name my-job", workCfg), "allow");
  });
  test("asks on mutating aws, allows readonly", () => {
    assert.equal(d("aws s3 rm s3://bucket/key", workCfg), "ask");
    assert.equal(d("aws --profile prod s3 rm s3://bucket/key", workCfg), "ask");
    assert.equal(d("aws ec2 terminate-instances --instance-ids i-1", workCfg), "ask");
    assert.equal(d("aws iam create-user --user-name x", workCfg), "ask");
    assert.equal(
      d("aws cloudformation deploy --stack-name s --template-file t.yml", workCfg),
      "ask",
    );
    assert.equal(d("aws s3 ls", workCfg), "allow");
    assert.equal(d("aws ec2 describe-instances", workCfg), "allow");
    assert.equal(d("aws sts get-caller-identity", workCfg), "allow");
  });
});
