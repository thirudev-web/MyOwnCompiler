# Node.js 22 on Debian Bookworm (pinned so gcc/python versions don't change under us)
# (the full image, not -slim: it includes CA certificates so apt can use https)
FROM node:22-bookworm

# gcc + libc headers for C, python3 for Python, procps for `ps`.
# prlimit comes from util-linux, which is already in the base image.
# apt is switched to https because some networks block plain http mirrors.
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && \
    apt-get update && \
    apt-get install -y --no-install-recommends gcc libc6-dev python3 procps && \
    rm -rf /var/lib/apt/lists/*

# Unprivileged user that student programs run as. No home, no login shell.
RUN groupadd -g 10001 runner && \
    useradd -u 10001 -g runner -M -d /nonexistent -s /usr/sbin/nologin runner

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./

# The app folder is read-only for everyone except root.
RUN chmod -R go-w /app

ENV NODE_ENV=production \
    SANDBOX=1 \
    RUNNER_UID=10001 \
    RUNNER_GID=10001

EXPOSE 3000

# The server stays root (with almost every capability dropped in docker-compose.yml)
# so it can start student programs as the runner user and kill them afterwards.
CMD ["node", "server.js"]
