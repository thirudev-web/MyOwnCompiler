const express = require('express');
const cors = require('cors');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');

const app = express();
let count = 0;

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
const COMPILE_TIMEOUT_MS = 10000;   // gcc / python syntax check
const RUN_TIMEOUT_MS = 5000;        // per test case (wall clock)
const MAX_OUTPUT_BYTES = 64 * 1024; // stdout + stderr per run
const MAX_CODE_BYTES = 64 * 1024;
const MAX_TEST_CASES = 100;

// Sandbox mode (set in the Dockerfile). Student code runs as an unprivileged
// "runner" user with per-process limits. Off for local development on a laptop.
const SANDBOX = process.env.SANDBOX === '1';
const RUNNER_UID = Number(process.env.RUNNER_UID || 10001);
const RUNNER_GID = Number(process.env.RUNNER_GID || 10001);
const PRLIMIT = [
  'prlimit',
  '--cpu=6',                    // seconds of CPU time
  `--as=${512 * 1024 * 1024}`,  // address space (memory)
  '--nproc=64',                 // processes for the runner user (stops fork bombs)
  `--fsize=${1024 * 1024}`,     // largest file it may write
  '--core=0',
  '--'
];

// Every submission gets its own folder under WORK_ROOT. In the sandbox the root
// folder is mode 0711, so the runner user can enter a folder whose name it
// knows but cannot list the others (other teams' code).
const WORK_ROOT = path.join(os.tmpdir(), 'subs');
fs.mkdirSync(WORK_ROOT, { recursive: true, mode: 0o711 });
fs.chmodSync(WORK_ROOT, 0o711);

const CHILD_ENV = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  LANG: 'C.UTF-8',
  PYTHONIOENCODING: 'utf-8',
  PYTHONDONTWRITEBYTECODE: '1'
};

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization', 'x-api-key']
}));
app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Runs a program WITHOUT a shell. Input goes to stdin. The program and anything
// it starts are killed on timeout or when output gets too big.
function run(cmd, args, { cwd, input = '', timeoutMs, sandboxed = false }) {
  return new Promise((resolve) => {
    let file = cmd;
    let argv = args;
    const opts = { cwd, env: CHILD_ENV, detached: true, stdio: ['pipe', 'pipe', 'pipe'] };
    if (sandboxed && SANDBOX) {
      file = PRLIMIT[0];
      argv = [...PRLIMIT.slice(1), cmd, ...args];
      opts.uid = RUNNER_UID;
      opts.gid = RUNNER_GID;
    }

    const child = spawn(file, argv, opts);
    let stdout = '';
    let stderr = '';
    let bytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let done = false;

    const killGroup = () => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);

    const collect = (which) => (chunk) => {
      if (outputExceeded) return;
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) { outputExceeded = true; killGroup(); return; }
      if (which === 'out') stdout += chunk; else stderr += chunk;
    };
    child.stdout.on('data', collect('out'));
    child.stderr.on('data', collect('err'));
    child.stdin.on('error', () => { /* program exited without reading input (EPIPE) */ });

    const finish = (code, signal, spawnError) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      killGroup(); // clean up background children left behind
      resolve({ stdout, stderr, code, signal, timedOut, outputExceeded, spawnError });
    };
    child.on('error', (err) => finish(null, null, err));
    child.on('close', (code, signal) => finish(code, signal));

    child.stdin.end(input.endsWith('\n') ? input : input + '\n');
  });
}

// Validates the request body. Returns an error message or null.
function validate(body) {
  const { code, testCases, submissionid } = body || {};
  if (!code || !testCases || !submissionid) return 'Missing required fields.';
  if (typeof code !== 'string') return 'code must be a string.';
  if (Buffer.byteLength(code) > MAX_CODE_BYTES) return 'Code is too large.';
  if (!Array.isArray(testCases) || testCases.length === 0) return 'testCases must be a non-empty array.';
  if (testCases.length > MAX_TEST_CASES) return 'Too many test cases.';
  for (const t of testCases) {
    if (!t || typeof t !== 'object') return 'Each test case must be an object.';
    if (t.input != null && typeof t.input !== 'string') return 'Test case input must be a string.';
    if (typeof t.expectedOutput !== 'string') return 'Test case expectedOutput must be a string.';
  }
  return null;
}

// submissionid is only used for logs, never for file names or commands.
const logId = (id) => String(id).replace(/[^\w.-]/g, '_').slice(0, 100);

async function withWorkDir(fn) {
  const dir = await fsp.mkdtemp(path.join(WORK_ROOT, 'job-'));
  await fsp.chmod(dir, 0o711);
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true }).catch((err) =>
      console.warn(`Failed to clean up ${dir}:`, err.message));
  }
}

// Removes the temp folder path from compiler/interpreter messages so students
// see "main.py" instead of "/tmp/subs/job-abc123/main.py".
function stripDir(text, dir) {
  let real = dir;
  try { real = fs.realpathSync(dir); } catch { /* keep dir */ }
  return text.split(real + path.sep).join('').split(dir + path.sep).join('');
}

// Turns a finished run into the text shown as actualOutput, or null if it ran fine.
function runtimeProblem(r, dir) {
  if (r.spawnError) return `Runtime error: ${r.spawnError.message}`;
  if (r.timedOut) return 'Execution timeout: Program took too long to execute (possible infinite loop)';
  if (r.outputExceeded) return 'Output limit exceeded: Program printed too much output';
  if (r.signal) return `Runtime error (signal ${r.signal})`;
  if (r.code !== 0) {
    const err = stripDir(r.stderr, dir).trim();
    return err || `Runtime error (exit code ${r.code})`;
  }
  return null;
}

async function runTestCases(testCases, dir, cmd, args, normalize) {
  const results = [];
  for (const { input, expectedOutput } of testCases) {
    const r = await run(cmd, args, { cwd: dir, input: input ?? '', timeoutMs: RUN_TIMEOUT_MS, sandboxed: true });
    const problem = runtimeProblem(r, dir);
    const actualOutput = problem ?? r.stdout;
    const passed = problem === null && normalize(r.stdout) === normalize(expectedOutput);
    results.push({ input, expectedOutput, actualOutput, passed });
  }
  return results;
}

// ---------------------------------------------------------------------------
// C
// ---------------------------------------------------------------------------
const dangerousFunctions = [
  'system', 'exec', 'fork', 'popen', 'fopen', 'freopen', 'remove', 'rename', 'tmpfile', 'tmpnam', 'open', 'creat', 'unlink', 'rmdir', 'chdir', 'chmod', 'chown', 'kill', 'signal', 'raise', 'socket', 'connect', 'listen', 'accept', 'bind', 'memcpy', 'memmove', 'dlopen', 'dlsym', 'dlclose', 'dlerror'
];
const escapeRegExp = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const normalizeC = str => str.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

app.post('/submit-c', async (req, res) => {
  const invalid = validate(req.body);
  if (invalid) return res.status(400).json({ error: invalid });
  const { code, testCases, submissionid } = req.body;

  const foundDangerous = dangerousFunctions.filter(fn => new RegExp(`\\b${escapeRegExp(fn)}\\s*\\(`).test(code));
  if (foundDangerous.length > 0) {
    return res.status(400).json({ error: 'Malicious or dangerous function calls detected', functions: foundDangerous });
  }

  try {
    await withWorkDir(async (dir) => {
      await fsp.writeFile(path.join(dir, 'main.c'), code, { mode: 0o644 });

      const c = await run('gcc', ['-O2', '-std=gnu11', 'main.c', '-o', 'main', '-lm'],
        { cwd: dir, timeoutMs: COMPILE_TIMEOUT_MS });
      if (c.timedOut) {
        return res.status(400).json({ error: 'Compilation timeout: Code took too long to compile' });
      }
      if (c.code !== 0) {
        const details = stripDir(c.stderr, dir).trim();
        return res.status(400).json({ error: `Compilation failed\n${details}`, details });
      }
      await fsp.chmod(path.join(dir, 'main'), 0o755);

      const results = await runTestCases(testCases, dir, './main', [], normalizeC);
      console.log(`C submission ${logId(submissionid)}: ${results.filter(r => r.passed).length}/${results.length} passed`);
      res.json({ results });
    });
  } catch (err) {
    console.error('C submission failed:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------
const PY_SYNTAX_CHECK = [
  'import sys, traceback',
  "src = open(sys.argv[1], encoding='utf-8').read()",
  'try:',
  "    compile(src, 'main.py', 'exec')",
  'except (SyntaxError, ValueError) as e:',
  "    sys.stderr.write(''.join(traceback.format_exception_only(type(e), e)))",
  '    sys.exit(1)'
].join('\n');
const normalizePython = str => str.replace(/[\s​-‍﻿]/g, '');

app.post('/submit-python', async (req, res) => {
  const invalid = validate(req.body);
  if (invalid) return res.status(400).json({ error: invalid });
  const { code, testCases, submissionid } = req.body;
  console.log(`count - ${count}, submission - ${logId(submissionid)}`);
  count = count + 1;

  try {
    await withWorkDir(async (dir) => {
      await fsp.writeFile(path.join(dir, 'main.py'), code, { mode: 0o644 });

      const c = await run('python3', ['-I', '-c', PY_SYNTAX_CHECK, 'main.py'],
        { cwd: dir, timeoutMs: COMPILE_TIMEOUT_MS, sandboxed: true });
      if (c.timedOut) {
        return res.status(400).json({ error: 'Syntax check timeout: Code took too long to check' });
      }
      if (c.code !== 0) {
        const details = c.stderr.trim() || 'Syntax check failed';
        return res.status(400).json({ error: `Syntax error\n${details}`, details });
      }

      const results = await runTestCases(testCases, dir, 'python3', ['main.py'], normalizePython);
      console.log(`Executed for submission id - ${logId(submissionid)}: ${results.filter(r => r.passed).length}/${results.length} passed`);
      res.json({ results });
    });
  } catch (err) {
    console.error('Python submission failed:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// ---------------------------------------------------------------------------
// Sweep: kill runner-user processes that escaped their process group
// (e.g. with setsid) and are still alive long after their run ended.
// ---------------------------------------------------------------------------
if (SANDBOX) {
  setInterval(() => {
    execFile('ps', ['-u', String(RUNNER_UID), '-o', 'pid=,etimes='], (err, stdout) => {
      if (err) return; // exit code 1 just means no runner processes
      for (const line of stdout.trim().split('\n')) {
        const [pid, secs] = line.trim().split(/\s+/).map(Number);
        if (pid && secs > 30) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
        }
      }
    });
  }, 10000).unref();
}

app.get('/compiler', (req, res) => {
  res.status(200).send('Server is running -> No issues with /compiler');
});
app.get('/', (req, res) => {
  res.status(200).send('Server is running -> No issues without /compiler');
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} (sandbox ${SANDBOX ? 'on' : 'off'})`);
});
