# MyOwnCompiler

A code-execution API for online coding contests. It compiles and runs **C** and **Python** code against test cases and reports which ones passed. Student code runs inside locked-down Docker containers, and nginx sits in front as the only entry point.

## Architecture

```
  Student ──► Main website ──► Main backend (holds the API key)
                                     │
                                     │  POST /submit-c or /submit-python
                                     │  header: x-api-key
                                     ▼
                         ┌───────────────────────────┐
                         │  nginx  (host port 5000)  │  checks the API key,
                         │                           │  allows only known URLs,
                         │                           │  picks the least busy container
                         └─────────────┬─────────────┘
                     internal network  │  (no internet access)
            ┌──────┬──────┬────────────┼────────────┬──────┐
            ▼      ▼      ▼            ▼            ▼      ▼
          ┌────┐ ┌────┐ ┌────┐       ┌────┐       ┌────┐ ┌─────┐
          │ c1 │ │ c2 │ │ c3 │  ...  │ c6 │  ...  │ c9 │ │ c10 │
          └────┘ └────┘ └────┘       └────┘       └────┘ └─────┘
            each container: Express (server.js) + gcc + python3
```

- **nginx** is the only container with a published port. It rejects requests without the correct `x-api-key` and passes valid ones to one of the 10 compiler containers.
- **c1 to c10** are identical copies of the `compiler` image. Each one runs `server.js` (Express), which writes the code to a private temp folder, compiles or syntax-checks it, runs it once per test case and compares the output.
- The compiler containers sit on an **internal-only network**, so student code cannot reach the internet, and nothing outside can reach the containers except through nginx.

The API key is meant to be kept in your **main backend**, not in browser code.

## Project files

```
MyOwnCompiler/
├── server.js                  # Express API: validate, compile, run, compare
├── Dockerfile                 # compiler image: Node 22 + gcc + python3 + "runner" user
├── docker-compose.yml         # nginx + c1..c10, networks and resource limits
├── conf/
│   └── nginx.conf.template    # nginx config; ${COMPILER_API_KEY} is filled in at startup
├── .env.example               # copy to .env and set your key
├── .dockerignore              # keeps .env and other files out of the image
└── package.json
```

## Setup

**Requirements:** Docker with Docker Compose. Nothing else needs to be installed; gcc, Python and Node are inside the image.

1. **Clone the repository**
   ```bash
   git clone https://github.com/thirudev-web/MyOwnCompiler.git
   cd MyOwnCompiler
   ```

2. **Create `.env`**
   ```bash
   cp .env.example .env
   ```
   Set `COMPILER_API_KEY` to a long random string, for example the output of `openssl rand -hex 32`. Compose refuses to start if the key is missing. `COMPILER_PORT` is optional and defaults to `5000`.

3. **Build the compiler image**
   ```bash
   docker build -t compiler:latest .
   ```

4. **Start everything**
   ```bash
   docker compose up -d
   ```

5. **Check it is running**
   ```bash
   curl http://localhost:5000/compiler
   # Server is running -> No issues with /compiler
   ```

After changing `server.js` or the `Dockerfile`, rebuild the image (step 3) and run `docker compose up -d` again. After changing the nginx template or `.env`, run `docker compose up -d` (or `docker compose restart nginx`).

### Running without Docker (development only)

```bash
npm install
node server.js        # http://localhost:3000
```

This mode is **not sandboxed**: there is no nginx (so no API key check), code runs as your own user, and there are no container limits. Use it only with your own test code.

## API

Base URL: `http://<host>:5000` (or your `COMPILER_PORT`).

| Method | Path | API key | Purpose |
|---|---|---|---|
| `POST` | `/submit-c` | required | Compile and run C code against test cases |
| `POST` | `/submit-python` | required | Run Python code against test cases |
| `GET` | `/` | no | Health check |
| `GET` | `/compiler` | no | Health check |

Any other path returns `404`.

### Request

Headers:
```
Content-Type: application/json
x-api-key: <COMPILER_API_KEY>
```

Body (same for C and Python):
```json
{
  "submissionid": "submission_123",
  "code": "#include <stdio.h>\nint main() {\n    int a, b;\n    scanf(\"%d %d\", &a, &b);\n    printf(\"%d\\n\", a + b);\n    return 0;\n}",
  "testCases": [
    { "input": "5 3",   "expectedOutput": "8" },
    { "input": "10 15", "expectedOutput": "25" }
  ]
}
```

| Field | Rules |
|---|---|
| `submissionid` | Required. Used only in logs. |
| `code` | Required string, up to 64 KB. |
| `testCases` | Required array of 1 to 100 objects. |
| `testCases[].input` | Optional string, sent to the program's standard input. |
| `testCases[].expectedOutput` | Required string. |

### Response

```json
{
  "results": [
    { "input": "5 3",   "expectedOutput": "8",  "actualOutput": "8\n",  "passed": true },
    { "input": "10 15", "expectedOutput": "25", "actualOutput": "25\n", "passed": true }
  ]
}
```

How outputs are compared:
- **C:** line endings are normalized and leading/trailing whitespace is trimmed.
- **Python:** all whitespace is ignored.

If a test case crashes, times out or prints too much, `passed` is `false` and `actualOutput` holds the reason, for example `Execution timeout: Program took too long to execute (possible infinite loop)`.

### Errors

| Status | Sent by | Meaning |
|---|---|---|
| `400` | server | Invalid body, blocked C function, compilation error or Python syntax error. Body has `error` and sometimes `details` (the compiler message). |
| `401` | nginx | Missing or wrong `x-api-key`. |
| `404` | nginx | Unknown path. |
| `413` | nginx | Request body over 10 MB. |
| `500` | server | Unexpected server error. |
| `502` / `504` | nginx | No container answered, or one took longer than 120 seconds. |

### Example

```bash
curl -X POST http://localhost:5000/submit-python \
  -H "Content-Type: application/json" \
  -H "x-api-key: $COMPILER_API_KEY" \
  -d '{"submissionid":"t1","code":"print(int(input())*2)","testCases":[{"input":"21","expectedOutput":"42"}]}'
```

## Limits

| Limit | Value |
|---|---|
| Compile / syntax-check time | 10 s |
| Run time per test case | 5 s wall clock, 6 s CPU |
| Output per run | 64 KB |
| Memory per program | 512 MB |
| Processes per program | 64 |
| Largest file a program may write | 1 MB |
| Per container | 1 CPU, 768 MB RAM, 256 processes, 64 MB `/tmp` |

C is compiled with `gcc -O2 -std=gnu11 ... -lm`.

## Security

Even when only your main backend can call this API, the student's code is passed through unchanged and runs here, so the containers are built to contain hostile code:

- **API key and allow-list in nginx:** only the main backend can submit, and only the four paths above are reachable.
- **No shell:** programs are started directly, never through a shell command, and `submissionid` is never used in file names or commands.
- **Unprivileged user:** student programs run as the `runner` user, not root.
- **Per-program limits** (`prlimit`) on CPU time, memory, processes and file size, plus timeouts and an output cap. The whole process group is killed after each run, and a background sweep kills any leftover `runner` processes older than 30 seconds.
- **Private folder per submission:** each job gets its own temp folder, deleted afterwards; students cannot list each other's folders.
- **Locked-down containers:** read-only filesystem except a small in-memory `/tmp`, almost all Linux capabilities dropped, `no-new-privileges`, CPU/memory/process limits, and automatic restart.
- **No internet:** the compiler containers are on an internal Docker network.
- **C function blocklist:** calls such as `system(`, `fork(`, `fopen(` and `socket(` are rejected before compiling. This is only a first filter and is easy to get around; the sandbox above is the real protection. Python has no blocklist and relies entirely on the sandbox.

## Scaling

Each container runs one CPU's worth of work, so 10 containers handle about 10 submissions at the same time. To change the number:

1. Add or remove `cN` lines in `docker-compose.yml`, and update nginx's `depends_on` list.
2. Add or remove the matching `server cN:3000;` lines in `conf/nginx.conf.template`.
3. Run `docker compose up -d`.

## Troubleshooting

| Problem | What to check |
|---|---|
| `docker compose up` says `Set COMPILER_API_KEY in .env` | Create `.env` from `.env.example` and set the key. |
| `401` on every submission | The `x-api-key` header must exactly match `COMPILER_API_KEY` in `.env`. Restart nginx after changing the key. |
| `502 Bad Gateway` | Compiler containers are not running: `docker compose ps`, then `docker compose logs c1`. |
| `pull access denied for compiler` | Build the image first: `docker build -t compiler:latest .` |
| Code changes not showing up | Rebuild the image, then `docker compose up -d`. |
| Logs | `docker compose logs -f nginx` or `docker compose logs -f c1` |

## License

Available for educational and non-commercial use.
