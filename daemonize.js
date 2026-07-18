#!/usr/bin/env node
// nohup/disown only stop the shell from *waiting* on a child - they don't
// move it into a new process group, so it's still killed alongside whatever
// tracked task launched it if that task's whole group gets torn down (which
// is exactly what's been killing the upload pipeline: watchdog.sh and both
// of its node children died in the same instant, from the same signal).
// child_process.spawn's `detached: true` actually calls setsid() under the
// hood, putting the child in a brand new session immune to that.
import { spawn } from "child_process";

const [, , cmd, ...args] = process.argv;
const child = spawn(cmd, args, {
  detached: true,
  stdio: ["ignore", "ignore", "ignore"],
});
child.unref();
console.log(child.pid);
