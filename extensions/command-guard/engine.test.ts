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
  allow: ["rm -f*", "rm -rf*", "rm --force*"],
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
    assert.equal(d("timeout 3 node scripts/install.mjs"), "allow");
    assert.equal(d("timeout 3 git push origin main"), "ask");
    assert.equal(d("env FOO=1 git push"), "ask");
    assert.equal(d("nohup git status"), "allow");
    assert.equal(normalize("timeout 3 node foo.mjs"), "node foo.mjs");
  });
  test("xargs peels to the utility", () => {
    assert.equal(d("find extensions -name '*.ts' | xargs wc -l"), "allow");
    assert.equal(d("xargs rm -rf /tmp/foo"), "allow");
    assert.equal(d("xargs rm /tmp/foo"), "ask");
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

describe("allow override (rm force flags)", () => {
  test("rm -f / -rf / --force are allowed without prompt", () => {
    assert.equal(d("rm -f /tmp/foo"), "allow");
    assert.equal(d("rm -rf /tmp/dir"), "allow");
    assert.equal(d("rm -fr /tmp/dir"), "allow");
    assert.equal(d("rm --force /tmp/foo"), "allow");
    assert.equal(d("rm -fv /tmp/foo"), "allow");
    assert.equal(d("rm -rfv /tmp/dir"), "allow");
  });
  test("plain rm and rm -r still ask", () => {
    assert.equal(d("rm /tmp/foo"), "ask");
    assert.equal(d("rm -r /tmp/dir"), "ask");
    assert.equal(d("rm -v /tmp/foo"), "ask");
  });
  test("deny still beats allow", () => {
    const rules: GuardConfig = {
      allow: ["rm -f*"],
      ask: ["rm *"],
      deny: ["rm -f /etc/*"],
    };
    assert.equal(d("rm -f /etc/passwd", rules), "deny");
    assert.equal(d("rm -f /tmp/foo", rules), "allow");
  });
  test("work config allows rm -f but asks on plain rm", () => {
    assert.equal(d("rm -f /tmp/foo", workCfg), "allow");
    assert.equal(d("rm -rf /tmp/dir", workCfg), "allow");
    assert.equal(d("rm /tmp/foo", workCfg), "ask");
    assert.equal(d("rm -r /tmp/dir", workCfg), "ask");
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

describe("env wrapper peeling", () => {
  test("env with assignments and flags peels to the inner command", () => {
    assert.equal(normalize("env FOO=1 git push origin"), "git push origin");
    assert.equal(normalize("env FOO=1 BAR=2 git push"), "git push");
    assert.equal(normalize("env -i git push"), "git push");
    assert.equal(normalize("env -0 git push"), "git push");
    assert.equal(normalize("env -v git push"), "git push");
    assert.equal(normalize("env -u FOO git push"), "git push");
    assert.equal(normalize("env -C /tmp git push"), "git push");
    assert.equal(normalize("env -S /bin/sh git push"), "git push");
  });
  test("bare env has nothing to peel", () => {
    assert.equal(normalize("env"), "env");
    assert.equal(normalize("env -i"), "env -i");
    assert.equal(normalize("env FOO=1"), "env FOO=1");
  });
});

describe("xargs wrapper peeling", () => {
  test("xargs with flags peels to the inner command", () => {
    assert.equal(normalize("xargs git push"), "git push");
    assert.equal(normalize("xargs -n1 git push"), "git push");
    assert.equal(normalize("xargs --arg=1 git push"), "git push");
    assert.equal(normalize("xargs -a f git push"), "git push");
    assert.equal(normalize("xargs --max-args 2 git push"), "git push");
    assert.equal(normalize("xargs --no-replace git push"), "git push");
  });
  test("bare xargs has nothing to peel", () => {
    assert.equal(normalize("xargs"), "xargs");
    assert.equal(normalize("xargs -n1"), "xargs -n1");
  });
});

describe("nice / nohup / time prefixes", () => {
  test("nice with and without -n peels", () => {
    assert.equal(normalize("nice -n 5 git push"), "git push");
    assert.equal(normalize("nice git push"), "git push");
  });
  test("nohup and time peel", () => {
    assert.equal(normalize("nohup git push"), "git push");
    assert.equal(normalize("time git push"), "git push");
  });
});

describe("splitCommands quoting and substitution", () => {
  test("escaped quote inside double quotes does not split", () => {
    assert.deepEqual(splitCommands('echo "a\\"; b" ; git status'), [
      'echo "a\\"; b"',
      "git status",
    ]);
  });
  test("trailing backslash inside double quotes at end of input", () => {
    assert.deepEqual(splitCommands('echo "x\\'), ['echo "x\\']);
  });
  test("separators inside $() never split", () => {
    assert.deepEqual(splitCommands("echo $(ls; pwd) && git status"), [
      "echo $(ls; pwd)",
      "git status",
    ]);
    assert.deepEqual(splitCommands("echo $(deep $(nested)) | wc"), [
      "echo $(deep $(nested))",
      "wc",
    ]);
  });
  test("bare ) outside substitution is kept in the token", () => {
    assert.deepEqual(splitCommands("echo ) ; git status"), ["echo )", "git status"]);
  });
});

describe("decideProgram edge cases", () => {
  test("empty and whitespace-only commands are allowed", () => {
    assert.equal(decideProgram("", cfg).decision, "allow");
    assert.equal(decideProgram("   ", cfg).decision, "allow");
  });
});

describe("pattern and flag helpers", () => {
  test("exact (starless) patterns match the whole string only", () => {
    assert.equal(matchesPattern("git status", "git status", "git status"), true);
    assert.equal(matchesPattern("git status", "git status extra", "git status extra"), false);
  });
  test("a flag as the first token is kept as-is", () => {
    assert.equal(flagStripped("-C /repo git push"), "-C /repo git push");
  });
});
