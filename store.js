import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const remote = process.env.DATA_REPO || "";
const keyB64 = process.env.DATA_SSH_KEY_B64 || "";
const useRemote = Boolean(remote && keyB64);
const dataDir = useRemote ? path.join(os.tmpdir(), "gbdc-data") : process.env.DATA_DIR || "";

let queue = Promise.resolve();

function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.then(() => {}, () => {});
  return run;
}

function resolveDir(root) {
  return dataDir || path.join(root, "data");
}

export function files(root) {
  const dir = resolveDir(root);
  return {
    dir,
    dataFile: path.join(dir, "itinerary.json"),
    authFile: path.join(dir, "auth.json"),
  };
}

async function git(dir, args) {
  const keyFile = path.join(os.tmpdir(), "gbdc-deploy-key");
  const knownHosts = path.join(os.tmpdir(), "gbdc-known-hosts");
  await exec("git", args, {
    cwd: dir,
    env: {
      ...process.env,
      GIT_SSH_COMMAND: `ssh -i "${keyFile}" -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="${knownHosts}"`,
    },
  });
}

async function prepareRemote(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const keyFile = path.join(os.tmpdir(), "gbdc-deploy-key");
  const knownHosts = path.join(os.tmpdir(), "gbdc-known-hosts");
  fs.writeFileSync(keyFile, Buffer.from(keyB64, "base64"));
  fs.chmodSync(keyFile, 0o600);
  if (!fs.existsSync(knownHosts)) {
    const { stdout } = await exec("ssh-keyscan", ["-t", "ed25519,rsa", "github.com"]);
    fs.writeFileSync(knownHosts, stdout);
  }
  if (!fs.existsSync(path.join(dir, ".git"))) {
    await exec("git", ["clone", remote, dir]);
  } else {
    await git(dir, ["pull", "--rebase", "origin", "main"]);
  }
}

export async function openStore(root) {
  if (!useRemote) return;
  await enqueue(() => prepareRemote(resolveDir(root)));
}

export async function publish(root) {
  if (!useRemote) return;
  const dir = resolveDir(root);
  await enqueue(async () => {
    await git(dir, ["add", "itinerary.json", "auth.json"]);
    try {
      await git(dir, ["-c", "user.name=GBDC", "-c", "user.email=gbdc@users.noreply.github.com", "commit", "-m", "Save itinerary"]);
    } catch (error) {
      const text = `${error.stdout || ""}\n${error.stderr || ""}`;
      if (text.includes("nothing to commit")) return;
      throw error;
    }
    try {
      await git(dir, ["pull", "--rebase", "origin", "main"]);
    } catch {
      await git(dir, ["rebase", "--abort"]).catch(() => {});
    }
    await git(dir, ["push", "origin", "main"]);
  });
}
