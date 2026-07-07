#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';

const HOMEBREW_JDK_17 = '/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home';

const env = { ...process.env };

if (!env.DRIVE_ASSISTANT_KEEP_JAVA_HOME && existsSync(HOMEBREW_JDK_17)) {
  env.JAVA_HOME = HOMEBREW_JDK_17;
}

const child = spawn(
  'react-native',
  ['run-android', ...process.argv.slice(2)],
  {
    env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
);

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
